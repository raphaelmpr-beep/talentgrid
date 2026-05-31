// Compensation + posting-date normalizers for ingested ATS/API jobs.
//
// These are pure functions: given a raw vendor job object and the source name,
// they return the normalized compensation/date fields the schema persists
// (see supabase/migrations/006_role_compensation_and_dates.sql). They are the
// single place that decides how precise a value is.
//
// Hard rule from the product brief: NEVER invent or estimate a salary or a
// posting date. When a source does not clearly provide a value, the result is
// the explicit "unavailable" state and the numeric/date fields stay null. The
// UI renders an em dash for those, and a later parser pass can revisit the raw
// source object (which the pipeline preserves on the row) without us having
// guessed anything in the meantime.

// Precision of a compensation value, most precise first. The pipeline's
// preservation logic ranks these so a richer value is never overwritten by a
// poorer one from a later run.
export type CompensationStatus =
  | "exact_range"
  | "exact_single_value"
  | "text_only"
  | "parsed_from_description"
  | "unavailable";

export type CompensationSource =
  | "ats_api"
  | "job_description_parsed"
  | "unavailable";

export type CompensationPeriod =
  | "year"
  | "hour"
  | "month"
  | "week"
  | "contract"
  | "unknown";

export type NormalizedCompensation = {
  compensation_min: number | null;
  compensation_max: number | null;
  compensation_currency: string | null;
  compensation_period: CompensationPeriod | null;
  compensation_text: string | null;
  compensation_source: CompensationSource;
  compensation_status: CompensationStatus;
};

export type PostedStatus = "exact" | "inferred_from_discovered_at" | "unavailable";

export type NormalizedPostedDate = {
  posted_at: string | null;
  posted_status: PostedStatus;
};

export const UNAVAILABLE_COMPENSATION: NormalizedCompensation = {
  compensation_min: null,
  compensation_max: null,
  compensation_currency: null,
  compensation_period: null,
  compensation_text: null,
  compensation_source: "unavailable",
  compensation_status: "unavailable",
};

export const UNAVAILABLE_POSTED: NormalizedPostedDate = {
  posted_at: null,
  posted_status: "unavailable",
};

// Numeric strength ranking of a status, used by the pipeline to decide whether a
// freshly-parsed value is at least as good as what is already stored (so a run
// that comes back with less detail never clobbers a richer prior value).
export function compensationStatusRank(status: CompensationStatus): number {
  switch (status) {
    case "exact_range":
      return 4;
    case "exact_single_value":
      return 3;
    case "parsed_from_description":
      return 2;
    case "text_only":
      return 1;
    case "unavailable":
      return 0;
  }
}

type Raw = Record<string, unknown>;

function asRecord(value: unknown): Raw | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Raw)
    : null;
}

// Coerce a numeric-looking value (number or a clean numeric string) to a finite
// number. Returns null for anything ambiguous so we never fabricate a figure.
function toNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const cleaned = value.replace(/[, $]/g, "").trim();
    if (cleaned === "") return null;
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

// Map a vendor's interval/period label onto our fixed period vocabulary. An
// unrecognised but present label becomes "unknown" (we know a period exists but
// not which one); a missing label returns null.
function normalizePeriod(value: unknown): CompensationPeriod | null {
  const s = nonEmptyString(value);
  if (!s) return null;
  const lower = s.toLowerCase();
  if (/(year|annual|annum|\/yr|per year|yr\b|p\.?a\.?)/.test(lower)) return "year";
  if (/(hour|hourly|\/hr|per hour|hr\b)/.test(lower)) return "hour";
  if (/(month|monthly|\/mo|per month|mo\b)/.test(lower)) return "month";
  if (/(week|weekly|\/wk|per week|wk\b)/.test(lower)) return "week";
  if (/(contract|project|fixed|one[- ]?time)/.test(lower)) return "contract";
  return "unknown";
}

function normalizeCurrency(value: unknown): string | null {
  const s = nonEmptyString(value);
  if (!s) return null;
  // ISO 4217 codes are three letters; pass them through uppercased. Common
  // symbols are mapped; anything else is left as-is so we preserve the source.
  if (/^[A-Za-z]{3}$/.test(s)) return s.toUpperCase();
  if (s === "$") return "USD";
  if (s === "€") return "EUR";
  if (s === "£") return "GBP";
  return s;
}

// Build a structured-range/single-value/text result from already-extracted
// pieces, choosing the most precise status the data supports. source is always
// ats_api here because these come straight off a vendor board object.
function fromStructured(args: {
  min: number | null;
  max: number | null;
  currency: string | null;
  period: CompensationPeriod | null;
  text: string | null;
}): NormalizedCompensation {
  const { min, max, currency, period, text } = args;
  const hasMin = min !== null && min > 0;
  const hasMax = max !== null && max > 0;

  if (hasMin && hasMax && min !== max) {
    return {
      compensation_min: min,
      compensation_max: max,
      compensation_currency: currency,
      compensation_period: period,
      compensation_text: text,
      compensation_source: "ats_api",
      compensation_status: "exact_range",
    };
  }
  // A single figure (only one bound, or min === max) is an exact single value.
  const single = hasMin ? min : hasMax ? max : null;
  if (single !== null) {
    return {
      compensation_min: single,
      compensation_max: single,
      compensation_currency: currency,
      compensation_period: period,
      compensation_text: text,
      compensation_source: "ats_api",
      compensation_status: "exact_single_value",
    };
  }
  // No usable numbers but the source gave a human compensation string.
  if (text) {
    return {
      compensation_min: null,
      compensation_max: null,
      compensation_currency: currency,
      compensation_period: period,
      compensation_text: text,
      compensation_source: "ats_api",
      compensation_status: "text_only",
    };
  }
  return UNAVAILABLE_COMPENSATION;
}

// --- Lever -----------------------------------------------------------------
// A Lever posting may carry `salaryRange: { min, max, currency, interval }`
// (interval e.g. "per-year-salary") and a human `salaryDescription`. Older
// boards omit salaryRange entirely.
function leverCompensation(raw: Raw): NormalizedCompensation {
  const range = asRecord(raw.salaryRange);
  const text =
    nonEmptyString(raw.salaryDescription) ??
    nonEmptyString(range?.text) ??
    null;
  if (range) {
    return fromStructured({
      min: toNumber(range.min),
      max: toNumber(range.max),
      currency: normalizeCurrency(range.currency),
      period: normalizePeriod(range.interval),
      text,
    });
  }
  if (text) {
    return fromStructured({ min: null, max: null, currency: null, period: null, text });
  }
  return UNAVAILABLE_COMPENSATION;
}

// --- Ashby -----------------------------------------------------------------
// With includeCompensation=true an Ashby job carries `compensation`:
//   { compensationTierSummary: "$120K – $180K", summaryComponents: [
//       { compensationType: "Salary", interval: "1 YEAR", currencyCode: "USD",
//         minValue: 120000, maxValue: 180000 } ] }
// Some jobs also expose top-level `compensationTierSummary`. We prefer the
// structured salary component, falling back to the summary text.
function ashbyCompensation(raw: Raw): NormalizedCompensation {
  const comp = asRecord(raw.compensation) ?? raw;
  const summary =
    nonEmptyString(comp.compensationTierSummary) ??
    nonEmptyString(raw.compensationTierSummary) ??
    null;

  const components = Array.isArray(comp.summaryComponents)
    ? (comp.summaryComponents as unknown[])
    : Array.isArray(raw.summaryComponents)
      ? (raw.summaryComponents as unknown[])
      : [];
  // Prefer a Salary/base component; fall back to the first component with a
  // numeric value so an equity-only listing doesn't masquerade as salary.
  const salaryComponent =
    components
      .map(asRecord)
      .filter((c): c is Raw => c !== null)
      .find((c) => {
        const type = nonEmptyString(c.compensationType)?.toLowerCase() ?? "";
        return type.includes("salary") || type.includes("base");
      }) ??
    components
      .map(asRecord)
      .find((c): c is Raw => c !== null && (toNumber(c?.minValue) !== null || toNumber(c?.maxValue) !== null));

  if (salaryComponent) {
    return fromStructured({
      min: toNumber(salaryComponent.minValue),
      max: toNumber(salaryComponent.maxValue),
      currency: normalizeCurrency(salaryComponent.currencyCode ?? salaryComponent.currency),
      period: normalizePeriod(salaryComponent.interval),
      text: summary,
    });
  }
  if (summary) {
    return fromStructured({ min: null, max: null, currency: null, period: null, text: summary });
  }
  return UNAVAILABLE_COMPENSATION;
}

// --- Greenhouse ------------------------------------------------------------
// The Greenhouse board jobs list does not include pay by default. When pay
// transparency is enabled the job carries `pay_input_ranges` (or `pay_ranges`):
//   [{ min_cents, max_cents, currency_type, title }] or
//   [{ min_value, max_value, currency, ... }]. Cents are converted to whole
//   currency units. Some boards instead surface a pay string in a `metadata`
//   custom field; we read that as text-only when no structured range exists.
function greenhouseCompensation(raw: Raw): NormalizedCompensation {
  const ranges =
    (Array.isArray(raw.pay_input_ranges) && raw.pay_input_ranges) ||
    (Array.isArray(raw.pay_ranges) && raw.pay_ranges) ||
    null;
  if (ranges && ranges.length > 0) {
    const first = asRecord((ranges as unknown[])[0]);
    if (first) {
      const cents = toNumber(first.min_cents) !== null || toNumber(first.max_cents) !== null;
      const minC = toNumber(first.min_cents);
      const maxC = toNumber(first.max_cents);
      const min = cents ? (minC !== null ? minC / 100 : null) : toNumber(first.min_value ?? first.min);
      const max = cents ? (maxC !== null ? maxC / 100 : null) : toNumber(first.max_value ?? first.max);
      return fromStructured({
        min,
        max,
        currency: normalizeCurrency(first.currency_type ?? first.currency),
        period: normalizePeriod(first.interval ?? first.title),
        text: nonEmptyString(first.title),
      });
    }
  }
  // Pay sometimes lives in a Greenhouse custom metadata field. These are
  // [{ name, value, value_type }]; treat a pay/salary/compensation-named string
  // field as a human compensation_text (text-only), never as a parsed number.
  const meta = Array.isArray(raw.metadata) ? (raw.metadata as unknown[]) : [];
  for (const entry of meta) {
    const m = asRecord(entry);
    if (!m) continue;
    const name = nonEmptyString(m.name)?.toLowerCase() ?? "";
    if (/(pay|salary|compensation)/.test(name)) {
      const value = nonEmptyString(m.value);
      if (value) {
        return fromStructured({ min: null, max: null, currency: null, period: null, text: value });
      }
    }
  }
  return UNAVAILABLE_COMPENSATION;
}

// normalizeCompensation — the entrypoint. Routes by source/vendor to the right
// field mapping; unknown sources return unavailable. Priority within a source is
// handled by fromStructured: structured range > single value > text-only.
export function normalizeCompensation(
  rawJob: Raw | null | undefined,
  sourceName: string | null | undefined
): NormalizedCompensation {
  const raw = asRecord(rawJob);
  if (!raw) return UNAVAILABLE_COMPENSATION;
  const vendor = (sourceName ?? "").trim().toLowerCase();
  switch (vendor) {
    case "lever":
      return leverCompensation(raw);
    case "ashby":
      return ashbyCompensation(raw);
    case "greenhouse":
      return greenhouseCompensation(raw);
    default:
      return UNAVAILABLE_COMPENSATION;
  }
}

// --- Posting dates ---------------------------------------------------------

// Parse a vendor date value into an ISO timestamp. Accepts ISO strings and
// epoch values (Lever uses milliseconds). Returns null for anything we cannot
// confidently interpret as a real date.
function toIso(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    // Heuristic: ms epochs are ~1e12 now, seconds ~1e9. Treat <1e12 as seconds.
    const ms = value < 1_000_000_000_000 ? value * 1000 : value;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  if (typeof value === "string") {
    const s = value.trim();
    if (!s) return null;
    // A bare numeric string is an epoch.
    if (/^\d{10,13}$/.test(s)) return toIso(Number(s));
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  return null;
}

// First date-bearing field present, in priority order, for a vendor. Only
// fields that clearly denote when the posting went live are listed — we never
// fall back to a generic "updated_at" as a posting date.
const POSTED_FIELDS: Record<string, string[]> = {
  // Greenhouse: first_published is the public posting date; created_at is when
  // the requisition was created (close enough to be the posting date on the
  // board, used only when first_published is absent).
  greenhouse: ["first_published", "first_published_at", "created_at"],
  // Lever: createdAt is the posting creation time (ms epoch); some payloads
  // expose listedAt.
  lever: ["createdAt", "listedAt", "created_at"],
  // Ashby: publishedAt / publishedDate denote when the posting was listed.
  ashby: ["publishedAt", "publishedDate", "published_at"],
  // Workday: postedOn / startDate when present on the CXS posting.
  workday: ["postedOn", "startDate", "posted_on"],
};

// normalizePostedDate — returns an exact posted_at only when a clear ATS posting
// field is present. It NEVER uses discovered_at as posted_at here; inferring
// from discovered_at is the pipeline's fallback (it owns that timestamp), and is
// labelled inferred_from_discovered_at there. Default is unavailable.
export function normalizePostedDate(
  rawJob: Raw | null | undefined,
  sourceName: string | null | undefined
): NormalizedPostedDate {
  const raw = asRecord(rawJob);
  if (!raw) return UNAVAILABLE_POSTED;
  const vendor = (sourceName ?? "").trim().toLowerCase();
  const fields = POSTED_FIELDS[vendor];
  if (!fields) return UNAVAILABLE_POSTED;
  for (const field of fields) {
    const iso = toIso(raw[field]);
    if (iso) {
      return { posted_at: iso, posted_status: "exact" };
    }
  }
  return UNAVAILABLE_POSTED;
}
