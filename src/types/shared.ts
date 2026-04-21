// ─── Enums (mirror Prisma enums for frontend use) ────────────────────────────

export type UserRole = 'USER' | 'ADMIN';
export type ListStatus = 'pending' | 'importing' | 'import_failed' | 'ready';
export type RunStatus = 'queuing' | 'processing' | 'completed' | 'stopped' | 'failed';
export type RunItemStatus = 'pending' | 'scraping' | 'classifying' | 'completed' | 'failed' | 'skipped' | 'retrying';
export type DomainSource = 'website' | 'email';
export type DomainResolutionMode = 'email_only' | 'website_only' | 'combined';
export type CombinedPriority = 'email_first' | 'website_first';
export type AiProvider = 'openai' | 'anthropic';
export type PromptMode = 'prompt_id' | 'text';
export type ScopeType = 'all' | 'selected' | 'filtered';
export type BillingSource = 'system_default' | 'user_credential';
export type FieldType = 'text' | 'number' | 'date' | 'boolean' | 'url' | 'select';
export type ProxyProtocol = 'http' | 'https' | 'socks5';
export type ScrapeStatus = 'success' | 'failed' | 'cached' | 'skipped';
export type SkipReason = 'personal_email' | 'invalid_domain' | 'no_domain' | 'non_html_content';
export type RunEventStep = 'dns_check' | 'scrape' | 'classify' | 'cache_hit' | 'skip' | 'error' | 'retry';
export type RunEventStatus = 'success' | 'failed' | 'skipped' | 'cached';
export type PromptSource = 'default' | 'stored' | 'text';

// ─── Pagination ──────────────────────────────────────────────────────────────

export interface PaginationMeta {
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
}

export interface PaginatedResponse<T> {
  data: T[];
  pagination: PaginationMeta;
}

// ─── Error Response ──────────────────────────────────────────────────────────

export interface ApiError {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}

// ─── Filter ──────────────────────────────────────────────────────────────────

export interface FilterItem {
  field: string;
  op: string;
  value: string | number | string[];
}

export interface FilterSnapshot {
  schema_version: 1;
  search?: string;
  filters: FilterItem[];
}

// ─── List DTOs ───────────────────────────────────────────────────────────────

export interface ListSummary {
  id: string;
  name: string;
  fileName: string;
  sourceRowCount: number;
  importedCount: number;
  duplicateCount: number;
  rejectedCount: number;
  status: ListStatus;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ListDetail extends ListSummary {
  originalHeaders: string[] | null;
  columnMapping: Record<string, unknown> | null;
}

// ─── Contact DTOs ────────────────────────────────────────────────────────────

export interface ContactRow {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  name: string | null;
  companyName: string | null;
  companyWebsite: string | null;
  websiteDomain: string | null;
  emailDomain: string | null;
  domainMismatch: boolean;
  customFields: Record<string, string | number | boolean | null>;
  rowIndex: number;
  // Projection from latest_result_id (current state)
  latestStatus: RunItemStatus | null;
  latestErrorMessage: string | null;
  latestAttemptAt: string | null;
  latestResultId: string | null;
  // Projection from latest_successful_result_id (stable classification)
  industry: string | null;
  subIndustry: string | null;
  confidence: number | null;
  reasoning: string | null;
  costUsd: string | null;
  latestSuccessfulResultId: string | null;
  createdAt: string;
}

// ─── Run DTOs ────────────────────────────────────────────────────────────────

export interface RunSummary {
  id: string;
  listId: string;
  status: RunStatus;
  aiProvider: AiProvider;
  aiModel: string;
  promptSource: PromptSource;
  billingSource: BillingSource;
  domainResolutionMode: DomainResolutionMode;
  totalItems: number;
  completedItems: number;
  failedItems: number;
  skippedItems: number;
  totalCostUsd: string;
  scopeMaterialized: boolean;
  errorMessage: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

export interface RunDetail extends RunSummary {
  combinedPriority: CombinedPriority | null;
  forceRescrape: boolean;
  domainCacheTtlDays: number;
  scopeType: ScopeType;
  selectedContactIds: string[] | null;
  filterSnapshot: FilterSnapshot | null;
  promptId: string | null;
  promptVersion: string | null;
  promptHash: string | null;
  aiCredentialId: string | null;
  totalInputTokens: number;
  totalOutputTokens: number;
  stoppedAt: string | null;
  updatedAt: string;
}

export interface RunProgress {
  run: {
    id: string;
    status: RunStatus;
    totalItems: number;
    completedItems: number;
    failedItems: number;
    skippedItems: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalCostUsd: string;
    startedAt: string | null;
    stoppedAt: string | null;
    completedAt: string | null;
    errorMessage: string | null;
    scopeMaterialized: boolean;
  };
  events: RunEventDto[];
  lastEventId: number | null;
}

// ─── Run Item DTOs ───────────────────────────────────────────────────────────

export interface RunItemRow {
  id: string;
  runId: string;
  contactId: string;
  contactEmail: string;
  contactRowIndex: number;
  status: RunItemStatus;
  domain: string | null;
  domainSource: DomainSource | null;
  fallbackDomain: string | null;
  fallbackAttempted: boolean;
  scrapeStatus: ScrapeStatus | null;
  scrapeError: string | null;
  scrapeMs: number | null;
  proxyUsed: string | null;
  industry: string | null;
  subIndustry: string | null;
  confidence: number | null;
  reasoning: string | null;
  inputTokens: number;
  outputTokens: number;
  costUsd: string;
  classifyMs: number | null;
  skipReason: SkipReason | null;
  errorMessage: string | null;
  attemptCount: number;
  lockedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

// ─── Run Event DTOs ──────────────────────────────────────────────────────────

export interface RunEventDto {
  id: number;
  runId: string;
  runItemId: string | null;
  contactId: string | null;
  step: RunEventStep;
  status: RunEventStatus;
  message: string;
  durationMs: number | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

// ─── Create Run Request ──────────────────────────────────────────────────────

export interface CreateRunRequest {
  domainResolutionMode: DomainResolutionMode;
  combinedPriority?: CombinedPriority;
  aiModel: string;
  promptSource: PromptSource;
  promptId?: string;
  promptText?: string;
  billingSource: BillingSource;
  aiCredentialId?: string;
  forceRescrape: boolean;
  domainCacheTtlDays: number;
  scopeType: ScopeType;
  selectedContactIds?: string[];
  filterSnapshot?: FilterSnapshot;
}

// ─── Settings DTOs ───────────────────────────────────────────────────────────

export interface ProfileDto {
  id: string;
  email: string;
  name: string | null;
  role: UserRole;
  domainCacheTtlDays: number;
  createdAt: string;
  updatedAt: string;
}

export interface AiCredentialDto {
  id: string;
  provider: AiProvider;
  label: string;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CustomFieldDto {
  id: string;
  name: string;
  fieldKey: string;
  fieldType: FieldType;
  selectOptions: string[] | null;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface SettingsResponse {
  profile: ProfileDto;
  aiCredentials: AiCredentialDto[];
  customFields: CustomFieldDto[];
}

export interface UpdateProfileRequest {
  name?: string | null;
  domainCacheTtlDays?: number;
}

export interface CreateAiCredentialRequest {
  provider: AiProvider;
  label: string;
  apiKey: string;
  isDefault?: boolean;
}

export interface CreateCustomFieldRequest {
  name: string;
  fieldType: FieldType;
  selectOptions?: string[];
}

export interface UpdateCustomFieldRequest {
  name?: string;
  selectOptions?: string[];
}

export interface ReorderCustomFieldsRequest {
  fieldIds: string[];
}

// ─── Dashboard DTOs ──────────────────────────────────────────────────────────

export interface DashboardResponse {
  totalLists: number;
  totalContacts: number;
  recentRuns: DashboardRun[];
  monthlyCostUsd: string;
}

export interface DashboardRun {
  id: string;
  listId: string;
  listName: string;
  status: RunStatus;
  totalItems: number;
  completedItems: number;
  failedItems: number;
  skippedItems: number;
  totalCostUsd: string;
  createdAt: string;
  completedAt: string | null;
}

// ─── Admin DTOs ──────────────────────────────────────────────────────────────

export interface AdminDomainRow {
  domain: string;
  dnsValid: boolean | null;
  dnsCheckedAt: string | null;
  latestSnapshotAt: string | null;
  classificationsCount: number;
  createdAt: string;
}

export interface AdminDomainDetail {
  domain: {
    id: string;
    domain: string;
    dnsValid: boolean | null;
    dnsCheckedAt: string | null;
    createdAt: string;
    updatedAt: string;
  };
  snapshots: AdminSnapshotRow[];
  classifications: AdminClassificationRow[];
}

export interface AdminSnapshotRow {
  id: string;
  pageTitle: string | null;
  metaDescription: string | null;
  pagesScraped: number;
  httpStatus: number | null;
  scrapeSuccess: boolean;
  scrapeError: string | null;
  contentLength: number | null;
  proxyUsed: string | null;
  scrapedAt: string;
  invalidatedAt: string | null;
  createdAt: string;
}

export interface AdminClassificationRow {
  id: string;
  snapshotId: string;
  aiProvider: AiProvider;
  aiModel: string;
  promptId: string | null;
  promptVersion: string | null;
  promptHash: string | null;
  industry: string;
  subIndustry: string | null;
  confidence: number;
  reasoning: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: string;
  createdAt: string;
}

export interface AdminProxyDto {
  id: string;
  name: string;
  host: string;
  port: number;
  protocol: ProxyProtocol;
  isActive: boolean;
  priority: number;
  totalRequests: number;
  successCount: number;
  failureCount: number;
  avgResponseMs: number;
  lastUsedAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateProxyRequest {
  name: string;
  host: string;
  port: number;
  username?: string;
  password?: string;
  protocol?: ProxyProtocol;
  isActive?: boolean;
  priority?: number;
}

export interface AdminStatsResponse {
  users: { total: number; admins: number };
  lists: { total: number; active: number; softDeleted: number };
  runs: {
    total: number;
    byStatus: Record<RunStatus, number>;
    totalCostUsdAllTime: string;
    totalCostUsdThisMonth: string;
  };
  domains: {
    total: number;
    withActiveSnapshot: number;
    classificationsTotal: number;
  };
  proxies: {
    total: number;
    active: number;
    avgSuccessRatePhase1: number;
  };
  workers: Array<{
    instanceId: string;
    status: 'healthy' | 'degraded' | 'dead';
    lastHeartbeat: string;
    queues: string[];
  }>;
}

// ─── Health DTOs ─────────────────────────────────────────────────────────────

export interface HealthResponse {
  status: string;
  server: { uptime: number };
  worker: {
    status: 'healthy' | 'degraded' | 'dead';
    last_heartbeat: string | null;
    instance_id: string | null;
  };
  queues: Record<string, { queued: number; retrying: number }>;
}
