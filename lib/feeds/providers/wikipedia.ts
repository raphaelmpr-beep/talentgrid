// Conservative public-Wikipedia fallback for company annual revenue.
//
// Used by the enrichment path when companies.metadata has none of
// annual_revenue / revenue_min / revenue_max. We never invent a number:
// only values that parse cleanly from a Wikidata "P2139" (total revenue)
// claim, or from a Wikipedia infobox `revenue` field, are returned.
//
// The Wikipedia/Wikidata REST APIs are unauthenticated. We keep timeouts
// and response sizes bounded so a slow/missing source never blocks an
// import, and any non-2xx / parse failure is surfaced as a structured
// "no_data" result rather than an exception.
//
// Provenance: every successful result carries source ("wikipedia" or
// "wikidata"), the canonical sourceUrl that produced the number, a
// human-readable label, and the raw matched text so reviewers can audit
// what we parsed.
import type { FetchLike } from "@/lib/feeds/providers/theirstack";

const WIKIPEDIA_API = "https://en.wikipedia.org/w/api.php";
const WIKIPEDIA_PAGE = "https://en.wikipedia.org/wiki/";
const WIKIDATA_ENTITY = "https://www.wikidata.org/wiki/Special:EntityData/";
const WIKIDATA_ITEM = "https://www.wikidata.org/wiki/";
const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_RESPONSE_BYTES = 256 * 1024;

export type WikipediaRevenueResult = {
  status: "ok";
  annualRevenue: number;
  currency: "USD";
  source: "wikipedia" | "wikidata";
  sourceUrl: string;
  sourceLabel: string;
  raw: string;
};

export type WikipediaNoDataResult = {
  status: "no_data";
  reason: string;
  source?: "wikipedia" | "wikidata";
  sourceUrl?: string;
};

export type WikipediaLookupResult = WikipediaRevenueResult | WikipediaNoDataResult;

export type WikipediaLookupInput = {
  name: string;
  domain?: string;
};

export type WikipediaLookupOptions = {
  fetch?: FetchLike;
  timeoutMs?: number;
  userAgent?: string;
};

const DEFAULT_UA =
  "TalentGridBot/1.0 (+https://github.com/raphaelmpr-beep/talentgrid) revenue-fallback";

export async function fetchWikipediaRevenue(
  input: WikipediaLookupInput,
  options: WikipediaLookupOptions = {}
): Promise<WikipediaLookupResult> {
  const name = (input.name ?? "").trim();
  if (!name) return { status: "no_data", reason: "empty_company_name" };

  const fetchImpl: FetchLike = options.fetch ?? globalThis.fetch.bind(globalThis);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const userAgent = options.userAgent ?? DEFAULT_UA;

  // 1) Resolve the canonical Wikipedia article + Wikidata QID via the
  //    MediaWiki search API. `srsearch` is URL-encoded.
  const search = await searchPage(fetchImpl, name, timeoutMs, userAgent);
  if (!search) {
    return { status: "no_data", reason: "no_wikipedia_match" };
  }

  // 2) Prefer structured Wikidata revenue (property P2139) — it has
  //    explicit units and a numeric amount, so it's safer to parse.
  if (search.qid) {
    const wd = await fetchWikidataRevenue(
      fetchImpl,
      search.qid,
      timeoutMs,
      userAgent,
      search.title
    );
    if (wd.status === "ok") return wd;
  }

  // 3) Fall back to parsing the Wikipedia infobox `revenue` row.
  const wp = await fetchInfoboxRevenue(
    fetchImpl,
    search.title,
    timeoutMs,
    userAgent
  );
  return wp;
}

type SearchHit = { title: string; qid?: string };

async function searchPage(
  fetchImpl: FetchLike,
  name: string,
  timeoutMs: number,
  userAgent: string
): Promise<SearchHit | null> {
  // Bias toward the company article rather than random matches.
  const query = `${name} company`;
  const url =
    `${WIKIPEDIA_API}?` +
    new URLSearchParams({
      action: "query",
      list: "search",
      srsearch: query,
      srlimit: "1",
      format: "json",
      origin: "*",
    }).toString();
  const data = await getJson(fetchImpl, url, timeoutMs, userAgent);
  if (!data) return null;
  const hit = (data as { query?: { search?: Array<{ title?: string }> } })?.query
    ?.search?.[0];
  const title = typeof hit?.title === "string" ? hit.title : null;
  if (!title) return null;

  // Look up the page's Wikidata QID so we can hit the structured endpoint.
  const propsUrl =
    `${WIKIPEDIA_API}?` +
    new URLSearchParams({
      action: "query",
      prop: "pageprops",
      titles: title,
      format: "json",
      origin: "*",
    }).toString();
  const props = await getJson(fetchImpl, propsUrl, timeoutMs, userAgent);
  let qid: string | undefined;
  if (props) {
    const pages = (props as {
      query?: { pages?: Record<string, { pageprops?: { wikibase_item?: string } }> };
    })?.query?.pages;
    if (pages) {
      for (const k of Object.keys(pages)) {
        const v = pages[k]?.pageprops?.wikibase_item;
        if (typeof v === "string" && v.startsWith("Q")) {
          qid = v;
          break;
        }
      }
    }
  }
  return { title, qid };
}

async function fetchWikidataRevenue(
  fetchImpl: FetchLike,
  qid: string,
  timeoutMs: number,
  userAgent: string,
  pageTitle: string
): Promise<WikipediaLookupResult> {
  const url = `${WIKIDATA_ENTITY}${encodeURIComponent(qid)}.json`;
  const data = await getJson(fetchImpl, url, timeoutMs, userAgent);
  if (!data) return { status: "no_data", reason: "wikidata_unavailable" };

  const entity = (data as {
    entities?: Record<
      string,
      {
        claims?: Record<string, Array<{
          mainsnak?: {
            datavalue?: {
              value?: {
                amount?: string;
                unit?: string;
              };
            };
          };
          rank?: string;
        }>>;
      }
    >;
  })?.entities?.[qid];
  const claims = entity?.claims?.P2139;
  if (!claims || claims.length === 0) {
    return { status: "no_data", reason: "no_wikidata_revenue", source: "wikidata" };
  }
  // Prefer "preferred" rank, then "normal", skip "deprecated".
  const sorted = [...claims].sort((a, b) => rankWeight(b.rank) - rankWeight(a.rank));
  for (const claim of sorted) {
    if (claim.rank === "deprecated") continue;
    const dv = claim.mainsnak?.datavalue?.value;
    if (!dv || typeof dv.amount !== "string") continue;
    const amount = parseWikidataAmount(dv.amount);
    if (amount === null || amount <= 0) continue;
    if (!isUsdUnit(dv.unit)) continue;
    return {
      status: "ok",
      annualRevenue: Math.round(amount),
      currency: "USD",
      source: "wikidata",
      sourceUrl: `${WIKIDATA_ITEM}${encodeURIComponent(qid)}#P2139`,
      sourceLabel: `Wikidata ${qid} (${pageTitle})`,
      raw: dv.amount,
    };
  }
  return {
    status: "no_data",
    reason: "no_usd_wikidata_revenue",
    source: "wikidata",
    sourceUrl: `${WIKIDATA_ITEM}${encodeURIComponent(qid)}`,
  };
}

async function fetchInfoboxRevenue(
  fetchImpl: FetchLike,
  title: string,
  timeoutMs: number,
  userAgent: string
): Promise<WikipediaLookupResult> {
  const url =
    `${WIKIPEDIA_API}?` +
    new URLSearchParams({
      action: "parse",
      page: title,
      prop: "wikitext",
      section: "0",
      format: "json",
      redirects: "1",
      origin: "*",
    }).toString();
  const data = await getJson(fetchImpl, url, timeoutMs, userAgent);
  if (!data) return { status: "no_data", reason: "wikipedia_unavailable" };
  const wikitext = (data as { parse?: { wikitext?: { "*"?: string } } })?.parse
    ?.wikitext?.["*"];
  if (typeof wikitext !== "string" || wikitext.length === 0) {
    return { status: "no_data", reason: "no_wikitext" };
  }
  const match = /\n\s*\|\s*revenue\s*=\s*([^\n]+)/i.exec(wikitext);
  if (!match) {
    return {
      status: "no_data",
      reason: "no_infobox_revenue",
      source: "wikipedia",
      sourceUrl: pageUrl(title),
    };
  }
  const raw = match[1].trim();
  const parsed = parseInfoboxRevenueValue(raw);
  if (parsed === null) {
    return {
      status: "no_data",
      reason: "unparseable_infobox_revenue",
      source: "wikipedia",
      sourceUrl: pageUrl(title),
    };
  }
  return {
    status: "ok",
    annualRevenue: parsed,
    currency: "USD",
    source: "wikipedia",
    sourceUrl: pageUrl(title),
    sourceLabel: `Wikipedia: ${title}`,
    raw,
  };
}

function pageUrl(title: string): string {
  return `${WIKIPEDIA_PAGE}${encodeURIComponent(title.replace(/ /g, "_"))}`;
}

function rankWeight(rank?: string): number {
  if (rank === "preferred") return 2;
  if (rank === "normal") return 1;
  return 0;
}

function parseWikidataAmount(amount: string): number | null {
  // Wikidata amounts look like "+1234567" or "-1.5e9". Strip the sign prefix
  // and parse with Number().
  const cleaned = amount.replace(/^\+/, "");
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function isUsdUnit(unit: string | undefined): boolean {
  if (!unit) return false;
  // Q4917 = "United States dollar" on Wikidata. The unit field is a URL.
  return /\/Q4917(?:[#?]|$)/.test(unit);
}

// Parse strings like:
//   "US$ 394.3 billion (2022)"
//   "$96.8 billion (FY2023)"
//   "{{US$|12.5 billion}}"
//   "US$1,234,567,890"
// Only returns when both the currency hint is USD (or absent + plain "$")
// and a numeric magnitude with an explicit scale word is present.
export function parseInfoboxRevenueValue(input: string): number | null {
  const stripped = input
    .replace(/<ref[^<]*<\/ref>/gi, "")
    .replace(/<ref[^>]*\/>/gi, "")
    .replace(/<!--.*?-->/gs, "")
    .replace(/\[\[(?:[^\]|]+\|)?([^\]]+)\]\]/g, "$1")
    .replace(/\{\{[^{}]*\}\}/g, (m) => m.replace(/[{}]/g, " "));
  const lower = stripped.toLowerCase();

  // Reject if a non-USD currency hint is present.
  if (/(?:€|£|¥|eur|gbp|jpy|cny|inr|cad|aud)\b/i.test(stripped)) return null;

  const usdHint = /\bus\$|\$/.test(stripped) || /\busd\b/i.test(stripped);
  if (!usdHint) return null;

  const m = /([0-9][0-9,]*(?:\.[0-9]+)?)\s*(trillion|billion|million|thousand|bn|m|tn|k)?/i.exec(
    lower
  );
  if (!m) return null;
  const numStr = m[1].replace(/,/g, "");
  const n = Number(numStr);
  if (!Number.isFinite(n) || n <= 0) return null;
  const scale = scaleMultiplier(m[2]);
  if (scale === null) {
    // No scale word — only trust the raw number when it's already a
    // realistic revenue figure (>= $1M). Stops us writing "5" for "$5".
    if (n < 1_000_000) return null;
    return n;
  }
  return n * scale;
}

function scaleMultiplier(token: string | undefined): number | null {
  if (!token) return null;
  const t = token.toLowerCase();
  switch (t) {
    case "trillion":
    case "tn":
      return 1_000_000_000_000;
    case "billion":
    case "bn":
      return 1_000_000_000;
    case "million":
    case "m":
      return 1_000_000;
    case "thousand":
    case "k":
      return 1_000;
    default:
      return null;
  }
}

async function getJson(
  fetchImpl: FetchLike,
  url: string,
  timeoutMs: number,
  userAgent: string
): Promise<unknown | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      method: "GET",
      headers: {
        accept: "application/json",
        "user-agent": userAgent,
      },
      signal: controller.signal,
    } as Parameters<FetchLike>[1]);
    if (!res.ok) return null;
    const text = await readBounded(res, MAX_RESPONSE_BYTES);
    if (text === null) return null;
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function readBounded(res: Response, maxBytes: number): Promise<string | null> {
  try {
    const text = await res.text();
    if (text.length > maxBytes) return text.slice(0, maxBytes);
    return text;
  } catch {
    return null;
  }
}
