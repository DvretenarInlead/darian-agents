import { config } from '../../config/index.js';
import { assertEgressAllowed, getScopedSecret, EGRESS_HOSTS } from '../../core/governance/credentials.js';
import { resilientFetch } from '../../core/net/resilientFetch.js';

/**
 * Owner notifications ("the agent pings me") behind a port. v1 channel: Slack
 * chat.postMessage to a fixed channel. Notifications are best-effort by
 * contract — callers must never let a failed ping fail the work that
 * triggered it (the audit log remains the source of truth).
 *
 * Governance: the credential/egress is scoped to the orchestrator agent, and
 * message text is plain (no user-controlled formatting/mentions).
 */
export interface Notifier {
  notify(text: string): Promise<void>;
}

const HOST = EGRESS_HOSTS.slack; // slack.com

export class SlackNotifier implements Notifier {
  constructor(private readonly channelId: string) {}

  async notify(text: string): Promise<void> {
    assertEgressAllowed('orchestrator', HOST);
    const token = getScopedSecret('orchestrator', 'slack');
    const res = await resilientFetch(`https://${HOST}/api/chat.postMessage`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ channel: this.channelId, text: text.slice(0, 3000) }),
    });
    if (!res.ok) throw new Error(`Slack request failed: ${res.status} ${res.statusText}`);
    const data = (await res.json()) as { ok?: boolean; error?: string };
    if (!data.ok) throw new Error(`Slack API error: ${data.error ?? 'unknown'}`);
  }
}

/** Build the configured notifier, or null when Slack isn't set up. */
export function createNotifier(): Notifier | null {
  const cfg = config();
  if (!cfg.slack.botToken || !cfg.slack.channelId) return null;
  return new SlackNotifier(cfg.slack.channelId);
}

/** Collecting stub for tests. */
export class StubNotifier implements Notifier {
  readonly sent: string[] = [];
  async notify(text: string): Promise<void> {
    this.sent.push(text);
  }
}
