import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { AnnotationListItem, LabelListItem } from '../src/types.js';

const execFileAsync = promisify(execFile);

interface RecordedRequest {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body?: unknown;
}

describe('Annotato End-to-End (dist/index.js against mock DoiT API server)', () => {
  let server: http.Server;
  let baseUrl = '';
  const recordedRequests: RecordedRequest[] = [];
  const annotationsStore = new Map<string, AnnotationListItem>();
  const labelsStore: LabelListItem[] = [
    { id: 'lbl_existing_prod', name: 'Production', color: 'blue', type: 'custom' },
  ];
  const tempFiles: string[] = [];

  function makeTempFile(prefix: string, content = ''): string {
    const filePath = path.join(
      os.tmpdir(),
      `annotato-e2e-${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    fs.writeFileSync(filePath, content, 'utf8');
    tempFiles.push(filePath);
    return filePath;
  }

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const rawBody = Buffer.concat(chunks).toString('utf8');
        let parsedBody: unknown;
        if (rawBody) {
          try {
            parsedBody = JSON.parse(rawBody);
          } catch {
            parsedBody = rawBody;
          }
        }

        const reqUrl = req.url || '/';
        recordedRequests.push({
          method: req.method || 'GET',
          url: reqUrl,
          headers: req.headers,
          body: parsedBody,
        });

        // Verify Bearer auth
        const auth = req.headers.authorization;
        if (auth !== 'Bearer e2e_doit_api_key_123') {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unauthorized - Invalid API key.' }));
          return;
        }

        const parsedUrl = new URL(reqUrl, 'http://127.0.0.1');

        if (req.method === 'GET' && parsedUrl.pathname === '/analytics/v1/labels') {
          const nameContains = (parsedUrl.searchParams.get('nameContains') || '').toLowerCase();
          const matched = nameContains
            ? labelsStore.filter((l) => l.name.toLowerCase().includes(nameContains))
            : labelsStore;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ rowCount: matched.length, labels: matched }));
          return;
        }

        if (req.method === 'POST' && parsedUrl.pathname === '/analytics/v1/labels') {
          const bodyObj = parsedBody as { name: string; color: LabelListItem['color'] };
          const createdLabel: LabelListItem = {
            id: `lbl_auto_${labelsStore.length + 1}`,
            name: bodyObj.name,
            color: bodyObj.color,
            type: 'custom',
          };
          labelsStore.push(createdLabel);
          res.writeHead(201, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(createdLabel));
          return;
        }

        if (req.method === 'POST' && parsedUrl.pathname === '/analytics/v1/annotations') {
          const bodyObj = parsedBody as {
            content: string;
            timestamp: string;
            reports?: string[];
            labels?: string[];
          };
          const id = `ann_e2e_${annotationsStore.size + 1}`;
          const nowIso = new Date().toISOString();
          const created: AnnotationListItem = {
            id,
            content: bodyObj.content,
            timestamp: bodyObj.timestamp,
            reports: bodyObj.reports ?? [],
            labels: (bodyObj.labels ?? []).map((lblId) => {
              const found = labelsStore.find((l) => l.id === lblId);
              return { id: lblId, name: found ? found.name : lblId };
            }),
            createTime: nowIso,
            updateTime: nowIso,
          };
          annotationsStore.set(id, created);
          res.writeHead(201, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(created));
          return;
        }

        if (parsedUrl.pathname.startsWith('/analytics/v1/annotations/')) {
          const id = decodeURIComponent(
            parsedUrl.pathname.replace('/analytics/v1/annotations/', '')
          );
          const existing = annotationsStore.get(id);
          if (!existing) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Not Found' }));
            return;
          }

          if (req.method === 'GET') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(existing));
            return;
          }

          if (req.method === 'PATCH') {
            const bodyObj = parsedBody as {
              content?: string;
              timestamp?: string;
              reports?: string[];
              labels?: string[];
            };
            const updated: AnnotationListItem = {
              ...existing,
              content: bodyObj.content ?? existing.content,
              timestamp: bodyObj.timestamp ?? existing.timestamp,
              reports: bodyObj.reports ?? existing.reports,
              updateTime: new Date().toISOString(),
            };
            annotationsStore.set(id, updated);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(updated));
            return;
          }

          if (req.method === 'DELETE') {
            annotationsStore.delete(id);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end('');
            return;
          }
        }

        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Route not found' }));
      });
    });

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        if (addr && typeof addr === 'object') {
          baseUrl = `http://127.0.0.1:${addr.port}`;
        }
        resolve();
      });
    });
  });

  afterEach(() => {
    recordedRequests.length = 0;
    for (const file of tempFiles.splice(0)) {
      if (fs.existsSync(file)) {
        fs.unlinkSync(file);
      }
    }
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('executes dist/index.js end-to-end for a GitHub release event with label resolution and creation', async () => {
    const distPath = path.resolve(process.cwd(), 'dist/index.js');
    expect(fs.existsSync(distPath)).toBe(true);

    const eventFile = makeTempFile(
      'event.json',
      JSON.stringify({
        release: {
          tag_name: 'v3.2.0',
          name: 'v3.2.0',
          published_at: '2026-10-21T16:20:00Z',
          html_url: 'https://github.com/doiteng/annotato/releases/tag/v3.2.0',
        },
      })
    );
    const outputFile = makeTempFile('output.txt');
    const summaryFile = makeTempFile('summary.md');

    await execFileAsync(process.execPath, [distPath], {
      env: {
        ...process.env,
        'INPUT_DOIT-API-KEY': 'e2e_doit_api_key_123',
        'INPUT_API-URL': baseUrl,
        'INPUT_TENANT-ID': 'tenant_doit_prod',
        INPUT_REPORTS: 'rep_cost_overview, rep_k8s_spend',
        INPUT_LABELS: 'Production, release-v3',
        'INPUT_CREATE-MISSING-LABELS': 'true',
        'INPUT_LABEL-COLOR': 'teal',
        GITHUB_EVENT_NAME: 'release',
        GITHUB_EVENT_PATH: eventFile,
        GITHUB_REPOSITORY: 'doiteng/annotato',
        GITHUB_SHA: 'deadbeefcafebabe1234567890abcdef12345678',
        GITHUB_ACTOR: 'eric',
        GITHUB_OUTPUT: outputFile,
        GITHUB_STEP_SUMMARY: summaryFile,
      },
    });

    // Verify requests received by mock DoiT server:
    // 1. GET /analytics/v1/labels?nameContains=Production
    // 2. GET /analytics/v1/labels?nameContains=release-v3
    // 3. POST /analytics/v1/labels (creating release-v3)
    // 4. POST /analytics/v1/annotations
    expect(recordedRequests).toHaveLength(4);
    expect(recordedRequests[3].method).toBe('POST');
    expect(recordedRequests[3].url).toBe('/analytics/v1/annotations');
    expect(recordedRequests[3].headers['x-tenant-id']).toBe('tenant_doit_prod');
    expect(recordedRequests[3].body).toEqual({
      content: '[doiteng/annotato] Release v3.2.0 (deadbee) published by @eric',
      timestamp: '2026-10-21T16:20:00.000Z',
      reports: ['rep_cost_overview', 'rep_k8s_spend'],
      labels: ['lbl_existing_prod', 'lbl_auto_2'],
    });

    const outputText = fs.readFileSync(outputFile, 'utf8');
    expect(outputText).toContain('annotation-id');
    expect(outputText).toContain('ann_e2e_1');
    expect(outputText).toContain('[doiteng/annotato] Release v3.2.0 (deadbee) published by @eric');

    const summaryText = fs.readFileSync(summaryFile, 'utf8');
    expect(summaryText).toContain('## 📌 DoiT Cloud Intelligence Annotation');
    expect(summaryText).toContain('`ann_e2e_1`');
    expect(summaryText).toContain('lbl_existing_prod, lbl_auto_2');
  });

  it('executes dist/index.js for update (rollback) and delete operations', async () => {
    const distPath = path.resolve(process.cwd(), 'dist/index.js');
    const outputFile = makeTempFile('output-update.txt');
    const summaryFile = makeTempFile('summary-update.md');

    await execFileAsync(process.execPath, [distPath], {
      env: {
        ...process.env,
        'INPUT_DOIT-API-KEY': 'e2e_doit_api_key_123',
        'INPUT_API-URL': baseUrl,
        INPUT_OPERATION: 'update',
        'INPUT_ANNOTATION-ID': 'ann_e2e_1',
        INPUT_CONTENT: '[doiteng/annotato] Release v3.2.0 (ROLLED BACK)',
        GITHUB_OUTPUT: outputFile,
        GITHUB_STEP_SUMMARY: summaryFile,
      },
    });

    expect(recordedRequests).toHaveLength(1);
    expect(recordedRequests[0].method).toBe('PATCH');
    expect(recordedRequests[0].url).toBe('/analytics/v1/annotations/ann_e2e_1');
    expect(recordedRequests[0].body).toEqual({
      content: '[doiteng/annotato] Release v3.2.0 (ROLLED BACK)',
    });

    // Now delete it
    recordedRequests.length = 0;
    await execFileAsync(process.execPath, [distPath], {
      env: {
        ...process.env,
        'INPUT_DOIT-API-KEY': 'e2e_doit_api_key_123',
        'INPUT_API-URL': baseUrl,
        INPUT_OPERATION: 'delete',
        'INPUT_ANNOTATION-ID': 'ann_e2e_1',
      },
    });

    expect(recordedRequests).toHaveLength(1);
    expect(recordedRequests[0].method).toBe('DELETE');
    expect(recordedRequests[0].url).toBe('/analytics/v1/annotations/ann_e2e_1');
  });

  it('executes dist/index.js in dry-run mode with zero HTTP calls', async () => {
    const distPath = path.resolve(process.cwd(), 'dist/index.js');
    const outputFile = makeTempFile('output-dry.txt');
    const summaryFile = makeTempFile('summary-dry.md');

    await execFileAsync(process.execPath, [distPath], {
      env: {
        ...process.env,
        'INPUT_DOIT-API-KEY': 'dry_run_key',
        'INPUT_API-URL': baseUrl,
        'INPUT_DRY-RUN': 'true',
        'INPUT_RELEASE-ID': 'v9.9.9-dry',
        GITHUB_EVENT_NAME: 'push',
        GITHUB_REPOSITORY: 'doiteng/annotato',
        GITHUB_SHA: '99999991111111',
        GITHUB_ACTOR: 'eric',
        GITHUB_OUTPUT: outputFile,
        GITHUB_STEP_SUMMARY: summaryFile,
      },
    });

    expect(recordedRequests).toHaveLength(0);
    const summaryText = fs.readFileSync(summaryFile, 'utf8');
    expect(summaryText).toContain('DoiT Cloud Intelligence Annotation (Dry Run)');
    expect(summaryText).toContain('v9.9.9-dry');
  });

  it('validates action.yml, README.md, and workflow templates exist and are properly configured', () => {
    const root = process.cwd();
    const actionYml = fs.readFileSync(path.join(root, 'action.yml'), 'utf8');
    expect(actionYml).toContain("using: 'node24'");
    expect(actionYml).toContain("main: 'dist/index.js'");
    expect(actionYml).toContain('doit-api-key:');
    expect(actionYml).toContain('annotation-id:');

    expect(fs.existsSync(path.join(root, '.github/workflows/ci.yml'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'examples/release-annotation.yml'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'examples/deploy-annotation.yml'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'examples/rollback-annotation.yml'))).toBe(true);

    const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
    expect(readme).toContain('/analytics/v1/annotations');
    expect(readme).toContain('doit-api-key');
  });
});
