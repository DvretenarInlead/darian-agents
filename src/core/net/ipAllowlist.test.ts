import { describe, it, expect } from 'vitest';
import { ipToBigInt, isIpAllowed, parseAllowlist } from './ipAllowlist.js';

describe('ipToBigInt', () => {
  it('maps IPv4 and its v4-mapped IPv6 form to the same value', () => {
    expect(ipToBigInt('192.168.1.10')).toBe(ipToBigInt('::ffff:192.168.1.10'));
  });

  it('parses compressed IPv6', () => {
    expect(ipToBigInt('::1')).toBe(1n);
    expect(ipToBigInt('2001:db8::1')).toBe((0x2001_0db8n << 96n) | 1n);
  });

  it('ignores IPv6 zone suffixes', () => {
    expect(ipToBigInt('fe80::1%eth0')).toBe(ipToBigInt('fe80::1'));
  });

  it('rejects garbage', () => {
    expect(ipToBigInt('not-an-ip')).toBeNull();
    expect(ipToBigInt('1.2.3.999')).toBeNull();
    expect(ipToBigInt('1.2.3')).toBeNull();
    expect(ipToBigInt('::1::2')).toBeNull();
    expect(ipToBigInt('12345::')).toBeNull();
  });
});

describe('parseAllowlist / isIpAllowed', () => {
  it('matches exact IPv4 entries, including v4-mapped clients', () => {
    const list = parseAllowlist(['203.0.113.7']);
    expect(isIpAllowed('203.0.113.7', list)).toBe(true);
    expect(isIpAllowed('::ffff:203.0.113.7', list)).toBe(true);
    expect(isIpAllowed('203.0.113.8', list)).toBe(false);
  });

  it('matches IPv4 CIDR ranges', () => {
    const list = parseAllowlist(['10.0.0.0/8']);
    expect(isIpAllowed('10.255.1.2', list)).toBe(true);
    expect(isIpAllowed('11.0.0.1', list)).toBe(false);
    // A raw IPv6 address must not fall into a v4 range.
    expect(isIpAllowed('2001:db8::1', list)).toBe(false);
  });

  it('matches IPv6 exact and CIDR entries', () => {
    const list = parseAllowlist(['2001:db8::/48', '::1']);
    expect(isIpAllowed('2001:db8:0:ffff::9', list)).toBe(true);
    expect(isIpAllowed('2001:db9::1', list)).toBe(false);
    expect(isIpAllowed('::1', list)).toBe(true);
  });

  it('denies everything on an empty allowlist', () => {
    expect(isIpAllowed('127.0.0.1', [])).toBe(false);
  });

  it('denies unparseable client IPs', () => {
    const list = parseAllowlist(['0.0.0.0/0']);
    expect(isIpAllowed('garbage', list)).toBe(false);
  });

  it('throws at parse time on malformed entries', () => {
    expect(() => parseAllowlist(['nope'])).toThrow(/invalid IP allowlist entry/);
    expect(() => parseAllowlist(['10.0.0.0/33'])).toThrow(/invalid CIDR prefix/);
    expect(() => parseAllowlist(['2001:db8::/129'])).toThrow(/invalid CIDR prefix/);
    expect(() => parseAllowlist(['10.0.0.0/8/2'])).toThrow(/invalid IP allowlist entry/);
    expect(() => parseAllowlist(['/8'])).toThrow(/invalid IP allowlist entry/);
  });
});
