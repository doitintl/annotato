import { describe, expect, it } from 'vitest';
import {
  evaluateAnnotationFilters,
  extractCleanCommitSubject,
  extractGitHubContext,
  interpolateTemplate,
  normalizeTimestamp,
  renderAnnotationContent,
} from '../src/context.js';

const NOW = new Date('2026-10-21T12:00:00.000Z');

function contextFor(
  env: NodeJS.ProcessEnv,
  payload: Record<string, unknown> = {},
  options: Parameters<typeof extractGitHubContext>[0] = {}
) {
  return extractGitHubContext({
    env: { GITHUB_REPOSITORY: 'org/service', ...env },
    payload,
    now: NOW,
    ...options,
  });
}

const branchPush = () =>
  contextFor(
    { GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/main' },
    { head_commit: { message: 'feat: thing [Annotate]' } }
  );

const tagPush = () =>
  contextFor({
    GITHUB_EVENT_NAME: 'push',
    GITHUB_REF: 'refs/tags/v1.0.0',
    GITHUB_REF_TYPE: 'tag',
    GITHUB_REF_NAME: 'v1.0.0',
  });

const noFilters = { requireTag: undefined, requireCommitTag: [], requirePrLabel: [] };

describe('evaluateAnnotationFilters', () => {
  describe('require-tag', () => {
    it.each(['true', '1', 'yes', '*', 'TRUE'])(
      'treats "%s" as "must be a tag or release" and skips branch refs',
      (value) => {
        expect(evaluateAnnotationFilters(branchPush(), { ...noFilters, requireTag: value })).toEqual({
          shouldAnnotate: false,
          skipReason: `Ref "main" is not a Git tag or release (require-tag="${value}").`,
        });
      }
    );

    it('passes tag refs and release events for the boolean-style values', () => {
      expect(evaluateAnnotationFilters(tagPush(), { ...noFilters, requireTag: 'true' })).toEqual({
        shouldAnnotate: true,
      });
      const release = contextFor(
        { GITHUB_EVENT_NAME: 'release' },
        { release: { tag_name: 'v2' } }
      );
      expect(evaluateAnnotationFilters(release, { ...noFilters, requireTag: 'yes' })).toEqual({
        shouldAnnotate: true,
      });
    });

    it.each(['false', '0', 'no', 'NO'])('treats "%s" as disabled', (value) => {
      expect(evaluateAnnotationFilters(branchPush(), { ...noFilters, requireTag: value })).toEqual({
        shouldAnnotate: true,
      });
    });

    it('ignores blank values', () => {
      expect(evaluateAnnotationFilters(branchPush(), { ...noFilters, requireTag: '   ' })).toEqual({
        shouldAnnotate: true,
      });
    });

    it('matches glob patterns against the tag, case-insensitively', () => {
      const ctx = tagPush();
      for (const pattern of ['v*', 'V*', 'v1.0.0', 'v?.0.0', 'v1.*.0', 'rc-*, v*', 'rc-*\nv*']) {
        expect(evaluateAnnotationFilters(ctx, { ...noFilters, requireTag: pattern })).toEqual({
          shouldAnnotate: true,
        });
      }
    });

    it('anchors glob patterns and treats regex metacharacters literally', () => {
      const ctx = tagPush();
      for (const pattern of ['v1.0', '1.0.0', 'v1.0.0.0', 'v1x0x0']) {
        expect(
          evaluateAnnotationFilters(ctx, { ...noFilters, requireTag: pattern }).shouldAnnotate
        ).toBe(false);
      }
    });

    it('also matches against the release name', () => {
      const release = contextFor(
        { GITHUB_EVENT_NAME: 'release' },
        { release: { tag_name: 'v9', name: 'Big Launch' } }
      );
      expect(evaluateAnnotationFilters(release, { ...noFilters, requireTag: 'Big*' })).toEqual({
        shouldAnnotate: true,
      });
    });

    it('reports the raw pattern when nothing matches', () => {
      expect(evaluateAnnotationFilters(tagPush(), { ...noFilters, requireTag: 'rc-*, beta' })).toEqual({
        shouldAnnotate: false,
        skipReason: 'Tag/release "v1.0.0" did not match require-tag pattern "rc-*, beta".',
      });
    });
  });

  describe('require-commit-tag', () => {
    it('matches markers case-insensitively', () => {
      expect(
        evaluateAnnotationFilters(branchPush(), { ...noFilters, requireCommitTag: ['[annotate]'] })
      ).toEqual({ shouldAnnotate: true });
    });

    it('passes when any one marker matches', () => {
      expect(
        evaluateAnnotationFilters(branchPush(), {
          ...noFilters,
          requireCommitTag: ['#nope', '[ANNOTATE]'],
        })
      ).toEqual({ shouldAnnotate: true });
    });

    it('skips with the marker list when none match, including an empty message', () => {
      const empty = contextFor({ GITHUB_EVENT_NAME: 'push' });
      expect(
        evaluateAnnotationFilters(empty, { ...noFilters, requireCommitTag: ['[a]', '[b]'] })
      ).toEqual({
        shouldAnnotate: false,
        skipReason: 'Commit/PR message did not contain any required marker ([a], [b]).',
      });
    });

    it('is skipped entirely when the marker list is empty', () => {
      expect(evaluateAnnotationFilters(branchPush(), noFilters)).toEqual({ shouldAnnotate: true });
    });
  });

  describe('require-pr-label', () => {
    const prContext = () =>
      contextFor(
        { GITHUB_EVENT_NAME: 'pull_request' },
        { pull_request: { labels: [{ name: 'finops-impact' }, { name: 'infra' }] } }
      );

    it('matches labels case-insensitively', () => {
      expect(
        evaluateAnnotationFilters(prContext(), { ...noFilters, requirePrLabel: ['FinOps-Impact'] })
      ).toEqual({ shouldAnnotate: true });
    });

    it('skips and lists existing and required labels when none match', () => {
      expect(
        evaluateAnnotationFilters(prContext(), {
          ...noFilters,
          requirePrLabel: ['annotate', 'release'],
        })
      ).toEqual({
        shouldAnnotate: false,
        skipReason:
          'Pull request labels [finops-impact, infra] did not match any required PR label (annotate, release).',
      });
    });

    it('skips when the context has no labels at all', () => {
      expect(
        evaluateAnnotationFilters(branchPush(), { ...noFilters, requirePrLabel: ['x'] })
      ).toEqual({
        shouldAnnotate: false,
        skipReason: 'Pull request labels [] did not match any required PR label (x).',
      });
    });
  });

  describe('filter order', () => {
    it('reports the require-tag failure first', () => {
      const result = evaluateAnnotationFilters(branchPush(), {
        requireTag: 'v*',
        requireCommitTag: ['#nope'],
        requirePrLabel: ['nope'],
      });
      expect(result.skipReason).toMatch(/^Tag\/release /);
    });

    it('reports the commit-tag failure before the label failure', () => {
      const result = evaluateAnnotationFilters(branchPush(), {
        requireTag: undefined,
        requireCommitTag: ['#nope'],
        requirePrLabel: ['nope'],
      });
      expect(result.skipReason).toMatch(/^Commit\/PR message /);
    });

    it('passes only when every filter passes', () => {
      const ctx = contextFor(
        {
          GITHUB_EVENT_NAME: 'push',
          GITHUB_REF: 'refs/tags/v1.0.0',
          GITHUB_REF_TYPE: 'tag',
          GITHUB_REF_NAME: 'v1.0.0',
          GITHUB_PR_LABELS: 'release',
        },
        { head_commit: { message: 'ship it [annotate]' } }
      );
      expect(
        evaluateAnnotationFilters(ctx, {
          requireTag: 'v*',
          requireCommitTag: ['[annotate]'],
          requirePrLabel: ['release'],
        })
      ).toEqual({ shouldAnnotate: true });
    });
  });
});

describe('extractGitHubContext', () => {
  describe('defaults', () => {
    it('falls back to safe defaults for an empty environment and payload', () => {
      const ctx = extractGitHubContext({ env: {}, payload: {}, now: NOW });
      expect(ctx).toEqual({
        eventName: 'workflow_dispatch',
        repo: 'unknown/repository',
        release: 'manual',
        tag: 'manual',
        sha: '',
        shortSha: '',
        actor: 'github-actions',
        environment: 'production',
        url: 'https://github.com/unknown/repository',
        timestamp: '2026-10-21T12:00:00.000Z',
        releaseName: undefined,
        releaseBody: undefined,
        isTagRef: false,
        commitMessage: '',
        prLabels: [],
      });
    });

    it('takes the repo from the payload when GITHUB_REPOSITORY is unset', () => {
      const ctx = extractGitHubContext({
        env: {},
        payload: { repository: { full_name: 'from/payload' } },
        now: NOW,
      });
      expect(ctx.repo).toBe('from/payload');
    });

    it('takes the actor from the payload sender when GITHUB_ACTOR is unset', () => {
      const ctx = extractGitHubContext({
        env: {},
        payload: { sender: { login: 'octocat' } },
        now: NOW,
      });
      expect(ctx.actor).toBe('octocat');
    });

    it('uses ENVIRONMENT from the env when no event-specific value exists', () => {
      expect(contextFor({ ENVIRONMENT: 'qa' }).environment).toBe('qa');
    });
  });

  describe('server and run URLs', () => {
    it('trims trailing slashes from the server URL and builds the run URL', () => {
      const ctx = contextFor({
        GITHUB_SERVER_URL: 'https://ghe.example.com//',
        GITHUB_RUN_ID: '5',
      });
      expect(ctx.url).toBe('https://ghe.example.com/org/service/actions/runs/5');
    });

    it('links to the repository when there is no run id', () => {
      expect(contextFor({}).url).toBe('https://github.com/org/service');
    });
  });

  describe('sha resolution', () => {
    it('prefers GITHUB_SHA, then head_commit, then PR merge commit, then deployment sha', () => {
      expect(
        contextFor({ GITHUB_SHA: '1111111aaaa' }, { head_commit: { id: '2222222bbbb' } }).sha
      ).toBe('1111111aaaa');
      expect(contextFor({}, { head_commit: { id: '2222222bbbb' } }).sha).toBe('2222222bbbb');
      expect(contextFor({}, { pull_request: { merge_commit_sha: '3333333cccc' } }).sha).toBe(
        '3333333cccc'
      );
      expect(contextFor({}, { deployment: { sha: '4444444dddd' } }).sha).toBe('4444444dddd');
    });

    it('derives a 7-character short sha', () => {
      const ctx = contextFor({ GITHUB_SHA: '0123456789abcdef' });
      expect(ctx.shortSha).toBe('0123456');
    });
  });

  describe('tag detection', () => {
    it('detects tags from GITHUB_REF_TYPE, GITHUB_REF, the payload ref, and release events', () => {
      expect(contextFor({ GITHUB_REF_TYPE: 'tag' }).isTagRef).toBe(true);
      expect(contextFor({ GITHUB_REF: 'refs/tags/v1' }).isTagRef).toBe(true);
      expect(contextFor({}, { ref: 'refs/tags/v1' }).isTagRef).toBe(true);
      expect(contextFor({ GITHUB_EVENT_NAME: 'release' }).isTagRef).toBe(true);
      expect(contextFor({ GITHUB_REF: 'refs/heads/main' }).isTagRef).toBe(false);
    });
  });

  describe('commit message and PR labels', () => {
    it('joins commit, PR, release and env messages in order, skipping blanks', () => {
      const ctx = contextFor(
        { GITHUB_COMMIT_MESSAGE: 'from-env' },
        {
          head_commit: { message: 'commit-msg' },
          pull_request: { title: 'pr-title', body: '  ' },
          release: { name: 'rel-name', body: 'rel-body' },
        }
      );
      expect(ctx.commitMessage).toBe('commit-msg\npr-title\nrel-name\nrel-body\nfrom-env');
    });

    it('merges payload and env PR labels without duplicates or blanks', () => {
      const ctx = contextFor(
        { GITHUB_PR_LABELS: 'b, c' },
        { pull_request: { labels: [' a ', { name: 'b' }, { name: '  ' }, {}] } }
      );
      expect(ctx.prLabels).toEqual(['a', 'b', 'c']);
    });
  });

  describe('release events', () => {
    const releasePayload = {
      release: {
        tag_name: 'v9',
        name: 'Big Launch',
        body: 'notes',
        published_at: '2026-10-21T10:00:00Z',
        created_at: '2026-10-20T10:00:00Z',
        html_url: 'https://github.com/org/service/releases/tag/v9',
      },
    };

    it('uses the release name as the release, and keeps the tag name as the tag', () => {
      const ctx = contextFor({ GITHUB_EVENT_NAME: 'release' }, releasePayload);
      expect(ctx).toMatchObject({
        tag: 'v9',
        release: 'Big Launch',
        releaseName: 'Big Launch',
        releaseBody: 'notes',
        timestamp: '2026-10-21T10:00:00.000Z',
        url: 'https://github.com/org/service/releases/tag/v9',
      });
    });

    it('falls back to the tag name when the release is unnamed', () => {
      const ctx = contextFor(
        { GITHUB_EVENT_NAME: 'release' },
        { release: { tag_name: 'v9' } }
      );
      expect(ctx.release).toBe('v9');
      expect(ctx.releaseName).toBeUndefined();
      expect(ctx.releaseBody).toBeUndefined();
    });

    it('falls back to created_at when published_at is missing', () => {
      const ctx = contextFor(
        { GITHUB_EVENT_NAME: 'release' },
        { release: { tag_name: 'v9', created_at: '2026-10-20T10:00:00Z' } }
      );
      expect(ctx.timestamp).toBe('2026-10-20T10:00:00.000Z');
    });

    it('lets releaseIdOverride win', () => {
      const ctx = contextFor({ GITHUB_EVENT_NAME: 'release' }, releasePayload, {
        releaseIdOverride: 'custom',
      });
      expect(ctx.release).toBe('custom');
      expect(ctx.tag).toBe('v9');
    });

    it('uses the run URL when the release has no html_url', () => {
      const ctx = contextFor(
        { GITHUB_EVENT_NAME: 'release', GITHUB_RUN_ID: '7' },
        { release: { tag_name: 'v9' } }
      );
      expect(ctx.url).toBe('https://github.com/org/service/actions/runs/7');
    });
  });

  describe('deployment events', () => {
    const deploymentPayload = {
      deployment: {
        ref: 'refs/heads/release-1',
        environment: 'staging',
        sha: 'cafebabe12345',
        created_at: '2026-10-20T00:00:00Z',
      },
      deployment_status: {
        environment: 'prod',
        updated_at: '2026-10-21T08:00:00Z',
        created_at: '2026-10-21T07:00:00Z',
        target_url: 'https://target.example.com',
        environment_url: 'https://env.example.com',
      },
    };

    it('prefers deployment_status values and strips the ref prefix', () => {
      const ctx = contextFor({ GITHUB_EVENT_NAME: 'deployment_status' }, deploymentPayload);
      expect(ctx).toMatchObject({
        tag: 'release-1',
        release: 'release-1',
        environment: 'prod',
        timestamp: '2026-10-21T08:00:00.000Z',
        url: 'https://target.example.com',
        sha: 'cafebabe12345',
      });
    });

    it('falls back through status created_at, environment_url, and deployment fields', () => {
      const ctx = contextFor(
        { GITHUB_EVENT_NAME: 'deployment_status' },
        {
          deployment: deploymentPayload.deployment,
          deployment_status: {
            created_at: '2026-10-21T07:00:00Z',
            environment_url: 'https://env.example.com',
          },
        }
      );
      expect(ctx.environment).toBe('staging');
      expect(ctx.timestamp).toBe('2026-10-21T07:00:00.000Z');
      expect(ctx.url).toBe('https://env.example.com');
    });

    it('falls back to the deployment created_at and the run URL', () => {
      const ctx = contextFor(
        { GITHUB_EVENT_NAME: 'deployment', GITHUB_RUN_ID: '3' },
        { deployment: deploymentPayload.deployment }
      );
      expect(ctx.timestamp).toBe('2026-10-20T00:00:00.000Z');
      expect(ctx.url).toBe('https://github.com/org/service/actions/runs/3');
    });

    it('keeps ENVIRONMENT when the payload names no environment', () => {
      const ctx = contextFor(
        { GITHUB_EVENT_NAME: 'deployment', ENVIRONMENT: 'qa' },
        { deployment: { ref: 'v1' } }
      );
      expect(ctx.environment).toBe('qa');
    });

    it('lets environmentOverride and releaseIdOverride win', () => {
      const ctx = contextFor({ GITHUB_EVENT_NAME: 'deployment_status' }, deploymentPayload, {
        environmentOverride: 'dr',
        releaseIdOverride: 'custom',
      });
      expect(ctx.environment).toBe('dr');
      expect(ctx.release).toBe('custom');
      expect(ctx.tag).toBe('release-1');
    });

    it('falls back to the ref name, short sha, then "deploy" for the tag', () => {
      expect(
        contextFor({ GITHUB_EVENT_NAME: 'deployment', GITHUB_REF_NAME: 'main' }).tag
      ).toBe('main');
      expect(
        contextFor({ GITHUB_EVENT_NAME: 'deployment', GITHUB_SHA: 'abcdef1234567' }).tag
      ).toBe('abcdef1');
      expect(contextFor({ GITHUB_EVENT_NAME: 'deployment' }).tag).toBe('deploy');
    });
  });

  describe('push events', () => {
    it('uses the payload ref for tag and release, and the head commit URL', () => {
      const ctx = contextFor(
        { GITHUB_EVENT_NAME: 'push' },
        {
          ref: 'refs/heads/feature/x',
          compare: 'https://compare.example.com',
          head_commit: {
            url: 'https://commit.example.com',
            timestamp: '2026-10-21T09:00:00Z',
          },
        }
      );
      expect(ctx).toMatchObject({
        tag: 'feature/x',
        release: 'feature/x',
        url: 'https://commit.example.com',
        timestamp: '2026-10-21T09:00:00.000Z',
      });
    });

    it('falls back to the compare URL, then the run URL', () => {
      expect(
        contextFor({ GITHUB_EVENT_NAME: 'push' }, { compare: 'https://compare.example.com' }).url
      ).toBe('https://compare.example.com');
      expect(contextFor({ GITHUB_EVENT_NAME: 'push', GITHUB_RUN_ID: '1' }).url).toBe(
        'https://github.com/org/service/actions/runs/1'
      );
    });

    it('falls back to "push" for the tag when nothing identifies the ref', () => {
      expect(contextFor({ GITHUB_EVENT_NAME: 'push' }).tag).toBe('push');
    });
  });

  describe('manual and other events', () => {
    it('prefers inputs.release, then version, then tag', () => {
      const event = { GITHUB_EVENT_NAME: 'workflow_dispatch' };
      expect(
        contextFor(event, { inputs: { release: 'r', version: 'v', tag: 't' } }).release
      ).toBe('r');
      expect(contextFor(event, { inputs: { version: 'v', tag: 't' } }).release).toBe('v');
      expect(contextFor(event, { inputs: { tag: 't' } }).release).toBe('t');
    });

    it('falls back to the ref name, then short sha, for the tag', () => {
      expect(contextFor({ GITHUB_REF_NAME: 'main' }).tag).toBe('main');
      expect(contextFor({ GITHUB_SHA: 'abcdef1234567' }).tag).toBe('abcdef1');
    });

    it('applies the environment input unless an override is given', () => {
      const payload = { inputs: { environment: 'dr' } };
      expect(contextFor({}, payload).environment).toBe('dr');
      expect(contextFor({}, payload, { environmentOverride: 'x' }).environment).toBe('x');
    });

    it('applies releaseIdOverride', () => {
      expect(contextFor({}, {}, { releaseIdOverride: 'custom' }).release).toBe('custom');
    });

    it('treats pull_request and other events like manual events', () => {
      const ctx = contextFor({ GITHUB_EVENT_NAME: 'pull_request' }, { inputs: { tag: 't' } });
      expect(ctx.tag).toBe('t');
      expect(ctx.timestamp).toBe('2026-10-21T12:00:00.000Z');
    });
  });

  describe('timestamp precedence', () => {
    const push = { GITHUB_EVENT_NAME: 'push' };
    const payload = { head_commit: { timestamp: '2026-10-21T09:00:00Z' } };

    it('prefers the override, then the detected value, then now', () => {
      expect(
        contextFor(push, payload, { timestampOverride: '2026-01-01T00:00:00Z' }).timestamp
      ).toBe('2026-01-01T00:00:00.000Z');
      expect(contextFor(push, payload).timestamp).toBe('2026-10-21T09:00:00.000Z');
      expect(contextFor(push, {}).timestamp).toBe('2026-10-21T12:00:00.000Z');
    });

    it('ignores a whitespace-only override', () => {
      expect(contextFor(push, payload, { timestampOverride: '   ' }).timestamp).toBe(
        '2026-10-21T09:00:00.000Z'
      );
    });

    it('rejects an invalid detected timestamp', () => {
      expect(() =>
        contextFor(push, { head_commit: { timestamp: 'not-a-date' } })
      ).toThrow('Invalid timestamp "not-a-date"');
    });
  });
});

describe('normalizeTimestamp', () => {
  it('returns the fallback for blank input', () => {
    expect(normalizeTimestamp('  ', NOW)).toBe('2026-10-21T12:00:00.000Z');
  });

  it('normalizes offsets to UTC', () => {
    expect(normalizeTimestamp('2026-10-21T10:00:00+02:00')).toBe('2026-10-21T08:00:00.000Z');
  });

  it('throws on invalid input', () => {
    expect(() => normalizeTimestamp('nope')).toThrow(
      'Invalid timestamp "nope". Expected ISO-8601 / RFC3339 date-time.'
    );
  });
});

describe('extractCleanCommitSubject', () => {
  it('returns the first non-blank line', () => {
    expect(extractCleanCommitSubject('\n  feat: x  \nbody')).toBe('feat: x');
  });

  it('skips Co-authored-by lines', () => {
    expect(extractCleanCommitSubject('Co-Authored-By: A <a@x>\nfix: y')).toBe('fix: y');
  });

  it('uses the second line for merge commits', () => {
    expect(extractCleanCommitSubject('Merge pull request #12 from a/b\nfix: real subject')).toBe(
      'fix: real subject'
    );
    expect(extractCleanCommitSubject('Merge pull request #12 from a/b')).toBe(
      'Merge pull request #12 from a/b'
    );
  });

  it('returns an empty string for empty input', () => {
    expect(extractCleanCommitSubject(undefined)).toBe('');
    expect(extractCleanCommitSubject('')).toBe('');
    expect(extractCleanCommitSubject('Co-authored-by: A <a@x>')).toBe('');
  });
});

describe('interpolateTemplate and renderAnnotationContent', () => {
  const ctx = contextFor(
    { GITHUB_EVENT_NAME: 'push', GITHUB_SHA: 'abcdef1234567', GITHUB_ACTOR: 'eric' },
    { ref: 'refs/heads/main', head_commit: { message: 'fix: subject\n\nbody text' } }
  );

  it('fills {message} with the clean commit subject, falling back to the release', () => {
    expect(interpolateTemplate('{message}', ctx)).toBe('fix: subject');
    const bare = contextFor({ GITHUB_EVENT_NAME: 'push' }, { ref: 'refs/heads/main' });
    expect(interpolateTemplate('{message}', bare)).toBe('main');
  });

  it('leaves unknown placeholders untouched', () => {
    expect(interpolateTemplate('{unknown} {tag}', ctx)).toBe('{unknown} main');
  });

  it('prefers content over template, trimmed and interpolated', () => {
    expect(renderAnnotationContent(ctx, { content: '  hi {tag}  ', template: 'ignored' })).toBe(
      'hi main'
    );
    expect(renderAnnotationContent(ctx, { content: '   ', template: 'T {tag}' })).toBe('T main');
  });

  it('renders event-specific defaults', () => {
    expect(renderAnnotationContent(ctx)).toBe(
      '[org/service] Push main (abcdef1) to production by @eric'
    );

    const release = contextFor(
      { GITHUB_EVENT_NAME: 'release', GITHUB_ACTOR: 'eric' },
      { release: { tag_name: 'v1' } }
    );
    expect(renderAnnotationContent(release)).toBe('[org/service] Release v1 published by @eric');

    const deployment = contextFor(
      { GITHUB_EVENT_NAME: 'deployment', GITHUB_SHA: 'abcdef1234567', GITHUB_ACTOR: 'eric' },
      { deployment: { ref: 'v2', environment: 'prod' } }
    );
    expect(renderAnnotationContent(deployment)).toBe(
      '[org/service] Deployed v2 (abcdef1) to prod by @eric'
    );

    const manual = contextFor({ GITHUB_ACTOR: 'eric' }, { inputs: { tag: 'v3' } });
    expect(renderAnnotationContent(manual)).toBe(
      '[org/service] Release v3 (workflow_dispatch) by @eric'
    );
  });
});
