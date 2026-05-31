#!/usr/bin/env tsx
// Offline smoke for the Recruiter Intel routing + search-link helpers.
//
// getContactPath/getRecruiterSearchLinks are pure functions, so they are fully
// testable without network or DB. This guards the product invariants that
// matter:
//   1. Each title routes to its expected recruiting contact path (the more
//      specific buckets win over the broad engineering bucket).
//   2. Unknown / empty input falls back to General Talent Acquisition at low
//      confidence — we never assert a path we can't justify.
//   3. Search links are public search-engine URLs only (no scraping), and the
//      company/title are correctly embedded in the query.

import {
  getContactPath,
  getRecruiterSearchLinks,
} from "@/lib/recruiter-intel/contact-path";

let failures = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) {
    console.log(`  ok - ${msg}`);
  } else {
    failures += 1;
    console.error(`  FAIL - ${msg}`);
  }
}

console.log("getContactPath routing");
{
  const cases: Array<{ title: string; expect: string }> = [
    { title: "Account Executive", expect: "GTM / Sales Recruiter" },
    { title: "Senior SDR", expect: "GTM / Sales Recruiter" },
    { title: "Partnerships Lead", expect: "GTM / Sales Recruiter" },
    { title: "Business Development Manager", expect: "GTM / Business Development Recruiter" },
    { title: "Capture Manager", expect: "GTM / Business Development Recruiter" },
    { title: "Software Engineer", expect: "Engineering Recruiter" },
    { title: "Backend Engineer", expect: "Engineering Recruiter" },
    { title: "Full Stack Developer", expect: "Engineering Recruiter" },
    { title: "AI Engineer", expect: "AI / Engineering Recruiter" },
    { title: "Machine Learning Engineer", expect: "AI / Engineering Recruiter" },
    { title: "Data Scientist", expect: "AI / Engineering Recruiter" },
    { title: "Data Engineer", expect: "Data / Platform Recruiter" },
    { title: "Analytics Engineer", expect: "Data / Platform Recruiter" },
    { title: "DevOps Engineer", expect: "Infrastructure / Cloud Recruiter" },
    { title: "Site Reliability Engineer", expect: "Infrastructure / Cloud Recruiter" },
    { title: "Cloud Platform Engineer", expect: "Infrastructure / Cloud Recruiter" },
    { title: "Security Engineer", expect: "Security Recruiter" },
    { title: "GRC Analyst", expect: "Security Recruiter" },
    { title: "Forward Deployed Engineer", expect: "Technical Recruiter / Field Engineering" },
    { title: "Solutions Engineer", expect: "Technical Recruiter / Field Engineering" },
    { title: "Product Manager", expect: "Product / Design Recruiter" },
    { title: "Product Designer", expect: "Product / Design Recruiter" },
    { title: "Staff Accountant", expect: "Corporate / G&A Recruiter" },
    { title: "Legal Counsel", expect: "Corporate / G&A Recruiter" },
    { title: "People Operations Partner", expect: "People / G&A Recruiter" },
    { title: "Technical Recruiter", expect: "People / G&A Recruiter" },
    { title: "Manufacturing Technician", expect: "Operations / Hardware Recruiter" },
    { title: "Hardware Operations Lead", expect: "Operations / Hardware Recruiter" },
    { title: "Software Engineering Intern", expect: "University Recruiter" },
    { title: "New Grad Engineer", expect: "University Recruiter" },
  ];
  for (const c of cases) {
    const path = getContactPath({ title: c.title });
    assert(
      path.contact_path_label === c.expect,
      `"${c.title}" → ${c.expect} (got ${path.contact_path_label})`
    );
  }
}

console.log("getContactPath fallback + confidence");
{
  const empty = getContactPath({ title: "" });
  assert(empty.contact_path_label === "General Talent Acquisition", "empty title → General TA");
  assert(empty.confidence_level === "low", "empty title → low confidence");

  const unknown = getContactPath({ title: "Chief Vibes Officer" });
  assert(unknown.contact_path_label === "General Talent Acquisition", "unknown title → General TA");

  const eng = getContactPath({ title: "Software Engineer" });
  assert(eng.confidence_level === "high", "engineering → high confidence");
  assert(eng.likely_contact_types.length > 0, "engineering has contact types");
}

console.log("getContactPath category hints");
{
  // Terse title but a persisted category should still route.
  const byCategory = getContactPath({ title: "Engineer II", role_category: "ml" });
  assert(
    byCategory.contact_path_label === "AI / Engineering Recruiter",
    `ml role_category routes to AI (got ${byCategory.contact_path_label})`
  );
}

console.log("getRecruiterSearchLinks");
{
  const path = getContactPath({ title: "AI Engineer" });
  const links = getRecruiterSearchLinks(
    {
      company_name: "Acme Corp",
      company_domain: "acme.com",
      job_title: "AI Engineer",
      role_category: "ml",
    },
    path
  );
  const byKey = Object.fromEntries(links.map((l) => [l.key, l]));
  assert(!!byKey["linkedin_recruiter"], "has LinkedIn Recruiter Search link");
  assert(!!byKey["linkedin_hiring_posts"], "has LinkedIn Hiring Posts link");
  assert(!!byKey["company_talent"], "has Company Talent Search link when domain present");
  assert(!!byKey["public_web"], "has Public Web Search link");
  assert(
    links.every((l) => l.url.startsWith("https://www.google.com/search?q=")),
    "all links are public search-engine URLs (no scraping)"
  );
  assert(
    decodeURIComponent(byKey["linkedin_recruiter"].url).includes("Acme Corp"),
    "company name embedded in recruiter query"
  );
  assert(
    decodeURIComponent(byKey["company_talent"].url).includes("site:acme.com"),
    "company domain embedded in talent query"
  );

  // No domain → no company talent link, but the rest still build.
  const noDomain = getRecruiterSearchLinks(
    { company_name: "Acme Corp", job_title: "AI Engineer", role_category: "ml" },
    path
  );
  assert(
    !noDomain.some((l) => l.key === "company_talent"),
    "omits Company Talent Search when domain absent"
  );
}

if (failures > 0) {
  console.error(`\n${failures} recruiter-intel smoke assertion(s) failed.`);
  process.exit(1);
}
console.log("\nAll recruiter-intel smoke assertions passed.");
