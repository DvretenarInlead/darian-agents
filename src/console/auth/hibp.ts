import { createHash } from 'node:crypto';

/**
 * HaveIBeenPwned k-anonymity breach check (build-order step 7).
 *
 * Only the first 5 hex chars of the SHA-1 are ever sent to the API; the rest is
 * matched locally against the returned suffix list, so the full password hash
 * never leaves the process. The hashing/splitting (`hibpHashParts`) and the
 * suffix-list parsing (`isSuffixBreached`) are pure and tested; the network call
 * is isolated in `breachCount` behind an injectable fetcher.
 */

export interface HibpHashParts {
  prefix: string; // first 5 hex chars (uppercase)
  suffix: string; // remaining 35 hex chars (uppercase)
}

export function hibpHashParts(password: string): HibpHashParts {
  const sha1 = createHash('sha1').update(password).digest('hex').toUpperCase();
  return { prefix: sha1.slice(0, 5), suffix: sha1.slice(5) };
}

/** Parse the API's "SUFFIX:count" lines and return the count for our suffix. */
export function suffixBreachCount(responseBody: string, suffix: string): number {
  for (const line of responseBody.split(/\r?\n/)) {
    const [hashSuffix, count] = line.split(':');
    if (hashSuffix && hashSuffix.toUpperCase() === suffix) {
      return Number(count) || 0;
    }
  }
  return 0;
}

export type RangeFetcher = (prefix: string) => Promise<string>;

/** Default fetcher hitting the public range API (text body of suffix:count). */
export const defaultRangeFetcher: RangeFetcher = async (prefix) => {
  const res = await fetch(`https://api.pwnedpasswords.com/range/${prefix}`, {
    headers: { 'add-padding': 'true' },
  });
  if (!res.ok) throw new Error(`HIBP range query failed: ${res.status}`);
  return res.text();
};

/** Number of times the password appears in breach corpora (0 = not found). */
export async function breachCount(password: string, fetcher: RangeFetcher = defaultRangeFetcher): Promise<number> {
  const { prefix, suffix } = hibpHashParts(password);
  const body = await fetcher(prefix);
  return suffixBreachCount(body, suffix);
}
