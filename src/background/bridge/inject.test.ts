import { describe, expect, it } from 'vitest';
import { pageRun } from './inject';

describe('pageRun (the injected run_js fallback)', () => {
  it('returns the value of a bare expression, with or without a trailing semicolon', async () => {
    expect(await pageRun('1 + 2', 100)).toEqual({ ok: true, json: '3', truncated: false });
    expect(await pageRun('  ({a: 1});\n', 100)).toEqual({ ok: true, json: '{"a":1}', truncated: false });
    expect(await pageRun('await Promise.resolve("x")', 100)).toEqual({ ok: true, json: '"x"', truncated: false });
  });

  it('runs a function body when the code is not a single expression', async () => {
    expect(await pageRun('return 7', 100)).toEqual({ ok: true, json: '7', truncated: false });
    expect(await pageRun('const x = 2; return x * 2', 100)).toEqual({ ok: true, json: '4', truncated: false });
    expect(await pageRun('const x = 2;', 100)).toEqual({ ok: true, json: null, truncated: false });
  });

  it('reports errors as name and message', async () => {
    expect(await pageRun('throw new TypeError("boom")', 100)).toMatchObject({ ok: false, kind: 'error', name: 'TypeError', message: 'boom' });
    expect(await pageRun('missingVariable', 100)).toMatchObject({ ok: false, kind: 'error', name: 'ReferenceError' });
  });
});
