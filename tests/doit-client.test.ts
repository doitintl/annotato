import { describe, expect, it, vi } from 'vitest';
import { DoitApiError, DoitClient } from '../src/doit-client.js';

function createMockFetch(
  handler: (url: string, init?: RequestInit) => Promise<{ status: number; statusText?: string; body?: unknown }>
): typeof fetch {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const result = await handler(url, init);
    const bodyText =
      result.body === undefined
        ? ''
        : typeof result.body === 'string'
          ? result.body
          : JSON.stringify(result.body);
    return {
      ok: result.status >= 200 && result.status < 300,
      status: result.status,
      statusText: result.statusText ?? (result.status === 200 ? 'OK' : result.status === 201 ? 'Created' : 'Error'),
      text: async () => bodyText,
    } as Response;
  });
}

describe('DoitClient', () => {
  it('throws if API key is empty or if a non-HTTPS external baseUrl is provided', () => {
    expect(() => new DoitClient({ apiKey: '   ' })).toThrow('DoiT API key is required');
    expect(
      () => new DoitClient({ apiKey: 'valid_key', baseUrl: 'http://api.doit.com' })
    ).toThrow('DoiT API base URL must use https://');
    expect(
      () => new DoitClient({ apiKey: 'valid_key', baseUrl: 'http://127.0.0.1:8080' })
    ).not.toThrow();
  });

  it('creates an annotation with Authorization Bearer and X-Tenant-Id headers', async () => {
    let capturedUrl = '';
    let capturedInit: RequestInit | undefined;

    const mockFetch = createMockFetch(async (url, init) => {
      capturedUrl = url;
      capturedInit = init;
      return {
        status: 201,
        body: {
          id: 'ann_123',
          content: 'Release v1.2.0 deployed to prod',
          timestamp: '2026-10-21T14:00:00.000Z',
          reports: ['rep_1'],
          labels: [{ id: 'lbl_1', name: 'Production' }],
          createTime: '2026-10-21T14:00:01.000Z',
          updateTime: '2026-10-21T14:00:01.000Z',
        },
      };
    });

    const client = new DoitClient({
      apiKey: 'secret_doit_token',
      baseUrl: 'https://api.doit.com/',
      tenantId: 'tenant_abc',
      fetchImpl: mockFetch,
    });

    const created = await client.createAnnotation({
      content: 'Release v1.2.0 deployed to prod',
      timestamp: '2026-10-21T14:00:00Z',
      reports: ['rep_1'],
      labels: ['lbl_1'],
    });

    expect(created.id).toBe('ann_123');
    expect(capturedUrl).toBe('https://api.doit.com/analytics/v1/annotations');
    expect(capturedInit?.method).toBe('POST');
    expect(capturedInit?.headers).toEqual({
      Authorization: 'Bearer secret_doit_token',
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'X-Tenant-Id': 'tenant_abc',
    });
    expect(JSON.parse(capturedInit?.body as string)).toEqual({
      content: 'Release v1.2.0 deployed to prod',
      timestamp: '2026-10-21T14:00:00.000Z',
      reports: ['rep_1'],
      labels: ['lbl_1'],
    });
  });

  it('validates content and timestamp before creating an annotation', async () => {
    const client = new DoitClient({
      apiKey: 'secret_doit_token',
      fetchImpl: createMockFetch(async () => ({ status: 201, body: {} })),
    });

    await expect(
      client.createAnnotation({ content: '  ', timestamp: '2026-10-21T14:00:00Z' })
    ).rejects.toThrow('Annotation content is required');

    await expect(
      client.createAnnotation({ content: 'Valid content', timestamp: 'not-a-timestamp' })
    ).rejects.toThrow('Invalid RFC3339 timestamp');
  });

  it('supports getAnnotation, listAnnotations, updateAnnotation (PATCH), and deleteAnnotation', async () => {
    const requests: Array<{ method?: string; url: string; body?: unknown }> = [];

    const mockFetch = createMockFetch(async (url, init) => {
      requests.push({
        method: init?.method,
        url,
        body: init?.body ? JSON.parse(init.body as string) : undefined,
      });

      if (init?.method === 'GET' && url.includes('/analytics/v1/annotations/ann_123')) {
        return {
          status: 200,
          body: {
            id: 'ann_123',
            content: 'Fetched annotation',
            timestamp: '2026-10-21T14:00:00.000Z',
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
                id: 'ann_123',
                content: 'Fetched annotation',
                timestamp: '2026-10-21T14:00:00.000Z',
              },
            ],
          },
        };
      }

      if (init?.method === 'PATCH') {
        return {
          status: 200,
          body: {
            id: 'ann_123',
            content: 'Updated after rollback',
            timestamp: '2026-10-21T15:00:00.000Z',
          },
        };
      }

      if (init?.method === 'DELETE') {
        return { status: 200, body: '' };
      }

      return { status: 404, body: { error: 'Not found' } };
    });

    const client = new DoitClient({ apiKey: 'test_key', fetchImpl: mockFetch });

    const single = await client.getAnnotation('ann_123');
    expect(single.id).toBe('ann_123');

    const list = await client.listAnnotations({
      maxResults: 10,
      filter: 'content:Release',
      sortBy: 'timestamp',
      sortOrder: 'desc',
    });
    expect(list.rowCount).toBe(1);

    const updated = await client.updateAnnotation('ann_123', {
      content: 'Updated after rollback',
      timestamp: '2026-10-21T15:00:00Z',
    });
    expect(updated.content).toBe('Updated after rollback');

    await client.deleteAnnotation('ann_123');

    expect(requests[0].method).toBe('GET');
    expect(requests[0].url).toBe('https://api.doit.com/analytics/v1/annotations/ann_123');
    expect(requests[1].url).toContain('maxResults=10');
    expect(requests[1].url).toContain('filter=content%3ARelease');
    expect(requests[2].method).toBe('PATCH');
    expect(requests[2].body).toEqual({
      content: 'Updated after rollback',
      timestamp: '2026-10-21T15:00:00.000Z',
    });
    expect(requests[3].method).toBe('DELETE');
  });

  it('resolves existing label names case-insensitively, creates missing labels when enabled, and passes through raw IDs', async () => {
    const mockFetch = createMockFetch(async (url, init) => {
      if (init?.method === 'GET' && url.includes('/analytics/v1/labels')) {
        const parsedUrl = new URL(url);
        const search = parsedUrl.searchParams.get('nameContains');
        if (search?.toLowerCase() === 'production') {
          return {
            status: 200,
            body: {
              rowCount: 1,
              labels: [{ id: 'lbl_prod_99', name: 'Production', color: 'teal' }],
            },
          };
        }
        return { status: 200, body: { rowCount: 0, labels: [] } };
      }

      if (init?.method === 'POST' && url.endsWith('/analytics/v1/labels')) {
        const body = JSON.parse(init.body as string);
        return {
          status: 201,
          body: {
            id: `lbl_created_${body.name}`,
            name: body.name,
            color: body.color,
          },
        };
      }

      return { status: 404, body: { error: 'Not found' } };
    });

    const client = new DoitClient({ apiKey: 'test_key', fetchImpl: mockFetch });

    // Without createMissing: resolves "production" -> "lbl_prod_99", passes through unknown "utHqK0OmwbPy1au3Xy22"
    const resolvedPassThrough = await client.resolveLabels([
      'production',
      'utHqK0OmwbPy1au3Xy22',
      'id:explicit_id_1',
    ]);
    expect(resolvedPassThrough).toEqual([
      'lbl_prod_99',
      'utHqK0OmwbPy1au3Xy22',
      'explicit_id_1',
    ]);

    // With createMissing: creates "release-tag" with specified color
    const resolvedCreated = await client.resolveLabels(['Production', 'release-tag'], {
      createMissing: true,
      defaultColor: 'mint',
    });
    expect(resolvedCreated).toEqual(['lbl_prod_99', 'lbl_created_release-tag']);
  });

  it('redacts API key from DoitApiError messages on non-2xx responses', async () => {
    const secretKey = 'super_secret_doit_key_999';
    const mockFetch = createMockFetch(async () => ({
      status: 401,
      statusText: 'Unauthorized',
      body: { error: `Invalid token ${secretKey} provided` },
    }));

    const client = new DoitClient({ apiKey: secretKey, fetchImpl: mockFetch });

    try {
      await client.getAnnotation('ann_1');
      expect.fail('Expected DoitApiError to be thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(DoitApiError);
      const apiErr = err as DoitApiError;
      expect(apiErr.status).toBe(401);
      expect(apiErr.message).not.toContain(secretKey);
      expect(apiErr.message).toContain('***');
    }
  });

  it('falls back to customerContext query param on 403 when tenantId is set and skips labels on 403', async () => {
    const seenUrls: string[] = [];
    const mockFetch = createMockFetch(async (url, init) => {
      seenUrls.push(url);
      const headers = (init?.headers ?? {}) as Record<string, string>;
      // Simulate a legacy Doer API key that returns 403 for X-Tenant-Id unless ?customerContext= is present
      if (headers['X-Tenant-Id'] && !url.includes('customerContext=')) {
        return { status: 403, statusText: 'Forbidden', body: { error: 'Forbidden' } };
      }
      if (url.includes('/analytics/v1/labels')) {
        return { status: 403, statusText: 'Forbidden', body: { error: 'Labels Forbidden' } };
      }
      if (init?.method === 'POST' && url.includes('/analytics/v1/annotations')) {
        return {
          status: 201,
          body: {
            id: 'ann_legacy_ok',
            content: 'Deployed with fallback',
            timestamp: '2026-10-21T16:00:00.000Z',
          },
        };
      }
      return { status: 404, body: { error: 'Not found' } };
    });

    const client = new DoitClient({
      apiKey: 'legacy_doer_key',
      tenantId: 'tenant_test_123',
      fetchImpl: mockFetch,
    });

    // resolveLabels should gracefully skip 403 on /analytics/v1/labels while preserving explicit id: labels
    const labels = await client.resolveLabels(['production', 'id:lbl_explicit_1'], {
      createMissing: true,
    });
    expect(labels).toEqual(['lbl_explicit_1']);

    // createAnnotation should succeed via the ?customerContext= fallback when X-Tenant-Id returns 403
    const created = await client.createAnnotation({
      content: 'Deployed with fallback',
      timestamp: '2026-10-21T16:00:00Z',
    });
    expect(created.id).toBe('ann_legacy_ok');
    expect(
      seenUrls.some((u) =>
        u.includes('/analytics/v1/annotations?customerContext=tenant_test_123')
      )
    ).toBe(true);
  });
});
