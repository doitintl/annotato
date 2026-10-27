import * as fs from 'node:fs';
import { ActionInputs, ActionResult, AnnotationListItem } from './types.js';

export function escapeMarkdownCell(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, ' ');
}

/** Escapes table delimiters while preserving literal backslashes inside code spans. */
export function escapeMarkdownCodeCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

const DEFAULT_REPORTS_TEXT = 'All eligible reports (default)';
const GLOBAL_FALLBACK_REPORTS_TEXT = 'All eligible reports (global fallback)';

function describeStatus(result: ActionResult): string {
  if (result.skipped) return `⏭️ Skipped (${result.skipReason || 'filtered'})`;
  if (result.dryRun) return '🧪 Dry Run (no API mutation)';
  return '✅ Success';
}

function describeReports(result: ActionResult, inputs: ActionInputs): string {
  const requestedReports = inputs.reports.length > 0 ? inputs.reports.join(', ') : undefined;
  const actualReports = result.annotation?.reports;
  if (actualReports === undefined) return requestedReports ?? DEFAULT_REPORTS_TEXT;
  if (actualReports.length > 0) return actualReports.join(', ');
  return requestedReports ? GLOBAL_FALLBACK_REPORTS_TEXT : DEFAULT_REPORTS_TEXT;
}

function describeLabels(result: ActionResult, inputs: ActionInputs): string {
  const labels = result.resolvedLabels?.length ? result.resolvedLabels : inputs.labels;
  return labels.length > 0 ? labels.join(', ') : 'None';
}

function buildOperationTable(result: ActionResult, inputs: ActionInputs): string[] {
  const rows = [
    '| Field | Value |',
    '| :--- | :--- |',
    `| **Operation** | \`${escapeMarkdownCodeCell(result.operation)}\` |`,
    `| **Status** | ${escapeMarkdownCell(describeStatus(result))} |`,
  ];
  if (result.annotationId) {
    rows.push(`| **Annotation ID** | \`${escapeMarkdownCodeCell(result.annotationId)}\` |`);
  }
  if (result.annotationTimestamp) {
    rows.push(`| **Timestamp (UTC)** | \`${escapeMarkdownCodeCell(result.annotationTimestamp)}\` |`);
  }
  if (result.annotationContent) {
    rows.push(`| **Content** | ${escapeMarkdownCell(result.annotationContent)} |`);
  }
  rows.push(
    `| **Repository** | \`${escapeMarkdownCodeCell(result.context.repo)}\` |`,
    `| **Release / Ref** | \`${escapeMarkdownCodeCell(result.context.release)}\` |`,
    `| **GitHub Event** | \`${escapeMarkdownCodeCell(result.context.eventName)}\` |`,
    `| **Environment** | \`${escapeMarkdownCodeCell(result.context.environment)}\` |`,
    `| **Reports** | ${escapeMarkdownCell(describeReports(result, inputs))} |`,
    `| **Labels** | ${escapeMarkdownCell(describeLabels(result, inputs))} |`
  );
  return rows;
}

function describeItemLabels(item: AnnotationListItem): string {
  return item.labels && item.labels.length > 0
    ? item.labels.map((l) => `${l.name} (${l.id})`).join(', ')
    : '—';
}

function buildListedAnnotationsSection(annotations: AnnotationListItem[]): string[] {
  const lines = [`### Listed Annotations (${annotations.length})`, ''];
  if (annotations.length === 0) {
    lines.push('_No annotations matched the query._');
    return lines;
  }
  lines.push('| ID | Timestamp | Content | Labels |', '| :--- | :--- | :--- | :--- |');
  for (const item of annotations) {
    lines.push(
      `| \`${escapeMarkdownCodeCell(item.id)}\` | \`${escapeMarkdownCodeCell(item.timestamp)}\` | ${escapeMarkdownCell(item.content)} | ${escapeMarkdownCell(describeItemLabels(item))} |`
    );
  }
  return lines;
}

export function buildStepSummaryMarkdown(result: ActionResult, inputs: ActionInputs): string {
  const modeSuffix = result.dryRun ? ' (Dry Run)' : '';
  const lines = [
    `## 📌 DoiT Cloud Intelligence Annotation${modeSuffix}`,
    '',
    ...buildOperationTable(result, inputs),
    '',
  ];
  if (result.operation === 'list' && result.annotations) {
    lines.push(...buildListedAnnotationsSection(result.annotations), '');
  }
  return lines.join('\n');
}

export function writeStepSummary(markdown: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const summaryPath = env.GITHUB_STEP_SUMMARY?.trim();
  if (!summaryPath) {
    return false;
  }
  fs.appendFileSync(summaryPath, `${markdown}\n`, 'utf8');
  return true;
}
