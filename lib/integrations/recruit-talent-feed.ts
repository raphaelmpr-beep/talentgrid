/** Pure, side-effect-free boundaries for the Recruit Talent job-feed integration. */
export const RECRUIT_TALENT_MAX_AGE_DAYS = 30;
export const RECRUIT_TALENT_MAX_PAGE_SIZE = 25;

const TRUSTED_ATS = new Set(['greenhouse', 'lever', 'ashby', 'workday']);

export const RECRUIT_TALENT_SECONDARY_SORT = 'id';

export type FeedParams = {
  page: number;
  pageSize: number;
  query?: string;
  location?: string;
  remote?: boolean;
};

export type FeedJob = {
  id: string;
  title: string;
  employer: string;
  location: string | null;
  remote: boolean;
  employmentType: string | null;
  seniority: string | null;
  descriptionExcerpt: string | null;
  compensation: {
    min: number | null;
    max: number | null;
    currency: string | null;
    period: string | null;
    status: string;
  } | null;
  postedAt: string | null;
  postedDateType: 'employer_confirmed' | 'first_seen' | 'unavailable';
  firstSeenAt: string | null;
  lastVerifiedAt: string;
  source: string;
  originalUrl: string;
  recruiterRepresented: false;
};

export type FeedRoleRow = {
  id: string;
  title: string;
  description: string | null;
  location: string | null;
  remote: boolean;
  employment_type: string | null;
  seniority: string | null;
  url: string | null;
  source: string | null;
  is_active: boolean;
  ghost_score: number | null;
  posted_at: string | null;
  posted_status: string | null;
  discovered_at: string | null;
  last_checked_at: string | null;
  compensation_min: number | string | null;
  compensation_max: number | string | null;
  compensation_currency: string | null;
  compensation_period: string | null;
  compensation_status: string | null;
  metadata: Record<string, unknown> | null;
  companies: { name: string } | Array<{ name: string }> | null;
};

function optionalText(value: string | null, limit: number): string | null {
  return value && value.trim() ? value.trim().slice(0, limit) : null;
}

function numeric(value: number | string | null): number | null {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export function parseFeedParams(params: URLSearchParams): FeedParams | null {
  const pageText = params.get('page') ?? '1';
  const sizeText = params.get('pageSize') ?? '20';
  // Do not accept fractions, signs, exponentials, or oversized pages.
  if (!/^\d{1,2}$/.test(pageText) || !/^\d{1,2}$/.test(sizeText)) return null;
  const page = Number(pageText);
  const pageSize = Number(sizeText);
  if (page < 1 || page > 20 || pageSize < 1 || pageSize > RECRUIT_TALENT_MAX_PAGE_SIZE) return null;
  const query = params.get('q')?.trim();
  const location = params.get('location')?.trim();
  if ((query && query.length > 100) || (location && location.length > 100)) return null;
  // Do not permit wildcard characters in PostgREST ilike patterns.
  if (query && !/^[\p{L}\p{N}\s.\-+/#]+$/u.test(query)) return null;
  if (location && !/^[\p{L}\p{N}\s,.\-]+$/u.test(location)) return null;
  const rawRemote = params.get('remote');
  if (rawRemote != null && rawRemote !== 'true' && rawRemote !== 'false') return null;
  return {
    page,
    pageSize,
    ...(query ? { query } : {}),
    ...(location ? { location } : {}),
    ...(rawRemote != null ? { remote: rawRemote === 'true' } : {}),
  };
}

export function mapVerifiedRole(row: FeedRoleRow, now: Date = new Date()): FeedJob | null {
  if (!row.is_active || (row.ghost_score ?? 0) >= 40) return null;
  if (row.source !== 'careers_portal') return null;
  const source = String(row.metadata?.ats_vendor ?? '').trim().toLowerCase();
  if (!TRUSTED_ATS.has(source)) return null;
  if (!row.id || !row.title?.trim() || !row.url) return null;

  // Source-specific ATS URLs should be tested during the pipeline's normal
  // validation. Only HTTPS outward-facing links are presented to applicants.
  let originalUrl: string;
  try {
    const url = new URL(row.url);
    const host = url.hostname.toLowerCase();
    if (url.protocol !== 'https:' || url.username || url.password ||
        host === 'localhost' || host.endsWith('.local') ||
        host === '127.0.0.1' || host === '0.0.0.0' || host === '::1') return null;
    originalUrl = url.toString();
  } catch {
    return null;
  }

  const verifiedAt = Date.parse(row.last_checked_at ?? '');
  const ageMs = now.getTime() - verifiedAt;
  if (!Number.isFinite(verifiedAt) || ageMs < -60_000 ||
      ageMs > RECRUIT_TALENT_MAX_AGE_DAYS * 86_400_000) return null;

  const joined = Array.isArray(row.companies) ? row.companies[0] : row.companies;
  if (!joined?.name?.trim()) return null;
  const status = row.compensation_status ?? 'unavailable';
  const hasNumbers = status === 'exact_range' || status === 'exact_single_value' ||
    status === 'parsed_from_description';
  const min = hasNumbers ? numeric(row.compensation_min) : null;
  const max = hasNumbers ? numeric(row.compensation_max) : null;
  const compensation = (min !== null || max !== null) ? {
    min, max,
    currency: optionalText(row.compensation_currency, 8),
    period: optionalText(row.compensation_period, 30),
    status,
  } : null;
  return {
    id: row.id,
    title: row.title.trim().slice(0, 200),
    employer: joined.name.trim().slice(0, 180),
    location: optionalText(row.location, 180),
    remote: row.remote === true,
    employmentType: optionalText(row.employment_type, 80),
    seniority: optionalText(row.seniority, 80),
    descriptionExcerpt: optionalText(row.description, 650),
    compensation,
    postedAt: row.posted_status === 'exact' ? row.posted_at : null,
    postedDateType: row.posted_status === 'exact'
      ? 'employer_confirmed'
      : row.posted_status === 'inferred_from_discovered_at'
        ? 'first_seen'
        : 'unavailable',
    firstSeenAt: row.posted_status === 'inferred_from_discovered_at'
      ? row.discovered_at ?? row.posted_at
      : null,
    lastVerifiedAt: new Date(verifiedAt).toISOString(),
    source,
    originalUrl,
    recruiterRepresented: false,
  };
}
