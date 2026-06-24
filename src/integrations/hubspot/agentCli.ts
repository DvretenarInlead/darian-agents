import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { renderPreview, type HubSpotClient } from './client.js';
import type { OwnerQuery, OwnerRef, SyncPlan, SyncPreview, SyncResult } from './types.js';

const execFileAsync = promisify(execFile);

/**
 * HubSpot Agent CLI wrapper — the primary integration per the brief (public
 * beta). Invocations use execFile with an argv array (never a shell string), so
 * meeting-derived values can never be interpreted as shell.
 *
 * ⚠️ BETA / PENDING VERIFICATION: the exact CLI subcommands, flags, and JSON
 * output shape are not yet confirmed against the installed CLI version. The
 * command construction below is the intended structure; the literal subcommand
 * names (`project create`, `--dry-run`, …) must be reconciled with the CLI once
 * the Hub/tier and CLI version are pinned (a brief "remaining confirmation").
 * Until then the version-pinned ProjectsApiHubSpotClient is the safe default.
 */
export interface AgentCliOptions {
  /** CLI binary on PATH. */
  binary?: string;
  /** Extra base args (e.g. ['--portal', '<id>']). */
  baseArgs?: string[];
}

export class AgentCliHubSpotClient implements HubSpotClient {
  private readonly binary: string;
  private readonly baseArgs: string[];

  constructor(opts: AgentCliOptions = {}) {
    this.binary = opts.binary ?? 'hubspot';
    this.baseArgs = opts.baseArgs ?? [];
  }

  private async run<T>(args: string[]): Promise<T> {
    const { stdout } = await execFileAsync(this.binary, [...this.baseArgs, ...args], {
      maxBuffer: 10_000_000,
    });
    return JSON.parse(stdout) as T;
  }

  async resolveOwner(query: OwnerQuery): Promise<OwnerRef | null> {
    if (!query.email) return null;
    const data = await this.run<{ id?: string; email?: string }>(['owners', 'get', '--email', query.email, '--json']);
    return data.id ? { ownerId: data.id, ...(data.email ? { email: data.email } : {}) } : null;
  }

  async preview(plan: SyncPlan): Promise<SyncPreview> {
    // The CLI supports --dry-run; we still render locally so the preview shape is
    // identical across adapters and the board sees a consistent summary.
    return renderPreview(plan);
  }

  async apply(plan: SyncPlan): Promise<SyncResult> {
    const data = await this.run<SyncResult>([
      'projects',
      'sync',
      '--plan',
      JSON.stringify(plan),
      '--json',
    ]);
    return data;
  }
}
