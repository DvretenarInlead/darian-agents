import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { log } from '../obs/logger.js';

/**
 * Minimal MCP client over stdio (newline-delimited JSON-RPC 2.0) for official
 * vendor MCP servers we run as managed subprocesses (first: @hubspot/mcp-server,
 * which authenticates headlessly with a private-app token — the remote
 * mcp.hubspot.com endpoint is OAuth-PKCE-only and unusable server-side).
 *
 * Lazy lifecycle: the child is spawned on first call, the initialize handshake
 * is performed once, and a crash rejects in-flight calls and clears state so
 * the next call respawns. Every call has a hard timeout.
 */

export interface McpStdioOptions {
  command: string;
  args: string[];
  /** Extra environment (e.g. the provider token). Merged over process.env. */
  env?: Record<string, string>;
  /** Display name for logs. */
  name?: string;
  callTimeoutMs?: number;
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

interface JsonRpcResponse {
  id?: number;
  result?: unknown;
  error?: { code: number; message: string };
}

export class McpStdioClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private buffer = '';
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private initializing: Promise<void> | null = null;

  constructor(private readonly opts: McpStdioOptions) {}

  private label(): string {
    return this.opts.name ?? this.opts.command;
  }

  private async ensureStarted(): Promise<void> {
    if (this.child) return this.initializing ?? Promise.resolve();
    const child = spawn(this.opts.command, this.opts.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...this.opts.env },
    });
    this.child = child;

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.onData(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      const line = chunk.trim();
      if (line) log().debug({ mcp: this.label(), stderr: line.slice(0, 500) }, 'mcp subprocess stderr');
    });
    child.on('exit', (code) => {
      log().warn({ mcp: this.label(), code }, 'mcp subprocess exited');
      const err = new Error(`${this.label()} exited (code ${code})`);
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(err);
      }
      this.pending.clear();
      this.child = null;
      this.initializing = null;
    });

    this.initializing = (async () => {
      await this.request('initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'darian-agents', version: '1.0.0' },
      });
      this.notify('notifications/initialized');
    })();
    return this.initializing;
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let msg: JsonRpcResponse;
      try {
        msg = JSON.parse(line) as JsonRpcResponse;
      } catch {
        continue; // non-JSON noise on stdout
      }
      if (typeof msg.id !== 'number') continue; // server notification — ignore
      const pending = this.pending.get(msg.id);
      if (!pending) continue;
      this.pending.delete(msg.id);
      clearTimeout(pending.timer);
      if (msg.error) pending.reject(new Error(`${this.label()}: ${msg.error.message}`));
      else pending.resolve(msg.result);
    }
  }

  private send(payload: Record<string, unknown>): void {
    if (!this.child?.stdin.writable) throw new Error(`${this.label()} is not running`);
    this.child.stdin.write(JSON.stringify(payload) + '\n');
  }

  private notify(method: string, params?: Record<string, unknown>): void {
    this.send({ jsonrpc: '2.0', method, ...(params ? { params } : {}) });
  }

  private request(method: string, params?: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId++;
    const timeoutMs = this.opts.callTimeoutMs ?? 30_000;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${this.label()}: ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.send({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) });
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(err as Error);
      }
    });
  }

  /**
   * Call an MCP tool and return its text payload. Tool-level failures
   * (isError) throw with the server's message.
   */
  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    await this.ensureStarted();
    const result = (await this.request('tools/call', { name, arguments: args })) as {
      isError?: boolean;
      content?: Array<{ type: string; text?: string }>;
    };
    const text = (result.content ?? [])
      .filter((c) => c.type === 'text')
      .map((c) => c.text ?? '')
      .join('\n');
    if (result.isError) throw new Error(`${this.label()} tool ${name} failed: ${text.slice(0, 500)}`);
    return text;
  }

  stop(): void {
    this.child?.kill();
    this.child = null;
    this.initializing = null;
  }
}
