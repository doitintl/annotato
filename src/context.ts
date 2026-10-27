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

export function extractGitHubContext(options?: ExtractContextOptions): GitHubEventContext {
  const env = options?.env ?? process.env;
  const payload = options?.payload ?? readEventPayloadFromEnv(env);
  const now = options?.now ?? new Date();

  const eventName = asString(env.GITHUB_EVENT_NAME) || 'workflow_dispatch';
  const serverUrl = trimTrailingSlashes(asString(env.GITHUB_SERVER_URL) || 'https://github.com');
  const repoObj = asRecord(payload.repository);
  const repo =
    asString(env.GITHUB_REPOSITORY) || asString(repoObj.full_name) || 'unknown/repository';

  const headCommit = asRecord(payload.head_commit);
  const deployment = asRecord(payload.deployment);
  const deploymentStatus = asRecord(payload.deployment_status);
  const releaseObj = asRecord(payload.release);
  const prObj = asRecord(payload.pull_request);
  const inputsObj = asRecord(payload.inputs);

  const sha =
    asString(env.GITHUB_SHA) ||
    asString(headCommit.id) ||
    asString(asRecord(prObj.merge_commit_sha)) ||
    asString(prObj.merge_commit_sha) ||
    asString(deployment.sha) ||
    '';
  const shortSha = sha ? sha.slice(0, 7) : '';

  const rawGithubRef = asString(env.GITHUB_REF);
  const rawPayloadRef = asString(payload.ref);
  const isTagRef =
    asString(env.GITHUB_REF_TYPE) === 'tag' ||
    rawGithubRef.startsWith('refs/tags/') ||
    rawPayloadRef.startsWith('refs/tags/') ||
    eventName === 'release';

  const refName =
    asString(env.GITHUB_REF_NAME) ||
    stripRefPrefix(rawGithubRef) ||
    stripRefPrefix(rawPayloadRef);

  const messageParts = [
    asString(headCommit.message),
    asString(prObj.title),
    asString(prObj.body),
    asString(releaseObj.name),
    asString(releaseObj.body),
    asString(env.GITHUB_COMMIT_MESSAGE),
  ].filter(Boolean);
  const commitMessage = messageParts.join('\n').trim();

  const rawPrLabels = Array.isArray(prObj.labels)
    ? prObj.labels
        .map((item) =>
          typeof item === 'string' ? item.trim() : asString(asRecord(item).name)
        )
        .filter(Boolean)
    : [];
  const envPrLabels = parseCsvList(asString(env.GITHUB_PR_LABELS));
  const prLabels = Array.from(new Set([...rawPrLabels, ...envPrLabels]));

  const senderObj = asRecord(payload.sender);
  const actor =
    asString(env.GITHUB_ACTOR) || asString(senderObj.login) || 'github-actions';

  const runId = asString(env.GITHUB_RUN_ID);
  const defaultRunUrl = runId
    ? `${serverUrl}/${repo}/actions/runs/${runId}`
    : `${serverUrl}/${repo}`;

  let tag = refName || shortSha || 'latest';
  let release = '';
  let environment =
    asString(options?.environmentOverride) || asString(env.ENVIRONMENT) || 'production';
  let url = defaultRunUrl;
  let detectedTimestamp = '';
  let releaseName: string | undefined;
  let releaseBody: string | undefined;

  if (eventName === 'release') {
    const tagName = asString(releaseObj.tag_name) || refName || shortSha || 'release';
    const relName = asString(releaseObj.name);
    tag = tagName;
    release = asString(options?.releaseIdOverride) || relName || tagName;
    releaseName = relName || undefined;
    releaseBody = asString(releaseObj.body) || undefined;
    detectedTimestamp =
      asString(releaseObj.published_at) || asString(releaseObj.created_at);
    url = asString(releaseObj.html_url) || defaultRunUrl;
  } else if (eventName === 'deployment_status' || eventName === 'deployment') {
    const deployRef = stripRefPrefix(asString(deployment.ref)) || refName || shortSha || 'deploy';
    tag = deployRef;
    release = asString(options?.releaseIdOverride) || deployRef;
    environment =
      asString(options?.environmentOverride) ||
      asString(deploymentStatus.environment) ||
      asString(deployment.environment) ||
      environment;
    detectedTimestamp =
      asString(deploymentStatus.updated_at) ||
      asString(deploymentStatus.created_at) ||
      asString(deployment.created_at);
    url =
      asString(deploymentStatus.target_url) ||
      asString(deploymentStatus.environment_url) ||
      defaultRunUrl;
  } else if (eventName === 'push') {
    const pushRef = stripRefPrefix(asString(payload.ref)) || refName || shortSha || 'push';
    tag = pushRef;
    release = asString(options?.releaseIdOverride) || pushRef;
    detectedTimestamp = asString(headCommit.timestamp);
    url = asString(headCommit.url) || asString(payload.compare) || defaultRunUrl;
  } else {
    const inputRelease =
      asString(inputsObj.release) ||
      asString(inputsObj.version) ||
      asString(inputsObj.tag);
    tag = inputRelease || refName || shortSha || 'manual';
    release = asString(options?.releaseIdOverride) || tag;
    if (asString(inputsObj.environment) && !asString(options?.environmentOverride)) {
      environment = asString(inputsObj.environment);
    }
  }

  const timestamp = options?.timestampOverride?.trim()
    ? normalizeTimestamp(options.timestampOverride, now)
    : detectedTimestamp
      ? normalizeTimestamp(detectedTimestamp, now)
      : now.toISOString();

  return {
    eventName,
    repo,
    release,
    tag,
    sha,
    shortSha,
    actor,
    environment,
    url,
    timestamp,
    releaseName,
    releaseBody,
    isTagRef,
    commitMessage,
    prLabels,
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

export function evaluateAnnotationFilters(
  context: GitHubEventContext,
  inputs: Pick<ActionInputs, 'requireTag' | 'requireCommitTag' | 'requirePrLabel'>
): { shouldAnnotate: boolean; skipReason?: string } {
  const rawRequireTag = inputs.requireTag?.trim();
  if (rawRequireTag) {
    const normalized = rawRequireTag.toLowerCase();
    if (['true', '1', 'yes', '*'].includes(normalized)) {
      if (!context.isTagRef) {
        return {
          shouldAnnotate: false,
          skipReason: `Ref "${context.tag}" is not a Git tag or release (require-tag="${rawRequireTag}").`,
        };
      }
    } else if (!['false', '0', 'no'].includes(normalized)) {
      const patterns = parseCsvList(rawRequireTag);
      const candidates = [context.tag, context.release].filter(Boolean);
      const matched = patterns.some((pattern) =>
        candidates.some((cand) => matchesGlobPattern(cand, pattern))
      );
      if (!matched) {
        return {
          shouldAnnotate: false,
          skipReason: `Tag/release "${context.tag}" did not match require-tag pattern "${rawRequireTag}".`,
        };
      }
    }
  }

  if (inputs.requireCommitTag && inputs.requireCommitTag.length > 0) {
    const messageLower = (context.commitMessage || '').toLowerCase();
    const matchedTag = inputs.requireCommitTag.some((marker) =>
      messageLower.includes(marker.toLowerCase())
    );
    if (!matchedTag) {
      return {
        shouldAnnotate: false,
        skipReason: `Commit/PR message did not contain any required marker (${inputs.requireCommitTag.join(', ')}).`,
      };
    }
  }

  if (inputs.requirePrLabel && inputs.requirePrLabel.length > 0) {
    const existingLabels = (context.prLabels ?? []).map((l) => l.toLowerCase());
    const matchedLabel = inputs.requirePrLabel.some((reqLabel) =>
      existingLabels.includes(reqLabel.toLowerCase())
    );
    if (!matchedLabel) {
      return {
        shouldAnnotate: false,
        skipReason: `Pull request labels [${(context.prLabels ?? []).join(', ')}] did not match any required PR label (${inputs.requirePrLabel.join(', ')}).`,
      };
    }
  }

  return { shouldAnnotate: true };
}
