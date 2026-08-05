import { describe, it, expect } from 'vitest';
import { sslConfig } from './index.js';

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
