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
