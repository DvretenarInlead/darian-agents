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
/** Content blocks (Messages API shapes) — used by the tool-use loop. */
export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean };

export interface LlmMessage {
  role: 'user' | 'assistant';
  content: string | ContentBlock[];
}

export interface ToolSpec {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface LlmRequest {
  system?: string;
  messages: LlmMessage[];
  model?: string;
  maxTokens?: number;
  tools?: ToolSpec[];
}

export interface LlmTurn {
  stopReason: string | null;
  content: ContentBlock[];
}

export interface LlmClient {
  /** Returns the assistant's text. `agent` drives credential/egress scoping. */
  complete(req: LlmRequest, agent: AgentName): Promise<string>;
}

/** Extended port for agentic (tool-use) consumers; returns the raw turn. */
export interface ToolLlmClient extends LlmClient {
  completeTurn(req: LlmRequest, agent: AgentName): Promise<LlmTurn>;
}

/** Runtime check: does this LlmClient support the tool-use loop? */
export function supportsTools(llm: LlmClient): llm is ToolLlmClient {
  return typeof (llm as Partial<ToolLlmClient>).completeTurn === 'function';
}

const HOST = EGRESS_HOSTS.anthropic; // api.anthropic.com
const ANTHROPIC_VERSION = '2023-06-01';

export class AnthropicLlmClient implements ToolLlmClient {
  async completeTurn(req: LlmRequest, agent: AgentName): Promise<LlmTurn> {
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
        ...(req.tools?.length ? { tools: req.tools } : {}),
        messages: req.messages,
      }),
    });
    if (!res.ok) {
      throw new Error(`Anthropic request failed: ${res.status} ${res.statusText}`);
    }
    const data = (await res.json()) as { stop_reason?: string | null; content?: ContentBlock[] };
    return { stopReason: data.stop_reason ?? null, content: data.content ?? [] };
  }

  async complete(req: LlmRequest, agent: AgentName): Promise<string> {
    const turn = await this.completeTurn(req, agent);
    return turn.content
      .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
      .map((b) => b.text)
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
