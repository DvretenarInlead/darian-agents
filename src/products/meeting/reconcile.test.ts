import { describe, it, expect } from 'vitest';
import { normalizeItem, itemHash } from './reconcile.js';

describe('normalizeItem', () => {
  it('is insensitive to case and whitespace', () => {
    expect(normalizeItem({ title: '  Send   Proposal ', owner_hint: 'Dana' })).toBe(
      normalizeItem({ title: 'send proposal', owner_hint: 'dana' }),
    );
  });

  it('separates title from owner', () => {
    expect(normalizeItem({ title: 'A', owner_hint: null })).toBe('a|');
  });
});

describe('itemHash', () => {
  it('is stable for equivalent items', () => {
    expect(itemHash({ title: 'Send proposal', owner_hint: 'Dana' })).toBe(
      itemHash({ title: 'SEND PROPOSAL', owner_hint: 'dana' }),
    );
  });

  it('differs for different items', () => {
    expect(itemHash({ title: 'A', owner_hint: null })).not.toBe(itemHash({ title: 'B', owner_hint: null }));
  });

  it('differs when the owner differs', () => {
    expect(itemHash({ title: 'A', owner_hint: 'Dana' })).not.toBe(itemHash({ title: 'A', owner_hint: 'Sam' }));
  });
});
