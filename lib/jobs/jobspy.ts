type RawJobSpyJob = {
  id?: string | number;
  title?: string | null;
  company?: string | null;
  location?: string | null;
  description?: string | null;
};

export type JobSpyNormalizedJob = {
  id: string;
  title: string;
  company: string;
  location?: string | null;
  description: string;
  roles: string[];
  roleKeys: string[];
  domains: string[];
  domainKeys: string[];
  source: "jobspy";
};

type CacheEntry = {
  expiresAt: number;
  jobs: JobSpyNormalizedJob[];
};

const CACHE_TTL_MS = 10 * 60 * 1000;
const jobSpyCache = new Map<string, CacheEntry>();

function normalizeSpace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function mapRoleKeys(title: string): string[] {
  const t = title.toLowerCase();
  if (t.includes("backend") || t.includes("back-end") || t.includes("back end")) {
    return ["backend"];
  }
  if (t.includes("frontend") || t.includes("front-end") || t.includes("front end")) {
    return ["frontend"];
  }
  if (t.includes("fullstack") || t.includes("full-stack") || t.includes("full stack")) {
    return ["fullstack"];
  }
  if (t.includes("devops") || t.includes("dev-ops") || t.includes("sre")) {
    return ["devops"];
  }
  if (t.includes("data")) return ["data"];
  if (t.includes("ml") || t.includes("ai") || t.includes("machine learning")) {
    return ["ml"];
  }
  return ["engineer"];
}

function mapRoles(title: string): string[] {
  const key = mapRoleKeys(title)[0];
  switch (key) {
    case "backend":
      return ["Backend"];
    case "frontend":
      return ["Frontend"];
    case "fullstack":
      return ["Full Stack"];
    case "devops":
      return ["DevOps/SRE"];
    case "data":
      return ["Data"];
    case "ml":
      return ["ML/AI"];
    default:
      return ["Software Engineer"];
  }
}

function mapDomainKeys(text: string): string[] {
  const t = text.toLowerCase();
  const keys = new Set<string>();

  if (t.includes("hr") || t.includes("recruit") || t.includes("talent")) {
    keys.add("hr");
  }
  if (t.includes("sales") || t.includes("crm") || t.includes("account executive")) {
    keys.add("sales");
  }
  if (t.includes("drone") || t.includes("robot") || t.includes("robotics")) {
    keys.add("robotics");
  }
  if (t.includes("finance") || t.includes("fintech") || t.includes("bank")) {
    keys.add("finance");
  }
  if (t.includes("health") || t.includes("medical") || t.includes("clinical")) {
    keys.add("healthcare");
  }
  if (t.includes("ai") || t.includes("ml") || t.includes("machine learning")) {
    keys.add("ai");
  }

  return Array.from(keys);
}

function mapDomains(text: string): string[] {
  const labels = new Map<string, string>([
    ["hr", "Human Resources"],
    ["sales", "Sales"],
    ["robotics", "Robotics"],
    ["finance", "Finance"],
    ["healthcare", "Healthcare"],
    ["ai", "AI"],
  ]);

  const keys = mapDomainKeys(text);
  if (keys.length === 0) return ["General"];
  return keys.map((k) => labels.get(k) ?? "General");
}

function normalizeJobSpyJob(raw: RawJobSpyJob): JobSpyNormalizedJob | null {
  const company = typeof raw.company === "string" ? normalizeSpace(raw.company) : "";
  const title = typeof raw.title === "string" ? normalizeSpace(raw.title) : "";
  if (!company || !title) return null;

  const description =
    typeof raw.description === "string" ? normalizeSpace(raw.description) : "";
  const classifierText = `${title} ${description}`;
  const roleKeys = mapRoleKeys(classifierText);
  const domainKeys = mapDomainKeys(classifierText);

  return {
    id: `jobspy-${String(raw.id ?? `${company}-${title}`)}`,
    title,
    company,
    location: raw.location ?? null,
    description,
    roles: mapRoles(classifierText),
    roleKeys,
    domains: mapDomains(classifierText),
    domainKeys,
    source: "jobspy",
  };
}

async function fetchRawJobSpyJobs(query: string): Promise<RawJobSpyJob[]> {
  const endpoint = process.env.JOBSPY_ENDPOINT;
  if (!endpoint) return [];

  const url = new URL(endpoint);
  url.searchParams.set("query", query);

  const res = await fetch(url.toString(), {
    method: "GET",
    headers: { Accept: "application/json" },
    cache: "no-store",
  });

  if (!res.ok) {
    throw new Error(`JobSpy endpoint failed: ${res.status}`);
  }

  const data = await res.json();
  return Array.isArray(data) ? (data as RawJobSpyJob[]) : [];
}

export async function fetchJobSpyJobs(query: string): Promise<JobSpyNormalizedJob[]> {
  const key = query.trim().toLowerCase();
  if (!key) return [];

  const existing = jobSpyCache.get(key);
  const now = Date.now();
  if (existing && existing.expiresAt > now) {
    return existing.jobs;
  }

  try {
    const rawJobs = await fetchRawJobSpyJobs(key);
    const jobs = rawJobs
      .map((raw) => normalizeJobSpyJob(raw))
      .filter((job): job is JobSpyNormalizedJob => job !== null);

    jobSpyCache.set(key, {
      expiresAt: now + CACHE_TTL_MS,
      jobs,
    });

    return jobs;
  } catch {
    return [];
  }
}
