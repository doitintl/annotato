import { describe, expect, it } from 'vitest';
import { buildStepSummaryMarkdown, escapeMarkdownCell, escapeMarkdownCodeCell } from '../src/summary.js';
import { parseActionInputs } from '../src/index.js';
import { trimTrailingSlashes } from '../src/utils.js';

describe('escapeMarkdownCell', () => {
  it('escapes pipes and flattens newlines', () => {
    expect(escapeMarkdownCell('a|b\nc')).toBe('a\\|b c');
  });

  it('escapes backslashes before pipes so they cannot cancel the pipe escape', () => {
    expect(escapeMarkdownCell('a\\|b')).toBe('a\\\\\\|b');
  });
});

describe('code-span summary cells', () => {
  it('preserves backslashes while escaping pipes and flattening newlines', () => {
    expect(escapeMarkdownCodeCell('C:\\repo\\|branch\r\nnext\nline')).toBe(
      'C:\\repo\\\\|branch next line'
    );
  });

  it('preserves paths in code spans and doubles backslashes only in plain-text cells', () => {
    const value = 'C:\\repo|branch\nnext';
    const codeCell = '`C:\\repo\\|branch next`';
    const plainCell = 'C:\\\\repo\\|branch next';
    const markdown = buildStepSummaryMarkdown({
      operation: 'list',
      dryRun: true,
      annotationId: value,
      annotationTimestamp: value,
      annotationContent: value,
      context: {
        repo: value,
        release: value,
        eventName: value,
        environment: value,
        tag: '',
        sha: '',
        shortSha: '',
        actor: '',
        url: '',
        timestamp: '',
      },
      annotations: [{ id: value, timestamp: value, content: value }],
    }, parseActionInputs({ INPUT_DRY_RUN: 'true' }));

    for (const field of ['Annotation ID', 'Timestamp (UTC)', 'Repository', 'Release / Ref', 'GitHub Event', 'Environment']) {
      expect(markdown).toContain(`| **${field}** | ${codeCell} |`);
    }
    expect(markdown).toContain('| **Operation** | `list` |');
    expect(markdown).toContain(`| **Content** | ${plainCell} |`);
    expect(markdown).toContain(`| ${codeCell} | ${codeCell} | ${plainCell} | — |`);
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
