import { describe, it, expect } from 'vitest';
import { prescanFile, prescanRepo } from './prescan.js';
import type { IngestedFile } from './ingest.js';

const file = (path: string, content: string): IngestedFile => ({ path, content, bytes: content.length });

describe('prescanFile', () => {
  it('flags a committed private key as critical', () => {
    const f = prescanFile(file('id_rsa', '-----BEGIN RSA PRIVATE KEY-----\nabc'));
    expect(f[0]!.type).toBe('private_key');
    expect(f[0]!.severity).toBe('critical');
  });
  it('flags AWS keys and .env files', () => {
    expect(prescanFile(file('aws.txt', 'AKIAIOSFODNN7EXAMPLE')).some((x) => x.type === 'cloud_key')).toBe(true);
    expect(prescanFile(file('.env', 'X=1')).some((x) => x.type === 'env_file')).toBe(true);
    expect(prescanFile(file('config/.env.production', 'X=1')).some((x) => x.type === 'env_file')).toBe(true);
  });
  it('passes clean files', () => {
    expect(prescanFile(file('a.ts', 'export const a = 1;'))).toHaveLength(0);
  });
});

describe('prescanRepo', () => {
  it('redacts secrets out of the content sent onward and flags critical', () => {
    const result = prescanRepo([
      file('a.ts', 'const k = "sk-abcdefghijklmnopqrstuv";'),
      file('id_rsa', '-----BEGIN PRIVATE KEY-----\nz'),
    ]);
    expect(result.hasCritical).toBe(true);
    expect(result.redactedFiles[0]!.content).not.toContain('sk-abcdefghijklmnopqrstuv');
  });
});
