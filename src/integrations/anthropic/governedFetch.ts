import { assertEgressAllowed, getScopedSecret, EgressDeniedError } from '../../core/governance/credentials.js';
import type { AgentName } from '../../core/agents/contract.js';

/**
 * A fetch that can only reach hosts the agent is scoped to, with the Anthropic
 * key resolved per request instead of living on the SDK object. Deliberately not
 * built on resilientFetch: its hard timeout would kill long-lived SSE streams,
 * and the SDK already retries 408/409/429/5xx itself.
 */
export function createGovernedFetch(agent: AgentName, inner: typeof fetch = fetch): typeof fetch {
  return async (input, init) => {
    const url = parseUrl(input);
    if (url.protocol !== 'https:') throw new EgressDeniedError(`refusing non-https request to ${url.hostname}`);
    if (url.port !== '') throw new EgressDeniedError(`refusing request to ${url.hostname} on a non-default port`);
    assertEgressAllowed(agent, url.hostname);

    // Request-carried headers first so init headers win, as with fetch.
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
    headers.set('x-api-key', getScopedSecret(agent, 'anthropic'));
    headers.delete('authorization');

    return inner(input, { ...init, headers });
  };
}

function parseUrl(input: string | URL | Request): URL {
  const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  try {
    return new URL(raw);
  } catch {
    throw new EgressDeniedError('refusing request with an unparseable URL');
  }
}
