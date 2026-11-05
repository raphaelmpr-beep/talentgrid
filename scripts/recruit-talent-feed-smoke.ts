import assert from 'node:assert/strict';
import { mapVerifiedRole, parseFeedParams, type FeedRoleRow } from '../lib/integrations/recruit-talent-feed';

const now = new Date('2026-11-04T20:00:00.000Z');
const valid: FeedRoleRow = {
  id: 'job-1', title: 'Cybersecurity Analyst', description: 'Risk and security responsibilities',
  location: 'Washington, DC', remote: true, employment_type: 'Full-time', seniority: 'Senior',
  url: 'https://jobs.example.com/openings/123', source: 'careers_portal',
  is_active: true, ghost_score: 12, posted_at: '2026-11-01T12:00:00.000Z',
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
assert.deepEqual(parseFeedParams(new URLSearchParams('page=2&pageSize=10&remote=true')),
  { page: 2, pageSize: 10, remote: true });
assert.equal(parseFeedParams(new URLSearchParams('pageSize=999')), null);
assert.equal(parseFeedParams(new URLSearchParams('q=%25%25%25')), null);
assert.equal(parseFeedParams(new URLSearchParams('remote=maybe')), null);
console.log('Recruit Talent feed mapping/validation smoke tests passed');
