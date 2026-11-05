import { timingSafeEqual } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { createFeedAdminClient } from '@/lib/feeds/supabase-admin';
import {
  mapVerifiedRole,
  parseFeedParams,
  RECRUIT_TALENT_MAX_AGE_DAYS,
  type FeedRoleRow,
} from '@/lib/integrations/recruit-talent-feed';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const HEADERS = { 'Cache-Control': 'private, no-store', Vary: 'Authorization' };
const ALLOWED_ATS = '(greenhouse,lever,ashby,workday)';

function authorized(req: NextRequest): boolean {
  const key = process.env.RECRUIT_TALENT_FEED_TOKEN;
  if (!key || key.length < 32) return false;
  const bearer = req.headers.get('authorization')?.match(/^Bearer ([^\s]+)$/)?.[1];
  if (!bearer) return false;
  const actual = Buffer.from(bearer, 'utf8');
  const expected = Buffer.from(key, 'utf8');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Read-only, server-to-server job feed. Never call this with a token from a browser. */
export async function GET(req: NextRequest) {
  if (!process.env.RECRUIT_TALENT_FEED_TOKEN ||
      process.env.RECRUIT_TALENT_FEED_TOKEN.length < 32) {
    return NextResponse.json({ error: 'feed_not_configured' }, { status: 503, headers: HEADERS });
  }
  if (!authorized(req)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401, headers: HEADERS });
  }

  const params = parseFeedParams(req.nextUrl.searchParams);
  if (!params) {
    return NextResponse.json({ error: 'invalid_query_parameters' }, { status: 400, headers: HEADERS });
  }
  const db = createFeedAdminClient();
  if (!db) {
    return NextResponse.json({ error: 'job_feed_unavailable' }, { status: 503, headers: HEADERS });
  }

  // Read only the fields needed by the recruiter site. Never return raw_data,
  // metadata, company intelligence, or any TalentGrid user data. The service
  // role is used ONLY after the independent integration token is checked.
  const columns = [
    'id', 'title', 'description', 'location', 'remote', 'employment_type',
    'seniority', 'url', 'source', 'is_active', 'ghost_score', 'posted_at',
    'last_checked_at', 'compensation_min', 'compensation_max',
    'compensation_currency', 'compensation_period', 'compensation_status',
    'metadata', 'companies(name)',
  ].join(',');
  const freshnessFloor = new Date(Date.now() - RECRUIT_TALENT_MAX_AGE_DAYS * 86_400_000).toISOString();
  const offset = (params.page - 1) * params.pageSize;

  let query = db.from('roles')
    .select(columns, { count: 'exact' })
    .eq('is_active', true)
    .lt('ghost_score', 40)
    .eq('source', 'careers_portal')
    .filter('metadata->>ats_vendor', 'in', ALLOWED_ATS)
    .gte('last_checked_at', freshnessFloor)
    .not('url', 'is', null)
    .order('last_checked_at', { ascending: false });
  if (params.query) query = query.ilike('title', `%${params.query}%`);
  if (params.location) query = query.ilike('location', `%${params.location}%`);
  if (params.remote !== undefined) query = query.eq('remote', params.remote);

  const { data, count, error } = await query.range(offset, offset + params.pageSize - 1);
  if (error) {
    // Do not expose database error details or config to the third-party caller.
    console.error('recruit_talent_feed_query_failed', error.code ?? 'unknown');
    return NextResponse.json({ error: 'job_feed_query_failed' }, { status: 502, headers: HEADERS });
  }
  const jobs = (data ?? []).map(row => mapVerifiedRole(row as unknown as FeedRoleRow))
    .filter((job): job is NonNullable<typeof job> => job !== null);

  return NextResponse.json({
    jobs,
    pagination: { page: params.page, pageSize: params.pageSize, returned: jobs.length, totalCandidateRows: count ?? 0 },
    asOf: new Date().toISOString(),
    source: 'TalentGrid',
    notice: 'External employer postings. Not represented by the recruiter. Verify availability at the employer link.',
  }, { status: 200, headers: HEADERS });
}
