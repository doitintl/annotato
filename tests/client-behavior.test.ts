import { describe, expect, it, vi } from 'vitest';
import { DoitApiError, DoitClient } from '../src/doit-client.js';

interface Seen {
  url: string;
  method?: string;
  headers: Record<string, string>;
  body?: Record<string, unknown>;
}

const ANNOTATION = { id: 'ann_1', content: 'c', timestamp: 't' };
const isValidate = (s: Seen) => s.url.includes('/auth/v1/validate');

function scriptedFetch(respond: (seen: Seen) => { status: number; body?: unknown }) {
  const seen: Seen[] = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const entry: Seen = {
      url: String(input),
      method: init?.method,
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body ? JSON.parse(init.body as string) : undefined,
    };
    seen.push(entry);
    const res = respond(entry);
    const text =
      res.body === undefined ? '' : typeof res.body === 'string' ? res.body : JSON.stringify(res.body);
    return {
      ok: res.status >= 200 && res.status < 300,
      status: res.status,
      statusText: 'Error',
      text: async () => text,
    } as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, seen, apiCalls: () => seen.filter((s) => !isValidate(s)) };
}

const shape = (s: Seen) => ({
  header: 'X-Tenant-Id' in s.headers,
  query: s.url.includes('customerContext='),
});

describe('DoitClient tenant retry strategy', () => {
  it('retries 401/403 with customerContext, both, then no tenant override, in that order', async () => {
    const { fetchImpl, apiCalls } = scriptedFetch(() => ({ status: 401, body: { error: 'nope' } }));
    const client = new DoitClient({ apiKey: 'k', tenantId: 't1', fetchImpl });

    const error = await client.getAnnotation('ann_1').catch((e) => e);

    expect(error).toBeInstanceOf(DoitApiError);
    expect(apiCalls().map(shape)).toEqual([
      { header: true, query: false },
      { header: false, query: true },
      { header: true, query: true },
      { header: false, query: false },
    ]);
    expect((error as DoitApiError).message).toContain('[attempts: X-Tenant-Id->401(');
    for (const label of ['customerContext->401', 'both->401', 'noTenantOverride->401']) {
      expect((error as DoitApiError).message).toContain(label);
    }
  });

  it('stops retrying at the first success', async () => {
    const { fetchImpl, apiCalls } = scriptedFetch((s) => {
      const { header, query } = shape(s);
      return header && query ? { status: 200, body: ANNOTATION } : { status: 403 };
    });
    const client = new DoitClient({ apiKey: 'k', tenantId: 't1', fetchImpl });

    await expect(client.getAnnotation('ann_1')).resolves.toEqual(ANNOTATION);
    expect(apiCalls().map(shape)).toEqual([
      { header: true, query: false },
      { header: false, query: true },
      { header: true, query: true },
    ]);
  });

  it('adds the tenant id as the customerContext query value on retry', async () => {
    const { fetchImpl, apiCalls } = scriptedFetch((s) =>
      shape(s).query ? { status: 200, body: ANNOTATION } : { status: 401 }
    );
    await new DoitClient({ apiKey: 'k', tenantId: 'tenant_x', fetchImpl }).getAnnotation('ann_1');
    expect(apiCalls()[1].url).toContain('customerContext=tenant_x');
  });

  it('does not retry without a tenant id', async () => {
    const { fetchImpl, apiCalls } = scriptedFetch(() => ({ status: 401 }));
    await new DoitClient({ apiKey: 'k', fetchImpl }).getAnnotation('ann_1').catch(() => {});
    expect(apiCalls()).toHaveLength(1);
    expect('X-Tenant-Id' in apiCalls()[0].headers).toBe(false);
  });

  it.each([404, 500])('does not retry on a %i even with a tenant id', async (status) => {
    const { fetchImpl, apiCalls } = scriptedFetch(() => ({ status }));
    await new DoitClient({ apiKey: 'k', tenantId: 't1', fetchImpl })
      .getAnnotation('ann_1')
      .catch(() => {});
    expect(apiCalls()).toHaveLength(1);
  });
});

describe('DoitClient error reporting', () => {
  const failWith = async (body: unknown, validate?: { status: number; body?: unknown }) => {
    const { fetchImpl, seen } = scriptedFetch((s) =>
      isValidate(s) ? (validate ?? { status: 404 }) : { status: 400, body }
    );
    const error = (await new DoitClient({ apiKey: 'distinct-test-credential', fetchImpl })
      .getAnnotation('ann_1')
      .catch((e) => e)) as DoitApiError;
    return { error, seen };
  };

  it('builds the message from the status line and parsed error detail', async () => {
    const { error } = await failWith({ message: 'boom' });
    expect(error.message).toContain(
      'DoiT API GET /analytics/v1/annotations/ann_1 failed (400 Error): boom'
    );
    expect(error.status).toBe(400);
    expect(error.statusText).toBe('Error');
    expect(error.endpoint).toBe('/analytics/v1/annotations/ann_1');
    expect(error.details).toContain('boom');
  });

  it('prefers error over message in the response body', async () => {
    const { error } = await failWith({ error: 'primary', message: 'secondary' });
    expect(error.message).toContain(': primary');
    expect(error.message).not.toContain('secondary');
  });

  it('keeps non-JSON bodies verbatim', async () => {
    const { error } = await failWith('plain text failure');
    expect(error.message).toContain('plain text failure');
  });

  it('appends token diagnostics, using a customerContext=doit.com fallback probe', async () => {
    const { error, seen } = await failWith({ error: 'x' });
    const probes = seen.filter(isValidate);
    expect(probes).toHaveLength(2);
    expect(probes[0].url).not.toContain('customerContext=');
    expect(probes[1].url).toContain('customerContext=doit.com');
    expect(error.message).toContain('[validate=404:');
  });

  it.each([
    [{ permissions: ['a', 'b'] }, 'permissions=a, b'],
    [{ permissions: [] }, 'permissions=none/doer-token'],
    [{}, 'permissions=unknown'],
  ])('describes validate permissions %j', async (validateBody, expected) => {
    const { error } = await failWith({ error: 'x' }, { status: 200, body: validateBody });
    expect(error.message).toContain(`[validate=200 ${expected}]`);
  });

  it('reports validate errors without failing the original error', async () => {
    const seen: string[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      seen.push(url);
      if (url.includes('/auth/v1/validate')) throw new Error('network down');
      return {
        ok: false,
        status: 400,
        statusText: 'Error',
        text: async () => JSON.stringify({ error: 'x' }),
      } as Response;
    }) as unknown as typeof fetch;
    const error = (await new DoitClient({ apiKey: 'distinct-test-credential', fetchImpl })
      .getAnnotation('ann_1')
      .catch((e) => e)) as DoitApiError;
    expect(error).toBeInstanceOf(DoitApiError);
    expect(error.message).toContain('[validate=error: network down]');
  });

  it('redacts the API key everywhere in the message and details', async () => {
    const { fetchImpl } = scriptedFetch((s) =>
      isValidate(s)
        ? { status: 200, body: { permissions: ['secret-key-123'] } }
        : { status: 400, body: { error: 'bad secret-key-123' } }
    );
    const error = (await new DoitClient({ apiKey: 'secret-key-123', fetchImpl })
      .getAnnotation('ann_1')
      .catch((e) => e)) as DoitApiError;
    expect(error.message).not.toContain('secret-key-123');
    expect(error.details).not.toContain('secret-key-123');
    expect(error.message).toContain('***');
  });

  it('does not probe diagnostics when the failing request is the validate call', async () => {
    const { fetchImpl, seen } = scriptedFetch(() => ({ status: 401 }));
    const client = new DoitClient({ apiKey: 'k', fetchImpl });
    await (client as unknown as { request: (m: string, p: string) => Promise<unknown> })
      .request('GET', '/auth/v1/validate')
      .catch(() => {});
    expect(seen.filter(isValidate)).toHaveLength(1);
  });
});

describe('DoitClient request construction', () => {
  it('sends auth and accept headers, and content-type only with a body', async () => {
    const { fetchImpl, seen } = scriptedFetch((s) =>
      s.method === 'POST' ? { status: 201, body: ANNOTATION } : { status: 200, body: ANNOTATION }
    );
    const client = new DoitClient({ apiKey: 'abc', fetchImpl });
    await client.getAnnotation('ann_1');
    await client.createAnnotation({ content: 'c', timestamp: '2026-10-21T10:00:00Z' });

    expect(seen[0].headers).toEqual({ Authorization: 'Bearer abc', Accept: 'application/json' });
    expect(seen[1].headers).toEqual({
      Authorization: 'Bearer abc',
      Accept: 'application/json',
      'Content-Type': 'application/json',
    });
  });

  it('sends X-Tenant-Id on the first attempt when a tenant is configured', async () => {
    const { fetchImpl, seen } = scriptedFetch(() => ({ status: 200, body: ANNOTATION }));
    await new DoitClient({ apiKey: 'k', tenantId: ' t1 ', fetchImpl }).getAnnotation('ann_1');
    expect(seen[0].headers['X-Tenant-Id']).toBe('t1');
  });

  it('refuses redirects and returns undefined for empty successful bodies', async () => {
    const calls: RequestInit[] = [];
    const fetchImpl = vi.fn(async (_input: unknown, init?: RequestInit) => {
      calls.push(init ?? {});
      return { ok: true, status: 200, statusText: 'OK', text: async () => '' } as Response;
    }) as unknown as typeof fetch;
    await expect(new DoitClient({ apiKey: 'k', fetchImpl }).deleteAnnotation('ann_1')).resolves.toBe(
      undefined
    );
    expect(calls[0].redirect).toBe('error');
    expect(calls[0].signal).toBeInstanceOf(AbortSignal);
  });

  it('only sends defined query parameters', async () => {
    const { fetchImpl, seen } = scriptedFetch(() => ({ status: 200, body: {} }));
    const client = new DoitClient({ apiKey: 'k', fetchImpl });
    await client.listAnnotations({ maxResults: 5, filter: 'f' });
    await client.listLabels({ nameContains: 'prod' });

    const annotationsUrl = new URL(seen[0].url);
    expect(annotationsUrl.pathname).toBe('/analytics/v1/annotations');
    expect([...annotationsUrl.searchParams.keys()].sort()).toEqual(['filter', 'maxResults']);
    expect(annotationsUrl.searchParams.get('maxResults')).toBe('5');

    const labelsUrl = new URL(seen[1].url);
    expect(labelsUrl.pathname).toBe('/analytics/v1/labels');
    expect([...labelsUrl.searchParams.keys()]).toEqual(['nameContains']);
  });
});

describe('DoitClient base URL normalization', () => {
  it('strips trailing slashes and defaults to api.doit.com', async () => {
    const slashed = scriptedFetch(() => ({ status: 200, body: ANNOTATION }));
    await new DoitClient({
      apiKey: 'k',
      baseUrl: 'https://api.doit.com///',
      fetchImpl: slashed.fetchImpl,
    }).getAnnotation('ann_1');
    expect(slashed.seen[0].url).toBe('https://api.doit.com/analytics/v1/annotations/ann_1');

    const defaulted = scriptedFetch(() => ({ status: 200, body: ANNOTATION }));
    await new DoitClient({ apiKey: 'k', fetchImpl: defaulted.fetchImpl }).getAnnotation('ann_1');
    expect(defaulted.seen[0].url).toBe('https://api.doit.com/analytics/v1/annotations/ann_1');
  });

  it.each([
    'https://api.doit.com',
    'https://eu.api.doit.com',
    'https://API.DOIT.COM',
    'http://localhost:3000',
    'http://127.0.0.1:8080',
    'http://[::1]:3000',
    'https://localhost',
  ])('accepts %s', (baseUrl) => {
    expect(() => new DoitClient({ apiKey: 'k', baseUrl })).not.toThrow();
  });

  it.each([
    ['https://notdoit.com', 'not in the allowlist'],
    ['https://evildoit.com', 'not in the allowlist'],
    ['https://api.doit.com.evil.com', 'not in the allowlist'],
    ['http://api.doit.com', 'must use https://'],
    ['ftp://api.doit.com', 'must use https://'],
    ['http://evil.example.com', 'must use https://'],
    ['not a url', 'Invalid DoiT API base URL'],
    ['https://user@api.doit.com', 'must not contain embedded credentials'],
  ])('rejects %s', (baseUrl, message) => {
    expect(() => new DoitClient({ apiKey: 'k', baseUrl })).toThrow(message);
  });
});

describe('DoitClient annotation ids and payloads', () => {
  it('validates and trims annotation ids before any request', async () => {
    const { fetchImpl, seen } = scriptedFetch(() => ({ status: 200, body: ANNOTATION }));
    const client = new DoitClient({ apiKey: 'k', fetchImpl });

    await expect(client.getAnnotation('  ')).rejects.toThrow(
      'Annotation ID is required for getAnnotation.'
    );
    await expect(client.updateAnnotation('bad/id', {})).rejects.toThrow(
      'Invalid Annotation ID "bad/id" for updateAnnotation.'
    );
    await expect(client.deleteAnnotation('x'.repeat(129))).rejects.toThrow(
      'Invalid Annotation ID'
    );
    expect(seen).toHaveLength(0);

    await client.getAnnotation(' ann_1 ');
    expect(seen[0].url).toMatch(/\/annotations\/ann_1$/);
    await client.getAnnotation('x'.repeat(128));
    expect(seen).toHaveLength(2);
  });

  it('forwards only provided fields on update, preserving a null timestamp', async () => {
    const { fetchImpl, seen } = scriptedFetch(() => ({ status: 200, body: ANNOTATION }));
    const client = new DoitClient({ apiKey: 'k', fetchImpl });

    await client.updateAnnotation('ann_1', {});
    await client.updateAnnotation('ann_1', { content: 'x' });
    await client.updateAnnotation('ann_1', { timestamp: null });
    await client.updateAnnotation('ann_1', { timestamp: '2026-10-21T10:00:00+02:00' });
    await client.updateAnnotation('ann_1', { reports: [], labels: ['l1'] });

    expect(seen.map((s) => s.body)).toEqual([
      {},
      { content: 'x' },
      { timestamp: null },
      { timestamp: '2026-10-21T08:00:00.000Z' },
      { reports: [], labels: ['l1'] },
    ]);
    await expect(client.updateAnnotation('ann_1', { timestamp: 'nope' })).rejects.toThrow(
      'Invalid RFC3339 timestamp for updateAnnotation: "nope"'
    );
  });

  it('trims content and normalizes the timestamp on create', async () => {
    const { fetchImpl, seen } = scriptedFetch(() => ({ status: 201, body: ANNOTATION }));
    await new DoitClient({ apiKey: 'k', fetchImpl }).createAnnotation({
      content: '  hello  ',
      timestamp: '2026-10-21T10:00:00+02:00',
      reports: [],
      labels: [],
    });
    expect(seen[0].body).toEqual({ content: 'hello', timestamp: '2026-10-21T08:00:00.000Z' });
  });
});

describe('DoitClient create fallback', () => {
  const payload = {
    content: 'c',
    timestamp: '2026-10-21T10:00:00Z',
    reports: ['r1'],
    labels: ['l1'],
  };

  it.each([403, 404])(
    'retries as a global annotation after a %i when reports or labels were attached',
    async (status) => {
      let posts = 0;
      const { fetchImpl, apiCalls } = scriptedFetch((s) => {
        if (isValidate(s)) return { status: 404 };
        posts += 1;
        return posts === 1 ? { status } : { status: 201, body: ANNOTATION };
      });
      const onWarning = vi.fn();
      const client = new DoitClient({ apiKey: 'k', fetchImpl, onWarning });

      await expect(client.createAnnotation(payload)).resolves.toEqual(ANNOTATION);

      expect(apiCalls()).toHaveLength(2);
      expect(apiCalls()[0].body).toMatchObject({ reports: ['r1'], labels: ['l1'] });
      expect(apiCalls()[1].body).toEqual({ content: 'c', timestamp: '2026-10-21T10:00:00.000Z' });
      expect(onWarning).toHaveBeenCalledTimes(1);
      expect(onWarning).toHaveBeenCalledWith(
        expect.stringContaining(`returned HTTP ${status}; retrying as a global annotation`)
      );
    }
  );

  it('does not retry when nothing was attached, or on other errors', async () => {
    const noExtras = scriptedFetch(() => ({ status: 403 }));
    await expect(
      new DoitClient({ apiKey: 'k', fetchImpl: noExtras.fetchImpl }).createAnnotation({
        content: 'c',
        timestamp: '2026-10-21T10:00:00Z',
      })
    ).rejects.toBeInstanceOf(DoitApiError);
    expect(noExtras.apiCalls()).toHaveLength(1);

    const serverError = scriptedFetch(() => ({ status: 500 }));
    await expect(
      new DoitClient({ apiKey: 'k', fetchImpl: serverError.fetchImpl }).createAnnotation(payload)
    ).rejects.toBeInstanceOf(DoitApiError);
    expect(serverError.apiCalls()).toHaveLength(1);
  });
});

describe('DoitClient labels', () => {
  it('requires a label name and defaults the color to blue', async () => {
    const { fetchImpl, seen } = scriptedFetch(() => ({
      status: 201,
      body: { id: 'l1', name: 'n', color: 'blue' },
    }));
    const client = new DoitClient({ apiKey: 'k', fetchImpl });
    await expect(client.createLabel({ name: '  ' } as never)).rejects.toThrow('Label name is required.');
    await client.createLabel({ name: ' prod ' } as never);
    expect(seen[0].body).toEqual({ name: 'prod', color: 'blue' });
  });

  describe('resolveLabels', () => {
    it('returns an empty list without any request for blank input', async () => {
      const { fetchImpl, seen } = scriptedFetch(() => ({ status: 200, body: {} }));
      await expect(
        new DoitClient({ apiKey: 'k', fetchImpl }).resolveLabels(['', '  '])
      ).resolves.toEqual([]);
      expect(seen).toHaveLength(0);
    });

    it('bypasses lookup for id: entries and drops empty ones', async () => {
      const { fetchImpl, seen } = scriptedFetch(() => ({ status: 200, body: {} }));
      const resolved = await new DoitClient({ apiKey: 'k', fetchImpl }).resolveLabels([
        'id:abc',
        'id: ',
        'id:abc',
      ]);
      expect(resolved).toEqual(['abc']);
      expect(seen).toHaveLength(0);
    });

    it('matches on exact id, searches with nameContains, and dedupes the result', async () => {
      const { fetchImpl, seen } = scriptedFetch(() => ({
        status: 200,
        body: { labels: [{ id: 'l_1', name: 'Prod' }] },
      }));
      const resolved = await new DoitClient({ apiKey: 'k', fetchImpl }).resolveLabels([
        'prod',
        ' prod ',
        'l_1',
      ]);
      expect(resolved).toEqual(['l_1']);
      expect(seen).toHaveLength(2);
      expect(new URL(seen[0].url).searchParams.get('nameContains')).toBe('prod');
      expect(new URL(seen[0].url).searchParams.get('maxResults')).toBe('50');
    });

    it('creates missing labels with the default color when asked', async () => {
      const { fetchImpl, seen } = scriptedFetch((s) =>
        s.method === 'POST'
          ? { status: 201, body: { id: 'l_new', name: 'x' } }
          : { status: 200, body: { labels: [] } }
      );
      const resolved = await new DoitClient({ apiKey: 'k', fetchImpl }).resolveLabels(['x'], {
        createMissing: true,
      });
      expect(resolved).toEqual(['l_new']);
      expect(seen[1].body).toEqual({ name: 'x', color: 'blue' });
    });

    it('warns and skips on 403 but rethrows other errors', async () => {
      const onWarning = vi.fn();
      const forbidden = scriptedFetch((s) => (isValidate(s) ? { status: 404 } : { status: 403 }));
      await expect(
        new DoitClient({ apiKey: 'k', fetchImpl: forbidden.fetchImpl, onWarning }).resolveLabels([
          'x',
        ])
      ).resolves.toEqual([]);
      expect(onWarning).toHaveBeenCalledWith(
        expect.stringContaining('Skipping label resolution for "x"')
      );

      const broken = scriptedFetch((s) => (isValidate(s) ? { status: 404 } : { status: 500 }));
      await expect(
        new DoitClient({ apiKey: 'k', fetchImpl: broken.fetchImpl }).resolveLabels(['x'])
      ).rejects.toBeInstanceOf(DoitApiError);
    });
  });
});
