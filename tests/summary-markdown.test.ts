import { describe, expect, it } from 'vitest';
import { extractGitHubContext } from '../src/context.js';
import { parseActionInputs } from '../src/index.js';
import { buildStepSummaryMarkdown } from '../src/summary.js';
import { ActionInputs, ActionResult, AnnotationListItem } from '../src/types.js';

const context = extractGitHubContext({
  env: { GITHUB_EVENT_NAME: 'push', GITHUB_REPOSITORY: 'org/repo' },
  payload: {},
  now: new Date('2026-10-21T10:00:00Z'),
});

function makeResult(overrides: Partial<ActionResult> = {}): ActionResult {
  return { operation: 'create', dryRun: false, context, ...overrides };
}

function makeInputs(overrides: Partial<ActionInputs> = {}): ActionInputs {
  return { ...parseActionInputs({}), ...overrides };
}

function makeItem(overrides: Record<string, unknown> = {}): AnnotationListItem {
  return {
    id: 'ann_1',
    content: 'c',
    timestamp: '2026-10-21T10:00:00.000Z',
    ...overrides,
  } as AnnotationListItem;
}

describe('buildStepSummaryMarkdown', () => {
  describe('header and status', () => {
    it('renders a success header and status', () => {
      const md = buildStepSummaryMarkdown(makeResult(), makeInputs());
      expect(md).toContain('## 📌 DoiT Cloud Intelligence Annotation\n');
      expect(md).toContain('| **Status** | ✅ Success |');
    });

    it('marks dry runs in the header and status', () => {
      const md = buildStepSummaryMarkdown(makeResult({ dryRun: true }), makeInputs());
      expect(md).toContain('## 📌 DoiT Cloud Intelligence Annotation (Dry Run)');
      expect(md).toContain('| **Status** | 🧪 Dry Run (no API mutation) |');
    });

    it('shows the skip reason, or "filtered" when none is given', () => {
      const withReason = buildStepSummaryMarkdown(
        makeResult({ skipped: true, skipReason: 'no tag' }),
        makeInputs()
      );
      expect(withReason).toContain('| **Status** | ⏭️ Skipped (no tag) |');

      const withoutReason = buildStepSummaryMarkdown(makeResult({ skipped: true }), makeInputs());
      expect(withoutReason).toContain('| **Status** | ⏭️ Skipped (filtered) |');
    });

    it('prefers the skipped status over the dry-run status', () => {
      const md = buildStepSummaryMarkdown(
        makeResult({ skipped: true, dryRun: true, skipReason: 'r' }),
        makeInputs()
      );
      expect(md).toContain('| **Status** | ⏭️ Skipped (r) |');
      expect(md).toContain('(Dry Run)');
    });
  });

  describe('optional rows', () => {
    it('omits annotation id, timestamp and content rows when absent', () => {
      const md = buildStepSummaryMarkdown(makeResult(), makeInputs());
      expect(md).not.toContain('**Annotation ID**');
      expect(md).not.toContain('**Timestamp (UTC)**');
      expect(md).not.toContain('**Content**');
    });

    it('renders annotation id, timestamp and content rows when present', () => {
      const md = buildStepSummaryMarkdown(
        makeResult({
          annotationId: 'ann_9',
          annotationTimestamp: '2026-10-21T10:00:00.000Z',
          annotationContent: 'Deployed',
        }),
        makeInputs()
      );
      expect(md).toContain('| **Annotation ID** | `ann_9` |');
      expect(md).toContain('| **Timestamp (UTC)** | `2026-10-21T10:00:00.000Z` |');
      expect(md).toContain('| **Content** | Deployed |');
    });

    it('always renders operation and context rows', () => {
      const md = buildStepSummaryMarkdown(makeResult({ operation: 'get' }), makeInputs());
      expect(md).toContain('| Field | Value |');
      expect(md).toContain('| **Operation** | `get` |');
      expect(md).toContain('| **Repository** | `org/repo` |');
      expect(md).toContain('| **Release / Ref** | `push` |');
      expect(md).toContain('| **GitHub Event** | `push` |');
      expect(md).toContain('| **Environment** | `production` |');
    });
  });

  describe('reports text', () => {
    it('lists the reports actually attached to the annotation', () => {
      const md = buildStepSummaryMarkdown(
        makeResult({ annotation: makeItem({ reports: ['r1', 'r2'] }) }),
        makeInputs({ reports: ['ignored'] })
      );
      expect(md).toContain('| **Reports** | r1, r2 |');
    });

    it('reports a global fallback when the annotation has no reports but inputs asked for some', () => {
      const md = buildStepSummaryMarkdown(
        makeResult({ annotation: makeItem({ reports: [] }) }),
        makeInputs({ reports: ['r1'] })
      );
      expect(md).toContain('| **Reports** | All eligible reports (global fallback) |');
    });

    it('reports the default when the annotation has no reports and none were requested', () => {
      const md = buildStepSummaryMarkdown(
        makeResult({ annotation: makeItem({ reports: [] }) }),
        makeInputs()
      );
      expect(md).toContain('| **Reports** | All eligible reports (default) |');
    });

    it('falls back to input reports when there is no annotation', () => {
      const md = buildStepSummaryMarkdown(makeResult(), makeInputs({ reports: ['a', 'b'] }));
      expect(md).toContain('| **Reports** | a, b |');
    });

    it('falls back to the default when there is no annotation and no input reports', () => {
      const md = buildStepSummaryMarkdown(makeResult(), makeInputs());
      expect(md).toContain('| **Reports** | All eligible reports (default) |');
    });

    it('treats an annotation without a reports field like no annotation', () => {
      const md = buildStepSummaryMarkdown(
        makeResult({ annotation: makeItem() }),
        makeInputs({ reports: ['x'] })
      );
      expect(md).toContain('| **Reports** | x |');
    });
  });

  describe('labels text', () => {
    it('prefers resolved labels over input labels', () => {
      const md = buildStepSummaryMarkdown(
        makeResult({ resolvedLabels: ['lbl_1', 'lbl_2'] }),
        makeInputs({ labels: ['prod'] })
      );
      expect(md).toContain('| **Labels** | lbl_1, lbl_2 |');
    });

    it('falls back to input labels when none were resolved', () => {
      const emptyResolved = buildStepSummaryMarkdown(
        makeResult({ resolvedLabels: [] }),
        makeInputs({ labels: ['prod', 'release'] })
      );
      expect(emptyResolved).toContain('| **Labels** | prod, release |');

      const undefinedResolved = buildStepSummaryMarkdown(
        makeResult(),
        makeInputs({ labels: ['prod'] })
      );
      expect(undefinedResolved).toContain('| **Labels** | prod |');
    });

    it('shows None when there are no labels at all', () => {
      const md = buildStepSummaryMarkdown(makeResult(), makeInputs());
      expect(md).toContain('| **Labels** | None |');
    });
  });

  describe('list operation section', () => {
    it('renders a table of listed annotations with label names and ids', () => {
      const md = buildStepSummaryMarkdown(
        makeResult({
          operation: 'list',
          annotations: [
            makeItem({ labels: [{ id: 'l1', name: 'prod' }, { id: 'l2', name: 'eu' }] }),
            makeItem({ id: 'ann_2', content: 'second', labels: [] }),
            makeItem({ id: 'ann_3', content: 'third' }),
          ],
        }),
        makeInputs()
      );
      expect(md).toContain('### Listed Annotations (3)');
      expect(md).toContain('| ID | Timestamp | Content | Labels |');
      expect(md).toContain('| `ann_1` | `2026-10-21T10:00:00.000Z` | c | prod (l1), eu (l2) |');
      expect(md).toContain('| `ann_2` | `2026-10-21T10:00:00.000Z` | second | — |');
      expect(md).toContain('| `ann_3` | `2026-10-21T10:00:00.000Z` | third | — |');
    });

    it('says so when the list is empty', () => {
      const md = buildStepSummaryMarkdown(
        makeResult({ operation: 'list', annotations: [] }),
        makeInputs()
      );
      expect(md).toContain('### Listed Annotations (0)');
      expect(md).toContain('_No annotations matched the query._');
      expect(md).not.toContain('| ID | Timestamp | Content | Labels |');
    });

    it('omits the section for non-list operations and for lists without annotations', () => {
      const notList = buildStepSummaryMarkdown(
        makeResult({ operation: 'create', annotations: [makeItem()] }),
        makeInputs()
      );
      expect(notList).not.toContain('### Listed Annotations');

      const noAnnotations = buildStepSummaryMarkdown(
        makeResult({ operation: 'list' }),
        makeInputs()
      );
      expect(noAnnotations).not.toContain('### Listed Annotations');
    });

    it('escapes pipes and newlines in listed content', () => {
      const md = buildStepSummaryMarkdown(
        makeResult({
          operation: 'list',
          annotations: [makeItem({ content: 'a|b\nc' })],
        }),
        makeInputs()
      );
      expect(md).toContain('| a\\|b c |');
    });
  });

  it('ends with a trailing blank line after the table', () => {
    const md = buildStepSummaryMarkdown(makeResult(), makeInputs());
    expect(md.endsWith('|\n')).toBe(true);
  });
});
