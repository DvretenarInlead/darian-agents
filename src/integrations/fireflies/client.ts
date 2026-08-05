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
export interface TranscriptMeta {
  id: string;
  title: string | null;
  dateIso: string | null;
}

export interface FirefliesClient {
  fetchTranscript(meetingId: string): Promise<string>;
  /** Newest-first listing used by the poller (pull-based ingestion, no webhook). */
  listRecentTranscripts(limit: number): Promise<TranscriptMeta[]>;
}

const HOST = EGRESS_HOSTS.fireflies; // api.fireflies.ai
const ENDPOINT = `https://${HOST}/graphql`;

const QUERY = `query Transcript($id: String!) { transcript(id: $id) { title sentences { speaker_name text } } }`;
const LIST_QUERY = `query Transcripts($limit: Int) { transcripts(limit: $limit) { id title date } }`;

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

interface ListResponse {
  data?: { transcripts?: Array<{ id?: string; title?: string | null; date?: string | number | null }> };
  errors?: Array<{ message: string }>;
}

/** Normalise the GraphQL transcripts listing. Pure. */
export function transcriptsToList(resp: ListResponse): TranscriptMeta[] {
  if (resp.errors?.length) throw new Error(`Fireflies error: ${resp.errors.map((e) => e.message).join('; ')}`);
  return (resp.data?.transcripts ?? [])
    .filter((t): t is { id: string; title?: string | null; date?: string | number | null } => typeof t.id === 'string' && t.id.length > 0)
    .map((t) => ({
      id: t.id,
      title: t.title ?? null,
      // Fireflies returns epoch millis or ISO depending on field/plan; normalise to ISO.
      dateIso: typeof t.date === 'number' ? new Date(t.date).toISOString() : (t.date ?? null),
    }));
}

export class GraphqlFirefliesClient implements FirefliesClient {
  /** Calls are scoped to the given agent (extraction path vs assistant tools). */
  constructor(private readonly agent: 'data_quality' | 'assistant' = 'data_quality') {}

  private async gql(query: string, variables: Record<string, unknown>): Promise<unknown> {
    assertEgressAllowed(this.agent, HOST);
    const apiKey = getScopedSecret(this.agent, 'fireflies');
    const res = await resilientFetch(ENDPOINT, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ query, variables }),
    });
    if (!res.ok) throw new Error(`Fireflies request failed: ${res.status} ${res.statusText}`);
    return res.json();
  }

  async fetchTranscript(meetingId: string): Promise<string> {
    return sentencesToText((await this.gql(QUERY, { id: meetingId })) as TranscriptResponse);
  }

  async listRecentTranscripts(limit: number): Promise<TranscriptMeta[]> {
    return transcriptsToList((await this.gql(LIST_QUERY, { limit })) as ListResponse);
  }
}

/** Deterministic stub for tests/local runs. */
export class StubFirefliesClient implements FirefliesClient {
  constructor(
    private readonly transcripts: Record<string, string>,
    private readonly recent: TranscriptMeta[] = [],
  ) {}
  async fetchTranscript(meetingId: string): Promise<string> {
    const t = this.transcripts[meetingId];
    if (t === undefined) throw new Error(`no stub transcript for ${meetingId}`);
    return t;
  }
  async listRecentTranscripts(_limit: number): Promise<TranscriptMeta[]> {
    return this.recent;
  }
}
