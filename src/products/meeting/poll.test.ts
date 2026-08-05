import { describe, it, expect } from 'vitest';
import type { Pool } from 'pg';
import { pollFireflies } from './poll.js';
import { StubFirefliesClient, transcriptsToList } from '../../integrations/fireflies/client.js';
import type { EnqueueInput } from '../../core/queue/jobs.js';
import type { AuditEvent } from '../../core/audit/writer.js';

const pool = {} as Pool; // never touched — enqueue/audit are injected

const RECENT = [
  { id: 'm-new', title: 'Weekly sync', dateIso: '2026-08-05T09:00:00.000Z' },
  { id: 'm-known', title: 'Standup', dateIso: '2026-08-04T09:00:00.000Z' },
];

describe('pollFireflies', () => {
  it('enqueues unseen meetings with the shared payload shape and audits them', async () => {
    const enqueued: EnqueueInput[] = [];
    const audited: AuditEvent[] = [];

    const summary = await pollFireflies({
      pool,
      fireflies: new StubFirefliesClient({}, RECENT),
      now: () => '2026-08-05T10:00:00.000Z',
      enqueue: async (_pool, input) => {
        enqueued.push(input);
        // Simulate m-known already being in the queue (dedupe no-op).
        return input.dedupeKey === 'meeting_ingest:m-known' ? { enqueued: false, id: null } : { enqueued: true, id: 'job-1' };
      },
      audit: async (event) => {
        audited.push(event);
      },
    });

    expect(summary).toEqual({ listed: 2, enqueued: 1 });
    expect(enqueued).toHaveLength(2);
    expect(enqueued[0]).toEqual({
      kind: 'meeting_ingest',
      payload: { source: 'fireflies-poll', deliveryId: 'poll:m-new', body: { meetingId: 'm-new' } },
      dedupeKey: 'meeting_ingest:m-new',
    });
    // Only the newly enqueued meeting is audited — quiet polls stay quiet.
    expect(audited).toHaveLength(1);
    expect(audited[0]!.subjectId).toBe('m-new');
    expect(audited[0]!.eventType).toBe('ingest');
  });

  it('is a no-op on an empty listing', async () => {
    const summary = await pollFireflies({
      pool,
      fireflies: new StubFirefliesClient({}, []),
      now: () => '2026-08-05T10:00:00.000Z',
      enqueue: async () => {
        throw new Error('should not enqueue');
      },
    });
    expect(summary).toEqual({ listed: 0, enqueued: 0 });
  });
});

describe('transcriptsToList', () => {
  it('normalises rows and epoch dates', () => {
    const out = transcriptsToList({
      data: {
        transcripts: [
          { id: 'a', title: 'T', date: 1_754_000_000_000 },
          { id: 'b', title: null, date: '2026-08-01T00:00:00Z' },
          { title: 'missing id' } as never,
        ],
      },
    });
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ id: 'a', title: 'T', dateIso: new Date(1_754_000_000_000).toISOString() });
    expect(out[1]).toEqual({ id: 'b', title: null, dateIso: '2026-08-01T00:00:00Z' });
  });

  it('throws on GraphQL errors', () => {
    expect(() => transcriptsToList({ errors: [{ message: 'no access' }] })).toThrow(/no access/);
  });
});
