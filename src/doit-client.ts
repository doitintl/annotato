import {
  AnnotationListItem,
  AnnotationListResponse,
  CreateAnnotationRequest,
  CreateLabelRequest,
  DoitErrorResponse,
  LabelColor,
  LabelListItem,
  LabelListResponse,
  ListAnnotationsParams,
  ListLabelsParams,
  UpdateAnnotationRequest,
} from './types.js';

export interface DoitClientOptions {
  apiKey: string;
  baseUrl?: string;
  tenantId?: string;
  fetchImpl?: typeof fetch;
  onWarning?: (message: string) => void;
}

export class DoitApiError extends Error {
  public readonly status: number;
  public readonly statusText: string;
  public readonly endpoint: string;
  public readonly details?: string;

  constructor(
    message: string,
    status: number,
    statusText: string,
    endpoint: string,
    details?: string
  ) {
    super(message);
    this.name = 'DoitApiError';
    this.status = status;
    this.statusText = statusText;
    this.endpoint = endpoint;
    this.details = details;
  }
}

export class DoitClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly tenantId?: string;
  private readonly fetchImpl: typeof fetch;
  private readonly onWarning?: (message: string) => void;

  constructor(options: DoitClientOptions) {
    const trimmedKey = options.apiKey?.trim();
    if (!trimmedKey) {
      throw new Error('DoiT API key is required and cannot be empty.');
    }
    this.apiKey = trimmedKey;
    this.baseUrl = (options.baseUrl?.trim() || 'https://api.doit.com').replace(/\/+$/, '');
    this.tenantId = options.tenantId?.trim() || undefined;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.onWarning = options.onWarning;
  }

  private buildHeaders(
    hasJsonBody: boolean,
    includeTenantHeader: boolean = true
  ): Record<string, string> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      Accept: 'application/json',
    };
    if (hasJsonBody) {
      headers['Content-Type'] = 'application/json';
    }
    if (includeTenantHeader && this.tenantId) {
      headers['X-Tenant-Id'] = this.tenantId;
    }
    return headers;
  }

  private async executeSingleRequest(
    method: string,
    path: string,
    options?: {
      query?: Record<string, string | number | undefined>;
      body?: unknown;
      includeTenantHeader?: boolean;
      includeCustomerContextQuery?: boolean;
    }
  ): Promise<{ response: Response; rawText: string }> {
    const url = new URL(`${this.baseUrl}${path}`);
    if (options?.query) {
      for (const [key, val] of Object.entries(options.query)) {
        if (val !== undefined && val !== '') {
          url.searchParams.set(key, String(val));
        }
      }
    }
    if (options?.includeCustomerContextQuery && this.tenantId) {
      url.searchParams.set('customerContext', this.tenantId);
    }

    const hasBody = options?.body !== undefined;
    const response = await this.fetchImpl(url.toString(), {
      method,
      headers: this.buildHeaders(hasBody, options?.includeTenantHeader ?? true),
      body: hasBody ? JSON.stringify(options.body) : undefined,
    });

    const rawText = await response.text();
    return { response, rawText };
  }

  private async fetchTokenDiagnostics(): Promise<string> {
    try {
      let { response, rawText } = await this.executeSingleRequest('GET', '/auth/v1/validate', {
        includeTenantHeader: Boolean(this.tenantId),
        includeCustomerContextQuery: Boolean(this.tenantId),
      });
      if (!response.ok) {
        const fallback = await this.executeSingleRequest('GET', '/auth/v1/validate', {
          query: { customerContext: 'doit.com' },
          includeTenantHeader: false,
          includeCustomerContextQuery: false,
        });
        if (fallback.response.ok) {
          response = fallback.response;
          rawText = fallback.rawText;
        }
      }
      if (response.ok && rawText) {
        const parsed = JSON.parse(rawText) as {
          domain?: string;
          email?: string;
          permissions?: string[];
        };
        const perms = Array.isArray(parsed.permissions)
          ? parsed.permissions.length > 0
            ? parsed.permissions.join(', ')
            : 'none/doer-token'
          : 'unknown';
        return ` [validate=200 domain=${parsed.domain || 'unknown'}, email=${parsed.email || 'service-account'}, permissions=${perms}]`;
      }
      return ` [validate=${response.status}: ${rawText.slice(0, 120)}]`;
    } catch (err) {
      return ` [validate=error: ${err instanceof Error ? err.message : String(err)}]`;
    }
  }

  private async request<T>(
    method: string,
    path: string,
    options?: {
      query?: Record<string, string | number | undefined>;
      body?: unknown;
    }
  ): Promise<T> {
    const attemptLogs: string[] = [];

    let { response, rawText } = await this.executeSingleRequest(method, path, {
      query: options?.query,
      body: options?.body,
      includeTenantHeader: true,
      includeCustomerContextQuery: false,
    });
    attemptLogs.push(
      `${this.tenantId ? 'X-Tenant-Id' : 'default'}->${response.status}(${rawText.slice(0, 80)})`
    );

    // If 401/403 when tenantId is configured:
    // 1. Retry with legacy ?customerContext=<tenantId> (for legacy Doer API keys that ignore/reject X-Tenant-Id)
    // 2. Retry with both X-Tenant-Id and ?customerContext=<tenantId>
    // 3. Retry without X-Tenant-Id or customerContext (for single-customer tokens where tenant override is rejected)
    if ((response.status === 401 || response.status === 403) && this.tenantId) {
      const strategies: Array<{
        label: string;
        includeTenantHeader: boolean;
        includeCustomerContextQuery: boolean;
      }> = [
        {
          label: 'customerContext',
          includeTenantHeader: false,
          includeCustomerContextQuery: true,
        },
        {
          label: 'both',
          includeTenantHeader: true,
          includeCustomerContextQuery: true,
        },
        {
          label: 'noTenantOverride',
          includeTenantHeader: false,
          includeCustomerContextQuery: false,
        },
      ];

      for (const strat of strategies) {
        const nextAttempt = await this.executeSingleRequest(method, path, {
          query: options?.query,
          body: options?.body,
          includeTenantHeader: strat.includeTenantHeader,
          includeCustomerContextQuery: strat.includeCustomerContextQuery,
        });
        attemptLogs.push(
          `${strat.label}->${nextAttempt.response.status}(${nextAttempt.rawText.slice(0, 80)})`
        );
        if (nextAttempt.response.ok) {
          response = nextAttempt.response;
          rawText = nextAttempt.rawText;
          break;
        }
      }
    }

    if (!response.ok) {
      let errorDetail = rawText;
      try {
        const parsed = JSON.parse(rawText) as DoitErrorResponse;
        errorDetail = parsed.error || parsed.message || rawText;
      } catch {
        // Keep raw text when not JSON
      }
      const attemptsSummary =
        attemptLogs.length > 1 ? ` [attempts: ${attemptLogs.join('; ')}]` : '';
      const diagnostics =
        path !== '/auth/v1/validate' ? await this.fetchTokenDiagnostics() : '';
      // Ensure API key is never leaked in error details
      const safeDetail = `${errorDetail}${attemptsSummary}${diagnostics}`
        .split(this.apiKey)
        .join('***');
      throw new DoitApiError(
        `DoiT API ${method} ${path} failed (${response.status} ${response.statusText}): ${safeDetail}`,
        response.status,
        response.statusText,
        path,
        safeDetail
      );
    }

    if (!rawText) {
      return undefined as T;
    }

    return JSON.parse(rawText) as T;
  }

  public async createAnnotation(payload: CreateAnnotationRequest): Promise<AnnotationListItem> {
    const content = payload.content?.trim();
    if (!content) {
      throw new Error('Annotation content is required.');
    }
    const timestamp = payload.timestamp?.trim();
    if (!timestamp || Number.isNaN(Date.parse(timestamp))) {
      throw new Error(`Invalid RFC3339 timestamp for annotation: "${payload.timestamp}"`);
    }

    const body: CreateAnnotationRequest = {
      content,
      timestamp: new Date(timestamp).toISOString(),
    };
    if (payload.reports && payload.reports.length > 0) {
      body.reports = payload.reports;
    }
    if (payload.labels && payload.labels.length > 0) {
      body.labels = payload.labels;
    }

    try {
      return await this.request<AnnotationListItem>('POST', '/analytics/v1/annotations', { body });
    } catch (err) {
      // If attaching to specific reports/labels caused a 403/404 (e.g. private user report with a service account token),
      // retry creating the annotation globally without report/label restrictions
      if (
        err instanceof DoitApiError &&
        (err.status === 403 || err.status === 404) &&
        (body.reports?.length || body.labels?.length)
      ) {
        this.onWarning?.(
          `[Annotato] Attaching annotation to specified reports/labels returned HTTP ${err.status}; retrying as a global annotation without report/label restrictions.`
        );
        return await this.request<AnnotationListItem>('POST', '/analytics/v1/annotations', {
          body: {
            content: body.content,
            timestamp: body.timestamp,
          },
        });
      }
      throw err;
    }
  }

  public async getAnnotation(id: string): Promise<AnnotationListItem> {
    const trimmedId = id?.trim();
    if (!trimmedId) {
      throw new Error('Annotation ID is required for getAnnotation.');
    }
    return this.request<AnnotationListItem>(
      'GET',
      `/analytics/v1/annotations/${encodeURIComponent(trimmedId)}`
    );
  }

  public async listAnnotations(params?: ListAnnotationsParams): Promise<AnnotationListResponse> {
    return this.request<AnnotationListResponse>('GET', '/analytics/v1/annotations', {
      query: {
        maxResults: params?.maxResults,
        pageToken: params?.pageToken,
        filter: params?.filter,
        sortBy: params?.sortBy,
        sortOrder: params?.sortOrder,
      },
    });
  }

  public async updateAnnotation(
    id: string,
    payload: UpdateAnnotationRequest
  ): Promise<AnnotationListItem> {
    const trimmedId = id?.trim();
    if (!trimmedId) {
      throw new Error('Annotation ID is required for updateAnnotation.');
    }
    const body: UpdateAnnotationRequest = {};
    if (payload.content !== undefined) {
      body.content = payload.content;
    }
    if (payload.timestamp !== undefined) {
      if (payload.timestamp !== null && Number.isNaN(Date.parse(payload.timestamp))) {
        throw new Error(`Invalid RFC3339 timestamp for updateAnnotation: "${payload.timestamp}"`);
      }
      body.timestamp =
        payload.timestamp !== null ? new Date(payload.timestamp).toISOString() : null;
    }
    if (payload.reports !== undefined) {
      body.reports = payload.reports;
    }
    if (payload.labels !== undefined) {
      body.labels = payload.labels;
    }

    return this.request<AnnotationListItem>(
      'PATCH',
      `/analytics/v1/annotations/${encodeURIComponent(trimmedId)}`,
      { body }
    );
  }

  public async deleteAnnotation(id: string): Promise<void> {
    const trimmedId = id?.trim();
    if (!trimmedId) {
      throw new Error('Annotation ID is required for deleteAnnotation.');
    }
    await this.request<void>(
      'DELETE',
      `/analytics/v1/annotations/${encodeURIComponent(trimmedId)}`
    );
  }

  public async listLabels(params?: ListLabelsParams): Promise<LabelListResponse> {
    return this.request<LabelListResponse>('GET', '/analytics/v1/labels', {
      query: {
        maxResults: params?.maxResults,
        pageToken: params?.pageToken,
        filter: params?.filter,
        nameContains: params?.nameContains,
        sortBy: params?.sortBy,
        sortOrder: params?.sortOrder,
      },
    });
  }

  public async createLabel(payload: CreateLabelRequest): Promise<LabelListItem> {
    const name = payload.name?.trim();
    if (!name) {
      throw new Error('Label name is required.');
    }
    return this.request<LabelListItem>('POST', '/analytics/v1/labels', {
      body: {
        name,
        color: payload.color || 'blue',
      },
    });
  }

  /**
   * Resolves an array of label identifiers (either human-readable label names or DoiT label IDs)
   * into DoiT label IDs suitable for CreateAnnotationRequest / UpdateAnnotationRequest.
   *
   * - Prefixing an entry with `id:` (e.g. `id:utHqK0OmwbPy1au3Xy22`) bypasses lookup.
   * - Otherwise, searches GET /analytics/v1/labels?nameContains=<entry> for a case-insensitive
   *   name match or exact ID match.
   * - If no match is found and `options.createMissing` is true, creates the label via
   *   POST /analytics/v1/labels with `options.defaultColor` (defaults to 'blue').
   * - If no match is found and `options.createMissing` is false, passes the value through as a raw label ID.
   */
  public async resolveLabels(
    inputs: string[],
    options?: {
      createMissing?: boolean;
      defaultColor?: LabelColor;
    }
  ): Promise<string[]> {
    const cleaned = Array.from(
      new Set(inputs.map((item) => item.trim()).filter((item) => item.length > 0))
    );
    if (cleaned.length === 0) {
      return [];
    }

    const resolvedIds: string[] = [];
    const defaultColor: LabelColor = options?.defaultColor ?? 'blue';

    for (const entry of cleaned) {
      if (entry.startsWith('id:')) {
        const explicitId = entry.slice(3).trim();
        if (explicitId) {
          resolvedIds.push(explicitId);
        }
        continue;
      }

      try {
        const searchResult = await this.listLabels({ nameContains: entry, maxResults: 50 });
        const labels = searchResult.labels ?? [];
        const exactMatch = labels.find(
          (lbl) => lbl.name.toLowerCase() === entry.toLowerCase() || lbl.id === entry
        );

        if (exactMatch) {
          resolvedIds.push(exactMatch.id);
        } else if (options?.createMissing) {
          const created = await this.createLabel({
            name: entry,
            color: defaultColor,
          });
          resolvedIds.push(created.id);
        } else {
          resolvedIds.push(entry);
        }
      } catch (err) {
        if (err instanceof DoitApiError && err.status === 403) {
          // Token lacks Labels API permission; skip label lookup/creation so annotation creation can still proceed
          this.onWarning?.(
            `[Annotato] Skipping label resolution for "${entry}" because /analytics/v1/labels returned 403 Forbidden.`
          );
          continue;
        }
        throw err;
      }
    }

    return Array.from(new Set(resolvedIds));
  }
}
