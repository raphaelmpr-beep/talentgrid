#!/usr/bin/env tsx
// Smoke test for the open-roles validation workflow. Runs fully offline against
// stubbed fetch responses — no network, no Supabase. Exits non-zero on any
// failed assertion so it can gate CI / be run ad hoc:
//
//   npm run smoke:open-roles
//   tsx scripts/validate-open-roles-smoke.ts
//
// The headline guarantee it protects: an exact public ATS count is reported
// UNCAPPED. Pinterest's Greenhouse board reports meta.total=176; even though the
// stored title/URL sample is bounded (sample-jobs=5), active_openings_count must
// be the full 176 and count_exact must be true. This is the regression the
// "no cap on job counts" requirement guards against.

import {
  validateCompany,
  parseCli,
  summarize,
  applyDrift,
  statusFromReason,
  type Cli,
  type SeedCompany,
  type OpenRolesValidation,
  type ValidatedCompany,
} from "@/scripts/validate-open-roles";
import type { FetchLike } from "@/lib/feeds/providers/careers-portal";

let failures = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) {
    console.log(`  ok - ${msg}`);
  } else {
    failures += 1;
    console.error(`  FAIL - ${msg}`);
  }
}

const SAMPLE_SIZE = 5;
const CLI: Cli = {
  inputPath: "",
  outputPath: "",
  limit: null,
  only: null,
  concurrency: 4,
  timeoutMs: 5000,
  sampleJobs: SAMPLE_SIZE,
};

// The stable set of keys every open_roles_validation object must carry, so
// downstream tooling and the runbook can rely on the schema.
const REQUIRED_KEYS: (keyof OpenRolesValidation)[] = [
  "live_checked",
  "checked_at",
  "active_openings_count",
  "count_exact",
  "count_status",
  "validation_method",
  "source_url",
  "api_url",
  "sample_job_titles",
  "job_listing_urls",
  "http_status",
  "error",
  "talentgrid_openings_count",
  "count_delta",
  "count_match_status",
];

function assertSchema(c: ValidatedCompany, label: string): void {
  const v = c.open_roles_validation;
  assert(!!v, `${label}: has open_roles_validation`);
  for (const key of REQUIRED_KEYS) {
    assert(key in v, `${label}: output has "${String(key)}"`);
  }
  assert(Array.isArray(v.sample_job_titles), `${label}: sample_job_titles is an array`);
  assert(Array.isArray(v.job_listing_urls), `${label}: job_listing_urls is an array`);
  assert(typeof v.checked_at === "string", `${label}: checked_at is a timestamp string`);
}

async function run(): Promise<void> {
  console.log("validate-open-roles: Pinterest exact Greenhouse count is UNCAPPED");
  {
    // Pinterest-style: company-hosted careers page with gh_jid links, no slug in
    // the URL and no api_url. The provider guesses "pinterest" from the name,
    // verifies the board, then reports meta.total=176 — uncapped — while the
    // stored sample stays bounded at sample-jobs=5.
    const ghJobs = Array.from({ length: 50 }, (_, i) => ({
      id: 1000 + i,
      title: `Engineer ${i}`,
      absolute_url: `https://www.pinterestcareers.com/jobs/?gh_jid=${1000 + i}`,
      location: { name: "San Francisco, CA, US" },
    }));
    const jobsBody = JSON.stringify({ jobs: ghJobs, meta: { total: 176 } });
    const stubFetch: FetchLike = async (url) => {
      const u = String(url);
      if (u === "https://boards-api.greenhouse.io/v1/boards/pinterest") {
        return new Response(JSON.stringify({ name: "Pinterest" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (u === "https://boards-api.greenhouse.io/v1/boards/pinterest/jobs") {
        return new Response(jobsBody, { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response("not found", { status: 404 });
    };

    const company: SeedCompany = {
      company_name: "Pinterest",
      careers_url: "https://www.pinterestcareers.com/jobs/?gh_jid=1",
      job_portal_url: null,
      source_name: "manual",
      ats_slug: null,
    };
    const result = await validateCompany(company, CLI, stubFetch);
    const v = result.open_roles_validation;

    assert(v.active_openings_count === 176, `active_openings_count is the full 176 (got ${v.active_openings_count})`);
    assert(v.count_exact === true, `count_exact is true (got ${v.count_exact})`);
    assert(
      v.count_status === "counted_from_public_api_exact",
      `count_status is counted_from_public_api_exact (got ${v.count_status})`
    );
    assert(v.validation_method === "greenhouse", `validation_method is greenhouse (got ${v.validation_method})`);
    assert(
      v.sample_job_titles.length === SAMPLE_SIZE,
      `sample is bounded at ${SAMPLE_SIZE} (got ${v.sample_job_titles.length})`
    );
    assert(
      (v.active_openings_count ?? 0) > v.sample_job_titles.length,
      "count is NOT capped to the sample size (uncapped invariant)"
    );
    assert(typeof v.api_url === "string", `api_url recorded for exact source (got ${v.api_url})`);
    assertSchema(result, "Pinterest");
  }

  console.log("validate-open-roles: Workday CXS reports exact uncapped total");
  {
    const TOTAL = 250;
    const stubFetch: FetchLike = async (_url, init) => {
      const bodyIn = init?.body ? JSON.parse(String(init.body)) : {};
      const offset = Number(bodyIn.offset ?? 0);
      const pageSize = Number(bodyIn.limit ?? 100);
      const count = Math.min(pageSize, Math.max(0, TOTAL - offset));
      const jobPostings = Array.from({ length: count }, (_, i) => ({
        title: `WD Engineer ${offset + i}`,
        externalPath: `/job/${offset + i}`,
        locationsText: "Remote, US",
      }));
      return new Response(JSON.stringify({ total: TOTAL, jobPostings }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const company: SeedCompany = {
      company_name: "Workco",
      careers_url: "https://workco.wd5.myworkdayjobs.com/en-US/External",
      source_name: "workday",
    };
    const result = await validateCompany(company, CLI, stubFetch);
    const v = result.open_roles_validation;
    assert(v.active_openings_count === TOTAL, `Workday count is exact ${TOTAL} (got ${v.active_openings_count})`);
    assert(v.count_exact === true, `Workday marked exact (got ${v.count_exact})`);
    assert(v.validation_method === "workday", `validation_method is workday (got ${v.validation_method})`);
  }

  console.log("validate-open-roles: scraped HTML is a non-exact sample");
  {
    const html = `
      <html><body><ul>
        <li><a href="/careers/jobs/1-backend">Backend Engineer</a></li>
        <li><a href="/careers/jobs/2-frontend">Frontend Engineer</a></li>
        <li><a href="/careers/jobs/3-data">Data Scientist</a></li>
      </ul></body></html>`;
    const stubFetch: FetchLike = async () =>
      new Response(html, { status: 200, headers: { "content-type": "text/html" } });
    const company: SeedCompany = {
      company_name: "Acme Manual Co",
      careers_url: "https://acme.example.com/careers",
      source_name: "manual",
    };
    const result = await validateCompany(company, CLI, stubFetch);
    const v = result.open_roles_validation;
    assert(v.active_openings_count === 3, `scraped count reflects anchors (got ${v.active_openings_count})`);
    assert(v.count_exact === false, `scraped count is NOT exact (got ${v.count_exact})`);
    assert(
      v.count_status === "scraped_sample_not_exact",
      `count_status is scraped_sample_not_exact (got ${v.count_status})`
    );
    assert(v.api_url === null, "no api_url for a scraped source");
    assertSchema(result, "Acme");
  }

  console.log("validate-open-roles: captcha wall is reported, never counted");
  {
    const stubFetch: FetchLike = async () =>
      new Response("<html><body>Please verify you are human (captcha)</body></html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    const company: SeedCompany = {
      company_name: "Walled Co",
      careers_url: "https://walled.example.com/careers",
      source_name: "manual",
    };
    const result = await validateCompany(company, CLI, stubFetch);
    const v = result.open_roles_validation;
    assert(v.active_openings_count === null, "no count behind a captcha wall");
    assert(
      v.count_status === "captcha_or_bot_challenge",
      `count_status is captcha_or_bot_challenge (got ${v.count_status})`
    );
    assertSchema(result, "Walled");
  }

  console.log("validate-open-roles: HTTP error is reachable-but-not-counted");
  {
    const stubFetch: FetchLike = async () => new Response("forbidden", { status: 403 });
    const company: SeedCompany = {
      company_name: "Blocked Co",
      careers_url: "https://blocked.example.com/careers",
      source_name: "manual",
    };
    const result = await validateCompany(company, CLI, stubFetch);
    const v = result.open_roles_validation;
    assert(v.active_openings_count === null, "no count on HTTP 403");
    assert(
      v.count_status === "portal_accessible_but_roles_not_counted",
      `count_status is portal_accessible_but_roles_not_counted (got ${v.count_status})`
    );
    assert(v.http_status === 403, `http_status is 403 (got ${v.http_status})`);
  }

  console.log("validate-open-roles: missing source URL is no_source_url");
  {
    const stubFetch: FetchLike = async () => new Response("", { status: 200 });
    const company: SeedCompany = { company_name: "No Url Co", careers_url: null, job_portal_url: null };
    const result = await validateCompany(company, CLI, stubFetch);
    assert(
      result.open_roles_validation.count_status === "no_source_url",
      `count_status is no_source_url (got ${result.open_roles_validation.count_status})`
    );
  }

  console.log("validate-open-roles: drift comparison fields");
  {
    const v: OpenRolesValidation = {
      live_checked: true,
      checked_at: new Date().toISOString(),
      active_openings_count: 176,
      count_exact: true,
      count_status: "counted_from_public_api_exact",
      validation_method: "greenhouse",
      source_url: null,
      api_url: null,
      sample_job_titles: [],
      job_listing_urls: [],
      http_status: null,
      error: null,
      talentgrid_openings_count: null,
      count_delta: null,
      count_match_status: "not_compared",
    };
    // TalentGrid carries a stale 178 against a live 176 → drift of +2.
    applyDrift(v, 178);
    assert(v.count_match_status === "drift", `detects drift (got ${v.count_match_status})`);
    assert(v.count_delta === 2, `delta is talentgrid - live = 2 (got ${v.count_delta})`);

    const v2: OpenRolesValidation = { ...v, count_delta: null, count_match_status: "not_compared" };
    applyDrift(v2, 176);
    assert(v2.count_match_status === "match", `equal counts match (got ${v2.count_match_status})`);

    const v3: OpenRolesValidation = { ...v, count_delta: null, count_match_status: "not_compared" };
    applyDrift(v3, null);
    assert(v3.count_match_status === "talentgrid_missing", `null TG count → talentgrid_missing (got ${v3.count_match_status})`);
  }

  console.log("validate-open-roles: CLI + helpers");
  {
    const cli = parseCli(["seed.json", "out.json", "--limit=10", "--concurrency=8", "--only=Pinterest"]);
    assert(cli.inputPath === "seed.json", "parses positional input path");
    assert(cli.outputPath === "out.json", "parses positional output path");
    assert(cli.limit === 10, `parses --limit (got ${cli.limit})`);
    assert(cli.concurrency === 8, `parses --concurrency (got ${cli.concurrency})`);
    assert(cli.only === "Pinterest", `parses --only (got ${cli.only})`);

    assert(statusFromReason("captcha_or_bot_challenge") === "captcha_or_bot_challenge", "maps captcha reason");
    assert(statusFromReason("js_only_portal") === "portal_accessible_but_roles_not_counted", "maps js_only reason");
    assert(statusFromReason("timeout") === "validation_failed", "maps timeout reason");
    assert(statusFromReason("http_404") === "portal_accessible_but_roles_not_counted", "maps http_404 reason");

    const summary = summarize([
      { open_roles_validation: { count_status: "counted_from_public_api_exact", count_exact: true, count_match_status: "drift" } },
      { open_roles_validation: { count_status: "scraped_sample_not_exact", count_exact: false, count_match_status: "match" } },
    ] as unknown as ValidatedCompany[]);
    assert(summary.by_status.counted_from_public_api_exact === 1, "summary tallies exact status");
    assert(summary.exact_counts === 1, "summary counts exact totals");
    assert(summary.drift_detected === 1, "summary counts drift");
  }
}

run()
  .then(() => {
    if (failures > 0) {
      console.error(`\n${failures} assertion(s) failed`);
      process.exit(1);
    }
    console.log("\nAll open-roles validation smoke assertions passed.");
  })
  .catch((err) => {
    console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
    process.exit(1);
  });
