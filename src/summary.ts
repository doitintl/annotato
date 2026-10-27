import * as fs from 'node:fs';
import { ActionInputs, ActionResult } from './types.js';

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

export function buildStepSummaryMarkdown(result: ActionResult, inputs: ActionInputs): string {
  const lines: string[] = [];
  const modeSuffix = result.dryRun ? ' (Dry Run)' : '';
  lines.push(`## 📌 DoiT Cloud Intelligence Annotation${modeSuffix}`);
  lines.push('');

  const statusText = result.skipped
    ? `⏭️ Skipped (${result.skipReason || 'filtered'})`
    : result.dryRun
      ? '🧪 Dry Run (no API mutation)'
      : '✅ Success';
  const actualReports = result.annotation?.reports;
  const reportsText =
    actualReports !== undefined
      ? actualReports.length > 0
        ? actualReports.join(', ')
        : inputs.reports.length > 0
          ? 'All eligible reports (global fallback)'
          : 'All eligible reports (default)'
      : inputs.reports.length > 0
        ? inputs.reports.join(', ')
        : 'All eligible reports (default)';
  const labelsList =
    result.resolvedLabels && result.resolvedLabels.length > 0
      ? result.resolvedLabels
      : inputs.labels;
  const labelsText = labelsList.length > 0 ? labelsList.join(', ') : 'None';

  lines.push('| Field | Value |');
  lines.push('| :--- | :--- |');
  lines.push(`| **Operation** | \`${escapeMarkdownCodeCell(result.operation)}\` |`);
  lines.push(`| **Status** | ${escapeMarkdownCell(statusText)} |`);
  if (result.annotationId) {
    lines.push(`| **Annotation ID** | \`${escapeMarkdownCodeCell(result.annotationId)}\` |`);
  }
  if (result.annotationTimestamp) {
    lines.push(`| **Timestamp (UTC)** | \`${escapeMarkdownCodeCell(result.annotationTimestamp)}\` |`);
  }
  if (result.annotationContent) {
    lines.push(`| **Content** | ${escapeMarkdownCell(result.annotationContent)} |`);
  }
  lines.push(`| **Repository** | \`${escapeMarkdownCodeCell(result.context.repo)}\` |`);
  lines.push(`| **Release / Ref** | \`${escapeMarkdownCodeCell(result.context.release)}\` |`);
  lines.push(`| **GitHub Event** | \`${escapeMarkdownCodeCell(result.context.eventName)}\` |`);
  lines.push(`| **Environment** | \`${escapeMarkdownCodeCell(result.context.environment)}\` |`);
  lines.push(`| **Reports** | ${escapeMarkdownCell(reportsText)} |`);
  lines.push(`| **Labels** | ${escapeMarkdownCell(labelsText)} |`);
  lines.push('');

  if (result.operation === 'list' && result.annotations) {
    lines.push(`### Listed Annotations (${result.annotations.length})`);
    lines.push('');
    if (result.annotations.length === 0) {
      lines.push('_No annotations matched the query._');
    } else {
      lines.push('| ID | Timestamp | Content | Labels |');
      lines.push('| :--- | :--- | :--- | :--- |');
      for (const item of result.annotations) {
        const itemLabels =
          item.labels && item.labels.length > 0
            ? item.labels.map((l) => `${l.name} (${l.id})`).join(', ')
            : '—';
        lines.push(
          `| \`${escapeMarkdownCodeCell(item.id)}\` | \`${escapeMarkdownCodeCell(item.timestamp)}\` | ${escapeMarkdownCell(item.content)} | ${escapeMarkdownCell(itemLabels)} |`
        );
      }
    }
    lines.push('');
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
