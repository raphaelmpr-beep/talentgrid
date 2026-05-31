// Direct careers-portal job source.
//
// Many large corporations show 0/1/2 active roles via TheirStack even when they
// are hiring heavily, because their openings live on a company-hosted careers
// page or an ATS portal that the third-party index hasn't crawled. This module
// fetches a company's own careers URL (or ATS job-portal URL) and conservatively
// extracts job links/titles so the refresh flow can surface real openings.
//
// Design goals (mirrors the conventions in theirstack.ts):
//   - Pure, testable extractor (`extractJobsFromHtml`) separate from network I/O.
//   - Bounded + best-effort: one request, short timeout, capped result count.
//   - Fail closed/non-fatally: blocked sites, JS-only SPAs, captcha, or
//     unrecognised formats yield an empty result with a reason, never a throw
//     that aborts the whole refresh run.
//   - No hallucination: a job is only emitted when there is clear title + link
//     evidence (an anchor whose text and href both look job-like, or a
//     structured JSON JobPosting entry).

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type CareersPortalJob = {
  // Stable identifier derived from the job URL (preferred) or title, so
  // re-runs upsert the same row instead of duplicating.
  external_id: string;
  title: string;
  url: string | null;
  location: string | null;
  source: "careers_portal";
  source_url: string;
};

export type CareersPortalInput = {
  companyName: string;
  companyId?: string;
  careersUrl: string;
  jobPortalUrl?: string | null;
  // Optional case-insensitive substring filters. When provided, a job must
  // match at least one role token (in the title) and, if domain tokens are
  // given, at least one of those too. Empty/omitted = no filtering.
  roleFilters?: string[];
  domainFilters?: string[];
  // Max jobs to emit per company. Defaults to DEFAULT_MAX_JOBS.
  maxJobs?: number;
};

export type CareersPortalResult = {
  jobs: CareersPortalJob[];
  // Which URL produced the jobs (careersUrl or jobPortalUrl), for debugging.
  fetchedUrl: string | null;
  // Non-fatal reason when no jobs were extracted (blocked, js_only, etc.).
  // Never contains secrets.
  reason?: string;
};

export type CareersPortalOptions = {
  fetch?: FetchLike;
  timeoutMs?: number;
  userAgent?: string;
  maxBytes?: number;
};

const DEFAULT_MAX_JOBS = 20;
const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_MAX_BYTES = 2_000_000; // 2 MB — guards against huge pages.
const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (compatible; TalentGridBot/1.0; +https://talentgrid.app/bot)";

// Anchor hrefs whose path contains one of these tokens are treated as a likely
// job posting link. Kept deliberately conservative.
const JOB_PATH_TOKENS = [
  "/job/",
  "/jobs/",
  "/career/",
  "/careers/",
  "/position/",
  "/positions/",
  "/opening/",
  "/openings/",
  "/vacancy/",
  "/vacancies/",
  "/listing/",
  "/listings/",
  "/req/",
  "/requisition",
  "gh_jid=",
  "/o/", // greenhouse/lever style opening slugs
];

// Anchor text shorter than this is unlikely to be a real job title.
const MIN_TITLE_LEN = 3;
const MAX_TITLE_LEN = 160;

function hostnameOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, d) => {
      const code = Number(d);
      return Number.isFinite(code) ? String.fromCodePoint(code) : "";
    });
}

function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function resolveUrl(href: string, base: string): string | null {
  try {
    return new URL(href, base).toString();
  } catch {
    return null;
  }
}

// Deterministic, stable external id from a job URL (preferred) or title.
function makeExternalId(url: string | null, title: string): string {
  const basis = (url ?? title).trim().toLowerCase();
  // Short, stable hash (djb2) — avoids pulling in crypto for a non-security id.
  let hash = 5381;
  for (let i = 0; i < basis.length; i++) {
    hash = ((hash << 5) + hash + basis.charCodeAt(i)) >>> 0;
  }
  return `careers_${hash.toString(36)}`;
}

function looksLikeJobHref(href: string): boolean {
  const lower = href.toLowerCase();
  return JOB_PATH_TOKENS.some((t) => lower.includes(t));
}

function matchesFilters(
  title: string,
  roleFilters: string[] | undefined,
  domainFilters: string[] | undefined
): boolean {
  const t = title.toLowerCase();
  if (roleFilters && roleFilters.length > 0) {
    if (!roleFilters.some((f) => t.includes(f.toLowerCase()))) return false;
  }
  if (domainFilters && domainFilters.length > 0) {
    if (!domainFilters.some((f) => t.includes(f.toLowerCase()))) return false;
  }
  return true;
}

// Pull JobPosting entries out of <script type="application/ld+json"> blocks.
// Returns [] when none are found or the JSON is unparseable.
function extractStructuredJobs(html: string, baseUrl: string): CareersPortalJob[] {
  const out: CareersPortalJob[] = [];
  const scriptRe =
    /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;
  while ((match = scriptRe.exec(html)) !== null) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(match[1].trim());
    } catch {
      continue;
    }
    const nodes = collectJobPostingNodes(parsed);
    for (const node of nodes) {
      const title = typeof node.title === "string" ? node.title.trim() : "";
      if (!title) continue;
      const rawUrl =
        typeof node.url === "string"
          ? node.url
          : typeof node.hiringUrl === "string"
            ? node.hiringUrl
            : null;
      const url = rawUrl ? resolveUrl(rawUrl, baseUrl) : null;
      out.push({
        external_id: makeExternalId(url, title),
        title: title.slice(0, MAX_TITLE_LEN),
        url,
        location: extractStructuredLocation(node),
        source: "careers_portal",
        source_url: baseUrl,
      });
    }
  }
  return out;
}

type LdNode = Record<string, unknown>;

function collectJobPostingNodes(value: unknown): LdNode[] {
  const result: LdNode[] = [];
  const visit = (node: unknown) => {
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (!node || typeof node !== "object") return;
    const obj = node as LdNode;
    const type = obj["@type"];
    const isJob = Array.isArray(type)
      ? type.includes("JobPosting")
      : type === "JobPosting";
    if (isJob) result.push(obj);
    // Recurse into @graph and any nested arrays/objects.
    for (const v of Object.values(obj)) {
      if (v && typeof v === "object") visit(v);
    }
  };
  visit(value);
  return result;
}

function extractStructuredLocation(node: LdNode): string | null {
  const loc = node.jobLocation;
  const first = Array.isArray(loc) ? loc[0] : loc;
  if (first && typeof first === "object") {
    const address = (first as LdNode).address;
    if (address && typeof address === "object") {
      const a = address as LdNode;
      const parts = [a.addressLocality, a.addressRegion, a.addressCountry]
        .filter((p): p is string => typeof p === "string" && p.length > 0);
      if (parts.length > 0) return parts.join(", ");
    }
    if (typeof (first as LdNode).name === "string") {
      return (first as LdNode).name as string;
    }
  }
  return null;
}

// Heuristic anchor-based extraction: find <a href> elements whose href looks
// job-like and whose visible text reads like a title.
function extractAnchorJobs(html: string, baseUrl: string): CareersPortalJob[] {
  const out: CareersPortalJob[] = [];
  const anchorRe = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;
  while ((match = anchorRe.exec(html)) !== null) {
    const href = match[1];
    if (!href || href.startsWith("#") || href.startsWith("javascript:")) continue;
    if (!looksLikeJobHref(href)) continue;
    const title = stripTags(match[2]);
    if (title.length < MIN_TITLE_LEN || title.length > MAX_TITLE_LEN) continue;
    // Skip obvious non-title navigation text.
    if (/^(view all|see all|apply|learn more|search|filter)$/i.test(title)) continue;
    const url = resolveUrl(href, baseUrl);
    out.push({
      external_id: makeExternalId(url, title),
      title,
      url,
      location: null,
      source: "careers_portal",
      source_url: baseUrl,
    });
  }
  return out;
}

// Pure extractor: given page HTML and the URL it came from, return de-duplicated
// job records. Structured JSON-LD is preferred; anchor heuristics fill in the
// rest. Exported for unit/smoke testing without any network access.
export function extractJobsFromHtml(
  html: string,
  baseUrl: string,
  opts: {
    roleFilters?: string[];
    domainFilters?: string[];
    maxJobs?: number;
  } = {}
): CareersPortalJob[] {
  const maxJobs = opts.maxJobs && opts.maxJobs > 0 ? Math.floor(opts.maxJobs) : DEFAULT_MAX_JOBS;
  const structured = extractStructuredJobs(html, baseUrl);
  const anchors = extractAnchorJobs(html, baseUrl);

  const seen = new Set<string>();
  const merged: CareersPortalJob[] = [];
  for (const job of [...structured, ...anchors]) {
    if (!matchesFilters(job.title, opts.roleFilters, opts.domainFilters)) continue;
    // Dedupe on external_id first, then on a normalised title+url key.
    const key = job.external_id || `${job.title}::${job.url ?? ""}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(job);
    if (merged.length >= maxJobs) break;
  }
  return merged;
}

// Detect content that we cannot meaningfully scrape. Returns a reason string or
// null when the body looks extractable.
function detectUnscrapable(body: string, contentType: string): string | null {
  const lower = body.toLowerCase();
  if (/captcha|are you a human|verify you are human|cf-browser-verification/.test(lower)) {
    return "captcha_or_bot_challenge";
  }
  // Heuristic for JS-only SPAs: almost no anchors and a root mount node.
  const anchorCount = (body.match(/<a\b/gi) ?? []).length;
  if (
    anchorCount < 3 &&
    /(id=["'](root|app|__next)["'])/.test(lower) &&
    !contentType.includes("application/json")
  ) {
    return "js_only_portal";
  }
  return null;
}

// Fetch a single URL with a bounded timeout and size cap. Returns the body text
// + content-type, or a reason on failure. Never throws.
async function fetchBounded(
  url: string,
  options: Required<Pick<CareersPortalOptions, "fetch" | "timeoutMs" | "userAgent" | "maxBytes">>
): Promise<{ body: string; contentType: string } | { reason: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    const res = await options.fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "user-agent": options.userAgent,
        accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
        "accept-language": "en-US,en;q=0.9",
      },
    });
    if (!res.ok) {
      return { reason: `http_${res.status}` };
    }
    const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
    const raw = await res.text();
    const body = raw.length > options.maxBytes ? raw.slice(0, options.maxBytes) : raw;
    return { body, contentType };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return { reason: "timeout" };
    }
    return { reason: "fetch_failed" };
  } finally {
    clearTimeout(timer);
  }
}

// Parse a JSON careers API response best-effort. Some ATS portals expose a JSON
// listing endpoint; we look for arrays of objects carrying a title-like field.
function extractJsonJobs(
  body: string,
  baseUrl: string,
  maxJobs: number
): CareersPortalJob[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return [];
  }
  const arrays: unknown[] = [];
  const visit = (node: unknown, depth: number) => {
    if (depth > 4 || arrays.length > 0) return;
    if (Array.isArray(node)) {
      if (node.some((n) => n && typeof n === "object")) arrays.push(node);
      return;
    }
    if (node && typeof node === "object") {
      for (const v of Object.values(node as Record<string, unknown>)) visit(v, depth + 1);
    }
  };
  visit(parsed, 0);
  const list = (arrays[0] as Array<Record<string, unknown>>) ?? [];
  const out: CareersPortalJob[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const title =
      pickStr(item, ["title", "name", "jobTitle", "text"]) ?? "";
    if (title.length < MIN_TITLE_LEN) continue;
    const rawUrl = pickStr(item, ["absolute_url", "url", "hostedUrl", "applyUrl", "link"]);
    const url = rawUrl ? resolveUrl(rawUrl, baseUrl) : null;
    out.push({
      external_id: makeExternalId(url, title),
      title: title.slice(0, MAX_TITLE_LEN),
      url,
      location: pickStr(item, ["location", "city", "office"]) ?? null,
      source: "careers_portal",
      source_url: baseUrl,
    });
    if (out.length >= maxJobs) break;
  }
  return out;
}

function pickStr(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v.trim().length > 0) return v.trim();
  }
  return undefined;
}

// Top-level provider entrypoint. Tries jobPortalUrl first (usually the ATS
// listing page, richer), then careersUrl. Best-effort and non-fatal.
export async function fetchCareersPortalJobs(
  input: CareersPortalInput,
  options: CareersPortalOptions = {}
): Promise<CareersPortalResult> {
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  const resolved = {
    fetch: fetchImpl,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    userAgent: options.userAgent ?? DEFAULT_USER_AGENT,
    maxBytes: options.maxBytes ?? DEFAULT_MAX_BYTES,
  };
  const maxJobs = input.maxJobs && input.maxJobs > 0 ? Math.floor(input.maxJobs) : DEFAULT_MAX_JOBS;

  const candidates = [input.jobPortalUrl, input.careersUrl].filter(
    (u): u is string => typeof u === "string" && u.trim().length > 0
  );
  if (candidates.length === 0) {
    return { jobs: [], fetchedUrl: null, reason: "no_careers_url" };
  }

  let lastReason: string | undefined;
  for (const url of candidates) {
    if (!hostnameOf(url)) {
      lastReason = "invalid_url";
      continue;
    }
    const fetched = await fetchBounded(url, resolved);
    if ("reason" in fetched) {
      lastReason = fetched.reason;
      continue;
    }
    let jobs: CareersPortalJob[];
    if (fetched.contentType.includes("application/json")) {
      jobs = extractJsonJobs(fetched.body, url, maxJobs);
    } else {
      const unscrapable = detectUnscrapable(fetched.body, fetched.contentType);
      if (unscrapable) {
        lastReason = unscrapable;
        continue;
      }
      jobs = extractJobsFromHtml(fetched.body, url, {
        roleFilters: input.roleFilters,
        domainFilters: input.domainFilters,
        maxJobs,
      });
    }
    if (jobs.length > 0) {
      return { jobs, fetchedUrl: url };
    }
    lastReason = "no_jobs_extracted";
  }

  return { jobs: [], fetchedUrl: null, reason: lastReason ?? "no_jobs_extracted" };
}
