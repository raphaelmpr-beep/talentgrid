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
  // ATS routing hints the importer stores in companies.metadata. When present
  // we can hit the vendor's public JSON board API directly (full inventory,
  // exact total) instead of scraping a JS-rendered careers page.
  atsType?: string | null;
  atsSlug?: string | null;
};

export type CareersPortalResult = {
  jobs: CareersPortalJob[];
  // Full live inventory size for the source. When an ATS JSON board API is hit
  // this is the vendor-reported total (e.g. Greenhouse meta.total = 176 for
  // Pinterest), which can exceed jobs.length because `jobs` is capped at
  // maxJobs for storage. Falls back to jobs.length for scraped HTML sources.
  totalCount: number;
  // Which URL produced the jobs (careersUrl or jobPortalUrl), for debugging.
  fetchedUrl: string | null;
  // Resolved source path actually used: "greenhouse" | "lever" | "workday" |
  // "html" | "json" etc. Lets the caller know whether the count is authoritative.
  source?: string;
  // True when totalCount is the vendor-reported exact live inventory (a public
  // JSON board API: Greenhouse meta.total, Lever array length, Workday total).
  // False/absent when the count is a best-effort sample from HTML/JSON scraping
  // and may undercount. Lets the caller flag fallback counts as non-authoritative.
  countExact?: boolean;
  // Non-fatal reason when no jobs were extracted (blocked, js_only, etc.).
  // Never contains secrets.
  reason?: string;
};

// A resolved ATS board endpoint plus the parser that turns its JSON into jobs
// and an exact total. Vendor JSON APIs are public, key-less, and return the
// full board, so they are strongly preferred over HTML scraping.
type AtsBoard = {
  vendor: "greenhouse" | "lever" | "workday";
  apiUrl: string;
  // Public page a candidate would land on, used as the base for relative URLs.
  baseUrl: string;
  // Workday only: the cxs host (e.g. company.wd5.myworkdayjobs.com) used to
  // resolve relative posting paths to absolute candidate URLs.
  host?: string;
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

// Pure extractor returning the de-duplicated sample (capped at maxJobs) plus the
// full de-duplicated count (`total`, uncapped) so a scraped page can report its
// true inventory size without storing every row. Structured JSON-LD is
// preferred; anchor heuristics fill in the rest.
export function extractJobsWithTotal(
  html: string,
  baseUrl: string,
  opts: {
    roleFilters?: string[];
    domainFilters?: string[];
    maxJobs?: number;
  } = {}
): { jobs: CareersPortalJob[]; total: number } {
  const maxJobs = opts.maxJobs && opts.maxJobs > 0 ? Math.floor(opts.maxJobs) : DEFAULT_MAX_JOBS;
  const structured = extractStructuredJobs(html, baseUrl);
  const anchors = extractAnchorJobs(html, baseUrl);

  const seen = new Set<string>();
  const merged: CareersPortalJob[] = [];
  let total = 0;
  for (const job of [...structured, ...anchors]) {
    if (!matchesFilters(job.title, opts.roleFilters, opts.domainFilters)) continue;
    // Dedupe on external_id first, then on a normalised title+url key.
    const key = job.external_id || `${job.title}::${job.url ?? ""}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    // Every unique job-like entry counts toward the full inventory; only the
    // stored sample is bounded by maxJobs.
    total += 1;
    if (merged.length < maxJobs) merged.push(job);
  }
  return { jobs: merged, total };
}

// Backwards-compatible wrapper returning just the capped sample. Exported for
// unit/smoke testing without any network access.
export function extractJobsFromHtml(
  html: string,
  baseUrl: string,
  opts: {
    roleFilters?: string[];
    domainFilters?: string[];
    maxJobs?: number;
  } = {}
): CareersPortalJob[] {
  return extractJobsWithTotal(html, baseUrl, opts).jobs;
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
// Returns the capped sample plus the full inventory `total` (count of all
// title-bearing entries in the listing array, before the maxJobs sample cap) so
// the caller can report the real board size without storing every row.
function extractJsonJobs(
  body: string,
  baseUrl: string,
  maxJobs: number
): { jobs: CareersPortalJob[]; total: number } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { jobs: [], total: 0 };
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
  let total = 0;
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const title =
      pickStr(item, ["title", "name", "jobTitle", "text"]) ?? "";
    if (title.length < MIN_TITLE_LEN) continue;
    // Count every valid listing toward the full inventory; only the stored
    // sample is bounded by maxJobs.
    total += 1;
    if (out.length >= maxJobs) continue;
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
  }
  return { jobs: out, total };
}

function pickStr(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v.trim().length > 0) return v.trim();
  }
  return undefined;
}

// ----------------------------------------------------------------------------
// ATS board adapters
//
// Most large careers sites are JS-rendered shells backed by an ATS that exposes
// a public, key-less JSON board API returning the *entire* posting inventory.
// Hitting that API gives an exact total (the live count users see) instead of
// the 0-2 anchors an HTML scrape recovers from the SPA shell. Greenhouse is the
// representative case (Pinterest: gh_jid links, board slug "pinterest").
// ----------------------------------------------------------------------------

// Extract a Greenhouse board slug from a careers/ATS/job URL. Handles both the
// vendor-hosted form (boards.greenhouse.io/<slug>) and company pages that link
// out with ?gh_jid= but encode the slug in a data attribute or path we can't
// see — for those we rely on the explicit ats_slug hint instead.
function greenhouseSlugFromUrl(url: string): string | null {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    if (host.endsWith("greenhouse.io")) {
      // boards.greenhouse.io/acme, job-boards.greenhouse.io/acme, or
      // boards-api.greenhouse.io/v1/boards/acme/jobs
      const parts = u.pathname.split("/").filter(Boolean);
      const boardsIdx = parts.indexOf("boards");
      if (boardsIdx >= 0 && parts[boardsIdx + 1]) return parts[boardsIdx + 1];
      if (parts[0]) return parts[0];
    }
  } catch {
    return null;
  }
  return null;
}

// Extract a Lever slug from a jobs.lever.co/<slug> or api.lever.co URL.
function leverSlugFromUrl(url: string): string | null {
  try {
    const u = new URL(url);
    if (!u.hostname.toLowerCase().endsWith("lever.co")) return null;
    const parts = u.pathname.split("/").filter(Boolean);
    // api.lever.co/v0/postings/<slug> | jobs.lever.co/<slug>
    const idx = parts.indexOf("postings");
    if (idx >= 0 && parts[idx + 1]) return parts[idx + 1];
    if (parts[0] && parts[0] !== "v0") return parts[0];
  } catch {
    return null;
  }
  return null;
}

// Derive a Workday CXS board from a public Workday candidate URL of the shape
//   https://{tenant}.{dc}.myworkdayjobs.com/{...}/{site}[/...]
// The public, key-less CXS jobs endpoint is
//   https://{tenant}.{dc}.myworkdayjobs.com/wday/cxs/{tenant}/{site}/jobs
// which accepts a POST { limit, offset, searchText, appliedFacets } and returns
// { total, jobPostings: [{ title, externalPath, locationsText }...] }. Paging
// through `offset` to `total` yields the exact live inventory.
function workdayBoardFromUrl(url: string): AtsBoard | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  if (!host.endsWith("myworkdayjobs.com")) return null;
  // tenant is the left-most label of the host (company.wd5.myworkdayjobs.com).
  const tenant = host.split(".")[0];
  if (!tenant) return null;

  // The site id is the path segment following an optional locale segment
  // (e.g. /en-US/<site> or /<site>). Workday locale segments look like "en-US".
  const parts = u.pathname.split("/").filter(Boolean);
  const localeRe = /^[a-z]{2}-[A-Z]{2}$/;
  let site: string | undefined;
  for (const part of parts) {
    if (localeRe.test(part)) continue;
    site = part;
    break;
  }
  if (!site) return null;

  return {
    vendor: "workday",
    apiUrl: `https://${host}/wday/cxs/${encodeURIComponent(tenant)}/${encodeURIComponent(site)}/jobs`,
    baseUrl: `https://${host}/${encodeURIComponent(site)}`,
    host,
  };
}

// Resolve which (if any) public ATS board API to call, from the explicit
// ats_type/ats_slug hints first, then by sniffing the candidate URLs.
function resolveAtsBoard(input: CareersPortalInput): AtsBoard | null {
  const urls = [input.jobPortalUrl, input.careersUrl].filter(
    (u): u is string => typeof u === "string" && u.trim().length > 0
  );
  const atsType = (input.atsType ?? "").trim().toLowerCase();
  const atsSlug = (input.atsSlug ?? "").trim();

  // Explicit hints win.
  if (atsType === "greenhouse" && atsSlug) {
    return greenhouseBoard(atsSlug);
  }
  if (atsType === "lever" && atsSlug) {
    return {
      vendor: "lever",
      apiUrl: `https://api.lever.co/v0/postings/${encodeURIComponent(atsSlug)}?mode=json`,
      baseUrl: `https://jobs.lever.co/${encodeURIComponent(atsSlug)}`,
    };
  }
  // Workday needs the full tenant/site/host, which the bare ats_slug can't carry
  // — so it is resolved by sniffing the candidate URL below regardless of hint.

  // Otherwise sniff the URLs.
  for (const url of urls) {
    const ghSlug = greenhouseSlugFromUrl(url);
    if (ghSlug) return greenhouseBoard(ghSlug);
    const lvSlug = leverSlugFromUrl(url);
    if (lvSlug) {
      return {
        vendor: "lever",
        apiUrl: `https://api.lever.co/v0/postings/${encodeURIComponent(lvSlug)}?mode=json`,
        baseUrl: `https://jobs.lever.co/${encodeURIComponent(lvSlug)}`,
      };
    }
    const wd = workdayBoardFromUrl(url);
    if (wd) return wd;
  }

  return null;
}

function greenhouseBoard(slug: string): AtsBoard {
  return {
    vendor: "greenhouse",
    apiUrl: `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(slug)}/jobs`,
    baseUrl: `https://boards.greenhouse.io/${encodeURIComponent(slug)}`,
  };
}

// When a candidate URL carries a Greenhouse `gh_jid` marker but the board slug
// is not in the URL or the metadata hints (common for company-hosted careers
// pages that embed Greenhouse, e.g. pinterestcareers.com), guess slugs from the
// company name. These are *verified* against the board API before use (see
// fetchCareersPortalJobs), so a wrong guess yields nothing rather than a bogus
// count. Returns an ordered list of plausible slugs, most-likely first.
function greenhouseSlugGuesses(input: CareersPortalInput): string[] {
  const urls = [input.jobPortalUrl, input.careersUrl].filter(
    (u): u is string => typeof u === "string" && u.trim().length > 0
  );
  const hasGhMarker = urls.some((u) => u.toLowerCase().includes("gh_jid="));
  if (!hasGhMarker) return [];
  const base = input.companyName
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  if (!base) return [];
  const collapsed = base.replace(/\s+/g, "");
  const firstWord = base.split(/\s+/)[0];
  const guesses = new Set<string>([collapsed, firstWord]);
  return [...guesses].filter((s) => s.length >= 2);
}

// Confirm a guessed Greenhouse slug resolves to a real board before trusting it.
async function greenhouseBoardExists(
  slug: string,
  resolved: Required<Pick<CareersPortalOptions, "fetch" | "timeoutMs" | "userAgent" | "maxBytes">>
): Promise<boolean> {
  const fetched = await fetchBounded(
    `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(slug)}`,
    resolved
  );
  if ("reason" in fetched) return false;
  try {
    const parsed = JSON.parse(fetched.body) as Record<string, unknown>;
    return typeof parsed.name === "string" && parsed.name.length > 0;
  } catch {
    return false;
  }
}

// Parse a Greenhouse board-API body: { jobs: [{ id, title, absolute_url,
// location: { name } }...], meta: { total } }. Returns the full inventory count
// plus jobs capped at maxJobs.
function parseGreenhouseBoard(
  body: string,
  board: AtsBoard,
  maxJobs: number
): { jobs: CareersPortalJob[]; total: number } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const root = parsed as Record<string, unknown>;
  const list = Array.isArray(root.jobs) ? (root.jobs as Array<Record<string, unknown>>) : null;
  if (!list) return null;

  const metaTotal =
    root.meta && typeof root.meta === "object"
      ? Number((root.meta as Record<string, unknown>).total)
      : NaN;
  const total = Number.isFinite(metaTotal) ? metaTotal : list.length;

  const jobs: CareersPortalJob[] = [];
  for (const item of list) {
    const title = pickStr(item, ["title", "name"]);
    if (!title || title.length < MIN_TITLE_LEN) continue;
    const rawUrl = pickStr(item, ["absolute_url", "url"]);
    const url = rawUrl ? resolveUrl(rawUrl, board.baseUrl) : null;
    const loc =
      item.location && typeof item.location === "object"
        ? pickStr(item.location as Record<string, unknown>, ["name"]) ?? null
        : pickStr(item, ["location"]) ?? null;
    jobs.push({
      external_id: makeExternalId(url, title),
      title: title.slice(0, MAX_TITLE_LEN),
      url,
      location: loc,
      source: "careers_portal",
      source_url: board.baseUrl,
    });
    if (jobs.length >= maxJobs) break;
  }
  return { jobs, total };
}

// Parse a Lever board-API body: a flat array of postings with `text`,
// `hostedUrl`, and `categories.location`.
function parseLeverBoard(
  body: string,
  board: AtsBoard,
  maxJobs: number
): { jobs: CareersPortalJob[]; total: number } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const list = parsed as Array<Record<string, unknown>>;
  const total = list.length;

  const jobs: CareersPortalJob[] = [];
  for (const item of list) {
    const title = pickStr(item, ["text", "title"]);
    if (!title || title.length < MIN_TITLE_LEN) continue;
    const rawUrl = pickStr(item, ["hostedUrl", "applyUrl", "url"]);
    const url = rawUrl ? resolveUrl(rawUrl, board.baseUrl) : null;
    let loc: string | null = null;
    const cats = item.categories;
    if (cats && typeof cats === "object") {
      loc = pickStr(cats as Record<string, unknown>, ["location"]) ?? null;
    }
    jobs.push({
      external_id: makeExternalId(url, title),
      title: title.slice(0, MAX_TITLE_LEN),
      url,
      location: loc,
      source: "careers_portal",
      source_url: board.baseUrl,
    });
    if (jobs.length >= maxJobs) break;
  }
  return { jobs, total };
}

// One page of the Workday CXS jobs API. Workday paginates; a single response
// carries `total` (exact live inventory) and up to `limit` postings, so we page
// through `offset` to recover the full board while capping stored rows.
const WORKDAY_PAGE_SIZE = 100;
// Hard cap on Workday pages fetched per company so a pathological board can't
// hang the per-company budget. 50 pages × 100 = 5000 postings of headroom; the
// reported `total` is always exact regardless of how many pages we store.
const WORKDAY_MAX_PAGES = 50;

type WorkdayPosting = {
  title?: unknown;
  externalPath?: unknown;
  locationsText?: unknown;
  bulletFields?: unknown;
};

// Page through the Workday CXS jobs endpoint to the exact total. Best-effort and
// non-fatal: returns null on the first failed/garbled page so the caller can
// fall back to HTML. `total` is the vendor-reported live inventory.
async function fetchWorkdayBoard(
  board: AtsBoard,
  maxJobs: number,
  resolved: Required<Pick<CareersPortalOptions, "fetch" | "timeoutMs" | "userAgent" | "maxBytes">>
): Promise<{ jobs: CareersPortalJob[]; total: number } | null> {
  const jobs: CareersPortalJob[] = [];
  let total = 0;
  let offset = 0;
  for (let page = 0; page < WORKDAY_MAX_PAGES; page++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), resolved.timeoutMs);
    let bodyText: string;
    try {
      const res = await resolved.fetch(board.apiUrl, {
        method: "POST",
        redirect: "follow",
        signal: controller.signal,
        headers: {
          "user-agent": resolved.userAgent,
          accept: "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify({ limit: WORKDAY_PAGE_SIZE, offset, searchText: "", appliedFacets: {} }),
      });
      if (!res.ok) return page === 0 ? null : { jobs, total };
      const raw = await res.text();
      bodyText = raw.length > resolved.maxBytes ? raw.slice(0, resolved.maxBytes) : raw;
    } catch {
      return page === 0 ? null : { jobs, total };
    } finally {
      clearTimeout(timer);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(bodyText);
    } catch {
      return page === 0 ? null : { jobs, total };
    }
    if (!parsed || typeof parsed !== "object") return page === 0 ? null : { jobs, total };
    const root = parsed as Record<string, unknown>;
    const list = Array.isArray(root.jobPostings)
      ? (root.jobPostings as WorkdayPosting[])
      : [];
    const pageTotal = Number(root.total);
    if (page === 0) total = Number.isFinite(pageTotal) ? pageTotal : list.length;

    for (const item of list) {
      const title = typeof item.title === "string" ? item.title.trim() : "";
      if (title.length < MIN_TITLE_LEN) continue;
      const path = typeof item.externalPath === "string" ? item.externalPath : null;
      const url = path ? resolveUrl(path, `https://${board.host}`) : null;
      const loc = typeof item.locationsText === "string" ? item.locationsText : null;
      if (jobs.length < maxJobs) {
        jobs.push({
          external_id: makeExternalId(url, title),
          title: title.slice(0, MAX_TITLE_LEN),
          url,
          location: loc,
          source: "careers_portal",
          source_url: board.baseUrl,
        });
      }
    }

    offset += WORKDAY_PAGE_SIZE;
    // Stop once we've covered the reported total or the page came back short
    // (defensive: a board that doesn't report total still terminates).
    if (list.length === 0 || (total > 0 && offset >= total)) break;
  }
  return { jobs, total: total || jobs.length };
}

// Fetch + parse a resolved ATS board. Best-effort and non-fatal: returns null
// on any failure so the caller can fall back to HTML scraping.
async function fetchAtsBoard(
  board: AtsBoard,
  maxJobs: number,
  resolved: Required<Pick<CareersPortalOptions, "fetch" | "timeoutMs" | "userAgent" | "maxBytes">>
): Promise<{ jobs: CareersPortalJob[]; total: number } | null> {
  if (board.vendor === "workday") {
    return fetchWorkdayBoard(board, maxJobs, resolved);
  }
  const fetched = await fetchBounded(board.apiUrl, resolved);
  if ("reason" in fetched) return null;
  if (board.vendor === "greenhouse") {
    return parseGreenhouseBoard(fetched.body, board, maxJobs);
  }
  return parseLeverBoard(fetched.body, board, maxJobs);
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

  // Prefer a public ATS board API when we can resolve one — it returns the full
  // live inventory and an exact total, which is the whole point of this fix.
  let board = resolveAtsBoard(input);

  // No board from hints/URLs, but the careers page carries a Greenhouse gh_jid
  // marker: guess the board slug from the company name and verify each guess
  // against the board API before trusting it (so a wrong guess can't fabricate
  // a count). This is what lets pinterestcareers.com resolve to board
  // "pinterest" with 176 openings.
  if (!board) {
    for (const slug of greenhouseSlugGuesses(input)) {
      if (await greenhouseBoardExists(slug, resolved)) {
        board = greenhouseBoard(slug);
        break;
      }
    }
  }

  if (board) {
    const result = await fetchAtsBoard(board, maxJobs, resolved);
    if (result && result.total > 0) {
      const filtered = (input.roleFilters?.length || input.domainFilters?.length)
        ? result.jobs.filter((j) =>
            matchesFilters(j.title, input.roleFilters, input.domainFilters)
          )
        : result.jobs;
      return {
        jobs: filtered,
        totalCount: result.total,
        fetchedUrl: board.apiUrl,
        source: board.vendor,
        // A resolved public board API reports the exact live inventory.
        countExact: true,
      };
    }
  }

  const candidates = [input.jobPortalUrl, input.careersUrl].filter(
    (u): u is string => typeof u === "string" && u.trim().length > 0
  );
  if (candidates.length === 0) {
    return { jobs: [], totalCount: 0, fetchedUrl: null, reason: "no_careers_url" };
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
    let total: number;
    let source: string;
    if (fetched.contentType.includes("application/json")) {
      const extracted = extractJsonJobs(fetched.body, url, maxJobs);
      jobs = extracted.jobs;
      total = extracted.total;
      source = "json";
    } else {
      const unscrapable = detectUnscrapable(fetched.body, fetched.contentType);
      if (unscrapable) {
        lastReason = unscrapable;
        continue;
      }
      const extracted = extractJobsWithTotal(fetched.body, url, {
        roleFilters: input.roleFilters,
        domainFilters: input.domainFilters,
        maxJobs,
      });
      jobs = extracted.jobs;
      total = extracted.total;
      source = "html";
    }
    if (jobs.length > 0) {
      // `jobs` is the (capped) stored sample; `total` is the full de-duplicated
      // count of job-like entries found on the page, so the inventory count is
      // not artificially limited by the sample cap. Scraped counts are a
      // best-effort sample of what the HTML/JSON exposed (a JS-rendered board may
      // show only a few visible links), so they are NOT marked exact — the caller
      // should treat them as a lower bound, not the authoritative live total.
      return {
        jobs,
        totalCount: Math.max(total, jobs.length),
        fetchedUrl: url,
        source,
        countExact: false,
      };
    }
    lastReason = "no_jobs_extracted";
  }

  return { jobs: [], totalCount: 0, fetchedUrl: null, reason: lastReason ?? "no_jobs_extracted" };
}
