import * as core from '@actions/core';
import {
  evaluateAnnotationFilters,
  extractGitHubContext,
  parseCsvList,
  renderAnnotationContent,
} from './context.js';
import { DoitClient } from './doit-client.js';
import { buildStepSummaryMarkdown, writeStepSummary } from './summary.js';
import {
  ActionInputs,
  ActionResult,
  AnnotationOperation,
  CreateAnnotationRequest,
  DEFAULT_API_URL,
  DOIT_LABEL_COLORS,
  LabelColor,
  UpdateAnnotationRequest,
} from './types.js';

const MIN_MAX_RESULTS = 1;
const MAX_MAX_RESULTS = 500;

const VALID_OPERATIONS: readonly AnnotationOperation[] = [
  'create',
  'update',
  'delete',
  'get',
  'list',
];

export function readRawInput(name: string, env: NodeJS.ProcessEnv = process.env): string {
  const hyphenKey = `INPUT_${name.toUpperCase()}`;
  const underscoreKey = `INPUT_${name.toUpperCase().replace(/-/g, '_')}`;
  if (env[hyphenKey] !== undefined && env[hyphenKey] !== '') {
    return String(env[hyphenKey]).trim();
  }
  if (env[underscoreKey] !== undefined && env[underscoreKey] !== '') {
    return String(env[underscoreKey]).trim();
  }
  if (env === process.env) {
    const fromCore = core.getInput(name);
    if (fromCore) {
      return fromCore.trim();
    }
  }
  return '';
}

function parseBoolean(val: string, defaultValue: boolean): boolean {
  if (!val) return defaultValue;
  const normalized = val.trim().toLowerCase();
  if (['true', '1', 'yes', 'y'].includes(normalized)) return true;
  if (['false', '0', 'no', 'n'].includes(normalized)) return false;
  return defaultValue;
}

export function parseActionInputs(env: NodeJS.ProcessEnv = process.env): ActionInputs {
  const doitApiKey =
    readRawInput('doit-api-key', env) || (env.DOIT_API_KEY ? env.DOIT_API_KEY.trim() : '');

  const rawOperation = (readRawInput('operation', env) || 'create').toLowerCase();
  if (!VALID_OPERATIONS.includes(rawOperation as AnnotationOperation)) {
    throw new Error(
      `Invalid operation "${rawOperation}". Must be one of: ${VALID_OPERATIONS.join(', ')}`
    );
  }
  const operation = rawOperation as AnnotationOperation;

  const rawColor = readRawInput('label-color', env) || 'blue';
  if (!DOIT_LABEL_COLORS.includes(rawColor as LabelColor)) {
    throw new Error(
      `Invalid label-color "${rawColor}". Must be one of: ${DOIT_LABEL_COLORS.join(', ')}`
    );
  }
  const labelColor = rawColor as LabelColor;

  const annotationId = readRawInput('annotation-id', env) || undefined;
  const releaseId = readRawInput('release-id', env) || undefined;
  const content = readRawInput('content', env) || undefined;
  const template = readRawInput('template', env) || undefined;
  const timestamp = readRawInput('timestamp', env) || undefined;
  const reports = parseCsvList(readRawInput('reports', env));
  const labels = parseCsvList(readRawInput('labels', env));
  const createMissingLabels = parseBoolean(readRawInput('create-missing-labels', env), false);
  const tenantId =
    readRawInput('tenant-id', env) || (env.DOIT_TENANT_ID ? env.DOIT_TENANT_ID.trim() : undefined);
  const apiUrl =
    readRawInput('api-url', env) ||
    (env.DOIT_API_URL ? env.DOIT_API_URL.trim() : '') ||
    DEFAULT_API_URL;
  const dryRun = parseBoolean(readRawInput('dry-run', env), false);
  const failOnError = parseBoolean(readRawInput('fail-on-error', env), true);
  const filter = readRawInput('filter', env) || undefined;
  const rawMaxResults = readRawInput('max-results', env);
  let maxResults: number | undefined;
  if (rawMaxResults) {
    const parsedMax = Number.parseInt(rawMaxResults, 10);
    if (!Number.isInteger(parsedMax) || parsedMax < MIN_MAX_RESULTS || parsedMax > MAX_MAX_RESULTS) {
      throw new Error(
        `Invalid max-results "${rawMaxResults}". Expected an integer between ${MIN_MAX_RESULTS} and ${MAX_MAX_RESULTS}.`
      );
    }
    maxResults = parsedMax;
  }
  const requireTag = readRawInput('require-tag', env) || undefined;
  const requireCommitTag = parseCsvList(readRawInput('require-commit-tag', env));
  const requirePrLabel = parseCsvList(readRawInput('require-pr-label', env));

  return {
    doitApiKey,
    operation,
    annotationId,
    releaseId,
    content,
    template,
    timestamp,
    reports,
    labels,
    createMissingLabels,
    labelColor,
    tenantId,
    apiUrl,
    dryRun,
    failOnError,
    filter,
    maxResults,
    requireTag,
    requireCommitTag,
    requirePrLabel,
  };
}

export interface ExecuteActionOptions {
  env?: NodeJS.ProcessEnv;
  payload?: Record<string, unknown>;
  fetchImpl?: typeof fetch;
  now?: Date;
}

export async function executeAction(
  inputs: ActionInputs,
  options?: ExecuteActionOptions
): Promise<ActionResult> {
  const env = options?.env ?? process.env;
  if (inputs.doitApiKey) {
    core.setSecret(inputs.doitApiKey);
  }
  if (inputs.tenantId) {
    core.setSecret(inputs.tenantId);
  }

  const context = extractGitHubContext({
    env,
    payload: options?.payload,
    now: options?.now,
    releaseIdOverride: inputs.releaseId,
    timestampOverride: inputs.timestamp,
  });

  if (inputs.operation === 'create') {
    const filterResult = evaluateAnnotationFilters(context, inputs);
    if (!filterResult.shouldAnnotate) {
      const skippedResult: ActionResult = {
        operation: inputs.operation,
        dryRun: inputs.dryRun,
        skipped: true,
        skipReason: filterResult.skipReason,
        context,
      };
      const markdown = buildStepSummaryMarkdown(skippedResult, inputs);
      writeStepSummary(markdown, env);
      return skippedResult;
    }
  }

  const renderedContent = renderAnnotationContent(context, {
    content: inputs.content,
    template: inputs.template,
  });

  if (inputs.dryRun) {
    const requestPayload: CreateAnnotationRequest | UpdateAnnotationRequest =
      inputs.operation === 'update'
        ? {
            ...(inputs.content || inputs.template || inputs.releaseId
              ? { content: renderedContent }
              : {}),
            ...(inputs.timestamp ? { timestamp: context.timestamp } : {}),
            ...(inputs.reports.length > 0 ? { reports: inputs.reports } : {}),
            ...(inputs.labels.length > 0 ? { labels: inputs.labels } : {}),
          }
        : {
            content: renderedContent,
            timestamp: context.timestamp,
            ...(inputs.reports.length > 0 ? { reports: inputs.reports } : {}),
            ...(inputs.labels.length > 0 ? { labels: inputs.labels } : {}),
          };

    const dryRunResult: ActionResult = {
      operation: inputs.operation,
      dryRun: true,
      annotationId: inputs.annotationId || 'dry-run-annotation-id',
      annotationContent: renderedContent,
      annotationTimestamp: context.timestamp,
      resolvedLabels: inputs.labels,
      requestPayload,
      context,
    };

    const markdown = buildStepSummaryMarkdown(dryRunResult, inputs);
    writeStepSummary(markdown, env);
    return dryRunResult;
  }

  if (!inputs.doitApiKey) {
    throw new Error(
      'Missing required input "doit-api-key" (or DOIT_API_KEY environment variable).'
    );
  }

  const client = new DoitClient({
    apiKey: inputs.doitApiKey,
    baseUrl: inputs.apiUrl,
    tenantId: inputs.tenantId,
    fetchImpl: options?.fetchImpl,
    onWarning: (msg: string) => core.warning(msg),
  });

  let result: ActionResult;

  if (inputs.operation === 'create') {
    const resolvedLabels =
      inputs.labels.length > 0
        ? await client.resolveLabels(inputs.labels, {
            createMissing: inputs.createMissingLabels,
            defaultColor: inputs.labelColor,
          })
        : [];

    const requestPayload: CreateAnnotationRequest = {
      content: renderedContent,
      timestamp: context.timestamp,
      ...(inputs.reports.length > 0 ? { reports: inputs.reports } : {}),
      ...(resolvedLabels.length > 0 ? { labels: resolvedLabels } : {}),
    };

    const created = await client.createAnnotation(requestPayload);
    result = {
      operation: 'create',
      dryRun: false,
      annotationId: created.id,
      annotationContent: created.content,
      annotationTimestamp: created.timestamp,
      annotation: created,
      resolvedLabels,
      requestPayload,
      context,
    };
  } else if (inputs.operation === 'update') {
    if (!inputs.annotationId) {
      throw new Error('Input "annotation-id" is required when operation is "update".');
    }

    const resolvedLabels =
      inputs.labels.length > 0
        ? await client.resolveLabels(inputs.labels, {
            createMissing: inputs.createMissingLabels,
            defaultColor: inputs.labelColor,
          })
        : undefined;

    const shouldUpdateContent = Boolean(
      inputs.content || inputs.template || inputs.releaseId
    );
    const updatePayload: UpdateAnnotationRequest = {};
    if (shouldUpdateContent) {
      updatePayload.content = renderedContent;
    }
    if (inputs.timestamp) {
      updatePayload.timestamp = context.timestamp;
    }
    if (inputs.reports.length > 0) {
      updatePayload.reports = inputs.reports;
    }
    if (resolvedLabels && resolvedLabels.length > 0) {
      updatePayload.labels = resolvedLabels;
    }

    const updated = await client.updateAnnotation(inputs.annotationId, updatePayload);
    result = {
      operation: 'update',
      dryRun: false,
      annotationId: updated.id,
      annotationContent: updated.content,
      annotationTimestamp: updated.timestamp,
      annotation: updated,
      resolvedLabels,
      requestPayload: updatePayload,
      context,
    };
  } else if (inputs.operation === 'delete') {
    if (!inputs.annotationId) {
      throw new Error('Input "annotation-id" is required when operation is "delete".');
    }
    await client.deleteAnnotation(inputs.annotationId);
    result = {
      operation: 'delete',
      dryRun: false,
      annotationId: inputs.annotationId,
      context,
    };
  } else if (inputs.operation === 'get') {
    if (!inputs.annotationId) {
      throw new Error('Input "annotation-id" is required when operation is "get".');
    }
    const fetched = await client.getAnnotation(inputs.annotationId);
    result = {
      operation: 'get',
      dryRun: false,
      annotationId: fetched.id,
      annotationContent: fetched.content,
      annotationTimestamp: fetched.timestamp,
      annotation: fetched,
      context,
    };
  } else {
    const listed = await client.listAnnotations({
      filter: inputs.filter,
      maxResults: inputs.maxResults,
    });
    const annotations = listed.annotations ?? [];
    const first = annotations[0];
    result = {
      operation: 'list',
      dryRun: false,
      annotationId: first?.id,
      annotationContent: first?.content,
      annotationTimestamp: first?.timestamp,
      annotations,
      context,
    };
  }

  const markdown = buildStepSummaryMarkdown(result, inputs);
  writeStepSummary(markdown, env);

  return result;
}

export async function run(options?: ExecuteActionOptions): Promise<ActionResult | undefined> {
  const env = options?.env ?? process.env;
  let failOnError = true;
  try {
    const inputs = parseActionInputs(env);
    failOnError = inputs.failOnError;

    const result = await executeAction(inputs, options);

    core.setOutput('annotation-id', result.annotationId ?? '');
    core.setOutput('annotation-content', result.annotationContent ?? '');
    core.setOutput('annotation-timestamp', result.annotationTimestamp ?? '');
    core.setOutput('annotation-skipped', result.skipped ? 'true' : 'false');
    core.setOutput(
      'annotation-json',
      JSON.stringify(
        result.annotation ??
          result.annotations ??
          result.requestPayload ?? {
            id: result.annotationId,
            skipped: Boolean(result.skipped),
            skipReason: result.skipReason,
          }
      )
    );

    if (result.skipped) {
      core.info(`[Annotato] Skipped annotation: ${result.skipReason}`);
    } else {
      core.info(
        `[Annotato] ${result.dryRun ? '(DRY RUN) ' : ''}Operation "${result.operation}" completed${
          result.annotationId ? ` (id: ${result.annotationId})` : ''
        }.`
      );
    }
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (failOnError) {
      core.setFailed(message);
    } else {
      core.warning(`[Annotato] Non-fatal error (fail-on-error=false): ${message}`);
    }
    return undefined;
  }
}

if (typeof require !== 'undefined' && require.main === module) {
  void run();
}
