import { randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Double-submit CSRF tokens (build-order step 7) for every state-changing
 * console route. The token is set as a cookie and echoed in a header/body; a
 * request is valid only when the two match (constant-time). Pure + testable.
 */

export function generateCsrfToken(): string {
  return randomBytes(32).toString('base64url');
}

export function verifyCsrf(cookieToken: string | undefined, submittedToken: string | undefined): boolean {
  if (!cookieToken || !submittedToken) return false;
  const a = Buffer.from(cookieToken);
  const b = Buffer.from(submittedToken);
  if (a.length !== b.length || a.length === 0) return false;
  return timingSafeEqual(a, b);
}
