import assert from 'node:assert/strict';
import {
  mapVerifiedRole,
  parseFeedParams,
  RECRUIT_TALENT_SECONDARY_SORT,
  type FeedRoleRow,
} from '../lib/integrations/recruit-talent-feed';

const now = new Date('2026-11-04T20:00:00.000Z');
const valid: FeedRoleRow = {
  id: 'job-1', title: 'Cybersecurity Analyst', description: 'Risk and security responsibilities',
  location: 'Washington, DC', remote: true, employment_type: 'Full-time', seniority: 'Senior',
  url: 'https://jobs.example.com/openings/123', source: 'careers_portal',
  is_active: true, ghost_score: 12, posted_at: '2026-11-01T12:00:00.000Z',
  posted_status: 'exact', discovered_at: '2026-10-31T12:00:00.000Z',
  last_checked_at: '2026-11-03T12:00:00.000Z',
  compensation_min: '125000', compensation_max: '145000', compensation_currency: 'USD',
  compensation_period: 'year', compensation_status: 'exact_range',
  metadata: { ats_vendor: 'greenhouse', raw_data: { internal_email: 'not-for-output@example.com' } },
  companies: { name: 'Example Employer' },
};
const mapped = mapVerifiedRole(valid, now);
assert(mapped);
assert.equal(mapped.employer, 'Example Employer');
assert.equal(mapped.source, 'greenhouse');
assert.equal(mapped.compensation?.min, 125000);
assert.equal(mapped.postedAt, valid.posted_at);
assert.equal(mapped.postedDateType, 'employer_confirmed');
assert.equal(mapped.firstSeenAt, null);
assert(!JSON.stringify(mapped).includes('not-for-output'));
assert(!JSON.stringify(mapped).includes('raw_data'));
assert.equal(mapped.recruiterRepresented, false);
assert.equal(mapVerifiedRole({ ...valid, source: 'theirstack' }, now), null);
assert.equal(mapVerifiedRole({ ...valid, metadata: { ats_vendor: 'html' } }, now), null);
assert.equal(mapVerifiedRole({ ...valid, last_checked_at: '2026-09-01T00:00:00.000Z' }, now), null);
assert.equal(mapVerifiedRole({ ...valid, url: 'http://malicious.example/jobs' }, now), null);
assert.equal(mapVerifiedRole({ ...valid, is_active: false }, now), null);
assert.equal(mapVerifiedRole({ ...valid, ghost_score: 40 }, now), null);
assert.equal(mapVerifiedRole({ ...valid, companies: null }, now), null);
const inferred = mapVerifiedRole({
  ...valid,
  posted_at: valid.discovered_at,
  posted_status: 'inferred_from_discovered_at',
}, now);
assert(inferred);
assert.equal(inferred.postedAt, null);
assert.equal(inferred.postedDateType, 'first_seen');
assert.equal(inferred.firstSeenAt, valid.discovered_at);
const unavailableDate = mapVerifiedRole({
  ...valid,
  posted_at: null,
  posted_status: 'unavailable',
}, now);
assert(unavailableDate);
assert.equal(unavailableDate.postedAt, null);
assert.equal(unavailableDate.postedDateType, 'unavailable');
assert.deepEqual(parseFeedParams(new URLSearchParams('page=2&pageSize=10&remote=true')),
  { page: 2, pageSize: 10, remote: true });
assert.equal(parseFeedParams(new URLSearchParams('pageSize=999')), null);
assert.equal(parseFeedParams(new URLSearchParams('q=%25%25%25')), null);
assert.equal(parseFeedParams(new URLSearchParams('remote=maybe')), null);

class OrderedRows {
  private readonly rows: Array<{ id: string; last_checked_at: string }>;
  private readonly orderBy: Array<{ column: string; ascending: boolean }> = [];

  constructor(rows: Array<{ id: string; last_checked_at: string }>) {
    this.rows = rows;
  }

  order(column: string, options: { ascending: boolean }): this {
    this.orderBy.push({ column, ascending: options.ascending });
    return this;
  }

  page(from: number, to: number) {
    const sorted = [...this.rows].sort((a, b) => {
      for (const { column, ascending } of this.orderBy) {
        const left = a[column as keyof typeof a];
        const right = b[column as keyof typeof b];
        const comparison = String(left).localeCompare(String(right));
        if (comparison) return ascending ? comparison : -comparison;
      }
      return 0;
    });
    return sorted.slice(from, to);
  }
}

const sameCheckTime = '2026-11-03T12:00:00.000Z';
const rows = ['job-d', 'job-a', 'job-c', 'job-b', 'job-e']
  .map(id => ({ id, last_checked_at: sameCheckTime }));
const ordered = new OrderedRows(rows)
  .order('last_checked_at', { ascending: false })
  .order(RECRUIT_TALENT_SECONDARY_SORT, { ascending: true });
assert.deepEqual(ordered.page(0, 2).map(row => row.id), ['job-a', 'job-b']);
assert.deepEqual(ordered.page(2, 4).map(row => row.id), ['job-c', 'job-d']);
assert.deepEqual(ordered.page(4, 6).map(row => row.id), ['job-e']);
console.log('Recruit Talent feed mapping/validation smoke tests passed');
