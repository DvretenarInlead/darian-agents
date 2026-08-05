import { Pool, type PoolConfig } from 'pg';
import { config } from '../../config/index.js';

/**
 * Single shared pg Pool. The app connects with the least-privilege `app_rw`
 * role (see migrations/0001_init.sql) which has no UPDATE/DELETE on audit_log.
 */
let pool: Pool | undefined;

/**
 * TLS config for managed Postgres (e.g. DO). Managed clusters present a cert
 * signed by the provider's own CA, which Node does not trust by default —
 * strict verification fails with SELF_SIGNED_CERT_IN_CHAIN. Precedence:
 *
 *  - CA cert provided (PEM, or base64-of-PEM to survive env-var storage):
 *    full verification against that CA — the strong setting; download the CA
 *    from the DO database cluster's Overview page.
 *  - No CA cert: encrypted but unverified (rejectUnauthorized: false). On App
 *    Platform traffic stays on DO's private network, but set DATABASE_CA_CERT
 *    to close the MITM gap.
 */
/**
 * Strip TLS-related query params (sslmode & friends) from a connection string.
 * node-postgres merges the parsed connection string OVER the explicit config
 * (`Object.assign({}, config, parse(connectionString))`), so a DO-style
 * `?sslmode=require` silently clobbers our `ssl` option — and pg ≥8.22 treats
 * `require` as verify-full, which the DO CA fails. Removing the params makes
 * sslConfig() the single source of truth. Non-URL (key=value) strings are
 * returned untouched.
 */
export function stripSslParams(connectionString: string): string {
  try {
    const url = new URL(connectionString);
    for (const p of ['ssl', 'sslmode', 'sslcert', 'sslkey', 'sslrootcert', 'sslpassword', 'sslnegotiation', 'uselibpqcompat']) {
      url.searchParams.delete(p);
    }
    return url.toString();
  } catch {
    return connectionString;
  }
}

export function sslConfig(ssl: boolean, caCert?: string): PoolConfig['ssl'] {
  if (!ssl) return false;
  if (!caCert) return { rejectUnauthorized: false };
  const pem = caCert.includes('-----BEGIN')
    ? caCert
    : Buffer.from(caCert, 'base64').toString('utf8');
  return { ca: pem, rejectUnauthorized: true };
}

export function getPool(): Pool {
  if (!pool) {
    const cfg = config();
    const poolConfig: PoolConfig = {
      connectionString: stripSslParams(cfg.db.url),
      ssl: sslConfig(cfg.db.ssl, cfg.db.caCert),
      // Per-instance cap. Across N web + M worker instances the total must stay
      // under the Postgres max_connections — front the DB with PgBouncer
      // (transaction mode) for horizontal scale. See docs/ARCHITECTURE.md.
      max: cfg.db.poolMax,
    };
    pool = new Pool(poolConfig);
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}
