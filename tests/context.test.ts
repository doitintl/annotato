import { describe, expect, it } from 'vitest';
import {
  evaluateAnnotationFilters,
  extractGitHubContext,
  interpolateTemplate,
  parseCsvList,
  renderAnnotationContent,
} from '../src/context.js';

describe('extractGitHubContext and renderAnnotationContent', () => {
  it('extracts release metadata and published_at timestamp from a GitHub release event', () => {
    const ctx = extractGitHubContext({
      env: {
        GITHUB_EVENT_NAME: 'release',
        GITHUB_REPOSITORY: 'doiteng/annotato',
        GITHUB_SHA: '9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b',
        GITHUB_ACTOR: 'eric',
      },
      payload: {
        release: {
          tag_name: 'v2.4.0',
          name: 'v2.4.0 - FinOps Timeline',
          body: 'Added release annotations',
          published_at: '2026-10-21T12:30:00Z',
          html_url: 'https://github.com/doiteng/annotato/releases/tag/v2.4.0',
        },
      },
    });

    expect(ctx.eventName).toBe('release');
    expect(ctx.repo).toBe('doiteng/annotato');
    expect(ctx.tag).toBe('v2.4.0');
    expect(ctx.release).toBe('v2.4.0 - FinOps Timeline');
    expect(ctx.shortSha).toBe('9a8b7c6');
    expect(ctx.actor).toBe('eric');
    expect(ctx.timestamp).toBe('2026-10-21T12:30:00.000Z');
    expect(ctx.url).toBe('https://github.com/doiteng/annotato/releases/tag/v2.4.0');

    const content = renderAnnotationContent(ctx);
    expect(content).toBe(
      '[doiteng/annotato] Release v2.4.0 - FinOps Timeline (9a8b7c6) published by @eric'
    );
  });

  it('extracts commit metadata and timestamp from a GitHub push event', () => {
    const ctx = extractGitHubContext({
      env: {
        GITHUB_EVENT_NAME: 'push',
        GITHUB_REPOSITORY: 'acme/payments-service',
        GITHUB_SHA: '1234567890abcdef1234567890abcdef12345678',
        GITHUB_ACTOR: 'deploy-bot',
      },
      payload: {
        ref: 'refs/heads/main',
        head_commit: {
          id: '1234567890abcdef1234567890abcdef12345678',
          timestamp: '2026-10-21T08:15:30-04:00',
          url: 'https://github.com/acme/payments-service/commit/1234567',
        },
      },
    });

    expect(ctx.tag).toBe('main');
    expect(ctx.release).toBe('main');
    expect(ctx.shortSha).toBe('1234567');
    expect(ctx.timestamp).toBe('2026-10-21T12:15:30.000Z');

    const content = renderAnnotationContent(ctx);
    expect(content).toBe(
      '[acme/payments-service] Push main (1234567) to production by @deploy-bot'
    );
  });

  it('extracts environment and ref from a deployment_status event', () => {
    const ctx = extractGitHubContext({
      env: {
        GITHUB_EVENT_NAME: 'deployment_status',
        GITHUB_REPOSITORY: 'acme/api',
        GITHUB_ACTOR: 'sre-user',
      },
      payload: {
        deployment: {
          sha: 'abcdef0123456789abcdef0123456789abcdef01',
          ref: 'refs/tags/v3.1.2',
          environment: 'staging',
        },
        deployment_status: {
          environment: 'production-us-east1',
          updated_at: '2026-10-21T14:45:00Z',
          target_url: 'https://github.com/acme/api/deployments/1',
        },
      },
    });

    expect(ctx.release).toBe('v3.1.2');
    expect(ctx.shortSha).toBe('abcdef0');
    expect(ctx.environment).toBe('production-us-east1');
    expect(ctx.timestamp).toBe('2026-10-21T14:45:00.000Z');
    expect(renderAnnotationContent(ctx)).toBe(
      '[acme/api] Deployed v3.1.2 (abcdef0) to production-us-east1 by @sre-user'
    );
  });

  it('supports workflow_dispatch inputs and custom template interpolation', () => {
    const fallbackNow = new Date('2026-10-21T16:00:00.000Z');
    const ctx = extractGitHubContext({
      env: {
        GITHUB_EVENT_NAME: 'workflow_dispatch',
        GITHUB_REPOSITORY: 'doiteng/billing-worker',
        GITHUB_SHA: 'feedface12345678',
        GITHUB_ACTOR: 'eric',
        GITHUB_RUN_ID: '998877',
      },
      payload: {
        inputs: {
          version: 'v4.0.0-rc1',
          environment: 'eu-west1',
        },
      },
      now: fallbackNow,
    });

    expect(ctx.release).toBe('v4.0.0-rc1');
    expect(ctx.environment).toBe('eu-west1');
    expect(ctx.timestamp).toBe('2026-10-21T16:00:00.000Z');
    expect(ctx.url).toBe('https://github.com/doiteng/billing-worker/actions/runs/998877');

    const custom = renderAnnotationContent(ctx, {
      template: '🚀 {repo} released {release} [{short_sha}] to {environment} by {actor} ({url})',
    });
    expect(custom).toBe(
      '🚀 doiteng/billing-worker released v4.0.0-rc1 [feedfac] to eu-west1 by eric (https://github.com/doiteng/billing-worker/actions/runs/998877)'
    );
  });

  it('honors releaseIdOverride and timestampOverride and rejects invalid timestamps', () => {
    const ctx = extractGitHubContext({
      env: {
        GITHUB_EVENT_NAME: 'push',
        GITHUB_REPOSITORY: 'doiteng/annotato',
      },
      releaseIdOverride: 'hotfix-2026.10.21',
      timestampOverride: '2026-10-21T18:00:00Z',
    });

    expect(ctx.release).toBe('hotfix-2026.10.21');
    expect(ctx.timestamp).toBe('2026-10-21T18:00:00.000Z');

    expect(() =>
      extractGitHubContext({
        timestampOverride: 'invalid-date-value',
      })
    ).toThrow('Invalid timestamp "invalid-date-value"');
  });

  it('parses comma and newline separated lists cleanly', () => {
    expect(parseCsvList('rep_1, rep_2\nrep_3, rep_1 , ')).toEqual(['rep_1', 'rep_2', 'rep_3']);
    expect(parseCsvList('')).toEqual([]);
    expect(parseCsvList(undefined)).toEqual([]);
  });

  it('interpolates all supported placeholders in interpolateTemplate', () => {
    const ctx = extractGitHubContext({
      env: {
        GITHUB_EVENT_NAME: 'release',
        GITHUB_REPOSITORY: 'org/service',
        GITHUB_SHA: '1122334455667788',
        GITHUB_ACTOR: 'alice',
      },
      payload: {
        release: {
          tag_name: 'v1.0.0',
          published_at: '2026-10-21T10:00:00Z',
          html_url: 'https://github.com/org/service/releases/tag/v1.0.0',
        },
      },
    });

    const rendered = interpolateTemplate(
      '{repo}|{release}|{tag}|{sha}|{short_sha}|{actor}|{event}|{environment}|{url}|{timestamp}',
      ctx
    );
    expect(rendered).toBe(
      'org/service|v1.0.0|v1.0.0|1122334455667788|1122334|alice|release|production|https://github.com/org/service/releases/tag/v1.0.0|2026-10-21T10:00:00.000Z'
    );
  });

  it('evaluates require-tag, require-commit-tag, and require-pr-label filters accurately', () => {
    const branchPushCtx = extractGitHubContext({
      env: {
        GITHUB_EVENT_NAME: 'push',
        GITHUB_REPOSITORY: 'org/service',
        GITHUB_REF: 'refs/heads/main',
      },
      payload: {
        ref: 'refs/heads/main',
        head_commit: {
          id: '1122334455667788',
          message: 'chore: bump readme',
          timestamp: '2026-10-21T10:00:00Z',
        },
      },
    });

    // Fails require-tag when pushing to a branch instead of a v* tag
    expect(
      evaluateAnnotationFilters(branchPushCtx, {
        requireTag: 'v*',
        requireCommitTag: [],
        requirePrLabel: [],
      })
    ).toEqual({
      shouldAnnotate: false,
      skipReason: 'Tag/release "main" did not match require-tag pattern "v*".',
    });

    // Fails require-commit-tag when commit message lacks [annotate]
    expect(
      evaluateAnnotationFilters(branchPushCtx, {
        requireTag: undefined,
        requireCommitTag: ['[annotate]', '#finops'],
        requirePrLabel: [],
      })
    ).toEqual({
      shouldAnnotate: false,
      skipReason:
        'Commit/PR message did not contain any required marker ([annotate], #finops).',
    });

    // Passes require-commit-tag when commit message contains [annotate]
    const taggedCommitCtx = extractGitHubContext({
      env: {
        GITHUB_EVENT_NAME: 'push',
        GITHUB_REPOSITORY: 'org/service',
        GITHUB_REF: 'refs/heads/main',
      },
      payload: {
        ref: 'refs/heads/main',
        head_commit: {
          id: '1122334455667788',
          message: 'feat: migrate worker fleet to spot instances [annotate]',
          timestamp: '2026-10-21T10:00:00Z',
        },
      },
    });
    expect(
      evaluateAnnotationFilters(taggedCommitCtx, {
        requireTag: undefined,
        requireCommitTag: ['[annotate]'],
        requirePrLabel: [],
      })
    ).toEqual({ shouldAnnotate: true });

    // Evaluates require-pr-label on pull_request events
    const prCtx = extractGitHubContext({
      env: {
        GITHUB_EVENT_NAME: 'pull_request',
        GITHUB_REPOSITORY: 'org/service',
      },
      payload: {
        pull_request: {
          title: 'Major infra upgrade',
          labels: [{ name: 'finops-impact' }, { name: 'infra' }],
        },
      },
    });
    expect(
      evaluateAnnotationFilters(prCtx, {
        requireTag: undefined,
        requireCommitTag: [],
        requirePrLabel: ['annotate', 'finops-impact'],
      })
    ).toEqual({ shouldAnnotate: true });
  });
});
