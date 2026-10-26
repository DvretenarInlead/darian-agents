import { describe, it, expect, beforeAll, vi } from 'vitest';

beforeAll(() => {
  process.env.DATABASE_URL = 'postgres://app:pw@localhost:5432/test';
  process.env.ANTHROPIC_API_KEY = 'sk-test-anthropic';
  process.env.EGRESS_ALLOWLIST = 'api.anthropic.com';
  // A stray base URL must not redirect traffic.
  process.env.ANTHROPIC_BASE_URL = 'https://evil.example.com';
});

const mod = () => import('./managedAgentsSdk.js');

interface Call {
  url: URL;
  method: string;
  headers: Headers;
  body: unknown;
  signal: AbortSignal | undefined;
}

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

const sse = (events: unknown[]) =>
  new Response(events.map((e) => `event: ${(e as { type?: string }).type ?? 'message'}\ndata: ${JSON.stringify(e)}\n\n`).join(''), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });

function fake(respond: (c: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const call: Call = {
      url,
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      signal: init?.signal ?? undefined,
    };
    calls.push(call);
    return respond(call);
  });
  return { calls, fetchImpl };
}

const session = (over: Record<string, unknown> = {}) => ({
  id: 'sesn_1',
  type: 'session',
  status: 'idle',
  budget: { type: 'limit', max_list_cost: { amount: '1000', currency: 'USD' } },
  usage: { list_cost: { amount: '1234', currency: 'USD' } },
  ...over,
});

async function client(respond: (c: Call) => Response | Promise<Response>) {
  const { SdkManagedAgentsClient } = await mod();
  const f = fake(respond);
  return { c: new SdkManagedAgentsClient({ fetchImpl: f.fetchImpl }), ...f };
}

describe('SdkManagedAgentsClient', () => {
  it('createSession sends the exact body, beta header and governed key', async () => {
    const { c, calls } = await client(() => json(session()));
    const s = await c.createSession({
      agentId: 'agent_1',
      agentVersion: 3,
      environmentId: 'env_1',
      vaultIds: ['vlt_1'],
      budgetCents: 1000,
      title: 'Run',
      metadata: { run: 'r1' },
    });
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.method).toBe('POST');
    expect(call.url.origin).toBe('https://api.anthropic.com');
    expect(call.url.pathname).toBe('/v1/sessions');
    expect(call.body).toEqual({
      agent: { type: 'agent', id: 'agent_1', version: 3 },
      environment_id: 'env_1',
      vault_ids: ['vlt_1'],
      title: 'Run',
      metadata: { run: 'r1' },
      budget: { type: 'limit', max_list_cost: { amount: '1000', currency: 'USD' } },
    });
    expect(call.headers.get('x-api-key')).toBe('sk-test-anthropic');
    expect(call.headers.has('authorization')).toBe(false);
    expect(call.headers.get('anthropic-beta')).toContain('managed-agents-2026-04-01');
    expect(s).toEqual({ id: 'sesn_1', status: 'idle', listCostCents: 1234, budgetCents: 1000 });
  });

  it('retrieveSession maps usage.list_cost.amount and tolerates its absence', async () => {
    const { c, calls } = await client(() => json(session()));
    expect(await c.retrieveSession('sesn_1')).toMatchObject({ listCostCents: 1234, budgetCents: 1000 });
    expect(calls[0]!.method).toBe('GET');
    expect(calls[0]!.url.pathname).toBe('/v1/sessions/sesn_1');

    const bare = await client(() => json(session({ usage: {}, budget: null })));
    expect(await bare.c.retrieveSession('sesn_1')).toMatchObject({ listCostCents: null, budgetCents: null });
  });

  it('sendUserMessage posts a user.message event', async () => {
    const { c, calls } = await client(() => json({}));
    await c.sendUserMessage('sesn_1', 'hello');
    expect(calls[0]!.url.pathname).toBe('/v1/sessions/sesn_1/events');
    expect(calls[0]!.body).toEqual({ events: [{ type: 'user.message', content: [{ type: 'text', text: 'hello' }] }] });
  });

  it('sendToolConfirmation omits deny_message for allow and includes it for deny', async () => {
    const { c, calls } = await client(() => json({}));
    await c.sendToolConfirmation('sesn_1', { toolUseId: 'sevt_9', result: 'allow', denyMessage: 'ignored' });
    await c.sendToolConfirmation('sesn_1', { toolUseId: 'sevt_9', result: 'deny', denyMessage: 'not now' });
    await c.sendToolConfirmation('sesn_1', { toolUseId: 'sevt_9', result: 'deny', denyMessage: null });
    expect(calls[0]!.body).toEqual({ events: [{ type: 'user.tool_confirmation', tool_use_id: 'sevt_9', result: 'allow' }] });
    expect(calls[1]!.body).toEqual({
      events: [{ type: 'user.tool_confirmation', tool_use_id: 'sevt_9', result: 'deny', deny_message: 'not now' }],
    });
    expect(calls[2]!.body).toEqual({ events: [{ type: 'user.tool_confirmation', tool_use_id: 'sevt_9', result: 'deny' }] });
  });

  it('interrupt posts a user.interrupt event', async () => {
    const { c, calls } = await client(() => json({}));
    await c.interrupt('sesn_1');
    expect(calls[0]!.body).toEqual({ events: [{ type: 'user.interrupt' }] });
  });

  it('updateBudget posts only the budget', async () => {
    const { c, calls } = await client(() => json(session({ budget: { type: 'limit', max_list_cost: { amount: '2500', currency: 'USD' } } })));
    const s = await c.updateBudget('sesn_1', 2500);
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.url.pathname).toBe('/v1/sessions/sesn_1');
    expect(calls[0]!.body).toEqual({ budget: { type: 'limit', max_list_cost: { amount: '2500', currency: 'USD' } } });
    expect(s.budgetCents).toBe(2500);
  });

  it('listEvents follows pagination and drops malformed items', async () => {
    const { c, calls } = await client((call) =>
      call.url.searchParams.get('page') === 'tok2'
        ? json({ data: [{ id: 'e3', type: 'agent.message' }], next_page: null })
        : json({
            data: [{ id: 'e1', type: 'user.message' }, { type: 'no-id' }, null, { id: 5, type: 'x' }, { id: 'e2', type: 'agent.tool_use', extra: 1 }],
            next_page: 'tok2',
          }),
    );
    const out = [];
    for await (const e of c.listEvents('sesn_1')) out.push(e);
    expect(out.map((e) => e.id)).toEqual(['e1', 'e2', 'e3']);
    expect(out[1]).toMatchObject({ extra: 1 });
    expect(calls).toHaveLength(2);
    expect(calls[0]!.url.pathname).toBe('/v1/sessions/sesn_1/events');
    expect(calls[1]!.url.searchParams.get('page')).toBe('tok2');
  });

  it('openEventStream yields parsed SSE events and ends when the body ends', async () => {
    const { c, calls } = await client(() =>
      sse([{ id: 'e1', type: 'agent.message' }, { type: 'bad' }, { id: 'e2', type: 'session.status_idle' }]),
    );
    const stream = await c.openEventStream('sesn_1', new AbortController().signal);
    const out = [];
    for await (const e of stream) out.push(e);
    expect(out.map((e) => e.id)).toEqual(['e1', 'e2']);
    expect(calls[0]!.url.pathname).toBe('/v1/sessions/sesn_1/events/stream');
    expect(calls[0]!.headers.get('x-api-key')).toBe('sk-test-anthropic');
  });

  it('openEventStream ends cleanly when the signal aborts', async () => {
    const enc = new TextEncoder();
    const { c } = await client(
      (call) =>
        new Response(
          new ReadableStream({
            start(ctrl) {
              ctrl.enqueue(enc.encode(`event: agent.message\ndata: ${JSON.stringify({ id: 'e1', type: 'agent.message' })}\n\n`));
              // never closes on its own: like real fetch, only the abort ends it
              call.signal?.addEventListener('abort', () => ctrl.error(new DOMException('aborted', 'AbortError')));
            },
          }),
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        ),
    );
    const ac = new AbortController();
    const stream = await c.openEventStream('sesn_1', ac.signal);
    const out: string[] = [];
    for await (const e of stream) {
      out.push(e.id);
      ac.abort();
    }
    expect(out).toEqual(['e1']);
  });

  it('never talks to a host other than api.anthropic.com despite ANTHROPIC_BASE_URL', async () => {
    const { c, calls } = await client(() => json(session()));
    await c.retrieveSession('sesn_1');
    expect(calls[0]!.url.hostname).toBe('api.anthropic.com');
  });
});
