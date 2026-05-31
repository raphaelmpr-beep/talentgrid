#!/usr/bin/env tsx
// Smoke test for the careers-portal HTML extractor. Runs fully offline against
// static fixtures — no network, no Supabase. Exits non-zero on any failed
// assertion so it can gate CI / be run ad hoc:
//
//   npm run smoke:careers-portal
//   tsx scripts/careers-portal-smoke.ts

import {
  extractJobsFromHtml,
  fetchCareersPortalJobs,
  type FetchLike,
} from "@/lib/feeds/providers/careers-portal";

let failures = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) {
    console.log(`  ok - ${msg}`);
  } else {
    failures += 1;
    console.error(`  FAIL - ${msg}`);
  }
}

const BASE = "https://acme.example.com/careers";

// Fixture 1: plain anchor list (the common case).
const ANCHOR_HTML = `
<html><body>
  <nav><a href="/about">About</a><a href="#top">Top</a></nav>
  <ul class="jobs">
    <li><a href="/careers/jobs/123-senior-backend-engineer">Senior Backend Engineer</a></li>
    <li><a href="/careers/jobs/124-frontend-engineer">Frontend Engineer</a></li>
    <li><a href="/jobs/125-data-scientist">Data Scientist</a></li>
    <li><a href="/careers/jobs/123-senior-backend-engineer">Senior Backend Engineer</a></li>
    <li><a href="/marketing">Marketing landing page</a></li>
    <li><a href="/careers/jobs/126">Apply</a></li>
  </ul>
</body></html>`;

// Fixture 2: JSON-LD structured JobPosting blocks.
const JSONLD_HTML = `
<html><head>
<script type="application/ld+json">
{ "@type": "JobPosting", "title": "Staff ML Engineer",
  "url": "https://acme.example.com/careers/jobs/900",
  "jobLocation": { "address": { "addressLocality": "Austin", "addressRegion": "TX", "addressCountry": "US" } } }
</script>
<script type="application/ld+json">
{ "@context": "https://schema.org", "@graph": [
  { "@type": "JobPosting", "title": "Product Designer", "url": "/careers/jobs/901" }
] }
</script>
</head><body><div id="root"></div></body></html>`;

// Fixture 3: JS-only SPA shell (should be detected as unscrapable).
const SPA_HTML = `<html><body><div id="__next"></div><script src="/bundle.js"></script></body></html>`;

console.log("extractJobsFromHtml: anchor extraction");
{
  const jobs = extractJobsFromHtml(ANCHOR_HTML, BASE);
  const titles = jobs.map((j) => j.title);
  assert(jobs.length === 3, `extracts 3 unique jobs (got ${jobs.length}: ${titles.join(", ")})`);
  assert(titles.includes("Senior Backend Engineer"), "includes Senior Backend Engineer");
  assert(titles.includes("Frontend Engineer"), "includes Frontend Engineer");
  assert(titles.includes("Data Scientist"), "includes Data Scientist");
  assert(!titles.includes("Marketing landing page"), "excludes non-job nav link");
  assert(!titles.includes("Apply"), "excludes generic 'Apply' anchor text");
  assert(
    jobs.every((j) => j.url?.startsWith("https://acme.example.com/")),
    "resolves relative hrefs to absolute URLs"
  );
  const first = jobs[0];
  assert(
    extractJobsFromHtml(ANCHOR_HTML, BASE)[0].external_id === first.external_id,
    "external_id is stable across runs"
  );
}

console.log("extractJobsFromHtml: role/domain filters");
{
  const backendOnly = extractJobsFromHtml(ANCHOR_HTML, BASE, { roleFilters: ["backend"] });
  assert(backendOnly.length === 1, `role filter narrows to 1 (got ${backendOnly.length})`);
  assert(backendOnly[0]?.title === "Senior Backend Engineer", "role filter keeps the right job");

  const capped = extractJobsFromHtml(ANCHOR_HTML, BASE, { maxJobs: 2 });
  assert(capped.length === 2, `maxJobs caps result count (got ${capped.length})`);
}

console.log("extractJobsFromHtml: JSON-LD structured data");
{
  const jobs = extractJobsFromHtml(JSONLD_HTML, BASE);
  const titles = jobs.map((j) => j.title);
  assert(titles.includes("Staff ML Engineer"), "extracts top-level JobPosting");
  assert(titles.includes("Product Designer"), "extracts JobPosting nested in @graph");
  const ml = jobs.find((j) => j.title === "Staff ML Engineer");
  assert(ml?.location === "Austin, TX, US", `parses structured location (got ${ml?.location})`);
}

async function runFetchAssertions(): Promise<void> {
  console.log("fetchCareersPortalJobs: end-to-end with stub fetch");
  {
    const stubFetch: FetchLike = async () =>
      new Response(ANCHOR_HTML, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    const result = await fetchCareersPortalJobs(
      { companyName: "Acme", careersUrl: BASE },
      { fetch: stubFetch }
    );
    assert(result.jobs.length === 3, `fetch path returns 3 jobs (got ${result.jobs.length})`);
    assert(result.fetchedUrl === BASE, "reports the fetched URL");
  }

  console.log("fetchCareersPortalJobs: JS-only SPA fails closed");
  {
    const stubFetch: FetchLike = async () =>
      new Response(SPA_HTML, { status: 200, headers: { "content-type": "text/html" } });
    const result = await fetchCareersPortalJobs(
      { companyName: "Acme", careersUrl: BASE },
      { fetch: stubFetch }
    );
    assert(result.jobs.length === 0, "no jobs from a JS-only shell");
    assert(result.reason === "js_only_portal", `reports js_only_portal (got ${result.reason})`);
  }

  console.log("fetchCareersPortalJobs: blocked/error fails closed");
  {
    const stubFetch: FetchLike = async () => new Response("forbidden", { status: 403 });
    const result = await fetchCareersPortalJobs(
      { companyName: "Acme", careersUrl: BASE },
      { fetch: stubFetch }
    );
    assert(result.jobs.length === 0, "no jobs on HTTP 403");
    assert(result.reason === "http_403", `reports http_403 (got ${result.reason})`);
  }

  console.log("fetchCareersPortalJobs: JSON listing endpoint");
  {
    const json = JSON.stringify({
      jobs: [
        { title: "Cloud Engineer", absolute_url: "https://acme.example.com/jobs/1", location: "Remote" },
        { title: "QA Lead", absolute_url: "https://acme.example.com/jobs/2" },
      ],
    });
    const stubFetch: FetchLike = async () =>
      new Response(json, { status: 200, headers: { "content-type": "application/json" } });
    const result = await fetchCareersPortalJobs(
      { companyName: "Acme", careersUrl: "https://acme.example.com/api/jobs" },
      { fetch: stubFetch }
    );
    assert(result.jobs.length === 2, `parses JSON listing (got ${result.jobs.length})`);
    assert(
      result.jobs.find((j) => j.title === "Cloud Engineer")?.location === "Remote",
      "carries JSON location through"
    );
  }

  console.log("fetchCareersPortalJobs: Greenhouse board API by ats_type/ats_slug");
  {
    // Simulates the Pinterest case: a JS-only careers page, but the ATS board
    // API returns the full inventory and an exact meta.total.
    const ghJobs = Array.from({ length: 50 }, (_, i) => ({
      id: 1000 + i,
      title: `Engineer ${i}`,
      absolute_url: `https://www.pinterestcareers.com/jobs/?gh_jid=${1000 + i}`,
      location: { name: "San Francisco, CA, US" },
    }));
    const body = JSON.stringify({ jobs: ghJobs, meta: { total: 176 } });
    let calledUrl = "";
    const stubFetch: FetchLike = async (url) => {
      calledUrl = String(url);
      return new Response(body, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const result = await fetchCareersPortalJobs(
      {
        companyName: "Pinterest",
        careersUrl: "https://www.pinterestcareers.com/jobs/",
        atsType: "greenhouse",
        atsSlug: "pinterest",
      },
      { fetch: stubFetch }
    );
    assert(
      calledUrl === "https://boards-api.greenhouse.io/v1/boards/pinterest/jobs",
      `hits the Greenhouse board API (got ${calledUrl})`
    );
    assert(result.source === "greenhouse", `reports greenhouse source (got ${result.source})`);
    assert(result.totalCount === 176, `totalCount is the live inventory 176 (got ${result.totalCount})`);
    assert(result.jobs.length === 20, `caps stored jobs at maxJobs default 20 (got ${result.jobs.length})`);
  }

  console.log("fetchCareersPortalJobs: Greenhouse slug sniffed from boards URL");
  {
    const body = JSON.stringify({
      jobs: [{ id: 1, title: "Staff Engineer", absolute_url: "https://boards.greenhouse.io/acme/jobs/1" }],
      meta: { total: 1 },
    });
    let calledUrl = "";
    const stubFetch: FetchLike = async (url) => {
      calledUrl = String(url);
      return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
    };
    const result = await fetchCareersPortalJobs(
      { companyName: "Acme", careersUrl: "https://boards.greenhouse.io/acme" },
      { fetch: stubFetch }
    );
    assert(
      calledUrl === "https://boards-api.greenhouse.io/v1/boards/acme/jobs",
      `derives board slug from boards.greenhouse.io URL (got ${calledUrl})`
    );
    assert(result.totalCount === 1, `reports total from sniffed board (got ${result.totalCount})`);
  }

  console.log("fetchCareersPortalJobs: Lever board API");
  {
    const body = JSON.stringify([
      { text: "Backend Engineer", hostedUrl: "https://jobs.lever.co/acme/1", categories: { location: "Remote" } },
      { text: "Designer", hostedUrl: "https://jobs.lever.co/acme/2", categories: { location: "NYC" } },
    ]);
    let calledUrl = "";
    const stubFetch: FetchLike = async (url) => {
      calledUrl = String(url);
      return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
    };
    const result = await fetchCareersPortalJobs(
      { companyName: "Acme", careersUrl: "https://jobs.lever.co/acme", atsType: "lever", atsSlug: "acme" },
      { fetch: stubFetch }
    );
    assert(
      calledUrl === "https://api.lever.co/v0/postings/acme?mode=json",
      `hits the Lever board API (got ${calledUrl})`
    );
    assert(result.source === "lever", `reports lever source (got ${result.source})`);
    assert(result.totalCount === 2, `reports Lever total (got ${result.totalCount})`);
    assert(
      result.jobs.find((j) => j.title === "Backend Engineer")?.location === "Remote",
      "carries Lever category location through"
    );
  }

  console.log("fetchCareersPortalJobs: Greenhouse slug guessed from gh_jid careers URL");
  {
    // Pinterest-style: company-hosted careers page with gh_jid links, no slug in
    // the URL and no ats hints. The provider guesses "pinterest" from the name
    // and verifies the board before trusting its total.
    const jobsBody = JSON.stringify({
      jobs: [
        { id: 1, title: "ML Engineer", absolute_url: "https://www.pinterestcareers.com/jobs/?gh_jid=1", location: { name: "SF" } },
      ],
      meta: { total: 176 },
    });
    const stubFetch: FetchLike = async (url) => {
      const u = String(url);
      // Board-exists verification probe.
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
    const result = await fetchCareersPortalJobs(
      { companyName: "Pinterest", careersUrl: "https://www.pinterestcareers.com/jobs/?gh_jid=1" },
      { fetch: stubFetch }
    );
    assert(result.source === "greenhouse", `resolves greenhouse via name guess (got ${result.source})`);
    assert(result.totalCount === 176, `reports verified live total 176 (got ${result.totalCount})`);
  }

  console.log("fetchCareersPortalJobs: wrong slug guess is not trusted");
  {
    // gh_jid present but the guessed board does not exist → no fabricated count.
    const stubFetch: FetchLike = async (url) => {
      const u = String(url);
      if (u.includes("/jobs") === false && u.includes("boards-api.greenhouse.io")) {
        return new Response("not found", { status: 404 }); // board-exists probe fails
      }
      return new Response("<html><body><div id='__next'></div></body></html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    };
    const result = await fetchCareersPortalJobs(
      { companyName: "Obscurecorp", careersUrl: "https://careers.obscurecorp.com/?gh_jid=9" },
      { fetch: stubFetch }
    );
    assert(result.totalCount === 0, `no count when board guess unverified (got ${result.totalCount})`);
    assert(result.source !== "greenhouse", `does not claim greenhouse source (got ${result.source})`);
  }

  console.log("fetchCareersPortalJobs: Workday CXS board paged to exact total");
  {
    // Workday's public CXS endpoint paginates: each POST returns `total` (the
    // exact live inventory) plus up to `limit` postings. The provider must page
    // through offset to the total and report the exact count, capping stored rows
    // at maxJobs. Simulate a 250-posting board over 3 pages.
    const TOTAL = 250;
    const calls: string[] = [];
    const stubFetch: FetchLike = async (url, init) => {
      calls.push(String(url));
      const bodyIn = init?.body ? JSON.parse(String(init.body)) : {};
      const offset = Number(bodyIn.offset ?? 0);
      const pageSize = Number(bodyIn.limit ?? 100);
      const remaining = Math.max(0, TOTAL - offset);
      const count = Math.min(pageSize, remaining);
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
    const result = await fetchCareersPortalJobs(
      {
        companyName: "Workco",
        careersUrl: "https://workco.wd5.myworkdayjobs.com/en-US/External",
        maxJobs: 50,
      },
      { fetch: stubFetch }
    );
    assert(result.source === "workday", `reports workday source (got ${result.source})`);
    assert(
      calls[0] === "https://workco.wd5.myworkdayjobs.com/wday/cxs/workco/External/jobs",
      `derives the CXS endpoint (got ${calls[0]})`
    );
    assert(result.totalCount === TOTAL, `reports exact live total ${TOTAL} (got ${result.totalCount})`);
    assert(result.countExact === true, `marks workday count exact (got ${result.countExact})`);
    assert(result.jobs.length === 50, `caps stored jobs at maxJobs 50 (got ${result.jobs.length})`);
    assert(calls.length >= 3, `pages through the board (got ${calls.length} calls)`);
    assert(
      result.jobs[0]?.url === "https://workco.wd5.myworkdayjobs.com/job/0",
      `resolves externalPath to absolute URL (got ${result.jobs[0]?.url})`
    );
  }

  console.log("fetchCareersPortalJobs: scraped HTML count is marked non-exact");
  {
    const stubFetch: FetchLike = async () =>
      new Response(ANCHOR_HTML, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    const result = await fetchCareersPortalJobs(
      { companyName: "Acme", careersUrl: BASE },
      { fetch: stubFetch }
    );
    assert(result.source === "html", `html source (got ${result.source})`);
    assert(
      result.countExact === false,
      `HTML scrape count is NOT marked exact (got ${result.countExact})`
    );
  }

  console.log("fetchCareersPortalJobs: ATS failure falls back to HTML scrape");
  {
    // Greenhouse API 404s, but the careers page is plain HTML with anchors.
    const stubFetch: FetchLike = async (url) => {
      if (String(url).includes("boards-api.greenhouse.io")) {
        return new Response("not found", { status: 404 });
      }
      return new Response(ANCHOR_HTML, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    };
    const result = await fetchCareersPortalJobs(
      { companyName: "Acme", careersUrl: BASE, atsType: "greenhouse", atsSlug: "acme" },
      { fetch: stubFetch }
    );
    assert(result.source === "html", `falls back to html scrape (got ${result.source})`);
    assert(result.jobs.length === 3, `recovers anchor jobs on fallback (got ${result.jobs.length})`);
    assert(result.totalCount === 3, `totalCount mirrors scraped count (got ${result.totalCount})`);
  }
}

runFetchAssertions()
  .then(() => {
    if (failures > 0) {
      console.error(`\n${failures} assertion(s) failed`);
      process.exit(1);
    }
    console.log("\nAll careers-portal smoke assertions passed.");
  })
  .catch((err) => {
    console.error(err instanceof Error ? err.stack ?? err.message : String(err));
    process.exit(1);
  });
