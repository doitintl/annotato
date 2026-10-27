import * as fs from 'node:fs';
import { ActionInputs, GitHubEventContext } from './types.js';
import { trimTrailingSlashes } from './utils.js';

export interface ExtractContextOptions {
  env?: NodeJS.ProcessEnv;
  payload?: Record<string, unknown>;
  now?: Date;
  releaseIdOverride?: string;
  timestampOverride?: string;
  environmentOverride?: string;
}

function readEventPayloadFromEnv(env: NodeJS.ProcessEnv): Record<string, unknown> {
  const eventPath = env.GITHUB_EVENT_PATH?.trim();
  if (!eventPath) {
    return {};
  }
  try {
    if (fs.existsSync(eventPath)) {
      const content = fs.readFileSync(eventPath, 'utf8');
      const parsed = JSON.parse(content);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    }
  } catch {
    // Ignore malformed event payload files and fall back to env vars
  }
  return {};
}

function stripRefPrefix(ref?: string): string {
  if (!ref) return '';
  return ref.replace(/^refs\/(heads|tags|remotes)\//, '').trim();
}

function asString(val: unknown): string {
  return typeof val === 'string' ? val.trim() : '';
}

function asRecord(val: unknown): Record<string, unknown> {
  return val && typeof val === 'object' && !Array.isArray(val)
    ? (val as Record<string, unknown>)
    : {};
}

export function normalizeTimestamp(rawTimestamp: string, fallbackNow: Date = new Date()): string {
  const trimmed = rawTimestamp.trim();
  if (!trimmed) {
    return fallbackNow.toISOString();
  }
  const parsedMs = Date.parse(trimmed);
  if (Number.isNaN(parsedMs)) {
    throw new Error(`Invalid timestamp "${rawTimestamp}". Expected ISO-8601 / RFC3339 date-time.`);
  }
  return new Date(parsedMs).toISOString();
}

interface EventResolverInput {
  payload: Record<string, unknown>;
  options?: ExtractContextOptions;
  refName: string;
  shortSha: string;
  defaultRunUrl: string;
  defaultEnvironment: string;
}

interface EventFields {
  tag: string;
  release: string;
  environment: string;
  url: string;
  detectedTimestamp: string;
  releaseName?: string;
  releaseBody?: string;
}

function resolveReleaseEvent(input: EventResolverInput): EventFields {
  const { payload, options, refName, shortSha, defaultRunUrl, defaultEnvironment } = input;
  const releaseObj = asRecord(payload.release);
  const tag = asString(releaseObj.tag_name) || refName || shortSha || 'release';
  const releaseName = asString(releaseObj.name);
  return {
    tag,
    release: asString(options?.releaseIdOverride) || releaseName || tag,
    environment: defaultEnvironment,
    url: asString(releaseObj.html_url) || defaultRunUrl,
    detectedTimestamp: asString(releaseObj.published_at) || asString(releaseObj.created_at),
    releaseName: releaseName || undefined,
    releaseBody: asString(releaseObj.body) || undefined,
  };
}

function resolveDeploymentEvent(input: EventResolverInput): EventFields {
  const { payload, options, refName, shortSha, defaultRunUrl, defaultEnvironment } = input;
  const deployment = asRecord(payload.deployment);
  const deploymentStatus = asRecord(payload.deployment_status);
  const tag = stripRefPrefix(asString(deployment.ref)) || refName || shortSha || 'deploy';
  return {
    tag,
    release: asString(options?.releaseIdOverride) || tag,
    environment:
      asString(options?.environmentOverride) ||
      asString(deploymentStatus.environment) ||
      asString(deployment.environment) ||
      defaultEnvironment,
    url:
      asString(deploymentStatus.target_url) ||
      asString(deploymentStatus.environment_url) ||
      defaultRunUrl,
    detectedTimestamp:
      asString(deploymentStatus.updated_at) ||
      asString(deploymentStatus.created_at) ||
      asString(deployment.created_at),
  };
}

function resolvePushEvent(input: EventResolverInput): EventFields {
  const { payload, options, refName, shortSha, defaultRunUrl, defaultEnvironment } = input;
  const headCommit = asRecord(payload.head_commit);
  const tag = stripRefPrefix(asString(payload.ref)) || refName || shortSha || 'push';
  return {
    tag,
    release: asString(options?.releaseIdOverride) || tag,
    environment: defaultEnvironment,
    url: asString(headCommit.url) || asString(payload.compare) || defaultRunUrl,
    detectedTimestamp: asString(headCommit.timestamp),
  };
}

function resolveManualEvent(input: EventResolverInput): EventFields {
  const { payload, options, refName, shortSha, defaultRunUrl, defaultEnvironment } = input;
  const inputsObj = asRecord(payload.inputs);
  const inputRelease =
    asString(inputsObj.release) || asString(inputsObj.version) || asString(inputsObj.tag);
  const tag = inputRelease || refName || shortSha || 'manual';
  const inputEnvironment = asString(inputsObj.environment);
  const useInputEnvironment = inputEnvironment && !asString(options?.environmentOverride);
  return {
    tag,
    release: asString(options?.releaseIdOverride) || tag,
    environment: useInputEnvironment ? inputEnvironment : defaultEnvironment,
    url: defaultRunUrl,
    detectedTimestamp: '',
  };
}

function resolveEventFields(eventName: string, input: EventResolverInput): EventFields {
  switch (eventName) {
    case 'release':
      return resolveReleaseEvent(input);
    case 'deployment_status':
    case 'deployment':
      return resolveDeploymentEvent(input);
    case 'push':
      return resolvePushEvent(input);
    default:
      return resolveManualEvent(input);
  }
}

function resolveSha(env: NodeJS.ProcessEnv, payload: Record<string, unknown>): string {
  return (
    asString(env.GITHUB_SHA) ||
    asString(asRecord(payload.head_commit).id) ||
    asString(asRecord(payload.pull_request).merge_commit_sha) ||
    asString(asRecord(payload.deployment).sha) ||
    ''
  );
}

function resolveRefName(env: NodeJS.ProcessEnv, payload: Record<string, unknown>): string {
  return (
    asString(env.GITHUB_REF_NAME) ||
    stripRefPrefix(asString(env.GITHUB_REF)) ||
    stripRefPrefix(asString(payload.ref))
  );
}

function isTagRef(
  env: NodeJS.ProcessEnv,
  payload: Record<string, unknown>,
  eventName: string
): boolean {
  return (
    asString(env.GITHUB_REF_TYPE) === 'tag' ||
    asString(env.GITHUB_REF).startsWith('refs/tags/') ||
    asString(payload.ref).startsWith('refs/tags/') ||
    eventName === 'release'
  );
}

function resolveCommitMessage(env: NodeJS.ProcessEnv, payload: Record<string, unknown>): string {
  const prObj = asRecord(payload.pull_request);
  const releaseObj = asRecord(payload.release);
  return [
    asString(asRecord(payload.head_commit).message),
    asString(prObj.title),
    asString(prObj.body),
    asString(releaseObj.name),
    asString(releaseObj.body),
    asString(env.GITHUB_COMMIT_MESSAGE),
  ]
    .filter(Boolean)
    .join('\n')
    .trim();
}

function resolvePrLabels(env: NodeJS.ProcessEnv, payload: Record<string, unknown>): string[] {
  const payloadLabels = asRecord(payload.pull_request).labels;
  const fromPayload = Array.isArray(payloadLabels)
    ? payloadLabels
        .map((item) => (typeof item === 'string' ? item.trim() : asString(asRecord(item).name)))
        .filter(Boolean)
    : [];
  const fromEnv = parseCsvList(asString(env.GITHUB_PR_LABELS));
  return Array.from(new Set([...fromPayload, ...fromEnv]));
}

function resolveTimestamp(
  options: ExtractContextOptions | undefined,
  detectedTimestamp: string,
  now: Date
): string {
  if (options?.timestampOverride?.trim()) {
    return normalizeTimestamp(options.timestampOverride, now);
  }
  if (detectedTimestamp) {
    return normalizeTimestamp(detectedTimestamp, now);
  }
  return now.toISOString();
}

export function extractGitHubContext(options?: ExtractContextOptions): GitHubEventContext {
  const env = options?.env ?? process.env;
  const payload = options?.payload ?? readEventPayloadFromEnv(env);
  const now = options?.now ?? new Date();

  const eventName = asString(env.GITHUB_EVENT_NAME) || 'workflow_dispatch';
  const serverUrl = trimTrailingSlashes(asString(env.GITHUB_SERVER_URL) || 'https://github.com');
  const repo =
    asString(env.GITHUB_REPOSITORY) ||
    asString(asRecord(payload.repository).full_name) ||
    'unknown/repository';
  const sha = resolveSha(env, payload);
  const shortSha = sha.slice(0, 7);
  const runId = asString(env.GITHUB_RUN_ID);

  const event = resolveEventFields(eventName, {
    payload,
    options,
    refName: resolveRefName(env, payload),
    shortSha,
    defaultRunUrl: runId
      ? `${serverUrl}/${repo}/actions/runs/${runId}`
      : `${serverUrl}/${repo}`,
    defaultEnvironment:
      asString(options?.environmentOverride) || asString(env.ENVIRONMENT) || 'production',
  });

  return {
    eventName,
    repo,
    release: event.release,
    tag: event.tag,
    sha,
    shortSha,
    actor:
      asString(env.GITHUB_ACTOR) || asString(asRecord(payload.sender).login) || 'github-actions',
    environment: event.environment,
    url: event.url,
    timestamp: resolveTimestamp(options, event.detectedTimestamp, now),
    releaseName: event.releaseName,
    releaseBody: event.releaseBody,
    isTagRef: isTagRef(env, payload, eventName),
    commitMessage: resolveCommitMessage(env, payload),
    prLabels: resolvePrLabels(env, payload),
  };
}

export function extractCleanCommitSubject(rawMessage?: string): string {
  if (!rawMessage) return '';
  const lines = rawMessage
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !/^co-authored-by:/i.test(line));
  if (lines.length === 0) return '';
  if (/^merge pull request #\d+/i.test(lines[0]) && lines.length > 1) {
    return lines[1];
  }
  return lines[0];
}

export function interpolateTemplate(template: string, context: GitHubEventContext): string {
  const cleanMessage = extractCleanCommitSubject(context.commitMessage) || context.release;
  const replacements: Record<string, string> = {
    repo: context.repo,
    release: context.release,
    tag: context.tag,
    sha: context.sha,
    short_sha: context.shortSha,
    actor: context.actor,
    event: context.eventName,
    environment: context.environment,
    url: context.url,
    timestamp: context.timestamp,
    message: cleanMessage,
  };

  return template.replace(
    /\{(repo|release|tag|sha|short_sha|actor|event|environment|url|timestamp|message)\}/g,
    (_, key: string) => {
      return replacements[key] ?? '';
    }
  );
}

export function renderAnnotationContent(
  context: GitHubEventContext,
  options?: {
    content?: string;
    template?: string;
  }
): string {
  if (options?.content?.trim()) {
    return interpolateTemplate(options.content.trim(), context);
  }

  if (options?.template?.trim()) {
    return interpolateTemplate(options.template.trim(), context);
  }

  const shaSuffix = context.shortSha ? ` (${context.shortSha})` : '';

  if (context.eventName === 'release') {
    return `[${context.repo}] Release ${context.release}${shaSuffix} published by @${context.actor}`;
  }

  if (context.eventName === 'deployment_status' || context.eventName === 'deployment') {
    return `[${context.repo}] Deployed ${context.release}${shaSuffix} to ${context.environment} by @${context.actor}`;
  }

  if (context.eventName === 'push') {
    return `[${context.repo}] Push ${context.release}${shaSuffix} to ${context.environment} by @${context.actor}`;
  }

  return `[${context.repo}] Release ${context.release}${shaSuffix} (${context.eventName}) by @${context.actor}`;
}

export function parseCsvList(raw?: string): string[] {
  if (!raw) return [];
  return Array.from(
    new Set(
      raw
        .split(/[,\n]/)
        .map((item) => item.trim())
        .filter((item) => item.length > 0)
    )
  );
}

function matchesGlobPattern(value: string, pattern: string): boolean {
  const escaped = pattern
    .trim()
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, 'i').test(value.trim());
}

const REQUIRE_TAG_ANY_TAG_VALUES = ['true', '1', 'yes', '*'];
const REQUIRE_TAG_DISABLED_VALUES = ['false', '0', 'no'];

function checkRequireTag(context: GitHubEventContext, requireTag?: string): string | undefined {
  const raw = requireTag?.trim();
  if (!raw) return undefined;

  const normalized = raw.toLowerCase();
  if (REQUIRE_TAG_ANY_TAG_VALUES.includes(normalized)) {
    return context.isTagRef
      ? undefined
      : `Ref "${context.tag}" is not a Git tag or release (require-tag="${raw}").`;
  }
  if (REQUIRE_TAG_DISABLED_VALUES.includes(normalized)) return undefined;

  const candidates = [context.tag, context.release].filter(Boolean);
  const matched = parseCsvList(raw).some((pattern) =>
    candidates.some((candidate) => matchesGlobPattern(candidate, pattern))
  );
  return matched
    ? undefined
    : `Tag/release "${context.tag}" did not match require-tag pattern "${raw}".`;
}

function checkRequireCommitTag(
  context: GitHubEventContext,
  markers?: string[]
): string | undefined {
  if (!markers || markers.length === 0) return undefined;

  const messageLower = (context.commitMessage || '').toLowerCase();
  const matched = markers.some((marker) => messageLower.includes(marker.toLowerCase()));
  return matched
    ? undefined
    : `Commit/PR message did not contain any required marker (${markers.join(', ')}).`;
}

function checkRequirePrLabel(
  context: GitHubEventContext,
  requiredLabels?: string[]
): string | undefined {
  if (!requiredLabels || requiredLabels.length === 0) return undefined;

  const existingLabels = context.prLabels ?? [];
  const existingLower = existingLabels.map((label) => label.toLowerCase());
  const matched = requiredLabels.some((required) =>
    existingLower.includes(required.toLowerCase())
  );
  return matched
    ? undefined
    : `Pull request labels [${existingLabels.join(', ')}] did not match any required PR label (${requiredLabels.join(', ')}).`;
}

export function evaluateAnnotationFilters(
  context: GitHubEventContext,
  inputs: Pick<ActionInputs, 'requireTag' | 'requireCommitTag' | 'requirePrLabel'>
): { shouldAnnotate: boolean; skipReason?: string } {
  const skipReason =
    checkRequireTag(context, inputs.requireTag) ??
    checkRequireCommitTag(context, inputs.requireCommitTag) ??
    checkRequirePrLabel(context, inputs.requirePrLabel);
  return skipReason ? { shouldAnnotate: false, skipReason } : { shouldAnnotate: true };
}
