import { describe, it, expect } from 'vitest';
import { hibpHashParts, suffixBreachCount, breachCount } from './hibp.js';

describe('hibpHashParts', () => {
  it('splits the SHA-1 into a 5-char prefix and 35-char suffix', () => {
    // SHA1("password") = 5BAA61E4C9B93F3F0682250B6CF8331B7EE68FD8
    const parts = hibpHashParts('password');
    expect(parts.prefix).toBe('5BAA6');
    expect(parts.suffix).toBe('1E4C9B93F3F0682250B6CF8331B7EE68FD8');
    expect(parts.prefix.length).toBe(5);
    expect(parts.suffix.length).toBe(35);
  });
});

describe('suffixBreachCount', () => {
  const body = '1E4C9B93F3F0682250B6CF8331B7EE68FD8:99\r\nFFFF:3';
  it('returns the count for a matching suffix', () => {
    expect(suffixBreachCount(body, '1E4C9B93F3F0682250B6CF8331B7EE68FD8')).toBe(99);
  });
  it('returns 0 when not present', () => {
    expect(suffixBreachCount(body, 'ABCDEF')).toBe(0);
  });
});

describe('breachCount', () => {
  it('uses only the prefix with the fetcher and matches locally', async () => {
    let sentPrefix = '';
    const count = await breachCount('password', async (prefix) => {
      sentPrefix = prefix;
      return '1E4C9B93F3F0682250B6CF8331B7EE68FD8:42';
    });
    expect(sentPrefix).toBe('5BAA6'); // never sends the full hash
    expect(count).toBe(42);
  });
});
