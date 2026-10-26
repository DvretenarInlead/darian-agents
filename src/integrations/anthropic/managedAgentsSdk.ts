import Anthropic from '@anthropic-ai/sdk';
import type { BetaManagedAgentsSession } from '@anthropic-ai/sdk/resources/beta/sessions/sessions';
import { log } from '../../core/obs/logger.js';
import { EGRESS_HOSTS } from '../../core/governance/credentials.js';
import type { AgentName } from '../../core/agents/contract.js';
import { createGovernedFetch } from './governedFetch.js';
import type {
  ManagedAgentsClient,
  McCreateSessionInput,
  McSession,
  McSessionStatus,
  McToolConfirmation,
  RawSessionEvent,
} from './managedAgents.js';

/** Not a secret: the governed fetch overwrites x-api-key on every request. */
export const GOVERNED_KEY_PLACEHOLDER = 'resolved-per-request';
/** Long enough for a working session; the supervisor reconnects when the stream ends. */
export const STREAM_TIMEOUT_MS = 6 * 3600_000;

const BASE_URL = `https://${EGRESS_HOSTS.anthropic}`;

const budget = (cents: number) =>
  ({ type: 'limit', max_list_cost: { amount: String(cents), currency: 'USD' } }) as const;

function isRawEvent(x: unknown): x is RawSessionEvent {
  if (typeof x !== 'object' || x === null) return false;
  const e = x as Record<string, unknown>;
  return typeof e.id === 'string' && typeof e.type === 'string';
}

function parseCents(amount: unknown): number | null {
  if (typeof amount !== 'string' || !/^\d+$/.test(amount)) return null;
  const n = Number(amount);
  return Number.isSafeInteger(n) ? n : null;
}

function toSession(s: BetaManagedAgentsSession): McSession {
  return {
    id: s.id,
    status: s.status as McSessionStatus,
    listCostCents: parseCents(s.usage?.list_cost?.amount),
    budgetCents: parseCents(s.budget?.max_list_cost?.amount),
  };
}

/** Pass through anything with a string id + type; drop (and warn about) the rest. */
async function* onlyEvents(source: AsyncIterable<unknown>): AsyncGenerator<RawSessionEvent> {
  for await (const e of source) {
    if (isRawEvent(e)) yield e;
    else log().warn('dropping managed-agents event without string id/type');
  }
}

export class SdkManagedAgentsClient implements ManagedAgentsClient {
  private readonly client: Anthropic;

  constructor(opts: { fetchImpl?: typeof fetch; agent?: AgentName } = {}) {
    this.client = new Anthropic({
      apiKey: GOVERNED_KEY_PLACEHOLDER,
      // Explicit so a stray ANTHROPIC_BASE_URL cannot redirect traffic.
      baseURL: BASE_URL,
      fetch: createGovernedFetch(opts.agent ?? 'team_control', opts.fetchImpl),
      maxRetries: 2,
    });
  }

  async createSession(input: McCreateSessionInput): Promise<McSession> {
    const s = await this.client.beta.sessions.create({
      agent: { type: 'agent', id: input.agentId, version: input.agentVersion },
      environment_id: input.environmentId,
      vault_ids: input.vaultIds,
      title: input.title,
      metadata: input.metadata,
      budget: budget(input.budgetCents),
    });
    return toSession(s);
  }

  async retrieveSession(sessionId: string): Promise<McSession> {
    return toSession(await this.client.beta.sessions.retrieve(sessionId));
  }

  async sendUserMessage(sessionId: string, text: string): Promise<void> {
    await this.client.beta.sessions.events.send(sessionId, {
      events: [{ type: 'user.message', content: [{ type: 'text', text }] }],
    });
  }

  async sendToolConfirmation(sessionId: string, c: McToolConfirmation): Promise<void> {
    await this.client.beta.sessions.events.send(sessionId, {
      events: [
        {
          type: 'user.tool_confirmation',
          tool_use_id: c.toolUseId,
          result: c.result,
          ...(c.result === 'deny' && c.denyMessage ? { deny_message: c.denyMessage } : {}),
        },
      ],
    });
  }

  async interrupt(sessionId: string): Promise<void> {
    await this.client.beta.sessions.events.send(sessionId, { events: [{ type: 'user.interrupt' }] });
  }

  async updateBudget(sessionId: string, cents: number): Promise<McSession> {
    return toSession(await this.client.beta.sessions.update(sessionId, { budget: budget(cents) }));
  }

  listEvents(sessionId: string): AsyncIterable<RawSessionEvent> {
    return onlyEvents(this.client.beta.sessions.events.list(sessionId));
  }

  async openEventStream(sessionId: string, signal: AbortSignal): Promise<AsyncIterable<RawSessionEvent>> {
    // Awaiting resolves once the response headers arrive, i.e. the SSE connection is open.
    const stream = await this.client.beta.sessions.events.stream(sessionId, {}, { signal, timeout: STREAM_TIMEOUT_MS });
    return onlyEvents(stream);
  }
}
