export const DEFAULT_API_URL = 'https://api.doit.com';

// Allowed DoiT Cloud Intelligence label color palette
export const DOIT_LABEL_COLORS = [
  'blue',
  'skyBlue',
  'teal',
  'mint',
  'lime',
  'softYellow',
  'apricot',
  'lavender',
  'purple',
  'rosePink',
  'slateGrey',
] as const;

export type LabelColor = (typeof DOIT_LABEL_COLORS)[number];

export interface LabelInfo {
  id: string;
  name: string;
}

export interface LabelListItem {
  id: string;
  name: string;
  color: LabelColor;
  type?: 'custom' | 'preset';
  createTime?: string;
  updateTime?: string;
}

export interface LabelListResponse {
  pageToken?: string;
  rowCount?: number;
  labels?: LabelListItem[];
}

export interface CreateLabelRequest {
  name: string;
  color: LabelColor;
}

export interface ListLabelsParams {
  maxResults?: number;
  pageToken?: string;
  filter?: string;
  nameContains?: string;
  sortBy?: 'id' | 'name' | 'type' | 'createTime' | 'updateTime';
  sortOrder?: 'asc' | 'desc';
}

export interface AnnotationListItem {
  id: string;
  content: string;
  timestamp: string;
  reports?: string[];
  labels?: LabelInfo[];
  createTime?: string;
  updateTime?: string;
}

export interface CreateAnnotationRequest {
  content: string;
  timestamp: string;
  reports?: string[];
  labels?: string[];
}

export interface UpdateAnnotationRequest {
  content?: string | null;
  timestamp?: string | null;
  reports?: string[] | null;
  labels?: string[] | null;
}

export interface AnnotationListResponse {
  pageToken?: string;
  rowCount?: number;
  annotations?: AnnotationListItem[];
}

export interface ListAnnotationsParams {
  maxResults?: number;
  pageToken?: string;
  filter?: string;
  sortBy?: 'id' | 'content' | 'timestamp' | 'timeCreated' | 'timeModified';
  sortOrder?: 'asc' | 'desc';
}

export interface DoitErrorResponse {
  error?: string;
  message?: string;
}

export type AnnotationOperation = 'create' | 'update' | 'delete' | 'get' | 'list';

export interface ActionInputs {
  doitApiKey: string;
  operation: AnnotationOperation;
  annotationId?: string;
  releaseId?: string;
  content?: string;
  template?: string;
  timestamp?: string;
  reports: string[];
  labels: string[];
  createMissingLabels: boolean;
  labelColor: LabelColor;
  tenantId?: string;
  apiUrl: string;
  dryRun: boolean;
  failOnError: boolean;
  filter?: string;
  maxResults?: number;
  requireTag?: string;
  requireCommitTag: string[];
  requirePrLabel: string[];
}

export interface GitHubEventContext {
  eventName: string;
  repo: string;
  release: string;
  tag: string;
  sha: string;
  shortSha: string;
  actor: string;
  environment: string;
  url: string;
  timestamp: string;
  releaseName?: string;
  releaseBody?: string;
  isTagRef?: boolean;
  commitMessage?: string;
  prLabels?: string[];
}

export interface ActionResult {
  operation: AnnotationOperation;
  dryRun: boolean;
  skipped?: boolean;
  skipReason?: string;
  annotationId?: string;
  annotationContent?: string;
  annotationTimestamp?: string;
  annotation?: AnnotationListItem;
  annotations?: AnnotationListItem[];
  resolvedLabels?: string[];
  requestPayload?: CreateAnnotationRequest | UpdateAnnotationRequest;
  context: GitHubEventContext;
}
