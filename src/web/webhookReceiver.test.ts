import { createHmac } from 'node:crypto';
import { describe, it, expect, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { createWebhookReceiver } from './webhookReceiver.js';
import { computeSignature } from '../core/triggers/webhookVerify.js';

const secret = 'webhook-secret';
const ts = 1_700_000_000;

/** Stub pool whose recordDelivery insert reports first-vs-replay via seen ids. */
function stubPool(): Pool {
  const seen = new Set<string>();
  return {
    query: async (_sql: string, params: unknown[]) => {
      const deliveryId = params[0] as string;
      if (seen.has(deliveryId)) return { rowCount: 0, rows: [] };
      seen.add(deliveryId);
      return { rowCount: 1, rows: [] };
    },
  } as unknown as Pool;
}

async function buildApp(onVerified = async () => {}): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(
    createWebhookReceiver({
      pool: stubPool(),
      secret,
      toleranceSec: 300,
      nowSec: () => ts,
      onVerified,
    }),
  );
  await app.ready();
  return app;
}

function post(app: FastifyInstance, body: string, sig: string, deliveryId: string, timestamp = ts) {
  return app.inject({
    method: 'POST',
    url: '/webhooks/fireflies',
    headers: {
      'content-type': 'application/json',
      'x-webhook-signature': sig,
      'x-webhook-timestamp': String(timestamp),
      'x-delivery-id': deliveryId,
    },
    payload: body,
  });
}

describe('webhook receiver', () => {
  let app: FastifyInstance;
  beforeEach(async () => {
    app = await buildApp();
  });

  it('accepts a valid, fresh delivery (202)', async () => {
    const body = '{"meetingId":"m1"}';
    const res = await post(app, body, computeSignature(secret, ts, body), 'd1');
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ status: 'accepted' });
  });

  it('rejects a bad signature (401)', async () => {
    const body = '{"meetingId":"m1"}';
    const res = await post(app, body, 'deadbeef', 'd2');
    expect(res.statusCode).toBe(401);
  });

  it('rejects a stale timestamp (401)', async () => {
    const body = '{"x":1}';
    const sig = computeSignature(secret, ts - 1000, body);
    const res = await post(app, body, sig, 'd3', ts - 1000);
    expect(res.statusCode).toBe(401);
  });

  it('treats a replayed delivery id as duplicate (200)', async () => {
    const body = '{"meetingId":"m1"}';
    const sig = computeSignature(secret, ts, body);
    expect((await post(app, body, sig, 'dup')).statusCode).toBe(202);
    const second = await post(app, body, sig, 'dup');
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual({ status: 'duplicate' });
  });

  it('400s when required headers are missing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/fireflies',
      headers: { 'content-type': 'application/json' },
      payload: '{}',
    });
    expect(res.statusCode).toBe(400);
  });

  it('only calls onVerified for fresh valid deliveries', async () => {
    let calls = 0;
    const app2 = await buildApp(async () => {
      calls += 1;
    });
    const body = '{"a":1}';
    const sig = computeSignature(secret, ts, body);
    await post(app2, body, sig, 'x1');
    await post(app2, body, 'badsig', 'x2');
    expect(calls).toBe(1);
  });
});

describe('webhook receiver — fireflies mode', () => {
  const ffSecret = 'fireflies-shared-secret';

  async function buildFf(onVerified: (p: { source: string; deliveryId: string; body: unknown }) => void = () => {}) {
    const app = Fastify();
    await app.register(
      createWebhookReceiver({
        pool: stubPool(),
        secret: ffSecret,
        toleranceSec: 300,
        mode: 'fireflies',
        nowSec: () => ts,
        onVerified,
      }),
    );
    await app.ready();
    return app;
  }

  function ffSig(body: string): string {
    return 'sha256=' + createHmac('sha256', ffSecret).update(body).digest('hex');
  }

  function ffPost(app: FastifyInstance, body: string, signature?: string) {
    return app.inject({
      method: 'POST',
      url: '/webhooks/fireflies',
      headers: {
        'content-type': 'application/json',
        ...(signature !== undefined ? { 'x-hub-signature': signature } : {}),
      },
      payload: body,
    });
  }

  it('accepts a correctly signed Fireflies payload (202) and passes the meeting body through', async () => {
    let seen: { source: string; deliveryId: string; body: unknown } | null = null;
    const app = await buildFf((p) => {
      seen = p;
    });
    const body = JSON.stringify({ meetingId: 'ASxwZxCstx', eventType: 'Transcription completed' });

    const res = await ffPost(app, body, ffSig(body));
    expect(res.statusCode).toBe(202);
    expect(seen!.source).toBe('fireflies');
    expect(seen!.deliveryId).toMatch(/^ff-[0-9a-f]{32}$/);
    expect((seen!.body as { meetingId: string }).meetingId).toBe('ASxwZxCstx');
  });

  it('accepts the signature with or without the sha256= prefix', async () => {
    const app = await buildFf();
    const body = JSON.stringify({ meetingId: 'm-prefix', eventType: 'Transcription completed' });
    const bare = createHmac('sha256', ffSecret).update(body).digest('hex');
    expect((await ffPost(app, body, bare)).statusCode).toBe(202);
  });

  it('rejects a wrong signature (401) without calling onVerified', async () => {
    let calls = 0;
    const app = await buildFf(() => {
      calls += 1;
    });
    const body = JSON.stringify({ meetingId: 'm-bad' });
    const res = await ffPost(app, body, 'sha256=' + 'ab'.repeat(32));
    expect(res.statusCode).toBe(401);
    expect(calls).toBe(0);
  });

  it('400s when x-hub-signature is missing', async () => {
    const app = await buildFf();
    expect((await ffPost(app, '{}')).statusCode).toBe(400);
  });

  it('deduplicates identical deliveries by body hash (replay defence)', async () => {
    let calls = 0;
    const app = await buildFf(() => {
      calls += 1;
    });
    const body = JSON.stringify({ meetingId: 'm-replay', eventType: 'Transcription completed' });
    expect((await ffPost(app, body, ffSig(body))).statusCode).toBe(202);
    const replay = await ffPost(app, body, ffSig(body));
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual({ status: 'duplicate' });
    expect(calls).toBe(1);
  });
});
