/**
 * IP allowlist matching (deny-by-default) for operator-facing surfaces.
 *
 * Entries are exact IPs or CIDR ranges, IPv4 or IPv6 (e.g. "203.0.113.7",
 * "10.0.0.0/8", "2001:db8::/48"). Everything is compared in the 128-bit IPv6
 * space with IPv4 mapped to ::ffff:a.b.c.d, so a client that Node reports in
 * v4-mapped form still matches its IPv4 allowlist entry.
 *
 * parseAllowlist() throws on a malformed entry so a bad config fails at boot,
 * never silently at request time. An empty allowlist matches nothing.
 */

const MAX128 = (1n << 128n) - 1n;
const V4_MAPPED_PREFIX = 0xffffn << 32n;

function ipv4ToBigInt(ip: string): bigint | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let value = 0n;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = (value << 8n) | BigInt(octet);
  }
  return value;
}

function ipv6ToBigInt(ip: string): bigint | null {
  let s = ip;
  // Rewrite an embedded IPv4 tail (e.g. ::ffff:1.2.3.4) as two hextets.
  const v4Tail = s.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (v4Tail) {
    const v4 = ipv4ToBigInt(v4Tail[2]!);
    if (v4 === null) return null;
    s = `${v4Tail[1]}${(v4 >> 16n).toString(16)}:${(v4 & 0xffffn).toString(16)}`;
  }

  const halves = s.split('::');
  if (halves.length > 2) return null;
  const parseGroups = (part: string): bigint[] | null => {
    if (part === '') return [];
    const out: bigint[] = [];
    for (const group of part.split(':')) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
      out.push(BigInt(parseInt(group, 16)));
    }
    return out;
  };

  let groups: bigint[];
  if (halves.length === 2) {
    const left = parseGroups(halves[0]!);
    const right = parseGroups(halves[1]!);
    if (!left || !right || left.length + right.length > 7) return null;
    groups = [...left, ...Array<bigint>(8 - left.length - right.length).fill(0n), ...right];
  } else {
    const all = parseGroups(s);
    if (!all || all.length !== 8) return null;
    groups = all;
  }
  return groups.reduce((acc, g) => (acc << 16n) | g, 0n);
}

/** Parse an IP (v4 or v6, optional %zone) into the unified 128-bit space. */
export function ipToBigInt(ip: string): bigint | null {
  const zoneless = ip.split('%')[0]!.trim();
  if (zoneless.includes(':')) return ipv6ToBigInt(zoneless);
  const v4 = ipv4ToBigInt(zoneless);
  return v4 === null ? null : V4_MAPPED_PREFIX | v4;
}

export interface IpMatcher {
  base: bigint;
  mask: bigint;
}

/** Parse allowlist entries (IP or CIDR). Throws on any malformed entry. */
export function parseAllowlist(entries: string[]): IpMatcher[] {
  return entries.map((raw) => {
    const entry = raw.trim();
    const slash = entry.split('/');
    if (slash.length > 2 || slash[0] === '') {
      throw new Error(`invalid IP allowlist entry: '${raw}'`);
    }
    const ipPart = slash[0]!;
    const isV4 = !ipPart.includes(':');
    const value = ipToBigInt(ipPart);
    if (value === null) {
      throw new Error(`invalid IP allowlist entry: '${raw}'`);
    }

    let prefix = 128;
    if (slash.length === 2) {
      const bits = Number(slash[1]);
      const maxBits = isV4 ? 32 : 128;
      if (!/^\d+$/.test(slash[1]!) || bits > maxBits) {
        throw new Error(`invalid CIDR prefix in allowlist entry: '${raw}'`);
      }
      // IPv4 prefixes shift into the v4-mapped tail of the 128-bit space.
      prefix = isV4 ? bits + 96 : bits;
    }

    const mask = prefix === 0 ? 0n : (~0n << BigInt(128 - prefix)) & MAX128;
    return { base: value & mask, mask };
  });
}

/** Deny-by-default: false for an empty allowlist or an unparseable client IP. */
export function isIpAllowed(ip: string, matchers: IpMatcher[]): boolean {
  const value = ipToBigInt(ip);
  if (value === null) return false;
  return matchers.some((m) => (value & m.mask) === m.base);
}
