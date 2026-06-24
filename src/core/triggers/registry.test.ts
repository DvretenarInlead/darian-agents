import { describe, it, expect } from 'vitest';
import { validateTriggerSpec } from './registry.js';
import { lockIdForKey } from './cronLock.js';

describe('validateTriggerSpec', () => {
  it('accepts a valid webhook spec and applies defaults', () => {
    const spec = validateTriggerSpec('webhook', { source: 'fireflies' }) as { deliveryIdHeader: string };
    expect(spec.deliveryIdHeader).toBe('x-delivery-id');
  });

  it('accepts a valid cron spec', () => {
    expect(validateTriggerSpec('cron', { expression: '*/5 * * * *' })).toMatchObject({ expression: '*/5 * * * *' });
  });

  it('rejects a malformed spec for its kind', () => {
    expect(() => validateTriggerSpec('on_demand', { nope: true })).toThrow();
  });

  it('rejects an unknown kind', () => {
    // @ts-expect-error testing runtime guard
    expect(() => validateTriggerSpec('bogus', {})).toThrow();
  });
});

describe('lockIdForKey', () => {
  it('is deterministic', () => {
    expect(lockIdForKey('job-a')).toBe(lockIdForKey('job-a'));
  });

  it('differs across keys', () => {
    expect(lockIdForKey('job-a')).not.toBe(lockIdForKey('job-b'));
  });

  it('stays within JS safe-integer range', () => {
    expect(Number.isSafeInteger(lockIdForKey('whatever-key'))).toBe(true);
  });
});
