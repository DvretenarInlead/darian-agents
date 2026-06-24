import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Pool } from 'pg';
import { INTEGRATION_URL, makeTestPool, resetAndMigrate } from './itestDb.js';
import { appendAuditBatch } from '../core/audit/writer.js';
import { verifyChain, type AuditEntryInput } from '../core/audit/hashChain.js';
import { reconcileItems } from '../products/meeting/reconcile.js';
import type { ActionItem } from '../products/meeting/extract.js';
import { enqueueJob, claimJob, completeJob, failJob } from '../core/queue/jobs.js';
import { recordDelivery } from '../core/triggers/dedupe.js';
import { withCronLock } from '../core/triggers/cronLock.js';
import { recordSodAction, assertApprovalAllowed, SeparationOfDutiesError } from '../console/rbac/sod.js';
import { setKillSwitch, isEngaged } from '../console/killswitch.js';
import { PgRateLimiter } from '../core/triggers/pgRateLimiter.js';

// Skipped unless a real Postgres is provided (CI service container).
const d = INTEGRATION_URL ? describe : describe.skip;

const NOW = '2026-06-24T00:00:00.000Z';
const item = (title: string): ActionItem => ({
  title,
  description: null,
  owner_hint: null,
  due_hint: null,
  source_quote: `${title} said`,
  confidence: 0.9,
});

d('Postgres integration', () => {
  let pool: Pool;
  beforeAll(async () => {
    pool = makeTestPool();
    await resetAndMigrate(pool);
  });
  afterAll(async () => {
    await pool.end();
  });

  it('audit log: batched append produces a verifiable hash chain', async () => {
    await appendAuditBatch(
      pool,
      [
        { eventType: 'ingest', product: 'meeting', actorId: null, subjectId: 's1', payload: { a: 1 } },
        { eventType: 'verdict', product: 'meeting', actorId: null, subjectId: 's1', payload: { b: 2 } },
      ],
      NOW,
    );
    const { rows } = await pool.query<{
      event_type: string;
      product: string | null;
      actor_id: string | null;
      subject_id: string | null;
      payload: unknown;
      prev_hash: string | null;
      row_hash: string;
    }>('SELECT event_type, product, actor_id, subject_id, payload, prev_hash, row_hash FROM audit_log ORDER BY id');
    const chain = rows.map((r) => ({
      eventType: r.event_type,
      product: r.product,
      actorId: r.actor_id,
      subjectId: r.subject_id,
      payload: r.payload,
      createdAt: NOW,
      prevHash: r.prev_hash,
      rowHash: r.row_hash,
    })) as Array<AuditEntryInput & { prevHash: string | null; rowHash: string }>;
    expect(verifyChain(chain)).toEqual({ valid: true, brokenAt: -1 });
  });

  it('reconciliation: first sighting created, repeat skipped', async () => {
    const first = await reconcileItems(pool, 'm1', [item('Ship it'), item('Ship it')]);
    expect(first.map((r) => r.decision)).toEqual(['created', 'skipped_duplicate']); // intra-batch dedupe
    const second = await reconcileItems(pool, 'm1', [item('Ship it')]);
    expect(second[0]!.decision).toBe('skipped_duplicate'); // cross-run dedupe
  });

  it('job queue: enqueue is idempotent; claim/complete and retry work', async () => {
    const a = await enqueueJob(pool, { kind: 'meeting_ingest', payload: { x: 1 }, dedupeKey: 'k1' });
    const b = await enqueueJob(pool, { kind: 'meeting_ingest', payload: { x: 1 }, dedupeKey: 'k1' });
    expect(a.enqueued).toBe(true);
    expect(b.enqueued).toBe(false); // idempotent on dedupe key

    const claimed = await claimJob(pool);
    expect(claimed?.kind).toBe('meeting_ingest');
    expect(claimed!.attempts).toBe(1);
    // A second claim finds nothing else runnable.
    expect(await claimJob(pool)).toBeNull();
    await completeJob(pool, claimed!.id);

    // Failed job with a future backoff is not immediately re-claimable.
    const j2 = await enqueueJob(pool, { kind: 'repo_score', payload: {}, maxAttempts: 2 });
    const c2 = await claimJob(pool);
    await failJob(pool, c2!, 'boom', 3600);
    expect(await claimJob(pool)).toBeNull();
    void j2;
  });

  it('webhook dedupe: first delivery wins, replay is a no-op', async () => {
    const r1 = await recordDelivery(pool, { deliveryId: 'd1', meetingId: 'm', signatureOk: true, tsInWindow: true });
    const r2 = await recordDelivery(pool, { deliveryId: 'd1', meetingId: 'm', signatureOk: true, tsInWindow: true });
    expect(r1.firstDelivery).toBe(true);
    expect(r2.firstDelivery).toBe(false);
  });

  it('cron lock: only one holder runs concurrently', async () => {
    let inner: { ran: boolean } = { ran: false };
    const outer = await withCronLock(pool, 'job-x', async () => {
      inner = await withCronLock(pool, 'job-x', async () => 'second');
      return 'first';
    });
    expect(outer.ran).toBe(true);
    expect(inner.ran).toBe(false); // re-entrant claim while held is skipped
  });

  it('separation of duties: configurer cannot self-approve', async () => {
    const me = (await pool.query<{ id: string }>(`INSERT INTO users (email, password_hash) VALUES ('sod@x.com','h') RETURNING id`)).rows[0]!.id;
    await recordSodAction(pool, { subjectId: 'agent-7', action: 'configured', actorId: me });
    await expect(assertApprovalAllowed(pool, me, 'agent-7')).rejects.toThrow(SeparationOfDutiesError);
    // A different user may approve.
    const other = (await pool.query<{ id: string }>(`INSERT INTO users (email, password_hash) VALUES ('other@x.com','h') RETURNING id`)).rows[0]!.id;
    await expect(assertApprovalAllowed(pool, other, 'agent-7')).resolves.toBeUndefined();
  });

  it('kill switch: set and read shared flag', async () => {
    expect(await isEngaged(pool)).toBe(false);
    await setKillSwitch(pool, true, null);
    expect(await isEngaged(pool)).toBe(true);
    await setKillSwitch(pool, false, null);
    expect(await isEngaged(pool)).toBe(false);
  });

  it('pg rate limiter: allows up to max then denies within a window', async () => {
    const rl = new PgRateLimiter(pool, { windowMs: 60_000, max: 2 });
    expect((await rl.consume(['ip:9'], 1000)).allowed).toBe(true);
    expect((await rl.consume(['ip:9'], 1100)).allowed).toBe(true);
    expect((await rl.consume(['ip:9'], 1200)).allowed).toBe(false);
    // New window resets.
    expect((await rl.consume(['ip:9'], 61_001)).allowed).toBe(true);
  });
});
