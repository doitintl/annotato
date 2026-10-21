import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as core from '@actions/core';
import { executeAction, parseActionInputs, run } from '../src/index.js';

function createMockFetch(
  handler: (url: string, init?: RequestInit) => Promise<{ status: number; body?: unknown }>
): typeof fetch {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const res = await handler(url, init);
    const text =
      res.body === undefined
        ? ''
        : typeof res.body === 'string'
          ? res.body
          : JSON.stringify(res.body);
    return {
      ok: res.status >= 200 && res.status < 300,
      status: res.status,
      statusText: res.status === 200 ? 'OK' : res.status === 201 ? 'Created' : 'Error',
      text: async () => text,
    } as Response;
  });
}

describe('Annotato Action Runner & Summary', () => {
  const tempFiles: string[] = [];

  function makeTempSummaryFile(): string {
    const file = path.join(
      os.tmpdir(),
      `annotato-summary-${Date.now()}-${Math.random().toString(36).slice(2)}.md`
    );
    fs.writeFileSync(file, '', 'utf8');
    tempFiles.push(file);
    return file;
  }

  afterEach(() => {
    vi.restoreAllMocks();
    for (const f of tempFiles.splice(0)) {
      if (fs.existsSync(f)) {
        fs.unlinkSync(f);
      }
    }
  });

  it('parses inputs from INPUT_* environment variables and validates enums', () => {
    const inputs = parseActionInputs({
      'INPUT_DOIT-API-KEY': 'my_key',
      INPUT_OPERATION: 'create',
      'INPUT_RELEASE-ID': 'v1.5.0',
      INPUT_REPORTS: 'rep_a, rep_b',
      INPUT_LABELS: 'production, release',
      'INPUT_CREATE-MISSING-LABELS': 'true',
      'INPUT_LABEL-COLOR': 'mint',
      'INPUT_DRY-RUN': 'true',
      'INPUT_FAIL-ON-ERROR': 'false',
    });

    expect(inputs.doitApiKey).toBe('my_key');
    expect(inputs.operation).toBe('create');
    expect(inputs.releaseId).toBe('v1.5.0');
    expect(inputs.reports).toEqual(['rep_a', 'rep_b']);
    expect(inputs.labels).toEqual(['production', 'release']);
    expect(inputs.createMissingLabels).toBe(true);
    expect(inputs.labelColor).toBe('mint');
    expect(inputs.dryRun).toBe(true);
    expect(inputs.failOnError).toBe(false);

    expect(() => parseActionInputs({ INPUT_OPERATION: 'invalid-op' })).toThrow(
      'Invalid operation "invalid-op"'
    );
    expect(() => parseActionInputs({ 'INPUT_LABEL-COLOR': 'neonGreen' })).toThrow(
      'Invalid label-color "neonGreen"'
    );
  });

  it('executes dry-run mode without making HTTP calls and writes GITHUB_STEP_SUMMARY', async () => {
    const summaryFile = makeTempSummaryFile();
    const mockFetch = vi.fn();

    const env: NodeJS.ProcessEnv = {
      'INPUT_DOIT-API-KEY': 'secret_token',
      'INPUT_DRY-RUN': 'true',
      INPUT_REPORTS: 'rep_123',
      INPUT_LABELS: 'prod-release',
      GITHUB_EVENT_NAME: 'release',
      GITHUB_REPOSITORY: 'doiteng/annotato',
      GITHUB_SHA: 'abcdef1234567890',
      GITHUB_ACTOR: 'eric',
      GITHUB_STEP_SUMMARY: summaryFile,
    };

    const inputs = parseActionInputs(env);
    const result = await executeAction(inputs, {
      env,
      payload: {
        release: {
          tag_name: 'v1.0.0',
          published_at: '2026-10-21T15:00:00Z',
        },
      },
      fetchImpl: mockFetch as unknown as typeof fetch,
    });

    expect(mockFetch).not.toHaveBeenCalled();
    expect(result.dryRun).toBe(true);
    expect(result.annotationId).toBe('dry-run-annotation-id');
    expect(result.annotationContent).toBe(
      '[doiteng/annotato] Release v1.0.0 (abcdef1) published by @eric'
    );
    expect(result.annotationTimestamp).toBe('2026-10-21T15:00:00.000Z');

    const summaryText = fs.readFileSync(summaryFile, 'utf8');
    expect(summaryText).toContain('DoiT Cloud Intelligence Annotation (Dry Run)');
    expect(summaryText).toContain('[doiteng/annotato] Release v1.0.0 (abcdef1) published by @eric');
    expect(summaryText).toContain('rep_123');
    expect(summaryText).toContain('prod-release');
  });

  it('executes create, update, get, list, and delete operations and masks the API secret', async () => {
    const summaryFile = makeTempSummaryFile();
    const setSecretSpy = vi.spyOn(core, 'setSecret').mockImplementation(() => {});
    const setOutputSpy = vi.spyOn(core, 'setOutput').mockImplementation(() => {});
    vi.spyOn(core, 'info').mockImplementation(() => {});

    const mockFetch = createMockFetch(async (url, init) => {
      if (init?.method === 'GET' && url.includes('/analytics/v1/labels')) {
        return {
          status: 200,
          body: {
            labels: [{ id: 'lbl_prod_1', name: 'production', color: 'blue' }],
          },
        };
      }
      if (init?.method === 'POST' && url.endsWith('/analytics/v1/annotations')) {
        const body = JSON.parse(init.body as string);
        return {
          status: 201,
          body: {
            id: 'ann_created_42',
            content: body.content,
            timestamp: body.timestamp,
            reports: body.reports,
            labels: [{ id: 'lbl_prod_1', name: 'production' }],
          },
        };
      }
      if (init?.method === 'PATCH' && url.endsWith('/analytics/v1/annotations/ann_created_42')) {
        const body = JSON.parse(init.body as string);
        return {
          status: 200,
          body: {
            id: 'ann_created_42',
            content: body.content ?? 'Updated content',
            timestamp: '2026-10-21T15:00:00.000Z',
          },
        };
      }
      if (init?.method === 'GET' && url.endsWith('/analytics/v1/annotations/ann_created_42')) {
        return {
          status: 200,
          body: {
            id: 'ann_created_42',
            content: 'Retrieved content',
            timestamp: '2026-10-21T15:00:00.000Z',
          },
        };
      }
      if (init?.method === 'GET' && url.includes('/analytics/v1/annotations')) {
        return {
          status: 200,
          body: {
            rowCount: 1,
            annotations: [
              {
                id: 'ann_created_42',
                content: 'Listed content',
                timestamp: '2026-10-21T15:00:00.000Z',
                labels: [{ id: 'lbl_prod_1', name: 'production' }],
              },
            ],
          },
        };
      }
      if (init?.method === 'DELETE' && url.endsWith('/analytics/v1/annotations/ann_created_42')) {
        return { status: 200, body: '' };
      }
      return { status: 404, body: { error: 'Not found' } };
    });

    const createEnv: NodeJS.ProcessEnv = {
      'INPUT_DOIT-API-KEY': 'live_secret_token',
      INPUT_OPERATION: 'create',
      INPUT_LABELS: 'production',
      INPUT_REPORTS: 'rep_99',
      GITHUB_EVENT_NAME: 'release',
      GITHUB_REPOSITORY: 'doiteng/annotato',
      GITHUB_SHA: '1122334455667788',
      GITHUB_ACTOR: 'eric',
      GITHUB_STEP_SUMMARY: summaryFile,
    };

    const createdResult = await run({
      env: createEnv,
      payload: {
        release: {
          tag_name: 'v2.0.0',
          published_at: '2026-10-21T15:00:00Z',
        },
      },
      fetchImpl: mockFetch,
    });

    expect(setSecretSpy).toHaveBeenCalledWith('live_secret_token');
    expect(createdResult?.annotationId).toBe('ann_created_42');
    expect(createdResult?.resolvedLabels).toEqual(['lbl_prod_1']);
    expect(setOutputSpy).toHaveBeenCalledWith('annotation-id', 'ann_created_42');

    // Update operation
    const updatedResult = await executeAction(
      parseActionInputs({
        'INPUT_DOIT-API-KEY': 'live_secret_token',
        INPUT_OPERATION: 'update',
        'INPUT_ANNOTATION-ID': 'ann_created_42',
        INPUT_CONTENT: 'Rolled back v2.0.0',
        GITHUB_STEP_SUMMARY: summaryFile,
      }),
      { fetchImpl: mockFetch }
    );
    expect(updatedResult.annotationContent).toBe('Rolled back v2.0.0');

    // Get operation
    const getResult = await executeAction(
      parseActionInputs({
        'INPUT_DOIT-API-KEY': 'live_secret_token',
        INPUT_OPERATION: 'get',
        'INPUT_ANNOTATION-ID': 'ann_created_42',
      }),
      { fetchImpl: mockFetch }
    );
    expect(getResult.annotationContent).toBe('Retrieved content');

    // List operation
    const listResult = await executeAction(
      parseActionInputs({
        'INPUT_DOIT-API-KEY': 'live_secret_token',
        INPUT_OPERATION: 'list',
        GITHUB_STEP_SUMMARY: summaryFile,
      }),
      { fetchImpl: mockFetch }
    );
    expect(listResult.annotations).toHaveLength(1);

    // Delete operation
    const deleteResult = await executeAction(
      parseActionInputs({
        'INPUT_DOIT-API-KEY': 'live_secret_token',
        INPUT_OPERATION: 'delete',
        'INPUT_ANNOTATION-ID': 'ann_created_42',
      }),
      { fetchImpl: mockFetch }
    );
    expect(deleteResult.annotationId).toBe('ann_created_42');
  });

  it('respects fail-on-error=false by emitting a warning instead of failing the action', async () => {
    const setFailedSpy = vi.spyOn(core, 'setFailed').mockImplementation(() => {});
    const warningSpy = vi.spyOn(core, 'warning').mockImplementation(() => {});

    const failingFetch = createMockFetch(async () => ({
      status: 503,
      body: { error: 'Service temporarily unavailable' },
    }));

    const res = await run({
      env: {
        'INPUT_DOIT-API-KEY': 'secret_token',
        'INPUT_FAIL-ON-ERROR': 'false',
      },
      fetchImpl: failingFetch,
    });

    expect(res).toBeUndefined();
    expect(setFailedSpy).not.toHaveBeenCalled();
    expect(warningSpy).toHaveBeenCalledWith(
      expect.stringContaining('Non-fatal error (fail-on-error=false)')
    );
  });

  it('skips creating an annotation without calling the DoiT API when require-commit-tag does not match', async () => {
    const summaryFile = makeTempSummaryFile();
    const setOutputSpy = vi.spyOn(core, 'setOutput').mockImplementation(() => {});
    vi.spyOn(core, 'info').mockImplementation(() => {});
    const mockFetch = vi.fn();

    const res = await run({
      env: {
        'INPUT_DOIT-API-KEY': 'live_secret_token',
        'INPUT_REQUIRE-COMMIT-TAG': '[annotate], [release]',
        GITHUB_EVENT_NAME: 'push',
        GITHUB_REPOSITORY: 'doiteng/annotato',
        GITHUB_REF: 'refs/heads/main',
        GITHUB_STEP_SUMMARY: summaryFile,
      },
      payload: {
        ref: 'refs/heads/main',
        head_commit: {
          id: 'abcdef1234567890',
          message: 'chore: routine typo fix',
          timestamp: '2026-10-21T15:00:00Z',
        },
      },
      fetchImpl: mockFetch as unknown as typeof fetch,
    });

    expect(mockFetch).not.toHaveBeenCalled();
    expect(res?.skipped).toBe(true);
    expect(setOutputSpy).toHaveBeenCalledWith('annotation-skipped', 'true');
    const summaryText = fs.readFileSync(summaryFile, 'utf8');
    expect(summaryText).toContain('⏭️ Skipped');
  });
});
