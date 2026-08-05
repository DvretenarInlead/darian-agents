import { describe, it, expect } from 'vitest';
import { sslConfig, stripSslParams } from './index.js';

const PEM = '-----BEGIN CERTIFICATE-----\nMIIBfake\n-----END CERTIFICATE-----\n';

describe('sslConfig', () => {
  it('disables TLS when ssl=false', () => {
    expect(sslConfig(false)).toBe(false);
    expect(sslConfig(false, PEM)).toBe(false);
  });

  it('encrypts without verification when no CA is provided', () => {
    expect(sslConfig(true)).toEqual({ rejectUnauthorized: false });
  });

  it('fully verifies against a provided PEM CA', () => {
    expect(sslConfig(true, PEM)).toEqual({ ca: PEM, rejectUnauthorized: true });
  });

  it('accepts a base64-encoded PEM (env-var friendly)', () => {
    const b64 = Buffer.from(PEM, 'utf8').toString('base64');
    expect(sslConfig(true, b64)).toEqual({ ca: PEM, rejectUnauthorized: true });
  });
});

describe('stripSslParams', () => {
  it('removes sslmode so it cannot clobber the explicit ssl option', () => {
    const out = stripSslParams('postgresql://u:p@host.db.ondigitalocean.com:25060/db?sslmode=require');
    expect(out).not.toContain('sslmode');
    expect(out).toContain('host.db.ondigitalocean.com:25060/db');
    expect(out).toContain('u:p@');
  });

  it('removes all TLS params but keeps unrelated ones', () => {
    const out = stripSslParams('postgres://u@h/db?sslmode=require&sslrootcert=/x.pem&application_name=darian');
    expect(out).not.toContain('sslmode');
    expect(out).not.toContain('sslrootcert');
    expect(out).toContain('application_name=darian');
  });

  it('leaves URLs without TLS params unchanged', () => {
    expect(stripSslParams('postgres://u:p@localhost:5432/darian_agents')).toBe(
      'postgres://u:p@localhost:5432/darian_agents',
    );
  });

  it('returns non-URL (key=value) connection strings untouched', () => {
    const kv = 'host=localhost port=5432 dbname=darian sslmode=require';
    expect(stripSslParams(kv)).toBe(kv);
  });
});
