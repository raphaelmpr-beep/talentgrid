# TalentGrid → Recruit Talent read-only job feed

This integration returns a bounded subset of recent, active, employer-direct ATS job listings already held in TalentGrid. It does **not** import candidates, expose TalentGrid's company intelligence or mutate data. It does not establish any legal right to redistribute employer job descriptions; review commercial-use terms before launch.

## Endpoint

`GET /api/integrations/recruit-talent/jobs`

Authentication: `Authorization: Bearer <RECRUIT_TALENT_FEED_TOKEN>` (server-to-server only). A missing/short token disables the endpoint with 503. Never call it directly from browser JavaScript or set this secret as `NEXT_PUBLIC_*`.

Supported optional query parameters: `q` (job title), `location`, `remote=true|false`, `page=1..20`, and `pageSize=1..25`.

Response: `{jobs, pagination, asOf, source, notice}`. Each result includes id, title, employer, location, remote status, employment type, seniority, up to 650 characters of job-description excerpt, compensation only when evidenced, dates, exact ATS source, and original HTTPS posting URL. `recruiterRepresented` is always `false` for external results.

Only `careers_portal` roles with vetted ATS vendors (Greenhouse, Lever, Ashby, Workday), `is_active=true`, ghost score below 40, and `last_checked_at` within 30 days are returned. No synthetic fallback jobs or inferred salaries.

## Configuration

Set the same random, high-entropy **minimum 32-character** `RECRUIT_TALENT_FEED_TOKEN` as a **server-only** environment variable in TalentGrid and in the Recruit Talent Vercel project. Do not reuse TalentGrid's feed-admin, cron or Supabase keys. Ensure TalentGrid's Supabase server configuration is already functional. Rotate the token if compromised.

For a static Recruit Talent website, add the accompanying `api/jobs.mjs` server-side proxy to its repository. Browser calls its own `/api/jobs`, never TalentGrid directly. Set `TALENTGRID_FEED_URL` in Recruit Talent to the exact HTTPS base URL of the TalentGrid deployment and its feed token on the **server only**.

## Verification on a reviewed non-production deployment

1. With no `RECRUIT_TALENT_FEED_TOKEN`, GET should return 503.
2. With a wrong/empty Authorization header, GET should return 401.
3. With the correct secret, GET should return only verified, recent, active ATS jobs with legitimate HTTPS original URLs.
4. Confirm no metadata, raw vendor payloads, Supabase keys, contacts, or candidates appear in the response.
5. Confirm original employer application URLs work. Check that no source violates redistribution terms.
6. If feed is empty, inspect TalentGrid ingestion freshness and source validation. Do not fabricate jobs.

## Development / testing

Run `npx tsx scripts/recruit-talent-feed-smoke.ts` or `npm exec -- tsx scripts/recruit-talent-feed-smoke.ts`. Run `npm run typecheck`, `npm run lint`, and relevant existing TalentGrid smoke tests before merging.

The feed mapping tests are offline and do not require database credentials. Do not merge unless CI and a manual sandbox endpoint test pass. This integration does not deploy itself or configure production secrets.
