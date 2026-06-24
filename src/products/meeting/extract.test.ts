import { describe, it, expect } from 'vitest';
import { LlmExtractor, ActionItems } from './extract.js';
import { StubLlmClient, extractJson } from '../../integrations/anthropic/client.js';

const sample = [
  { title: 'Send proposal', description: null, owner_hint: 'Dana', due_hint: 'Friday', source_quote: 'Dana will send the proposal by Friday', confidence: 0.9 },
];

describe('extractJson', () => {
  it('parses a bare JSON array', () => {
    expect(extractJson('[1,2,3]')).toEqual([1, 2, 3]);
  });
  it('parses JSON inside a code fence with prose', () => {
    expect(extractJson('Here you go:\n```json\n{"a":1}\n```\nthanks')).toEqual({ a: 1 });
  });
  it('throws when no JSON is present', () => {
    expect(() => extractJson('no json here')).toThrow();
  });
});

describe('ActionItems schema', () => {
  it('requires a source_quote', () => {
    expect(() => ActionItems.parse([{ ...sample[0], source_quote: '' }])).toThrow();
  });
  it('rejects unexpected keys (strict)', () => {
    expect(() => ActionItems.parse([{ ...sample[0], injected: true }])).toThrow();
  });
});

describe('LlmExtractor', () => {
  it('extracts and validates items from model JSON', async () => {
    const llm = new StubLlmClient(() => JSON.stringify(sample));
    const items = await new LlmExtractor(llm).extract({ meetingId: 'm1', transcript: 'Dana will send the proposal by Friday' });
    expect(items).toHaveLength(1);
    expect(items[0]!.source_quote).toContain('proposal');
  });

  it('passes the transcript as data, scoped to data_quality', async () => {
    let usedAgent = '';
    const llm = new StubLlmClient((_req, agent) => {
      usedAgent = agent;
      return JSON.stringify(sample);
    });
    await new LlmExtractor(llm).extract({ meetingId: 'm1', transcript: 'x' });
    expect(usedAgent).toBe('data_quality');
  });

  it('throws on malformed model output (caller quarantines)', async () => {
    const llm = new StubLlmClient(() => 'not json');
    await expect(new LlmExtractor(llm).extract({ meetingId: 'm1', transcript: 'x' })).rejects.toThrow();
  });
});
