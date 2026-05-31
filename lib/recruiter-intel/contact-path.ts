// Recruiter Intel: pure, dependency-free helpers that route a job opening to a
// likely recruiting contact path and build manual search links for it.
//
// COMPLIANCE: these functions never scrape, automate, or call any third-party /
// enrichment API. getContactPath only classifies a title into a recruiting team
// label; getRecruiterSearchLinks only assembles public search-engine URLs the
// user opens themselves in a new tab. No exact recruiter is ever asserted — the
// label is a "likely path", and any saved contact defaults to manual review.

export type ConfidenceLevel = "high" | "medium" | "low";

export type ContactPath = {
  contact_path_label: string;
  likely_department: string;
  likely_contact_types: string[];
  confidence_level: ConfidenceLevel;
};

export type ContactPathInput = {
  title?: string | null;
  role_category?: string | null;
  domain_category?: string | null;
  department?: string | null;
  company_name?: string | null;
  location?: string | null;
};

// Each rule matches against the combined title + category + department text.
// Order matters: the first matching rule wins, so the more specific buckets
// (AI/ML, university, security) are listed before the broad engineering bucket.
type Rule = {
  test: RegExp;
  label: string;
  department: string;
  contactTypes: string[];
  confidence: ConfidenceLevel;
};

const RULES: Rule[] = [
  {
    test: /forward[\s-]?deployed|solutions?\s+engineer|field\s+engineer/,
    label: "Technical Recruiter / Field Engineering",
    department: "Field / Solutions Engineering",
    contactTypes: ["Technical Recruiter", "Engineering Manager"],
    confidence: "medium",
  },
  {
    test: /intern|new\s+grad|university|campus|early\s+career/,
    label: "University Recruiter",
    department: "Early Career / University",
    contactTypes: ["University Recruiter", "Campus Recruiter"],
    confidence: "high",
  },
  {
    test: /ai\s+engineer|ml\s+engineer|machine\s+learning|data\s+scien|deep\s+learning|\bnlp\b|computer\s+vision|\bai\/ml\b/,
    label: "AI / Engineering Recruiter",
    department: "AI / Machine Learning",
    contactTypes: ["Technical Recruiter", "AI Recruiter"],
    confidence: "high",
  },
  {
    test: /data\s+engineer|analytics\s+engineer|data\s+analyst/,
    label: "Data / Platform Recruiter",
    department: "Data / Platform",
    contactTypes: ["Technical Recruiter", "Data Recruiter"],
    confidence: "high",
  },
  {
    test: /devops|dev[\s-]?ops|\bsre\b|site\s+reliability|infrastructure|platform\s+eng|\bcloud\b/,
    label: "Infrastructure / Cloud Recruiter",
    department: "Infrastructure / Cloud",
    contactTypes: ["Technical Recruiter", "Infrastructure Recruiter"],
    confidence: "high",
  },
  {
    test: /cyber\s?security|security\s+engineer|\bgrc\b|\bsoc\b|appsec|infosec/,
    label: "Security Recruiter",
    department: "Security",
    contactTypes: ["Technical Recruiter", "Security Recruiter"],
    confidence: "high",
  },
  {
    test: /software\s+engineer|backend|back[\s-]?end|frontend|front[\s-]?end|full[\s-]?stack/,
    label: "Engineering Recruiter",
    department: "Engineering",
    contactTypes: ["Technical Recruiter", "Engineering Recruiter"],
    confidence: "high",
  },
  {
    test: /product\s+manager|product\s+designer|\bux\b|\bui\b\s+designer|product\s+design/,
    label: "Product / Design Recruiter",
    department: "Product / Design",
    contactTypes: ["Product Recruiter", "Design Recruiter"],
    confidence: "high",
  },
  {
    test: /account\s+executive|\bsales\b|\bsdr\b|\bbdr\b|partnerships?/,
    label: "GTM / Sales Recruiter",
    department: "Go-To-Market / Sales",
    contactTypes: ["GTM Recruiter", "Sales Recruiter"],
    confidence: "high",
  },
  {
    test: /business\s+development|\bcapture\b|\bgrowth\b|\bstrategy\b/,
    label: "GTM / Business Development Recruiter",
    department: "Go-To-Market / Business Development",
    contactTypes: ["GTM Recruiter", "Business Development Recruiter"],
    confidence: "medium",
  },
  {
    test: /finance|account(ing|ant)|\blegal\b|compliance/,
    label: "Corporate / G&A Recruiter",
    department: "Corporate / G&A",
    contactTypes: ["Corporate Recruiter", "G&A Recruiter"],
    confidence: "medium",
  },
  {
    test: /\bhr\b|human\s+resources|\bpeople\b|talent|recruit/,
    label: "People / G&A Recruiter",
    department: "People / G&A",
    contactTypes: ["People Recruiter", "Talent Acquisition"],
    confidence: "medium",
  },
  {
    test: /manufactur|technician|operations|hardware/,
    label: "Operations / Hardware Recruiter",
    department: "Operations / Hardware",
    contactTypes: ["Operations Recruiter", "Hardware Recruiter"],
    confidence: "medium",
  },
];

const FALLBACK: ContactPath = {
  contact_path_label: "General Talent Acquisition",
  likely_department: "Talent Acquisition",
  likely_contact_types: ["Recruiter", "Talent Acquisition"],
  confidence_level: "low",
};

// Map the persisted role_category / domain_category buckets onto words the rule
// regexes recognise, so a row already classified by ingestion routes correctly
// even when its title is terse.
function categoryHints(
  roleCategory?: string | null,
  domainCategory?: string | null
): string {
  const parts: string[] = [];
  const rc = (roleCategory ?? "").toLowerCase();
  const dc = (domainCategory ?? "").toLowerCase();
  const roleWords: Record<string, string> = {
    frontend: "frontend",
    backend: "backend",
    fullstack: "full stack",
    devops: "devops",
    data: "data engineer",
    mobile: "software engineer",
    ml: "ml engineer",
    engineer: "software engineer",
  };
  const domainWords: Record<string, string> = {
    hr: "hr people",
    sales: "sales",
    finance: "finance",
    ai: "ai engineer",
  };
  if (roleWords[rc]) parts.push(roleWords[rc]);
  if (domainWords[dc]) parts.push(domainWords[dc]);
  return parts.join(" ");
}

export function getContactPath(input: ContactPathInput): ContactPath {
  const haystack = [
    input.title ?? "",
    input.department ?? "",
    categoryHints(input.role_category, input.domain_category),
  ]
    .join(" ")
    .toLowerCase();

  if (!haystack.trim()) return { ...FALLBACK };

  for (const rule of RULES) {
    if (rule.test.test(haystack)) {
      return {
        contact_path_label: rule.label,
        likely_department: rule.department,
        likely_contact_types: [...rule.contactTypes],
        confidence_level: rule.confidence,
      };
    }
  }

  return { ...FALLBACK };
}

export type RecruiterSearchLink = {
  key: string;
  label: string;
  url: string;
};

export type RecruiterSearchJob = {
  company_name?: string | null;
  company_domain?: string | null;
  job_title?: string | null;
  role_category?: string | null;
};

// Build a Google search URL for a raw query string. We only ever produce a link
// the user clicks to open in a new tab — nothing is fetched or scraped here.
function googleSearchUrl(query: string): string {
  return `https://www.google.com/search?q=${encodeURIComponent(query)}`;
}

// Assemble manual public-web search links for finding a likely recruiter or
// hiring post. Returns links only; the caller renders them as buttons that open
// in a new tab. No request is made and no LinkedIn automation is involved.
export function getRecruiterSearchLinks(
  job: RecruiterSearchJob,
  contactPath: Pick<ContactPath, "contact_path_label">
): RecruiterSearchLink[] {
  const company = (job.company_name ?? "").trim();
  const title = (job.job_title ?? "").trim();
  const roleCategory = (job.role_category ?? "").trim();
  const domain = (job.company_domain ?? "").trim();
  const label = contactPath.contact_path_label;

  const links: RecruiterSearchLink[] = [
    {
      key: "linkedin_recruiter",
      label: "LinkedIn Recruiter Search",
      url: googleSearchUrl(
        `site:linkedin.com/in "${company}" "recruiter" "${roleCategory}"`
      ),
    },
    {
      key: "linkedin_hiring_posts",
      label: "LinkedIn Hiring Posts",
      url: googleSearchUrl(
        `site:linkedin.com/posts "${company}" "${title}" "hiring"`
      ),
    },
    {
      key: "public_web",
      label: "Public Web Search",
      url: googleSearchUrl(
        `"${company}" "${title}" "recruiter" "hiring"`
      ),
    },
  ];

  // Company talent search only makes sense when we know the company domain.
  if (domain) {
    links.splice(2, 0, {
      key: "company_talent",
      label: "Company Talent Search",
      url: googleSearchUrl(`site:${domain} "recruiter" "talent acquisition"`),
    });
  }

  // A profile-search-by-path link, useful when the contact_path_label is more
  // descriptive than the bare role_category.
  links.push({
    key: "linkedin_profile",
    label: "LinkedIn Profile Search",
    url: googleSearchUrl(`site:linkedin.com/in "${company}" "${label}"`),
  });

  return links;
}
