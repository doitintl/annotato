import { describe, expect, it } from 'vitest';
import { escapeMarkdownCell } from '../src/summary.js';
import { trimTrailingSlashes } from '../src/utils.js';

describe('escapeMarkdownCell', () => {
  it('escapes pipes and flattens newlines', () => {
    expect(escapeMarkdownCell('a|b\nc')).toBe('a\\|b c');
  });

  it('escapes backslashes before pipes so they cannot cancel the pipe escape', () => {
    expect(escapeMarkdownCell('a\\|b')).toBe('a\\\\\\|b');
  });
});

describe('trimTrailingSlashes', () => {
  it('removes only trailing slashes', () => {
    expect(trimTrailingSlashes('https://x.com///')).toBe('https://x.com');
    expect(trimTrailingSlashes('https://x.com/a/b')).toBe('https://x.com/a/b');
    expect(trimTrailingSlashes('///')).toBe('');
  });

  it('handles long slash runs quickly', () => {
    const start = Date.now();
    trimTrailingSlashes('/'.repeat(200000) + 'x');
    expect(Date.now() - start).toBeLessThan(200);
  });
});
