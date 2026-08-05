import { describe, it, expect } from 'vitest';
import { sentencesToText, StubFirefliesClient } from './client.js';

describe('sentencesToText', () => {
  it('joins speaker-attributed sentences into a transcript', () => {
    const text = sentencesToText({
      data: { transcript: { title: 'Sync', sentences: [{ speaker_name: 'Dana', text: 'Ship Friday' }, { speaker_name: 'Sam', text: 'On it' }] } },
    });
    expect(text).toBe('Dana: Ship Friday\nSam: On it');
  });

  it('handles sentences without a speaker', () => {
    expect(sentencesToText({ data: { transcript: { sentences: [{ text: 'hello' }] } } })).toBe('hello');
  });

  it('throws on GraphQL errors', () => {
    expect(() => sentencesToText({ errors: [{ message: 'unauthorized' }] })).toThrow('unauthorized');
  });

  it('throws when no transcript is present', () => {
    expect(() => sentencesToText({ data: {} })).toThrow('no transcript');
  });
});

describe('StubFirefliesClient', () => {
  it('returns the canned transcript', async () => {
    const c = new StubFirefliesClient({ m1: 'hello world' });
    expect(await c.fetchTranscript('m1')).toBe('hello world');
    await expect(c.fetchTranscript('missing')).rejects.toThrow();
  });
});
