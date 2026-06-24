import type { Pool } from 'pg';

/**
 * Webhook replay/idempotency dedupe (brief §1).
 *
 * Records each provider delivery ID exactly once. The PRIMARY KEY on
 * webhook_deliveries.delivery_id + ON CONFLICT DO NOTHING makes this atomic: the
 * first insert wins (firstDelivery=true) and any re-fire of the same captured
 * webhook is a no-op (firstDelivery=false), so the worker never processes a
 * replay even under concurrent receipt.
 */

export interface DeliveryRecord {
  deliveryId: string;
  meetingId: string | null;
  signatureOk: boolean;
  tsInWindow: boolean;
}

export interface DedupeResult {
  firstDelivery: boolean;
}

export async function recordDelivery(pool: Pool, record: DeliveryRecord): Promise<DedupeResult> {
  const res = await pool.query(
    `INSERT INTO webhook_deliveries (delivery_id, meeting_id, signature_ok, ts_in_window)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (delivery_id) DO NOTHING`,
    [record.deliveryId, record.meetingId, record.signatureOk, record.tsInWindow],
  );
  return { firstDelivery: res.rowCount === 1 };
}
