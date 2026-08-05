import { config } from '../../config/index.js';
import { assertEgressAllowed, getScopedSecret, EGRESS_HOSTS } from '../../core/governance/credentials.js';
import { resilientFetch } from '../../core/net/resilientFetch.js';

/**
 * ElevenLabs voice adapter behind a port: text-to-speech (the assistant's
 * mouth) and speech-to-text (its ears). Only the `assistant` agent is scoped
 * for the credential/egress, and only two payloads ever cross the wire: the
 * answer text to be spoken, and the recorded question audio to transcribe.
 *
 * The HUD degrades gracefully — when no API key is configured the routes
 * report the capability as absent and the browser's built-in voice is used.
 */

export interface TtsResult {
  audio: Buffer;
  mime: string;
}

export interface VoiceClient {
  /** Synthesize speech for `text`. */
  tts(text: string): Promise<TtsResult>;
  /** Transcribe recorded audio (webm/ogg/mp4 from MediaRecorder). */
  stt(audio: Buffer, mime: string): Promise<string>;
}

const HOST = EGRESS_HOSTS.elevenlabs; // api.elevenlabs.io
const TTS_MODEL = 'eleven_multilingual_v2'; // covers English + Croatian
const STT_MODEL = 'scribe_v1';

export class ElevenLabsVoiceClient implements VoiceClient {
  constructor(private readonly fetchImpl?: typeof fetch) {}

  private key(): string {
    assertEgressAllowed('assistant', HOST);
    return getScopedSecret('assistant', 'elevenlabs');
  }

  async tts(text: string): Promise<TtsResult> {
    const apiKey = this.key();
    const voiceId = config().elevenlabs.voiceId;
    const res = await resilientFetch(
      `https://${HOST}/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`,
      {
        method: 'POST',
        headers: { 'xi-api-key': apiKey, 'content-type': 'application/json' },
        body: JSON.stringify({ text, model_id: TTS_MODEL }),
      },
      { timeoutMs: 30_000, ...(this.fetchImpl ? { fetchImpl: this.fetchImpl } : {}) },
    );
    if (!res.ok) {
      throw new Error(`ElevenLabs TTS failed: ${res.status} ${res.statusText}`);
    }
    return { audio: Buffer.from(await res.arrayBuffer()), mime: 'audio/mpeg' };
  }

  async stt(audio: Buffer, mime: string): Promise<string> {
    const apiKey = this.key();
    const form = new FormData();
    form.append('model_id', STT_MODEL);
    form.append('file', new Blob([new Uint8Array(audio)], { type: mime }), 'question.webm');
    const res = await resilientFetch(
      `https://${HOST}/v1/speech-to-text`,
      { method: 'POST', headers: { 'xi-api-key': apiKey }, body: form },
      { timeoutMs: 30_000, ...(this.fetchImpl ? { fetchImpl: this.fetchImpl } : {}) },
    );
    if (!res.ok) {
      throw new Error(`ElevenLabs STT failed: ${res.status} ${res.statusText}`);
    }
    const data = (await res.json()) as { text?: string };
    return (data.text ?? '').trim();
  }
}

/** Deterministic stub for tests. */
export class StubVoiceClient implements VoiceClient {
  constructor(
    private readonly onTts: (text: string) => TtsResult,
    private readonly onStt: (audio: Buffer, mime: string) => string,
  ) {}
  async tts(text: string): Promise<TtsResult> {
    return this.onTts(text);
  }
  async stt(audio: Buffer, mime: string): Promise<string> {
    return this.onStt(audio, mime);
  }
}
