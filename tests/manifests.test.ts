import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as core from '@actions/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { compareManifestFiles, renderManifestContent } from '../src/manifests.js';
import { executeAction, parseActionInputs, run } from '../src/index.js';

const files: string[] = [];
function file(content: string): string {
  const filename = path.join(os.tmpdir(), `annotato-manifest-${crypto.randomUUID()}.yaml`);
  fs.writeFileSync(filename, content);
  files.push(filename);
  return filename;
}

function workload(options: {
  kind?: string; name?: string; namespace?: string; replicas?: unknown;
  cpu?: unknown; memory?: unknown; image?: string;
} = {}) {
  return {
    apiVersion: 'apps/v1',
    kind: options.kind ?? 'Deployment',
    metadata: { name: options.name ?? 'payments', namespace: options.namespace },
    spec: {
      replicas: options.replicas,
      template: {
        spec: {
          containers: [{
            name: 'app', image: options.image ?? 'payments:v1',
            resources: { requests: { cpu: options.cpu, memory: options.memory } },
          }],
        },
      },
    },
  };
}

function manifests(before: unknown, after: unknown): NodeJS.ProcessEnv {
  return {
    INPUT_MANIFEST_BEFORE: file(JSON.stringify(before)),
    INPUT_MANIFEST_AFTER: file(JSON.stringify(after)),
  };
}

function compare(before: unknown, after: unknown, namespace?: string): string[] {
  const env = manifests(before, after);
  return compareManifestFiles(env.INPUT_MANIFEST_BEFORE!, env.INPUT_MANIFEST_AFTER!, namespace);
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const filename of files.splice(0)) fs.unlinkSync(filename);
});

describe('Kubernetes manifest comparison', () => {
  it('compares Helm-style YAML documents and ignores Secrets and unrelated changes', () => {
    const before = file(`apiVersion: apps/v1
kind: Deployment
metadata:
  name: payments
spec:
  replicas: 3
  template:
    spec:
      containers:
        - name: app
          image: payments:v1
          resources:
            requests:
              cpu: 250m
              memory: 512Mi
---
apiVersion: v1
kind: Secret
data:
  password: DO_NOT_SEND_THIS
---
`);
    const changes = compareManifestFiles(before, file(JSON.stringify(workload({ replicas: 6, cpu: '500m', memory: '1Gi' }))));
    expect(changes).toEqual([
      'Deployment default/payments: container app cpu request: 250m → 500m; container app memory request: 512Mi → 1Gi; desired replicas: 3 → 6',
    ]);
    expect(changes.join()).not.toContain('DO_NOT_SEND_THIS');
    expect(compare(workload({ image: 'payments:v1' }), workload({ image: 'payments:v2' }))).toEqual([]);
  });

  it.each([
    ['1', '1000m'], ['0.5', '500m'], ['1Gi', '1024Mi'], ['1e3', '1k'],
    [0, '0m'], ['1G', '1000000000'], ['0.000001', '1u'],
  ])('treats equivalent quantities %s and %s as unchanged', (cpu, equivalent) => {
    expect(compare(workload({ cpu }), workload({ cpu: equivalent }))).toEqual([]);
  });

  it('matches containers by name rather than order and handles added/removed requests', () => {
    const before = workload({ cpu: '250m' });
    before.spec.template.spec.containers.push({ name: 'sidecar', image: 'helper', resources: { requests: { cpu: '10m', memory: undefined } } });
    const after = structuredClone(before);
    after.spec.template.spec.containers.reverse();
    expect(compare(before, after)).toEqual([]);
    const changes = compare(workload({ cpu: '250m' }), workload({ memory: '1Gi' }));
    expect(changes[0]).toContain('cpu request: 250m → unspecified');
    expect(changes[0]).toContain('memory request: unspecified → 1Gi');
  });

  it('supports StatefulSets, Kubernetes Lists, explicit namespaces and zero replicas', () => {
    expect(compare(
      { kind: 'List', items: [workload({ kind: 'StatefulSet', namespace: 'prod', replicas: 2 })] },
      workload({ kind: 'StatefulSet', namespace: 'prod', replicas: 0 }),
    )).toEqual(['StatefulSet prod/payments: desired replicas: 2 → 0']);
    expect(compare(workload(), workload({ replicas: 1, namespace: 'prod' }), 'prod')).toEqual([]);
  });

  it('reports workload additions and removals rather than inventing prior values', () => {
    expect(compare({ kind: 'List', items: [] }, workload({ cpu: '250m' }))[0]).toContain('added to manifests (');
    expect(compare(workload(), { kind: 'List', items: [] })[0]).toContain('removed from manifests (');
    const moved = compare(workload({ namespace: 'old' }), workload({ namespace: 'new' }));
    expect(moved).toHaveLength(2);
    expect(moved.join()).toContain('Deployment old/payments: removed');
    expect(moved.join()).toContain('Deployment new/payments: added');
    expect(compareManifestFiles(file(''), file('# empty'))).toEqual([]);
  });

  it.each([
    workload({ replicas: -1 }), workload({ replicas: '2' }), workload({ replicas: 1.5 }),
    workload({ cpu: 'invalid' }), workload({ memory: -1 }), workload({ cpu: '1e999' }),
    { kind: 'Deployment', apiVersion: 'apps/v1', metadata: { name: 'missing-spec' } },
    { kind: 'List', items: [workload(), workload()] },
  ])('rejects invalid tracked resources without leaking source values (%#)', (invalid) => {
    expect(() => compare(workload(), invalid)).toThrow('Invalid Kubernetes manifest');
  });

  it('ignores scalar, kind-less and non-workload documents', () => {
    const noise = file('just a string\n---\nfoo: bar\n---\n- a\n---\nkind: ConfigMap\n');
    expect(compareManifestFiles(noise, file(JSON.stringify(workload({ replicas: 2 }))))[0]).toContain('added to manifests');
    expect(compareManifestFiles(noise, noise)).toEqual([]);
  });

  it('renders content with workflow URL, falling back to the context URL', () => {
    const context = { repo: 'org/app', environment: 'prod', shortSha: 'abc1234', release: 'v1', url: 'https://example/ctx' } as never;
    expect(renderManifestContent(context, ['change'], { GITHUB_RUN_ID: '9', GITHUB_SERVER_URL: 'https://gh.example/' }))
      .toBe('[org/app] Kubernetes configuration changes in prod (abc1234)\nchange\nConfigured demand only; not measured spend or live capacity.\nWorkflow: https://gh.example/org/app/actions/runs/9');
    expect(renderManifestContent(context, ['change'], {})).toContain('Workflow: https://example/ctx');
  });

  it('rejects malformed YAML without including parser source snippets', () => {
    const invalid = file('password: [SECRET_DO_NOT_LOG');
    expect(() => compareManifestFiles(file(''), invalid)).toThrow('Source content omitted');
    try { compareManifestFiles(file(''), invalid); } catch (error) {
      expect(String(error)).not.toContain('SECRET_DO_NOT_LOG');
    }
  });

  it('rejects missing and oversized files instead of treating them as an empty baseline', () => {
    expect(() => compareManifestFiles('/does-not-exist/manifest.yaml', file(''))).toThrow();
    expect(() => compareManifestFiles(file(' '.repeat(5 * 1024 * 1024 + 1)), file(''))).toThrow('5 MiB');
  });
});

describe('manifest action integration', () => {
  it('posts a capacity-only annotation at deployment-step time with reports, labels and workflow link', async () => {
    const env = {
      ...manifests(workload({ replicas: 3, cpu: '250m' }), workload({ replicas: 6, cpu: '500m' })),
      DOIT_API_KEY: 'test', INPUT_REPORTS: 'report1', INPUT_LABELS: 'id:label1',
      GITHUB_EVENT_NAME: 'push', GITHUB_REPOSITORY: 'org/app', GITHUB_RUN_ID: '42',
      ENVIRONMENT: 'staging',
    };
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      const payload: unknown = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ id: 'annotation1', ...(payload as object) }), { status: 201 });
    });
    const result = await executeAction(parseActionInputs(env), {
      env, fetchImpl, now: new Date('2026-10-27T19:00:00Z'),
      payload: { head_commit: { timestamp: '2026-10-20T00:00:00Z' } },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.annotationTimestamp).toBe('2026-10-27T19:00:00.000Z');
    expect(result.annotationContent).toContain('Kubernetes configuration changes in staging');
    expect(result.annotationContent).toContain('desired replicas: 3 → 6');
    expect(result.annotationContent).toContain('https://github.com/org/app/actions/runs/42');
    expect(result.annotationContent).not.toContain('payments:v1');
    expect(result.requestPayload).toMatchObject({ reports: ['report1'], labels: ['label1'] });
  });

  it('skips unchanged manifests without credentials, label lookup or API calls', async () => {
    const env = { ...manifests(workload({ cpu: '1' }), workload({ cpu: '1000m' })), INPUT_LABELS: 'production' };
    const fetchImpl = vi.fn<typeof fetch>();
    const result = await executeAction(parseActionInputs(env), { env, fetchImpl });
    expect(result.skipped).toBe(true);
    expect(result.skipReason).toContain('No tracked Kubernetes manifest changes');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('supports dry-run previews with an explicit deployment timestamp and no API calls', async () => {
    const env = {
      ...manifests(workload(), workload({ replicas: 2 })),
      INPUT_DRY_RUN: 'true', INPUT_TIMESTAMP: '2026-10-26T10:00:00Z',
    };
    const fetchImpl = vi.fn<typeof fetch>();
    const result = await executeAction(parseActionInputs(env), { env, fetchImpl });
    expect(result.dryRun).toBe(true);
    expect(result.annotationTimestamp).toBe('2026-10-26T10:00:00.000Z');
    expect(result.requestPayload?.content).toContain('desired replicas: 1 → 2');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    { INPUT_MANIFEST_BEFORE: 'before.yaml' },
    { INPUT_MANIFEST_AFTER: 'after.yaml' },
    { INPUT_MANIFEST_BEFORE: 'a', INPUT_MANIFEST_AFTER: 'b', INPUT_OPERATION: 'update' },
    { INPUT_MANIFEST_BEFORE: 'a', INPUT_MANIFEST_AFTER: 'b', INPUT_CONTENT: 'override' },
    { INPUT_MANIFEST_BEFORE: 'a', INPUT_MANIFEST_AFTER: 'b', INPUT_TEMPLATE: 'override' },
  ])('rejects incompatible inputs before any API request (%#)', async (env) => {
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(executeAction(parseActionInputs(env), { env, fetchImpl })).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('can warn without failing the deployment when annotation submission fails', async () => {
    const warning = vi.spyOn(core, 'warning').mockImplementation(() => {});
    const failed = vi.spyOn(core, 'setFailed').mockImplementation(() => {});
    const env = {
      ...manifests(workload(), workload({ replicas: 2 })),
      DOIT_API_KEY: 'test', INPUT_FAIL_ON_ERROR: 'false',
    };
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response('Unavailable', { status: 503 }));
    expect(await run({ env, fetchImpl })).toBeUndefined();
    expect(failed).not.toHaveBeenCalled();
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('Non-fatal error'));
  });
});
