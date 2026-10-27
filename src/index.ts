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
  GitHubEventContext,
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

function optionalInput(name: string, env: NodeJS.ProcessEnv): string | undefined {
  return readRawInput(name, env) || undefined;
}

function inputWithEnvFallback(
  name: string,
  envKey: string,
  env: NodeJS.ProcessEnv
): string | undefined {
  return readRawInput(name, env) || env[envKey]?.trim() || undefined;
}

function parseOperation(raw: string): AnnotationOperation {
  const operation = raw.toLowerCase();
  if (!VALID_OPERATIONS.includes(operation as AnnotationOperation)) {
    throw new Error(
      `Invalid operation "${operation}". Must be one of: ${VALID_OPERATIONS.join(', ')}`
    );
  }
  return operation as AnnotationOperation;
}

function parseLabelColor(raw: string): LabelColor {
  if (!DOIT_LABEL_COLORS.includes(raw as LabelColor)) {
    throw new Error(`Invalid label-color "${raw}". Must be one of: ${DOIT_LABEL_COLORS.join(', ')}`);
  }
  return raw as LabelColor;
}

function parseMaxResults(raw: string): number | undefined {
  if (!raw) return undefined;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < MIN_MAX_RESULTS || parsed > MAX_MAX_RESULTS) {
    throw new Error(
      `Invalid max-results "${raw}". Expected an integer between ${MIN_MAX_RESULTS} and ${MAX_MAX_RESULTS}.`
    );
  }
  return parsed;
}

export function parseActionInputs(env: NodeJS.ProcessEnv = process.env): ActionInputs {
  return {
    doitApiKey: inputWithEnvFallback('doit-api-key', 'DOIT_API_KEY', env) ?? '',
    operation: parseOperation(readRawInput('operation', env) || 'create'),
    annotationId: optionalInput('annotation-id', env),
    releaseId: optionalInput('release-id', env),
    content: optionalInput('content', env),
    template: optionalInput('template', env),
    timestamp: optionalInput('timestamp', env),
    reports: parseCsvList(readRawInput('reports', env)),
    labels: parseCsvList(readRawInput('labels', env)),
    createMissingLabels: parseBoolean(readRawInput('create-missing-labels', env), false),
    labelColor: parseLabelColor(readRawInput('label-color', env) || 'blue'),
    tenantId: inputWithEnvFallback('tenant-id', 'DOIT_TENANT_ID', env),
    apiUrl: inputWithEnvFallback('api-url', 'DOIT_API_URL', env) ?? DEFAULT_API_URL,
    dryRun: parseBoolean(readRawInput('dry-run', env), false),
    failOnError: parseBoolean(readRawInput('fail-on-error', env), true),
    filter: optionalInput('filter', env),
    maxResults: parseMaxResults(readRawInput('max-results', env)),
    requireTag: optionalInput('require-tag', env),
    requireCommitTag: parseCsvList(readRawInput('require-commit-tag', env)),
    requirePrLabel: parseCsvList(readRawInput('require-pr-label', env)),
  };
}

export interface ExecuteActionOptions {
  env?: NodeJS.ProcessEnv;
  payload?: Record<string, unknown>;
  fetchImpl?: typeof fetch;
  now?: Date;
}

interface OperationArgs {
  client: DoitClient;
  inputs: ActionInputs;
  context: GitHubEventContext;
  renderedContent: string;
}

function maskSecrets(inputs: ActionInputs): void {
  if (inputs.doitApiKey) {
    core.setSecret(inputs.doitApiKey);
  }
  if (inputs.tenantId) {
    core.setSecret(inputs.tenantId);
  }
}

function recordSummary(
  result: ActionResult,
  inputs: ActionInputs,
  env: NodeJS.ProcessEnv
): ActionResult {
  writeStepSummary(buildStepSummaryMarkdown(result, inputs), env);
  return result;
}

function requireAnnotationId(inputs: ActionInputs): string {
  if (!inputs.annotationId) {
    throw new Error(`Input "annotation-id" is required when operation is "${inputs.operation}".`);
  }
  return inputs.annotationId;
}

function shouldUpdateContent(inputs: ActionInputs): boolean {
  return Boolean(inputs.content || inputs.template || inputs.releaseId);
}

function buildCreatePayload(
  inputs: ActionInputs,
  context: GitHubEventContext,
  content: string,
  labels: string[]
): CreateAnnotationRequest {
  return {
    content,
    timestamp: context.timestamp,
    ...(inputs.reports.length > 0 ? { reports: inputs.reports } : {}),
    ...(labels.length > 0 ? { labels } : {}),
  };
}

function buildUpdatePayload(
  inputs: ActionInputs,
  context: GitHubEventContext,
  content: string,
  labels: string[]
): UpdateAnnotationRequest {
  return {
    ...(shouldUpdateContent(inputs) ? { content } : {}),
    ...(inputs.timestamp ? { timestamp: context.timestamp } : {}),
    ...(inputs.reports.length > 0 ? { reports: inputs.reports } : {}),
    ...(labels.length > 0 ? { labels } : {}),
  };
}

function buildSkippedResult(
  inputs: ActionInputs,
  context: GitHubEventContext,
  skipReason: string | undefined
): ActionResult {
  return {
    operation: inputs.operation,
    dryRun: inputs.dryRun,
    skipped: true,
    skipReason,
    context,
  };
}

function buildDryRunResult(
  inputs: ActionInputs,
  context: GitHubEventContext,
  content: string
): ActionResult {
  const requestPayload =
    inputs.operation === 'update'
      ? buildUpdatePayload(inputs, context, content, inputs.labels)
      : buildCreatePayload(inputs, context, content, inputs.labels);
  return {
    operation: inputs.operation,
    dryRun: true,
    annotationId: inputs.annotationId || 'dry-run-annotation-id',
    annotationContent: content,
    annotationTimestamp: context.timestamp,
    resolvedLabels: inputs.labels,
    requestPayload,
    context,
  };
}

function resolveInputLabels({ client, inputs }: OperationArgs): Promise<string[]> {
  return client.resolveLabels(inputs.labels, {
    createMissing: inputs.createMissingLabels,
    defaultColor: inputs.labelColor,
  });
}

async function handleCreate(args: OperationArgs): Promise<ActionResult> {
  const { client, inputs, context, renderedContent } = args;
  const resolvedLabels = inputs.labels.length > 0 ? await resolveInputLabels(args) : [];
  const requestPayload = buildCreatePayload(inputs, context, renderedContent, resolvedLabels);
  const created = await client.createAnnotation(requestPayload);
  return {
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
}

async function handleUpdate(args: OperationArgs): Promise<ActionResult> {
  const { client, inputs, context, renderedContent } = args;
  const annotationId = requireAnnotationId(inputs);
  const resolvedLabels = inputs.labels.length > 0 ? await resolveInputLabels(args) : undefined;
  const requestPayload = buildUpdatePayload(inputs, context, renderedContent, resolvedLabels ?? []);
  const updated = await client.updateAnnotation(annotationId, requestPayload);
  return {
    operation: 'update',
    dryRun: false,
    annotationId: updated.id,
    annotationContent: updated.content,
    annotationTimestamp: updated.timestamp,
    annotation: updated,
    resolvedLabels,
    requestPayload,
    context,
  };
}

async function handleDelete({ client, inputs, context }: OperationArgs): Promise<ActionResult> {
  const annotationId = requireAnnotationId(inputs);
  await client.deleteAnnotation(annotationId);
  return { operation: 'delete', dryRun: false, annotationId, context };
}

async function handleGet({ client, inputs, context }: OperationArgs): Promise<ActionResult> {
  const fetched = await client.getAnnotation(requireAnnotationId(inputs));
  return {
    operation: 'get',
    dryRun: false,
    annotationId: fetched.id,
    annotationContent: fetched.content,
    annotationTimestamp: fetched.timestamp,
    annotation: fetched,
    context,
  };
}

async function handleList({ client, inputs, context }: OperationArgs): Promise<ActionResult> {
  const listed = await client.listAnnotations({
    filter: inputs.filter,
    maxResults: inputs.maxResults,
  });
  const annotations = listed.annotations ?? [];
  const first = annotations[0];
  return {
    operation: 'list',
    dryRun: false,
    annotationId: first?.id,
    annotationContent: first?.content,
    annotationTimestamp: first?.timestamp,
    annotations,
    context,
  };
}

function runOperation(args: OperationArgs): Promise<ActionResult> {
  switch (args.inputs.operation) {
    case 'create':
      return handleCreate(args);
    case 'update':
      return handleUpdate(args);
    case 'delete':
      return handleDelete(args);
    case 'get':
      return handleGet(args);
    case 'list':
      return handleList(args);
  }
}

export async function executeAction(
  inputs: ActionInputs,
  options?: ExecuteActionOptions
): Promise<ActionResult> {
  const env = options?.env ?? process.env;
  maskSecrets(inputs);

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
      return recordSummary(buildSkippedResult(inputs, context, filterResult.skipReason), inputs, env);
    }
  }

  const renderedContent = renderAnnotationContent(context, {
    content: inputs.content,
    template: inputs.template,
  });

  if (inputs.dryRun) {
    return recordSummary(buildDryRunResult(inputs, context, renderedContent), inputs, env);
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

  const result = await runOperation({ client, inputs, context, renderedContent });
  return recordSummary(result, inputs, env);
}

function buildAnnotationJson(result: ActionResult): string {
  return JSON.stringify(
    result.annotation ??
      result.annotations ??
      result.requestPayload ?? {
        id: result.annotationId,
        skipped: Boolean(result.skipped),
        skipReason: result.skipReason,
      }
  );
}

function publishOutputs(result: ActionResult): void {
  core.setOutput('annotation-id', result.annotationId ?? '');
  core.setOutput('annotation-content', result.annotationContent ?? '');
  core.setOutput('annotation-timestamp', result.annotationTimestamp ?? '');
  core.setOutput('annotation-skipped', result.skipped ? 'true' : 'false');
  core.setOutput('annotation-json', buildAnnotationJson(result));
}

function logCompletion(result: ActionResult): void {
  if (result.skipped) {
    core.info(`[Annotato] Skipped annotation: ${result.skipReason}`);
    return;
  }
  const dryRunMarker = result.dryRun ? '(DRY RUN) ' : '';
  const idSuffix = result.annotationId ? ` (id: ${result.annotationId})` : '';
  core.info(
    `[Annotato] ${dryRunMarker}Operation "${result.operation}" completed${idSuffix}.`
  );
}

export async function run(options?: ExecuteActionOptions): Promise<ActionResult | undefined> {
  const env = options?.env ?? process.env;
  let failOnError = true;
  try {
    const inputs = parseActionInputs(env);
    failOnError = inputs.failOnError;

    const result = await executeAction(inputs, options);
    publishOutputs(result);
    logCompletion(result);
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
