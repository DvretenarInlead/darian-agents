/**
 * Claude Managed Agents behind a port. The team control plane (launcher, gate,
 * supervisor) depends only on this interface; the SDK adapter lives in
 * managedAgentsSdk.ts and routes HTTP through the governance layer. Events are
 * passed through raw (id + type + whatever the API sends); parsing is the
 * consumer's job (products/team/events.ts) so new event fields never break I/O.
 */

export type McSessionStatus = 'idle' | 'running' | 'rescheduling' | 'terminated';

export interface McSession {
  id: string;
  status: McSessionStatus;
  listCostCents: number | null;
  budgetCents: number | null;
}

export interface McCreateSessionInput {
  agentId: string;
  agentVersion: number;
  environmentId: string;
  vaultIds: string[];
  budgetCents: number;
  title: string;
  metadata: Record<string, string>;
}

export interface McToolConfirmation {
  toolUseId: string; // the agent.(mcp_)tool_use EVENT id, not a toolu_ id
  result: 'allow' | 'deny';
  denyMessage: string | null; // sent only with 'deny'
}

/** A received session event: always has string id + type; everything else is opaque. */
export interface RawSessionEvent {
  id: string;
  type: string;
  processed_at?: string | null;
  session_thread_id?: string | null;
  [key: string]: unknown;
}

export interface ManagedAgentsClient {
  createSession(input: McCreateSessionInput): Promise<McSession>;
  retrieveSession(sessionId: string): Promise<McSession>;
  sendUserMessage(sessionId: string, text: string): Promise<void>;
  sendToolConfirmation(sessionId: string, c: McToolConfirmation): Promise<void>;
  interrupt(sessionId: string): Promise<void>;
  updateBudget(sessionId: string, cents: number): Promise<McSession>;
  /** Full history, oldest first (auto-paginated). */
  listEvents(sessionId: string): AsyncIterable<RawSessionEvent>;
  /** Resolves once the SSE connection is open (stream-first ordering); iterates live events until closed/aborted. */
  openEventStream(sessionId: string, signal: AbortSignal): Promise<AsyncIterable<RawSessionEvent>>;
}

export type OutboundEvent =
  | { type: 'user.message'; text: string }
  | { type: 'user.tool_confirmation'; toolUseId: string; result: 'allow' | 'deny'; denyMessage: string | null }
  | { type: 'user.interrupt' };

type Push = (e: RawSessionEvent | null) => void;

/** Deterministic in-memory twin for tests. No network, no timers. */
export class InMemoryManagedAgents implements ManagedAgentsClient {
  readonly creates: McCreateSessionInput[] = [];
  readonly sent: Array<{ sessionId: string; event: OutboundEvent }> = [];
  readonly budgetUpdates: Array<{ sessionId: string; cents: number }> = [];
  private readonly sessions = new Map<string, McSession>();
  private readonly history = new Map<string, RawSessionEvent[]>();
  private readonly subscribers = new Map<string, Set<Push>>();
  private readonly failures = new Map<keyof ManagedAgentsClient, Error>();
  private seq = 0;

  /** Make the next call to `method` throw `err` once. */
  failNext(method: keyof ManagedAgentsClient, err: Error): void {
    this.failures.set(method, err);
  }

  /** Simulate the server emitting an event. historyOnly = emitted during a stream gap. */
  emit(sessionId: string, event: RawSessionEvent, opts: { historyOnly?: boolean } = {}): void {
    this.historyOf(sessionId).push(event);
    if (!opts.historyOnly) for (const push of this.subscribers.get(sessionId) ?? []) push(event);
  }

  /** Simulate a dropped SSE connection: every open iterator for the session ends. */
  dropStreams(sessionId: string): void {
    for (const push of this.subscribers.get(sessionId) ?? []) push(null);
  }

  setSession(sessionId: string, patch: Partial<McSession>): void {
    const s = this.mustGet(sessionId);
    this.sessions.set(sessionId, { ...s, ...patch });
  }

  openStreamCount(sessionId: string): number {
    return this.subscribers.get(sessionId)?.size ?? 0;
  }

  async createSession(input: McCreateSessionInput): Promise<McSession> {
    this.maybeFail('createSession');
    this.creates.push(input);
    const s: McSession = { id: `sesn_mem_${++this.seq}`, status: 'idle', listCostCents: 0, budgetCents: input.budgetCents };
    this.sessions.set(s.id, s);
    return s;
  }
  async retrieveSession(sessionId: string): Promise<McSession> {
    this.maybeFail('retrieveSession');
    return this.mustGet(sessionId);
  }
  async sendUserMessage(sessionId: string, text: string): Promise<void> {
    this.maybeFail('sendUserMessage');
    this.mustGet(sessionId);
    this.sent.push({ sessionId, event: { type: 'user.message', text } });
  }
  async sendToolConfirmation(sessionId: string, c: McToolConfirmation): Promise<void> {
    this.maybeFail('sendToolConfirmation');
    this.mustGet(sessionId);
    this.sent.push({
      sessionId,
      event: { type: 'user.tool_confirmation', toolUseId: c.toolUseId, result: c.result, denyMessage: c.denyMessage },
    });
  }
  async interrupt(sessionId: string): Promise<void> {
    this.maybeFail('interrupt');
    this.mustGet(sessionId);
    this.sent.push({ sessionId, event: { type: 'user.interrupt' } });
  }
  async updateBudget(sessionId: string, cents: number): Promise<McSession> {
    this.maybeFail('updateBudget');
    this.budgetUpdates.push({ sessionId, cents });
    this.setSession(sessionId, { budgetCents: cents });
    return this.mustGet(sessionId);
  }
  async *listEvents(sessionId: string): AsyncIterable<RawSessionEvent> {
    this.maybeFail('listEvents');
    for (const e of [...this.historyOf(sessionId)]) yield e;
  }
  async openEventStream(sessionId: string, signal: AbortSignal): Promise<AsyncIterable<RawSessionEvent>> {
    this.maybeFail('openEventStream');
    this.mustGet(sessionId);
    const queue: Array<RawSessionEvent | null> = [];
    let wake: (() => void) | null = null;
    const push: Push = (e) => {
      queue.push(e);
      wake?.();
    };
    const subs = this.subscribers.get(sessionId) ?? new Set<Push>();
    subs.add(push);
    this.subscribers.set(sessionId, subs); // registered eagerly = stream-first
    const onAbort = () => push(null);
    signal.addEventListener('abort', onAbort, { once: true });
    const cleanup = () => {
      subs.delete(push);
      signal.removeEventListener('abort', onAbort);
    };
    return {
      async *[Symbol.asyncIterator]() {
        try {
          for (;;) {
            if (queue.length === 0) {
              await new Promise<void>((r) => {
                wake = r;
              });
            }
            wake = null;
            const e = queue.shift();
            if (e === null || e === undefined) return;
            yield e;
          }
        } finally {
          cleanup();
        }
      },
    };
  }

  private maybeFail(method: keyof ManagedAgentsClient): void {
    const err = this.failures.get(method);
    if (err) {
      this.failures.delete(method);
      throw err;
    }
  }
  private mustGet(id: string): McSession {
    const s = this.sessions.get(id);
    if (!s) throw new Error(`unknown session ${id}`);
    return s;
  }
  private historyOf(id: string): RawSessionEvent[] {
    let h = this.history.get(id);
    if (!h) {
      h = [];
      this.history.set(id, h);
    }
    return h;
  }
}
