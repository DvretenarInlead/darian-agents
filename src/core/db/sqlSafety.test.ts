import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * SQL-injection regression guard: every query in this codebase must be
 * parameterized ($1, $2, …). This test fails the build if anyone ever
 * interpolates a value into a query template literal — the only way SQLi
 * could enter a pg codebase.
 */

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.ts') && !p.endsWith('.test.ts')) out.push(p);
  }
  return out;
}

// `.query(` followed by a template literal containing ${ before the backtick closes.
const INTERPOLATED_QUERY = /\.query\(\s*`[^`]*\$\{/s;

describe('SQL safety', () => {
  it('no query() call interpolates values into SQL text', () => {
    const offenders: string[] = [];
    for (const file of [...walk('src'), ...walk('scripts')]) {
      if (INTERPOLATED_QUERY.test(readFileSync(file, 'utf8'))) offenders.push(file);
    }
    expect(offenders, `string interpolation inside SQL — use $n parameters: ${offenders.join(', ')}`).toEqual([]);
  });
});
