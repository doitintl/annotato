import {
  AnnotationListItem,
  AnnotationListResponse,
  CreateAnnotationRequest,
  CreateLabelRequest,
  DEFAULT_API_URL,
  DoitErrorResponse,
  LabelColor,
  LabelListItem,
  LabelListResponse,
  ListAnnotationsParams,
  ListLabelsParams,
  UpdateAnnotationRequest,
} from './types.js';
import { trimTrailingSlashes } from './utils.js';

const REQUEST_TIMEOUT_MS = 30_000;
const LABEL_SEARCH_PAGE_SIZE = 50;
const ANNOTATION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const FALLBACK_CUSTOMER_CONTEXT = 'doit.com';
const ATTEMPT_LOG_SNIPPET_LENGTH = 80;
const DIAGNOSTICS_SNIPPET_LENGTH = 120;

interface RequestOptions {
  query?: Record<string, string | number | undefined>;
  body?: unknown;
}

interface SingleRequestOptions extends RequestOptions {
  includeTenantHeader?: boolean;
  includeCustomerContextQuery?: boolean;
}

interface RawResponse {
  response: Response;
  rawText: string;
}

interface TenantRetryStrategy {
  label: string;
  includeTenantHeader: boolean;
  includeCustomerContextQuery: boolean;
}

// Tried in order after a 401/403 when a tenant id is configured:
// 1. legacy ?customerContext=<tenantId> (legacy Doer API keys that ignore/reject X-Tenant-Id)
// 2. both X-Tenant-Id and ?customerContext=<tenantId>
// 3. neither (single-customer tokens where a tenant override is rejected)
const TENANT_RETRY_STRATEGIES: readonly TenantRetryStrategy[] = [
  { label: 'customerContext', includeTenantHeader: false, includeCustomerContextQuery: true },
  { label: 'both', includeTenantHeader: true, includeCustomerContextQuery: true },
  { label: 'noTenantOverride', includeTenantHeader: false, includeCustomerContextQuery: false },
];

function isLoopbackHost(hostname: string): boolean {
  return ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(hostname);
}

function isDoitHost(hostname: string): boolean {
  return hostname === 'api.doit.com' || hostname.endsWith('.doit.com');
}

function describePermissions(permissions: unknown): string {
  if (!Array.isArray(permissions)) return 'unknown';
  return permissions.length > 0 ? permissions.join(', ') : 'none/doer-token';
}

function describeAttempt(label: string, { response, rawText }: RawResponse): string {
  return `${label}->${response.status}(${rawText.slice(0, ATTEMPT_LOG_SNIPPET_LENGTH)})`;
}

function parseErrorDetail(rawText: string): string {
  try {
    const parsed = JSON.parse(rawText) as DoitErrorResponse;
    return parsed.error || parsed.message || rawText;
  } catch {
    return rawText;
  }
}

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
    this.baseUrl = DoitClient.normalizeBaseUrl(options.baseUrl);
    this.tenantId = options.tenantId?.trim() || undefined;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.onWarning = options.onWarning;
  }

  private static normalizeBaseUrl(rawBaseUrl?: string): string {
    const candidate = trimTrailingSlashes(rawBaseUrl?.trim() || DEFAULT_API_URL);
    let parsed: URL;
    try {
      parsed = new URL(candidate);
    } catch {
      throw new Error(`Invalid DoiT API base URL: "${candidate}"`);
    }
    if (parsed.username || parsed.password) {
      throw new Error('DoiT API base URL must not contain embedded credentials.');
    }
    const hostname = parsed.hostname.toLowerCase();
    const isLoopback = isLoopbackHost(hostname);
    if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLoopback)) {
      throw new Error(
        `DoiT API base URL must use https:// (received "${parsed.protocol}//${parsed.hostname}").`
      );
    }
    if (!isDoitHost(hostname) && !isLoopback) {
      throw new Error(
        `DoiT API base URL host "${parsed.hostname}" is not in the allowlist (*.doit.com).`
      );
    }
    return candidate;
  }

  private static validateAnnotationId(id: string, operationName: string): string {
    const trimmedId = id?.trim();
    if (!trimmedId) {
      throw new Error(`Annotation ID is required for ${operationName}.`);
    }
    if (!ANNOTATION_ID_PATTERN.test(trimmedId)) {
      throw new Error(
        `Invalid Annotation ID "${trimmedId}" for ${operationName}. Expected 1-128 alphanumeric, underscore, or hyphen characters.`
      );
    }
    return trimmedId;
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
    options?: SingleRequestOptions
  ): Promise<RawResponse> {
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
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
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
          query: { customerContext: FALLBACK_CUSTOMER_CONTEXT },
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
          permissions?: string[];
        };
        return ` [validate=200 permissions=${describePermissions(parsed.permissions)}]`;
      }
      return ` [validate=${response.status}: ${rawText.slice(0, DIAGNOSTICS_SNIPPET_LENGTH)}]`;
    } catch (err) {
      return ` [validate=error: ${err instanceof Error ? err.message : String(err)}]`;
    }
  }

  private async retryWithTenantStrategies(
    method: string,
    path: string,
    options: RequestOptions | undefined,
    firstAttempt: RawResponse,
    attemptLogs: string[]
  ): Promise<RawResponse> {
    for (const strategy of TENANT_RETRY_STRATEGIES) {
      const attempt = await this.executeSingleRequest(method, path, {
        ...options,
        includeTenantHeader: strategy.includeTenantHeader,
        includeCustomerContextQuery: strategy.includeCustomerContextQuery,
      });
      attemptLogs.push(describeAttempt(strategy.label, attempt));
      if (attempt.response.ok) {
        return attempt;
      }
    }
    return firstAttempt;
  }

  private async buildApiError(
    method: string,
    path: string,
    { response, rawText }: RawResponse,
    attemptLogs: string[]
  ): Promise<DoitApiError> {
    const attemptsSummary = attemptLogs.length > 1 ? ` [attempts: ${attemptLogs.join('; ')}]` : '';
    const diagnostics = path !== '/auth/v1/validate' ? await this.fetchTokenDiagnostics() : '';
    // Ensure API key is never leaked in error details
    const safeDetail = `${parseErrorDetail(rawText)}${attemptsSummary}${diagnostics}`
      .split(this.apiKey)
      .join('***');
    return new DoitApiError(
      `DoiT API ${method} ${path} failed (${response.status} ${response.statusText}): ${safeDetail}`,
      response.status,
      response.statusText,
      path,
      safeDetail
    );
  }

  private async request<T>(method: string, path: string, options?: RequestOptions): Promise<T> {
    const firstAttempt = await this.executeSingleRequest(method, path, {
      ...options,
      includeTenantHeader: true,
      includeCustomerContextQuery: false,
    });
    const attemptLogs = [
      describeAttempt(this.tenantId ? 'X-Tenant-Id' : 'default', firstAttempt),
    ];

    const isAuthFailure = firstAttempt.response.status === 401 || firstAttempt.response.status === 403;
    const { response, rawText } =
      isAuthFailure && this.tenantId
        ? await this.retryWithTenantStrategies(method, path, options, firstAttempt, attemptLogs)
        : firstAttempt;

    if (!response.ok) {
      throw await this.buildApiError(method, path, { response, rawText }, attemptLogs);
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
    const trimmedId = DoitClient.validateAnnotationId(id, 'getAnnotation');
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
    const trimmedId = DoitClient.validateAnnotationId(id, 'updateAnnotation');
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
    const trimmedId = DoitClient.validateAnnotationId(id, 'deleteAnnotation');
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
   * Resolves label names or IDs into label IDs.
   *
   * - `id:<value>` entries bypass lookup.
   * - Unmatched entries are created when `createMissing` is set (using `defaultColor`, which defaults to `'blue'`), otherwise passed through as raw IDs.
   * - A 403 from the labels API skips that entry so annotation creation can still proceed.
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
        const searchResult = await this.listLabels({ nameContains: entry, maxResults: LABEL_SEARCH_PAGE_SIZE });
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
