import {
  User,
  WhatsappStatus,
  DigestFrequency,
  AlertRule,
  RagDocument,
  RagDocumentListResponse,
  RagQueryResponse,
  DocumentStatus,
  DocumentProgress,
  ScrapedItem,
  ScrapedItemCategory,
  ScrapeRun,
  ScrapeRunStatus,
  ScrapeRunProgress,
  ScrapeSource,
  ScrapePaginationType,
  SitemapCheckResult,
  RouteDiscoveryResult,
  SchedulerStatus,
  RunAllResult,
  PublicNoticeDetail,
  PublicNoticeSource,
  SettingsView,
  SettingApplyResult,
  PublicSiteSettings,
  AiHealthSnapshot,
  AiProvider,
  AiProviderKind,
  AiProviderModel,
  AiProviderInput,
  SystemStatus,
} from "./types"

// `||` (not `??`) deliberately — an unset GitHub Actions build-time Variable
// bakes in "" at build time, which is falsy but not null/undefined, so `??`
// would silently keep the empty string and every request would resolve as a
// same-origin relative path instead of falling back.
export const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:5005"

const TOKEN_KEY = "pnm_token"
const TOKEN_COOKIE = "pnm_token"
const SESSION_DAYS = 7

/**
 * Fired on `window` whenever a request comes back 401 while a token was sent.
 * AuthProvider listens and force-logs-out so guards can bounce to /login.
 */
export const AUTH_EXPIRED_EVENT = "pnm:unauthorized"

export const tokenStore = {
  get: () => (typeof window === "undefined" ? null : localStorage.getItem(TOKEN_KEY)),
  set: (token: string) => {
    if (typeof window === "undefined") return
    localStorage.setItem(TOKEN_KEY, token)
    // Mirror to a cookie so the edge middleware can gate protected routes
    // without a round-trip to the API. SameSite=Lax keeps it usable for the
    // browser navigation; the API still authorizes via the Authorization
    // header (the cookie is a UX gate, never a security boundary).
    const siteUrl = typeof window !== "undefined" ? window.location.href : ""
    const secureFlag = siteUrl.startsWith("https") ? "; Secure" : ""
    document.cookie = `${TOKEN_COOKIE}=${encodeURIComponent(token)}; path=/; max-age=${
      60 * 60 * 24 * SESSION_DAYS
    }; SameSite=Lax${secureFlag}`
  },
  clear: () => {
    if (typeof window === "undefined") return
    localStorage.removeItem(TOKEN_KEY)
    document.cookie = `${TOKEN_COOKIE}=; path=/; max-age=0; SameSite=Lax`
  },
}

// Shape returned by the API for a user.
interface ApiUser {
  id: string
  email: string
  name: string
  avatarUrl: string | null
  role: "user" | "admin"
  status: "active" | "inactive"
  createdAt: string
  lastLoginAt: string | null
}

// Map the API user onto the web app's existing User shape.
function mapUser(u: ApiUser): User {
  return {
    id: u.id,
    username: u.name,
    name: u.name,
    email: u.email,
    avatarUrl: u.avatarUrl,
    role: u.role,
    status: u.status,
    createdAt: u.createdAt,
    lastLogin: u.lastLoginAt ?? u.createdAt,
  }
}

// ─── Membership & billing ────────────────────────────────────────────────────

export type PlanTier = "FREE" | "PRO" | "MAX"

export type QuotaKind =
  | "ai_questions"
  | "documents"
  | "alert_rules"
  | "whatsapp_notifications"
  | "upload_size"
  | "instant_alerts"

export interface QuotaDenial {
  kind: QuotaKind
  limit: number | null
  used: number
  tier: PlanTier
  message: string
}

/** Thrown on HTTP 402 — the request was refused by the user's plan. */
export class QuotaError extends Error {
  constructor(message: string, readonly quota: QuotaDenial) {
    super(message)
    this.name = "QuotaError"
  }
}

export function isQuotaError(err: unknown): err is QuotaError {
  return err instanceof QuotaError
}

/**
 * Thrown when the request never reached the server at all — offline, DNS
 * failure, connection refused, or it timed out. Distinct from a server-side
 * error (which has a real HTTP status) so the UI can show "check your
 * connection" instead of a generic failure message, and so callers can
 * decide whether retrying is worth offering.
 */
export class NetworkError extends Error {
  constructor(message = "Couldn't reach the server. Check your connection and try again.") {
    super(message)
    this.name = "NetworkError"
  }
}

export function isNetworkError(err: unknown): err is NetworkError {
  return err instanceof NetworkError
}

/**
 * Thrown for any non-2xx HTTP response (other than the 402 handled by
 * `QuotaError`). Carries the real status so callers can distinguish "this
 * doesn't exist" (404) from "the server is having trouble" (5xx) instead of
 * treating every failure the same way.
 */
export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
    this.name = "ApiError"
  }
}

export function isApiError(err: unknown): err is ApiError {
  return err instanceof ApiError
}

export interface PlanLimits {
  maxDocuments: number | null
  maxAiQuestionsPerMonth: number | null
  maxAlertRules: number | null
  maxWhatsappPerMonth: number | null
  maxUploadMb: number
  allowInstantAlerts: boolean
}

export interface PublicPlan {
  tier: PlanTier
  name: string
  tagline: string | null
  description: string | null
  priceMonthlyCents: number
  priceYearlyCents: number | null
  currency: string
  features: string[]
  limits: PlanLimits
  sortOrder: number
  purchasable: boolean
}

export interface UsageMeter {
  used: number
  limit: number | null
  remaining: number | null
  exceeded: boolean
}

export interface BillingSummary {
  plan: {
    tier: PlanTier
    name: string
    tagline: string | null
    priceMonthlyCents: number
    currency: string
  }
  status: "ACTIVE" | "TRIALING" | "PAST_DUE" | "CANCELED" | "INCOMPLETE"
  isDefault: boolean
  currentPeriodEnd: string | null
  cancelAtPeriodEnd: boolean
  limits: PlanLimits
  usage: {
    aiQuestions: UsageMeter
    documents: UsageMeter
    alertRules: UsageMeter
    whatsappNotifications: UsageMeter
    periodStart: string
    periodEnd: string
  }
  paymentsConfigured: boolean
}

/** Public plan catalogue for the pricing page (no auth required). */
export async function fetchPlans(): Promise<PublicPlan[]> {
  return apiFetch("/plans")
}

/** Current plan, limits and this month's usage for the signed-in user. */
export async function fetchBillingSummary(): Promise<BillingSummary> {
  return apiFetch("/billing/me")
}

/** Start an upgrade — returns the Stripe Checkout URL to redirect to. */
export async function startCheckout(tier: Exclude<PlanTier, "FREE">): Promise<{ url: string }> {
  return apiFetch("/billing/checkout", {
    method: "POST",
    body: JSON.stringify({ tier }),
  })
}

/** Open Stripe's hosted billing portal for the current subscriber. */
export async function openBillingPortal(): Promise<{ url: string }> {
  return apiFetch("/billing/portal", { method: "POST", body: JSON.stringify({}) })
}

export interface AdminPlan extends Omit<PublicPlan, "features" | "purchasable"> {
  id: string
  features: string[] | null
  stripeProductId: string | null
  stripePriceId: string | null
  stripeYearlyPriceId: string | null
  maxDocuments: number | null
  maxAiQuestionsPerMonth: number | null
  maxAlertRules: number | null
  maxWhatsappPerMonth: number | null
  maxUploadMb: number
  allowInstantAlerts: boolean
  isPublic: boolean
}

export async function fetchAdminPlans(): Promise<AdminPlan[]> {
  return apiFetch("/admin/plans")
}

export async function updateAdminPlan(
  tier: PlanTier,
  patch: Partial<AdminPlan>,
): Promise<AdminPlan> {
  return apiFetch(`/admin/plans/${tier}`, { method: "PUT", body: JSON.stringify(patch) })
}

export interface AdminUsageRow {
  id: string
  name: string
  email: string
  role: "user" | "admin"
  status: "active" | "inactive"
  createdAt: string
  tier: PlanTier
  planName: string
  subscriptionStatus: string | null
  grantedByAdmin: boolean
  currentPeriodEnd: string | null
  cancelAtPeriodEnd: boolean
  usage: {
    aiQuestions: number
    documentUploads: number
    whatsappNotifications: number
    documents: number
    alertRules: number
  }
}

export async function fetchAdminUsage(
  limit = 100,
  offset = 0,
): Promise<{ data: AdminUsageRow[]; meta: { total: number; limit: number; offset: number; periodStart: string } }> {
  return apiFetch(`/admin/usage?limit=${limit}&offset=${offset}`)
}

export interface AdminUserUsageDetail extends BillingSummary {
  userId: string
  events: Array<{
    id: string
    metric: string
    quantity: number
    metadata: Record<string, unknown> | null
    createdAt: string
  }>
}

export async function fetchAdminUserUsage(userId: string): Promise<AdminUserUsageDetail> {
  return apiFetch(`/admin/users/${userId}/usage`)
}

export async function grantUserPlan(userId: string, tier: PlanTier, note?: string) {
  return apiFetch(`/admin/users/${userId}/plan`, {
    method: "POST",
    body: JSON.stringify({ tier, note }),
  })
}

export async function revokeUserPlan(userId: string) {
  return apiFetch(`/admin/users/${userId}/plan`, { method: "DELETE" })
}

/** Money formatting shared by the pricing page and billing panel. */
export function formatPlanPrice(cents: number, currency: string): string {
  if (cents === 0) return "Free"
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency.toUpperCase(),
    minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
  }).format(cents / 100)
}

/**
 * In-flight GETs, keyed by path. A browser only opens a handful of connections
 * per host, so a poll timer that fires again before its previous request came
 * back (slow API, backgrounded tab) queues duplicates until nothing else — a
 * chat query, a page load — can get through. Identical GETs therefore share
 * one request instead of stacking. Entries auto-expire after 8s to prevent a
 * hung request from blocking retries indefinitely.
 */
const inFlightGets = new Map<string, { promise: Promise<unknown>; startedAt: number }>()
const IN_FLIGHT_TTL_MS = 8000

function getPending<T>(key: string): Promise<T> | undefined {
  const entry = inFlightGets.get(key)
  if (!entry) return undefined
  if (Date.now() - entry.startedAt > IN_FLIGHT_TTL_MS) {
    inFlightGets.delete(key)
    return undefined
  }
  return entry.promise as Promise<T>
}

/** Authenticated fetch - attaches the bearer token when present. */
export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const method = (init.method ?? "GET").toUpperCase()
  // Callers that pass their own signal manage cancellation themselves, so they
  // must not be handed a shared promise someone else can abort.
  if (method !== "GET" || init.signal) return requestJson<T>(path, init)

  const token = tokenStore.get() || ""
  const dedupKey = `${token.slice(0, 8)}:${path}`

  const pending = getPending<T>(dedupKey)
  if (pending) return pending

  const startedAt = Date.now()
  const request = requestJson<T>(path, init).finally(() => {
    // Only delete if we are still the owner (prevents deleting a newer retry)
    const cur = inFlightGets.get(dedupKey)
    if (cur?.startedAt === startedAt) inFlightGets.delete(dedupKey)
  })
  inFlightGets.set(dedupKey, { promise: request, startedAt })
  return request
}

/**
 * Nest error bodies are JSON ({statusCode, message, error}); surface the
 * message so UI toasts read "Downloaded file is not a PDF …" instead of a
 * dump of the whole envelope. 402 means "your plan doesn't cover this" —
 * throws a typed QuotaError so callers can render a targeted upgrade prompt
 * instead of a generic toast.
 */
async function throwApiError(res: Response): Promise<never> {
  const body = await res.text()
  let message = body
  let parsed: { message?: unknown; error?: unknown; quota?: unknown } | null = null
  try {
    parsed = JSON.parse(body)
    const raw = parsed?.message ?? parsed?.error
    if (raw) message = Array.isArray(raw) ? raw.join(", ") : String(raw)
  } catch {
    // not JSON — use the raw body
  }

  if (res.status === 402 && parsed?.quota) {
    throw new QuotaError(message, parsed.quota as QuotaDenial)
  }

  throw new ApiError(message || `Request failed: ${res.status}`, res.status)
}

/** No caller sets a longer-running request without passing its own signal, so one shared ceiling is enough. */
const DEFAULT_TIMEOUT_MS = 20_000

/** A GET is safe to retry (no side effects); a single retry papers over a dropped connection or a cold-start blip. */
const RETRYABLE_METHODS = new Set(["GET", "HEAD"])

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Combines the caller's own abort signal (if any) with an internal timeout, so either can cancel the fetch. */
function timeoutSignal(callerSignal: AbortSignal | null | undefined, ms: number): AbortSignal {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ms)
  callerSignal?.addEventListener("abort", () => controller.abort(), { once: true })
  controller.signal.addEventListener("abort", () => clearTimeout(timer), { once: true })
  return controller.signal
}

async function requestJson<T>(path: string, init: RequestInit, attempt = 0): Promise<T> {
  const token = tokenStore.get()
  const method = (init.method ?? "GET").toUpperCase()

  let res: Response
  try {
    res = await fetch(`${API_URL}${path}`, {
      ...init,
      signal: timeoutSignal(init.signal, DEFAULT_TIMEOUT_MS),
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...init.headers,
      },
    })
  } catch (err) {
    // AbortError (our own timeout, not a caller-initiated cancel) and raw
    // network failures both mean "never got a response" — retry once for
    // idempotent requests before giving up.
    const callerAborted = init.signal?.aborted
    if (!callerAborted && attempt === 0 && RETRYABLE_METHODS.has(method)) {
      await sleep(400)
      return requestJson<T>(path, init, attempt + 1)
    }
    if (callerAborted) throw err
    throw new NetworkError()
  }

  if (!res.ok) {
    // A 401 while we believed we were signed in means the session died
    // (expired token, revoked account, storage wiped mid-session). Clear it
    // and tell AuthProvider so protected pages bounce to /login.
    if (res.status === 401 && token && typeof window !== "undefined") {
      tokenStore.clear()
      window.dispatchEvent(new CustomEvent(AUTH_EXPIRED_EVENT))
    }
    // A transient 5xx (cold start, brief overload) is worth one retry too.
    if (res.status >= 500 && attempt === 0 && RETRYABLE_METHODS.has(method)) {
      await sleep(400)
      return requestJson<T>(path, init, attempt + 1)
    }
    await throwApiError(res)
  }
  return res.json() as Promise<T>
}

/** Exchange a Google ID token for an app session and return the mapped user. */
export async function googleLogin(credential: string): Promise<User> {
  const data = await apiFetch<{ token: string; user: ApiUser }>("/auth/google", {
    method: "POST",
    body: JSON.stringify({ credential }),
  })
  tokenStore.set(data.token)
  return mapUser(data.user)
}

/** Validate the stored token and return the current user, or null. */
export async function fetchMe(): Promise<User | null> {
  if (!tokenStore.get()) return null
  try {
    return mapUser(await apiFetch<ApiUser>("/auth/me"))
  } catch {
    tokenStore.clear()
    return null
  }
}

/**
 * Tell the backend to revoke the session (best-effort — the client clears
 * local state regardless, and the token dies on expiry anyway).
 */
export async function apiLogout(): Promise<void> {
  try {
    await apiFetch("/auth/logout", { method: "POST" })
  } catch {
    // network hiccup — the server token is short-lived; nothing to do
  }
}

// ─── Documents API ───────────────────────────────────────────────────────────

export async function uploadDocument(file: File, title: string): Promise<RagDocument> {
  const token = tokenStore.get()
  const form = new FormData()
  form.append("file", file)
  form.append("title", title)

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 120_000)
  try {
    const res = await fetch(`${API_URL}/documents`, {
      method: "POST",
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body: form,
      signal: controller.signal,
    })
    if (!res.ok) {
      if (res.status === 401 && token && typeof window !== "undefined") {
        tokenStore.clear()
        window.dispatchEvent(new CustomEvent(AUTH_EXPIRED_EVENT))
      }
      await throwApiError(res)
    }
    return res.json()
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") throw new NetworkError("Upload timed out — the server took too long to respond. Please try again.")
    throw err
  } finally {
    clearTimeout(timeout)
  }
}

export async function fetchDocuments(
  page = 1,
  limit = 50,
  status?: DocumentStatus,
): Promise<RagDocumentListResponse> {
  const params = new URLSearchParams({ page: String(page), limit: String(limit) })
  if (status) params.set("status", status)
  return apiFetch<RagDocumentListResponse>(`/documents?${params}`)
}

export async function fetchDocument(id: string): Promise<RagDocument> {
  return apiFetch<RagDocument>(`/documents/${id}`)
}

export async function deleteDocument(id: string): Promise<void> {
  await apiFetch<{ message: string }>(`/documents/${id}`, { method: "DELETE" })
}

/** Start embedding a document's file into the vector store. */
export async function embedDocument(id: string): Promise<RagDocument> {
  return apiFetch<RagDocument>(`/documents/${id}/embed`, { method: "POST" })
}

/** Remove a document's vectors from the store (keeps the file and record). */
export async function unembedDocument(id: string): Promise<RagDocument> {
  return apiFetch<RagDocument>(`/documents/${id}/unembed`, { method: "POST" })
}

/** Live ingestion progress while a document is PENDING/PROCESSING. */
export async function fetchDocumentProgress(id: string): Promise<DocumentProgress> {
  return apiFetch<DocumentProgress>(`/documents/${id}/progress`)
}

/** Batched progress for several documents - one request per poll tick. */
export async function fetchDocumentsProgress(
  ids: string[],
): Promise<Record<string, DocumentProgress | null>> {
  if (ids.length === 0) return {}
  const params = new URLSearchParams({ ids: ids.join(",") })
  return apiFetch<Record<string, DocumentProgress | null>>(`/documents/progress/batch?${params}`)
}

// ─── RAG Query API ───────────────────────────────────────────────────────────

export async function ragQuery(
  question: string,
  documentId?: string,
  topK = 5,
): Promise<RagQueryResponse> {
  return apiFetch<RagQueryResponse>("/rag/query", {
    method: "POST",
    body: JSON.stringify({ question, documentId, topK }),
  })
}

// ─── Admin Scraping API (crawl4ai pipeline, dynamic multi-source) ────────────

export async function fetchScrapeSources(): Promise<ScrapeSource[]> {
  return apiFetch("/admin/scraping/sources")
}

export interface ScrapeSourceInput {
  name: string
  baseUrl: string
  noticeListUrl?: string
  newsListUrl?: string
  pressReleaseListUrl?: string
  paginationType?: ScrapePaginationType
  paginationParam?: string
  startPage?: number
  maxPages?: number
  pollIntervalSeconds?: number
  sitemapUrl?: string | null
}

export async function createScrapeSource(input: ScrapeSourceInput): Promise<ScrapeSource> {
  return apiFetch("/admin/scraping/sources", {
    method: "POST",
    body: JSON.stringify(input),
  })
}

export async function updateScrapeSource(
  id: string,
  input: Partial<ScrapeSourceInput & { enabled: boolean }>,
): Promise<ScrapeSource> {
  return apiFetch(`/admin/scraping/sources/${id}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  })
}

export async function deleteScrapeSource(id: string): Promise<void> {
  await apiFetch(`/admin/scraping/sources/${id}`, { method: "DELETE" })
}

/**
 * Trigger a scrape run for one source. Returns immediately; poll
 * fetchScrapeRunProgress for live status. `deep` walks every page of each
 * listing (archive backfill) instead of the newest few.
 */
export async function runScrapeSource(
  id: string,
  categories?: ScrapedItemCategory[],
  deep?: boolean,
): Promise<{ runId: string }> {
  return apiFetch(`/admin/scraping/sources/${id}/run`, {
    method: "POST",
    body: JSON.stringify({ categories, deep }),
  })
}

/** Poll live status messages for a run while it's in progress. */
export async function fetchScrapeRunProgress(runId: string): Promise<ScrapeRunProgress> {
  return apiFetch(`/admin/scraping/runs/${runId}/progress`)
}

/** Retry a specific run (typically FAILED) by re-running its source. */
export async function retryScrapeRun(runId: string): Promise<{ runId: string }> {
  return apiFetch(`/admin/scraping/runs/${runId}/retry`, { method: "POST" })
}

/**
 * One-time sitemap detection (robots.txt → /sitemap.xml → best child).
 * Persists the cached sitemap URL on the source; safe to call again.
 */
export async function detectScrapeSitemap(id: string): Promise<ScrapeSource> {
  return apiFetch(`/admin/scraping/sources/${id}/detect-sitemap`, {
    method: "POST",
    body: JSON.stringify({}),
  })
}

/**
 * Cheap sitemap poll — sitemap URLs not yet known to this source, without
 * triggering a full crawl. Requires a sitemapUrl on the source.
 */
export async function checkScrapeSitemap(id: string): Promise<SitemapCheckResult> {
  return apiFetch(`/admin/scraping/sources/${id}/check`, {
    method: "POST",
    body: JSON.stringify({}),
  })
}

/**
 * Find a site's real notice/news/press-release listing routes from its own
 * navigation, proving each one by crawling it. Lets an admin paste a home
 * page instead of hunting for the right listing URL. Slow by nature — it
 * loads several pages — so call it behind an explicit action.
 */
export async function discoverScrapeRoutes(baseUrl: string): Promise<RouteDiscoveryResult> {
  return apiFetch("/admin/scraping/discover-routes", {
    method: "POST",
    body: JSON.stringify({ baseUrl }),
  })
}

/**
 * Explain a source's most recent failure and what to change about it. The
 * same analysis a failed run records automatically, on demand.
 */
export async function diagnoseScrapeSource(id: string): Promise<ScrapeSource> {
  return apiFetch(`/admin/scraping/sources/${id}/diagnose`, {
    method: "POST",
    body: JSON.stringify({}),
  })
}

/** Effective scheduler configuration + last tick. */
export async function fetchSchedulerStatus(): Promise<SchedulerStatus> {
  return apiFetch("/admin/scraping/scheduler")
}

/** Flip the global auto-scraping switch. Returns the updated scheduler status. */
export async function setAutoScraping(enabled: boolean): Promise<SchedulerStatus> {
  return apiFetch("/admin/scraping/scheduler/auto-scraping", {
    method: "PATCH",
    body: JSON.stringify({ enabled }),
  })
}

/** Triggers a run of every enabled source that isn't already scraping.
 * `deep` makes each of those runs walk every listing page. */
export async function runAllScrapeSources(deep?: boolean): Promise<RunAllResult> {
  return apiFetch("/admin/scraping/sources/run-all", {
    method: "POST",
    body: JSON.stringify({ deep }),
  })
}

/**
 * Admin "paste a link" quick-scrape: ingest one arbitrary notice/news/
 * press-release URL directly, with no Source pre-configuration required.
 */
export type QuickScrapeResult =
  | { alreadyExists: true; item: { id: string; title: string; category: ScrapedItemCategory } }
  | { alreadyExists: false; runId: string; sourceId: string; sourceCreated: boolean }

export async function quickScrapeUrl(url: string): Promise<QuickScrapeResult> {
  return apiFetch("/admin/scraping/quick-scrape", {
    method: "POST",
    body: JSON.stringify({ url }),
  })
}

/** Admin settings: schema + effective values for the settings UI. */
export async function fetchSettings(): Promise<SettingsView> {
  return apiFetch("/admin/settings")
}

/** Batch-apply settings; returns fresh state + per-key validation errors. */
export async function updateSettings(values: Record<string, string>): Promise<SettingApplyResult> {
  return apiFetch("/admin/settings", {
    method: "PUT",
    body: JSON.stringify({ values }),
  })
}

/** Revert one setting to its schema default. */
export async function resetSetting(key: string): Promise<{ key: string; reset: boolean }> {
  return apiFetch(`/admin/settings/${encodeURIComponent(key)}`, { method: "DELETE" })
}

/**
 * Live LLM provider health — makes a real probe call to each configured
 * provider, so it is slow by nature (seconds, not milliseconds) and is only
 * ever triggered by an explicit admin action, never on page load.
 */
export async function fetchAiHealth(): Promise<AiHealthSnapshot> {
  return apiFetch("/admin/ai/health")
}

// ─── AI provider registry (admin) ────────────────────────────────────────────

/** Live health of every dependency, measured server-side at request time. */
export async function fetchSystemStatus(): Promise<SystemStatus> {
  return apiFetch("/admin/system/status")
}

export async function fetchAiProviders(): Promise<AiProvider[]> {
  return apiFetch("/admin/ai/providers")
}

export async function createAiProvider(input: AiProviderInput): Promise<AiProvider> {
  return apiFetch("/admin/ai/providers", { method: "POST", body: JSON.stringify(input) })
}

export async function updateAiProvider(
  id: string,
  input: Partial<AiProviderInput>,
): Promise<AiProvider> {
  return apiFetch(`/admin/ai/providers/${id}`, { method: "PUT", body: JSON.stringify(input) })
}

export async function deleteAiProvider(id: string): Promise<{ id: string; deleted: boolean }> {
  return apiFetch(`/admin/ai/providers/${id}`, { method: "DELETE" })
}

/** Persist a new fallback chain — `ids` is every provider, in display order. */
export async function reorderAiProviders(ids: string[]): Promise<AiProvider[]> {
  return apiFetch("/admin/ai/providers/order", { method: "PUT", body: JSON.stringify({ ids }) })
}

/** Probe exactly one provider (the per-card Test button). */
export async function testAiProvider(id: string): Promise<AiHealthSnapshot> {
  return apiFetch(`/admin/ai/providers/${id}/health`, { method: "POST", body: JSON.stringify({}) })
}

/**
 * The provider's live model catalogue, for the picker in the provider dialog.
 *
 * POST because an unsaved provider has no id and the candidate key travels in
 * the body — a key in a query string would end up in access logs.
 */
export async function fetchAiProviderModels(input: {
  id?: string
  kind: AiProviderKind
  baseUrl?: string | null
  apiKey?: string
}): Promise<{ models: AiProviderModel[]; note?: string }> {
  return apiFetch("/admin/ai/providers/models", {
    method: "POST",
    body: JSON.stringify(input),
  })
}

/** Public subset (site.title/description) for the footer. */
export async function fetchPublicSettings(): Promise<PublicSiteSettings> {
  return apiFetch("/public/settings")
}

export interface ScrapedItemFilters {
  sourceId?: string
  category?: ScrapedItemCategory
  search?: string
  dateFrom?: string
  dateTo?: string
  sortBy?: "publishedAt" | "scrapedAt" | "title"
  sortOrder?: "asc" | "desc"
  page?: number
  limit?: number
}

export async function fetchScrapedItems(
  filters: ScrapedItemFilters = {},
): Promise<{ data: ScrapedItem[]; meta: { page: number; limit: number; total: number; totalPages: number } }> {
  const { page = 1, limit = 20, ...rest } = filters
  const params = new URLSearchParams({ page: String(page), limit: String(limit) })
  for (const [key, value] of Object.entries(rest)) {
    if (value) params.set(key, String(value))
  }
  return apiFetch(`/admin/scraping/items?${params}`)
}

export async function deleteScrapedItem(id: string): Promise<void> {
  await apiFetch(`/admin/scraping/items/${id}`, { method: "DELETE" })
}

export interface ReextractResult {
  id: string
  updated: boolean
  chars?: number
  isOcr?: boolean
  method?: string | null
  qualityBefore?: number
  qualityAfter?: number
  reason?: string
}

/** Admin: re-run attachment text extraction for one notice. */
export async function reextractNotice(id: string): Promise<ReextractResult> {
  return apiFetch(`/admin/scraping/items/${id}/reextract`, {
    method: "POST",
    body: JSON.stringify({}),
  })
}

export interface BulkReextractResult {
  scope: "garbled" | "all"
  scanned: number
  queued: number
  message: string
}

/**
 * Admin: re-extract many notices at once. "garbled" (default) only touches
 * notices whose stored text scores as unreadable.
 */
export async function reextractNotices(
  scope: "garbled" | "all" = "garbled",
  limit = 200,
): Promise<BulkReextractResult> {
  return apiFetch("/admin/scraping/items/reextract", {
    method: "POST",
    body: JSON.stringify({ scope, limit }),
  })
}

export interface ScrapeRunFilters {
  sourceId?: string
  status?: ScrapeRunStatus
  page?: number
  limit?: number
}

export async function fetchScrapeRuns(
  filters: ScrapeRunFilters = {},
): Promise<{ data: ScrapeRun[]; meta: { page: number; limit: number; total: number; totalPages: number } }> {
  const { page = 1, limit = 20, ...rest } = filters
  const params = new URLSearchParams({ page: String(page), limit: String(limit) })
  for (const [key, value] of Object.entries(rest)) {
    if (value) params.set(key, String(value))
  }
  return apiFetch(`/admin/scraping/runs?${params}`)
}

// ─── Public Notices API (no auth required) ───────────────────────────────────

export interface PublicNoticeFilters {
  category?: ScrapedItemCategory
  sourceId?: string
  search?: string
  tag?: string
  dateFrom?: string
  dateTo?: string
  urgency?: string
  sortBy?: "publishedAt" | "views"
  sortOrder?: "asc" | "desc"
  page?: number
  limit?: number
}

export async function fetchNotices(
  filters: PublicNoticeFilters = {},
): Promise<{ data: ScrapedItem[]; meta: { page: number; limit: number; total: number; totalPages: number } }> {
  const { page = 1, limit = 20, ...rest } = filters
  const params = new URLSearchParams({ page: String(page), limit: String(limit) })
  for (const [key, value] of Object.entries(rest)) {
    if (value) params.set(key, String(value))
  }
  return apiFetch(`/notices?${params}`)
}

export async function fetchNotice(id: string): Promise<PublicNoticeDetail> {
  return apiFetch(`/notices/${id}`)
}

export async function askNoticeQuestion(id: string, question: string): Promise<{ answer: string }> {
  return apiFetch(`/notices/${id}/ask`, {
    method: "POST",
    body: JSON.stringify({ question }),
  })
}

/**
 * Returned instead of an answer when the question is ambiguous against the
 * corpus — e.g. "how many are dead?" when flood, earthquake and accident
 * notices each report a different toll. Every option is drawn from notices
 * that were actually retrieved, so each one is answerable.
 */
export interface SearchClarification {
  question: string
  options: { label: string; query: string }[]
}

export interface NoticeSearchResponse {
  answer: string
  sources: { id: string; title: string; category: string; sourceUrl: string; score?: number }[]
  model_used: string | null
  clarification?: SearchClarification
}

export async function searchNotices(
  question: string,
  category?: string,
  language?: string,
  skipClarification?: boolean,
): Promise<NoticeSearchResponse> {
  return apiFetch("/notices/search", {
    method: "POST",
    body: JSON.stringify({ question, category, language, skipClarification }),
  })
}

export async function fetchNoticeCategoryCounts(): Promise<Record<string, number>> {
  return apiFetch("/notices/meta/category-counts")
}

export async function fetchNoticeSources(): Promise<PublicNoticeSource[]> {
  return apiFetch("/notices/meta/sources")
}

// ─── Alerts API ───────────────────────────────────────────────────────────
// Server and client share the same AlertRule shape directly — no mapping
// needed (each filter dimension is AND'd; values within one are OR'd).

export type NewAlertRuleInput = Pick<
  AlertRule,
  | "name"
  | "enabled"
  | "priority"
  | "categories"
  | "tags"
  | "keywords"
  | "excludeKeywords"
  | "organizations"
  | "minUrgency"
  | "deadlineWithinDays"
>

export async function fetchAlertRules(): Promise<AlertRule[]> {
  return apiFetch<AlertRule[]>("/alerts")
}

export async function createAlertRule(input: NewAlertRuleInput): Promise<AlertRule> {
  return apiFetch<AlertRule>("/alerts", { method: "POST", body: JSON.stringify(input) })
}

export async function updateAlertRule(id: string, updates: Partial<NewAlertRuleInput>): Promise<AlertRule> {
  return apiFetch<AlertRule>(`/alerts/${id}`, { method: "PATCH", body: JSON.stringify(updates) })
}

export async function deleteAlertRule(id: string): Promise<void> {
  await apiFetch(`/alerts/${id}`, { method: "DELETE" })
}

// ─── WhatsApp notification channel API ───────────────────────────────────

export async function fetchWhatsappStatus(): Promise<WhatsappStatus> {
  return apiFetch("/notifications/whatsapp/status")
}

export async function setWhatsappDigestFrequency(digestFrequency: DigestFrequency): Promise<WhatsappStatus> {
  return apiFetch("/notifications/whatsapp/digest-frequency", {
    method: "PATCH",
    body: JSON.stringify({ digestFrequency }),
  })
}

export async function requestWhatsappOtp(phoneNumber: string): Promise<{ requested: true }> {
  return apiFetch("/notifications/whatsapp/request-otp", {
    method: "POST",
    body: JSON.stringify({ phoneNumber }),
  })
}

export async function verifyWhatsappOtp(code: string): Promise<WhatsappStatus> {
  return apiFetch("/notifications/whatsapp/verify-otp", {
    method: "POST",
    body: JSON.stringify({ code }),
  })
}

export async function toggleWhatsappAlerts(enabled: boolean): Promise<WhatsappStatus> {
  return apiFetch("/notifications/whatsapp/toggle", {
    method: "PATCH",
    body: JSON.stringify({ enabled }),
  })
}

export async function disconnectWhatsapp(): Promise<WhatsappStatus> {
  return apiFetch("/notifications/whatsapp", { method: "DELETE" })
}

// ─── Admin: shared WhatsApp sender instance (Evolution API) ─────────────────
// Distinct from the per-user opt-in flow above — this controls the single
// shared sending number itself. Admin-only (JwtAuthGuard + RolesGuard).

export interface AdminWhatsappStatus {
  configured: boolean
  state: string // "open" (connected) | "connecting" | "close" | "unknown"
}

export async function fetchAdminWhatsappStatus(): Promise<AdminWhatsappStatus> {
  return apiFetch("/admin/whatsapp/status")
}

export async function fetchAdminWhatsappQr(): Promise<{ available: boolean; base64: string | null; pairingCode: string | null }> {
  return apiFetch("/admin/whatsapp/qr", { method: "POST" })
}

export async function logoutAdminWhatsapp(): Promise<{ loggedOut: boolean }> {
  return apiFetch("/admin/whatsapp/logout", { method: "POST" })
}

// ─── Admin: WhatsApp alert message template ─────────────────────────────────
// The template itself is stored as the `alerts.whatsappTemplate` setting
// (save/reset reuse updateSettings/resetSetting above) — these two just add
// what the generic settings endpoints can't: the token reference list and a
// live preview rendered against sample data.

export interface AlertTemplateToken {
  token: string
  description: string
  optional: boolean
}

export async function fetchAlertTemplateTokens(): Promise<{ tokens: AlertTemplateToken[]; default: string }> {
  return apiFetch("/admin/alerts/template/tokens")
}

export async function previewAlertTemplate(template: string): Promise<{ preview: string }> {
  return apiFetch("/admin/alerts/template/preview", {
    method: "POST",
    body: JSON.stringify({ template }),
  })
}

/**
 * Admin SMTP channel. The password is write-only by design: it is never in a
 * GET response, only `passwordConfigured` + a masked preview, so this type
 * has no field that could hold it.
 */
export interface EmailChannelConfig {
  enabled: boolean
  host: string
  port: number
  secure: boolean
  username: string
  fromAddress: string
  fromName: string
  passwordConfigured: boolean
  passwordPreview?: string
  configured: boolean
  lastTestedAt: string | null
  lastTestOk: boolean | null
}

export interface EmailChannelUpdate {
  enabled?: boolean
  host?: string
  port?: number
  secure?: boolean
  username?: string
  /** Omit (or send "") to keep the stored password unchanged. */
  password?: string
  fromAddress?: string
  fromName?: string
}

export async function fetchEmailChannel(): Promise<EmailChannelConfig> {
  return apiFetch("/admin/alert-channels/email")
}

export async function updateEmailChannel(body: EmailChannelUpdate): Promise<EmailChannelConfig> {
  return apiFetch("/admin/alert-channels/email", {
    method: "PUT",
    body: JSON.stringify(body),
  })
}

export async function testEmailChannel(): Promise<{ ok: true; sentTo: string; testedAt: string }> {
  // A real SMTP handshake plus a send can outlast the default request
  // ceiling; the API's own connect/socket timeouts cap it at ~30s.
  return apiFetch("/admin/alert-channels/email/test", {
    method: "POST",
    signal: AbortSignal.timeout(45_000),
  })
}

export async function correctScrapedItem(
  id: string,
  body: { category?: string; tags?: string[]; aiCategoryConfidence?: number; reClassify?: boolean }
): Promise<{ reClassified?: boolean; category?: string; tags?: string[]; aiCategoryConfidence?: number }> {
  return apiFetch(`/admin/scraping/items/${id}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  })
}

// ─── Admin Users API ───────────────────────────────────────────────────────

export interface AdminUser {
  id: string
  email: string
  name: string
  avatarUrl: string | null
  role: "user" | "admin"
  status: "active" | "inactive"
  createdAt: string
  updatedAt: string
  lastLoginAt: string | null
  subscription?: { status: string; plan: { tier: string; name: string } } | null
  documentsCount?: number
  alertRulesCount?: number
}

export interface AdminUsersResponse {
  data: AdminUser[]
  meta: { page: number; limit: number; total: number; totalPages: number }
}

export interface AdminUserFilters {
  search?: string
  role?: "user" | "admin"
  status?: "active" | "inactive"
  page?: number
  limit?: number
  sortBy?: "createdAt" | "lastLoginAt" | "name" | "email"
  sortOrder?: "asc" | "desc"
}

export async function fetchAdminUsers(
  filters: AdminUserFilters = {},
): Promise<AdminUsersResponse> {
  const { page = 1, limit = 20, ...rest } = filters
  const params = new URLSearchParams({ page: String(page), limit: String(limit) })
  for (const [key, value] of Object.entries(rest)) {
    if (value) params.set(key, String(value))
  }
  return apiFetch<AdminUsersResponse>(`/admin/users?${params}`)
}

export async function fetchAdminUser(id: string): Promise<AdminUser> {
  return apiFetch<AdminUser>(`/admin/users/${id}`)
}

export async function createAdminUser(input: {
  email: string
  name: string
  role?: "user" | "admin"
  status?: "active" | "inactive"
}): Promise<AdminUser> {
  return apiFetch<AdminUser>("/admin/users", {
    method: "POST",
    body: JSON.stringify(input),
  })
}

export async function updateAdminUser(
  id: string,
  patch: Partial<Pick<AdminUser, "email" | "name" | "role" | "status">>,
): Promise<AdminUser> {
  return apiFetch<AdminUser>(`/admin/users/${id}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  })
}

export async function deleteAdminUser(id: string): Promise<{ deleted: boolean; id: string }> {
  return apiFetch<{ deleted: boolean; id: string }>(`/admin/users/${id}`, {
    method: "DELETE",
  })
}

// ─── Contact API (public) ───────────────────────────────────────────────

export interface ContactInput {
  name: string
  email: string
  subject: string
  message: string
  /** honeypot — must be empty */
  website?: string
  hpTimestamp?: string
  /** Google reCAPTCHA v2 token (g-recaptcha-response) */
  recaptchaToken?: string
}

export async function submitContact(input: ContactInput): Promise<{ ok: true; id: string; message: string }> {
  return apiFetch<{ ok: true; id: string; message: string }>("/contact", {
    method: "POST",
    body: JSON.stringify(input),
  })
}

export type ContactMessageStatus = "NEW" | "READ" | "REPLIED" | "ARCHIVED"

export interface ContactMessage {
  id: string
  name: string
  email: string
  subject: string
  message: string
  status: ContactMessageStatus
  ip: string | null
  userAgent: string | null
  createdAt: string
  updatedAt: string
}

export async function fetchContactMessages(params: {
  page?: number
  limit?: number
  status?: ContactMessageStatus
  search?: string
  sortOrder?: "asc" | "desc"
} = {}): Promise<{ data: ContactMessage[]; meta: { page: number; limit: number; total: number; totalPages: number } }> {
  const { page = 1, limit = 20, ...rest } = params
  const q = new URLSearchParams({ page: String(page), limit: String(limit) })
  for (const [k, v] of Object.entries(rest)) if (v) q.set(k, String(v))
  return apiFetch(`/admin/contact-messages?${q}`)
}

export async function fetchContactCounts(): Promise<{ total: number; byStatus: Record<string, number> }> {
  return apiFetch("/admin/contact-messages/counts")
}

export async function updateContactStatus(
  id: string,
  status: ContactMessageStatus,
): Promise<ContactMessage> {
  return apiFetch(`/admin/contact-messages/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ status }),
  })
}

export async function deleteContactMessage(id: string): Promise<{ deleted: boolean; id: string }> {
  return apiFetch(`/admin/contact-messages/${id}`, { method: "DELETE" })
}
