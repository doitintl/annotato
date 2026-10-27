import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as core from '@actions/core';
import { executeAction, parseActionInputs, run } from '../src/index.js';

const NOW = new Date('2026-10-21T12:00:00.000Z');
const RELEASE_PAYLOAD = {
  release: { tag_name: 'v1', published_at: '2026-10-21T10:00:00Z' },
};
const DEFAULT_CONTENT = '[org/service] Release v1 (1122334) published by @eric';
const DEFAULT_TIMESTAMP = '2026-10-21T10:00:00.000Z';

interface Call {
  url: string;
  method?: string;
  body?: Record<string, unknown>;
}

function recordingFetch(respond: (call: Call) => { status: number; body?: unknown }) {
  const calls: Call[] = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      method: init?.method,
      body: init?.body ? JSON.parse(init.body as string) : undefined,
    };
    calls.push(call);
    const res = respond(call);
    const text = res.body === undefined ? '' : JSON.stringify(res.body);
    return {
      ok: res.status >= 200 && res.status < 300,
      status: res.status,
      statusText: 'X',
      text: async () => text,
    } as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function baseEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    'INPUT_DOIT-API-KEY': 'test_key',
    GITHUB_EVENT_NAME: 'release',
    GITHUB_REPOSITORY: 'org/service',
    GITHUB_SHA: '1122334455667788',
    GITHUB_ACTOR: 'eric',
    ...extra,
  };
}

async function execute(
  env: NodeJS.ProcessEnv,
  fetchImpl?: typeof fetch,
  payload: Record<string, unknown> = RELEASE_PAYLOAD
) {
  return executeAction(parseActionInputs(env), { env, payload, fetchImpl, now: NOW });
}

function outputOf(spy: ReturnType<typeof vi.spyOn>, name: string): string | undefined {
  const call = spy.mock.calls.find((args: unknown[]) => args[0] === name);
  return call?.[1] as string | undefined;
}

describe('executeAction', () => {
  beforeEach(() => {
    vi.spyOn(core, 'setSecret').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('dry run payloads', () => {
    it('builds a create payload with only the non-empty optional fields', async () => {
      const bare = await execute(baseEnv({ 'INPUT_DRY-RUN': 'true' }));
      expect(bare.requestPayload).toEqual({ content: DEFAULT_CONTENT, timestamp: DEFAULT_TIMESTAMP });
      expect(Object.keys(bare.requestPayload ?? {}).sort()).toEqual(['content', 'timestamp']);

      const full = await execute(
        baseEnv({ 'INPUT_DRY-RUN': 'true', INPUT_REPORTS: 'r1', INPUT_LABELS: 'l1' })
      );
      expect(full.requestPayload).toEqual({
        content: DEFAULT_CONTENT,
        timestamp: DEFAULT_TIMESTAMP,
        reports: ['r1'],
        labels: ['l1'],
      });
    });

    it('builds an update payload containing only what was requested', async () => {
      const reportsOnly = await execute(
        baseEnv({ 'INPUT_DRY-RUN': 'true', INPUT_OPERATION: 'update', INPUT_REPORTS: 'r1' })
      );
      expect(reportsOnly.requestPayload).toEqual({ reports: ['r1'] });
      expect(Object.keys(reportsOnly.requestPayload ?? {})).toEqual(['reports']);

      const withContent = await execute(
        baseEnv({
          'INPUT_DRY-RUN': 'true',
          INPUT_OPERATION: 'update',
          INPUT_CONTENT: 'hi {tag}',
          INPUT_LABELS: 'l1',
        })
      );
      expect(withContent.requestPayload).toEqual({ content: 'hi v1', labels: ['l1'] });
    });

    it('includes content in an update payload when only release-id or template is given', async () => {
      const releaseId = await execute(
        baseEnv({
          'INPUT_DRY-RUN': 'true',
          INPUT_OPERATION: 'update',
          'INPUT_RELEASE-ID': 'v2',
        })
      );
      expect(releaseId.requestPayload).toEqual({
        content: '[org/service] Release v2 (1122334) published by @eric',
      });

      const template = await execute(
        baseEnv({
          'INPUT_DRY-RUN': 'true',
          INPUT_OPERATION: 'update',
          INPUT_TEMPLATE: 'T {release}',
        })
      );
      expect(template.requestPayload).toEqual({ content: 'T v1' });
    });

    it('includes a normalized timestamp in an update payload only when one was given', async () => {
      const result = await execute(
        baseEnv({
          'INPUT_DRY-RUN': 'true',
          INPUT_OPERATION: 'update',
          INPUT_TIMESTAMP: '2026-01-01T00:00:00Z',
        })
      );
      expect(result.requestPayload).toEqual({ timestamp: '2026-01-01T00:00:00.000Z' });
    });

    it('returns the dry-run result shape and never calls the API', async () => {
      const { fetchImpl, calls } = recordingFetch(() => ({ status: 500 }));
      const result = await execute(
        baseEnv({ 'INPUT_DRY-RUN': 'true', INPUT_LABELS: 'l1', 'INPUT_ANNOTATION-ID': 'ann_9' }),
        fetchImpl
      );
      expect(calls).toHaveLength(0);
      expect(result).toMatchObject({
        operation: 'create',
        dryRun: true,
        annotationId: 'ann_9',
        annotationContent: DEFAULT_CONTENT,
        annotationTimestamp: DEFAULT_TIMESTAMP,
        resolvedLabels: ['l1'],
      });
    });

    it('uses a placeholder annotation id when none was given', async () => {
      const result = await execute(baseEnv({ 'INPUT_DRY-RUN': 'true' }));
      expect(result.annotationId).toBe('dry-run-annotation-id');
    });

    it('does not require an API key', async () => {
      const env = baseEnv({ 'INPUT_DRY-RUN': 'true' });
      delete env['INPUT_DOIT-API-KEY'];
      await expect(execute(env)).resolves.toMatchObject({ dryRun: true });
    });
  });

  describe('filtering', () => {
    const skippingEnv = (extra: NodeJS.ProcessEnv = {}) =>
      baseEnv({
        GITHUB_EVENT_NAME: 'push',
        'INPUT_REQUIRE-COMMIT-TAG': '[annotate]',
        ...extra,
      });
    const pushPayload = { ref: 'refs/heads/main', head_commit: { message: 'chore: nothing' } };

    it('skips create operations and returns a skipped result', async () => {
      const { fetchImpl, calls } = recordingFetch(() => ({ status: 500 }));
      const result = await execute(skippingEnv(), fetchImpl, pushPayload);
      expect(calls).toHaveLength(0);
      expect(result).toMatchObject({ operation: 'create', dryRun: false, skipped: true });
      expect(result.skipReason).toContain('did not contain any required marker');
      expect(result.annotationId).toBeUndefined();
    });

    it('keeps the dry-run flag on a skipped result', async () => {
      const result = await execute(skippingEnv({ 'INPUT_DRY-RUN': 'true' }), undefined, pushPayload);
      expect(result).toMatchObject({ dryRun: true, skipped: true });
    });

    it('does not apply filters to non-create operations', async () => {
      const result = await execute(
        skippingEnv({ 'INPUT_DRY-RUN': 'true', INPUT_OPERATION: 'update' }),
        undefined,
        pushPayload
      );
      expect(result.skipped).toBeUndefined();
      expect(result.requestPayload).toBeDefined();
    });

    it('writes the step summary for skipped runs', async () => {
      const file = path.join(os.tmpdir(), `annotato-exec-${Date.now()}-${Math.random()}.md`);
      fs.writeFileSync(file, '');
      try {
        await execute(skippingEnv({ GITHUB_STEP_SUMMARY: file }), undefined, pushPayload);
        expect(fs.readFileSync(file, 'utf8')).toContain('⏭️ Skipped');
      } finally {
        fs.unlinkSync(file);
      }
    });
  });

  describe('input validation', () => {
    it('requires an API key for non-dry-run operations', async () => {
      const env = baseEnv();
      delete env['INPUT_DOIT-API-KEY'];
      await expect(execute(env)).rejects.toThrow(
        'Missing required input "doit-api-key" (or DOIT_API_KEY environment variable).'
      );
    });

    it.each(['update', 'delete', 'get'])(
      'requires annotation-id for %s before calling the API',
      async (operation) => {
        const { fetchImpl, calls } = recordingFetch(() => ({ status: 200 }));
        await expect(execute(baseEnv({ INPUT_OPERATION: operation }), fetchImpl)).rejects.toThrow(
          `Input "annotation-id" is required when operation is "${operation}".`
        );
        expect(calls).toHaveLength(0);
      }
    );

    it('masks the API key and tenant id', async () => {
      const setSecret = vi.spyOn(core, 'setSecret').mockImplementation(() => {});
      await execute(baseEnv({ 'INPUT_DRY-RUN': 'true', 'INPUT_TENANT-ID': 'tenant_1' }));
      expect(setSecret).toHaveBeenCalledWith('test_key');
      expect(setSecret).toHaveBeenCalledWith('tenant_1');
    });
  });

  describe('create', () => {
    const created = { id: 'ann_1', content: 'c', timestamp: 't' };

    it('sends content, timestamp and reports, but no labels key when there are none', async () => {
      const { fetchImpl, calls } = recordingFetch(() => ({ status: 201, body: created }));
      const result = await execute(baseEnv({ INPUT_REPORTS: 'r1' }), fetchImpl);
      expect(calls).toHaveLength(1);
      expect(calls[0].method).toBe('POST');
      expect(calls[0].body).toEqual({
        content: DEFAULT_CONTENT,
        timestamp: DEFAULT_TIMESTAMP,
        reports: ['r1'],
      });
      expect(result).toMatchObject({
        operation: 'create',
        dryRun: false,
        annotationId: 'ann_1',
        annotationContent: 'c',
        annotationTimestamp: 't',
        annotation: created,
        resolvedLabels: [],
      });
    });

    it('sends resolved label ids rather than the raw input labels', async () => {
      const { fetchImpl, calls } = recordingFetch((call) =>
        call.url.includes('/analytics/v1/labels')
          ? { status: 200, body: { labels: [{ id: 'l_prod', name: 'prod' }] } }
          : { status: 201, body: created }
      );
      const result = await execute(baseEnv({ INPUT_LABELS: 'prod' }), fetchImpl);
      const post = calls.find((c) => c.method === 'POST');
      expect(post?.body?.labels).toEqual(['l_prod']);
      expect(result.resolvedLabels).toEqual(['l_prod']);
    });

    it('omits the labels key when no label could be resolved', async () => {
      const { fetchImpl, calls } = recordingFetch((call) =>
        call.url.includes('/analytics/v1/labels') ? { status: 403 } : { status: 201, body: created }
      );
      const result = await execute(baseEnv({ INPUT_LABELS: 'prod' }), fetchImpl);
      const post = calls.find((c) => c.method === 'POST');
      expect(post?.body).not.toHaveProperty('labels');
      expect(result.resolvedLabels).toEqual([]);
    });
  });

  describe('update', () => {
    const updated = { id: 'ann_1', content: 'u', timestamp: 't' };
    const updateEnv = (extra: NodeJS.ProcessEnv = {}) =>
      baseEnv({ INPUT_OPERATION: 'update', 'INPUT_ANNOTATION-ID': 'ann_1', ...extra });

    it('patches only the fields that were requested', async () => {
      const { fetchImpl, calls } = recordingFetch(() => ({ status: 200, body: updated }));
      const result = await execute(updateEnv({ INPUT_REPORTS: 'r1' }), fetchImpl);
      expect(calls).toHaveLength(1);
      expect(calls[0].method).toBe('PATCH');
      expect(calls[0].url).toMatch(/\/analytics\/v1\/annotations\/ann_1$/);
      expect(calls[0].body).toEqual({ reports: ['r1'] });
      expect(Object.keys(calls[0].body ?? {})).toEqual(['reports']);
      expect(result).toMatchObject({
        operation: 'update',
        dryRun: false,
        annotationId: 'ann_1',
        annotationContent: 'u',
        annotation: updated,
        requestPayload: { reports: ['r1'] },
      });
      expect(result.resolvedLabels).toBeUndefined();
    });

    it('patches rendered content and normalized timestamp when requested', async () => {
      const { fetchImpl, calls } = recordingFetch(() => ({ status: 200, body: updated }));
      await execute(
        updateEnv({ INPUT_CONTENT: 'hi {tag}', INPUT_TIMESTAMP: '2026-01-01T00:00:00Z' }),
        fetchImpl
      );
      expect(calls[0].body).toEqual({ content: 'hi v1', timestamp: '2026-01-01T00:00:00.000Z' });
    });

    it('patches resolved label ids, and omits labels when none resolve', async () => {
      const resolving = recordingFetch((call) =>
        call.url.includes('/analytics/v1/labels')
          ? { status: 200, body: { labels: [{ id: 'l_prod', name: 'prod' }] } }
          : { status: 200, body: updated }
      );
      const withLabels = await execute(updateEnv({ INPUT_LABELS: 'prod' }), resolving.fetchImpl);
      expect(resolving.calls.find((c) => c.method === 'PATCH')?.body).toEqual({
        labels: ['l_prod'],
      });
      expect(withLabels.resolvedLabels).toEqual(['l_prod']);

      const forbidden = recordingFetch((call) =>
        call.url.includes('/analytics/v1/labels') ? { status: 403 } : { status: 200, body: updated }
      );
      await execute(updateEnv({ INPUT_LABELS: 'prod', INPUT_REPORTS: 'r1' }), forbidden.fetchImpl);
      expect(forbidden.calls.find((c) => c.method === 'PATCH')?.body).toEqual({ reports: ['r1'] });
    });
  });

  describe('delete and get', () => {
    it('deletes and returns only the id', async () => {
      const { fetchImpl, calls } = recordingFetch(() => ({ status: 200 }));
      const result = await execute(
        baseEnv({ INPUT_OPERATION: 'delete', 'INPUT_ANNOTATION-ID': 'ann_1' }),
        fetchImpl
      );
      expect(calls.map((c) => c.method)).toEqual(['DELETE']);
      expect(result).toMatchObject({ operation: 'delete', dryRun: false, annotationId: 'ann_1' });
      expect(result.annotationContent).toBeUndefined();
      expect(result.annotation).toBeUndefined();
    });

    it('gets and returns the fetched annotation', async () => {
      const fetched = { id: 'ann_1', content: 'got', timestamp: 't' };
      const { fetchImpl } = recordingFetch(() => ({ status: 200, body: fetched }));
      const result = await execute(
        baseEnv({ INPUT_OPERATION: 'get', 'INPUT_ANNOTATION-ID': 'ann_1' }),
        fetchImpl
      );
      expect(result).toMatchObject({
        operation: 'get',
        dryRun: false,
        annotationId: 'ann_1',
        annotationContent: 'got',
        annotationTimestamp: 't',
        annotation: fetched,
      });
    });
  });

  describe('list', () => {
    it('returns the first annotation summary and passes filter and max-results', async () => {
      const annotations = [
        { id: 'a1', content: 'first', timestamp: 't1' },
        { id: 'a2', content: 'second', timestamp: 't2' },
      ];
      const { fetchImpl, calls } = recordingFetch(() => ({ status: 200, body: { annotations } }));
      const result = await execute(
        baseEnv({ INPUT_OPERATION: 'list', INPUT_FILTER: 'x', 'INPUT_MAX-RESULTS': '5' }),
        fetchImpl
      );
      expect(calls[0].url).toContain('maxResults=5');
      expect(calls[0].url).toContain('filter=x');
      expect(result).toMatchObject({
        operation: 'list',
        dryRun: false,
        annotationId: 'a1',
        annotationContent: 'first',
        annotationTimestamp: 't1',
        annotations,
      });
    });

    it('handles an empty or missing annotations array', async () => {
      for (const body of [{ annotations: [] }, {}]) {
        const { fetchImpl } = recordingFetch(() => ({ status: 200, body }));
        const result = await execute(baseEnv({ INPUT_OPERATION: 'list' }), fetchImpl);
        expect(result.annotations).toEqual([]);
        expect(result.annotationId).toBeUndefined();
      }
    });
  });
});

describe('run outputs', () => {
  let setOutput: ReturnType<typeof vi.spyOn>;
  let info: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.spyOn(core, 'setSecret').mockImplementation(() => {});
    setOutput = vi.spyOn(core, 'setOutput').mockImplementation(() => {});
    info = vi.spyOn(core, 'info').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const runWith = (env: NodeJS.ProcessEnv, fetchImpl?: typeof fetch, payload = RELEASE_PAYLOAD) =>
    run({ env, payload, fetchImpl, now: NOW });

  it('always sets string outputs, using empty strings for missing values', async () => {
    const { fetchImpl } = recordingFetch(() => ({ status: 200 }));
    await runWith(baseEnv({ INPUT_OPERATION: 'delete', 'INPUT_ANNOTATION-ID': 'ann_1' }), fetchImpl);
    expect(outputOf(setOutput, 'annotation-id')).toBe('ann_1');
    expect(outputOf(setOutput, 'annotation-content')).toBe('');
    expect(outputOf(setOutput, 'annotation-timestamp')).toBe('');
    expect(outputOf(setOutput, 'annotation-skipped')).toBe('false');
  });

  it('outputs the annotation as JSON for create, update and get', async () => {
    const created = { id: 'ann_1', content: 'c', timestamp: 't' };
    const { fetchImpl } = recordingFetch(() => ({ status: 201, body: created }));
    await runWith(baseEnv(), fetchImpl);
    expect(JSON.parse(outputOf(setOutput, 'annotation-json') ?? '')).toEqual(created);
  });

  it('outputs the list of annotations as JSON for list', async () => {
    const annotations = [{ id: 'a1', content: 'c', timestamp: 't' }];
    const { fetchImpl } = recordingFetch(() => ({ status: 200, body: { annotations } }));
    await runWith(baseEnv({ INPUT_OPERATION: 'list' }), fetchImpl);
    expect(JSON.parse(outputOf(setOutput, 'annotation-json') ?? '')).toEqual(annotations);
  });

  it('outputs the request payload as JSON for dry runs', async () => {
    const result = await runWith(baseEnv({ 'INPUT_DRY-RUN': 'true' }));
    expect(JSON.parse(outputOf(setOutput, 'annotation-json') ?? '')).toEqual(result?.requestPayload);
  });

  it('outputs id and skip details as JSON for delete', async () => {
    const { fetchImpl } = recordingFetch(() => ({ status: 200 }));
    await runWith(baseEnv({ INPUT_OPERATION: 'delete', 'INPUT_ANNOTATION-ID': 'ann_1' }), fetchImpl);
    expect(JSON.parse(outputOf(setOutput, 'annotation-json') ?? '')).toEqual({
      id: 'ann_1',
      skipped: false,
    });
  });

  it('outputs the skip reason as JSON for skipped runs', async () => {
    const result = await runWith(
      baseEnv({ GITHUB_EVENT_NAME: 'push', 'INPUT_REQUIRE-COMMIT-TAG': '[annotate]' }),
      undefined,
      { ref: 'refs/heads/main', head_commit: { message: 'chore: nothing' } } as never
    );
    expect(outputOf(setOutput, 'annotation-skipped')).toBe('true');
    expect(JSON.parse(outputOf(setOutput, 'annotation-json') ?? '')).toEqual({
      skipped: true,
      skipReason: result?.skipReason,
    });
    expect(info).toHaveBeenCalledWith(`[Annotato] Skipped annotation: ${result?.skipReason}`);
  });

  it('logs a completion message with the operation, dry-run marker and id', async () => {
    await runWith(baseEnv({ 'INPUT_DRY-RUN': 'true' }));
    expect(info).toHaveBeenCalledWith(
      '[Annotato] (DRY RUN) Operation "create" completed (id: dry-run-annotation-id).'
    );

    const { fetchImpl } = recordingFetch(() => ({ status: 200, body: { annotations: [] } }));
    await runWith(baseEnv({ INPUT_OPERATION: 'list' }), fetchImpl);
    expect(info).toHaveBeenCalledWith('[Annotato] Operation "list" completed.');
  });

  it('fails the action with the error message when fail-on-error is true', async () => {
    const setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {});
    const result = await runWith(baseEnv({ INPUT_OPERATION: 'bogus' }));
    expect(result).toBeUndefined();
    expect(setFailed).toHaveBeenCalledWith(expect.stringContaining('Invalid operation "bogus"'));
  });
});
