import { config } from '../../config/index.js';
import { assertEgressAllowed, getScopedSecret, EGRESS_HOSTS } from '../../core/governance/credentials.js';
import { resilientFetch } from '../../core/net/resilientFetch.js';
import type { AgentName } from '../../core/agents/contract.js';

/**
 * Minimal Anthropic Messages client behind a port (build-order step 6).
 *
 * Anthropic is the sole LLM provider on commercial API terms (no training on
 * inputs). Every call is scoped to the calling agent: the egress host and API
 * key are resolved through the governance layer, so an agent can only reach
 * Anthropic with its own scoped credential. Consumers (extraction, board) depend
 * on the `LlmClient` interface, never the concrete adapter, so tests use a stub.
 */
export interface LlmMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface LlmRequest {
  system?: string;
  messages: LlmMessage[];
  model?: string;
  maxTokens?: number;
}

export interface LlmClient {
  /** Returns the assistant's text. `agent` drives credential/egress scoping. */
  complete(req: LlmRequest, agent: AgentName): Promise<string>;
}

const HOST = EGRESS_HOSTS.anthropic; // api.anthropic.com
const ANTHROPIC_VERSION = '2023-06-01';

export class AnthropicLlmClient implements LlmClient {
  async complete(req: LlmRequest, agent: AgentName): Promise<string> {
    assertEgressAllowed(agent, HOST);
    const apiKey = getScopedSecret(agent, 'anthropic');
    const model = req.model ?? config().anthropic.defaultModel;

    const res = await resilientFetch(`https://${HOST}/v1/messages`, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model,
        max_tokens: req.maxTokens ?? 2048,
        ...(req.system ? { system: req.system } : {}),
        messages: req.messages,
      }),
    });
    if (!res.ok) {
      throw new Error(`Anthropic request failed: ${res.status} ${res.statusText}`);
    }
    const data = (await res.json()) as { content?: { type: string; text?: string }[] };
    return (data.content ?? [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('');
  }
}

/** Deterministic stub for tests/local runs. */
export class StubLlmClient implements LlmClient {
  constructor(private readonly responder: (req: LlmRequest, agent: AgentName) => string) {}
  async complete(req: LlmRequest, agent: AgentName): Promise<string> {
    return this.responder(req, agent);
  }
}

/**
 * Extract the first top-level JSON value from model text, tolerating prose or
 * code fences around it. Throws if no JSON value is found.
 */
export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1]! : text;
  const start = candidate.search(/[[{]/);
  if (start === -1) throw new Error('no JSON value found in model output');
  const open = candidate[start]!;
  const close = open === '[' ? ']' : '}';
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < candidate.length; i++) {
    const ch = candidate[i]!;
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return JSON.parse(candidate.slice(start, i + 1));
    }
  }
  throw new Error('unbalanced JSON value in model output');
}
