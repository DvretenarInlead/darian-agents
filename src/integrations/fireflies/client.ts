import { getScopedSecret, assertEgressAllowed, EGRESS_HOSTS } from '../../core/governance/credentials.js';
import { resilientFetch } from '../../core/net/resilientFetch.js';

/**
 * Fireflies transcript fetch (Product A worker step). Behind a port so the
 * meeting handler is testable with a stub; the GraphQL impl is egress-scoped to
 * `data_quality` and uses the resilient fetch wrapper.
 *
 * ⚠️ PENDING API CONFIRMATION: the exact GraphQL query/field names below follow
 * Fireflies' public docs (transcript(id){ sentences { text } }), but should be
 * verified against the provisioned plan/scopes (a brief "remaining
 * confirmation"). Response parsing is isolated in `sentencesToText` and tested.
 */
export interface FirefliesClient {
  fetchTranscript(meetingId: string): Promise<string>;
}

const HOST = EGRESS_HOSTS.fireflies; // api.fireflies.ai
const ENDPOINT = `https://${HOST}/graphql`;

const QUERY = `query Transcript($id: String!) { transcript(id: $id) { title sentences { speaker_name text } } }`;

interface TranscriptResponse {
  data?: { transcript?: { title?: string; sentences?: Array<{ speaker_name?: string; text?: string }> } };
  errors?: Array<{ message: string }>;
}

/** Flatten GraphQL sentence rows into a plain transcript string. Pure. */
export function sentencesToText(resp: TranscriptResponse): string {
  if (resp.errors?.length) throw new Error(`Fireflies error: ${resp.errors.map((e) => e.message).join('; ')}`);
  const t = resp.data?.transcript;
  if (!t) throw new Error('Fireflies returned no transcript');
  const lines = (t.sentences ?? []).map((s) => (s.speaker_name ? `${s.speaker_name}: ${s.text ?? ''}` : (s.text ?? '')));
  return lines.join('\n');
}

export class GraphqlFirefliesClient implements FirefliesClient {
  async fetchTranscript(meetingId: string): Promise<string> {
    assertEgressAllowed('data_quality', HOST);
    const apiKey = getScopedSecret('data_quality', 'fireflies');
    const res = await resilientFetch(ENDPOINT, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ query: QUERY, variables: { id: meetingId } }),
    });
    if (!res.ok) throw new Error(`Fireflies request failed: ${res.status} ${res.statusText}`);
    return sentencesToText((await res.json()) as TranscriptResponse);
  }
}

/** Deterministic stub for tests/local runs. */
export class StubFirefliesClient implements FirefliesClient {
  constructor(private readonly transcripts: Record<string, string>) {}
  async fetchTranscript(meetingId: string): Promise<string> {
    const t = this.transcripts[meetingId];
    if (t === undefined) throw new Error(`no stub transcript for ${meetingId}`);
    return t;
  }
}
