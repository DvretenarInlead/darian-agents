import { describe, it, expect } from 'vitest';
import { buildCloneArgs, cloneUrl } from './clone.js';

describe('cloneUrl', () => {
  it('embeds the token for HTTPS auth', () => {
    expect(cloneUrl('acme/widget', 'tok')).toBe('https://x-access-token:tok@github.com/acme/widget.git');
  });
  it('omits auth when no token', () => {
    expect(cloneUrl('acme/widget', undefined)).toBe('https://github.com/acme/widget.git');
  });
});

describe('buildCloneArgs', () => {
  const args = buildCloneArgs('https://github.com/acme/widget.git', '/tmp/x');
  it('is a shallow, single-branch, no-tags clone', () => {
    expect(args).toEqual(expect.arrayContaining(['clone', '--depth', '1', '--no-tags', '--single-branch']));
    expect(args[args.length - 2]).toBe('https://github.com/acme/widget.git');
    expect(args[args.length - 1]).toBe('/tmp/x');
  });
  it('disables repo-provided git hooks', () => {
    const i = args.indexOf('core.hooksPath=/dev/null');
    expect(i).toBeGreaterThan(-1);
    expect(args[i - 1]).toBe('-c');
  });
});
