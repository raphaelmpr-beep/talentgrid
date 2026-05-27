export type Job = {
  id: string;
  title: string;
  company: string;
  roles: string[];
  domains: string[];
  skills: string[];
  description: string;
  location?: string | null;
  createdAt: string;
  revenueCategory?: string;
  revenue?: number | null;
  remote?: boolean | null;
  employment_type?: string | null;
  seniority?: string | null;
  salary_min?: number | null;
  salary_max?: number | null;
  url?: string | null;
  ghost_score?: number | null;
  role_family?: string | null;
  posted_at?: string | null;
};

export type RoleSummaryItem = {
  role: string;
  count: number;
};

export type CompanyMeta = {
  company: string;
  revenueCategory: string;
  revenue?: number | null;
  location?: string | null;
};

export type CompanyResult = {
  id: string;
  name: string;
  location?: string | null;
  domain?: string | null;
  industry?: string | null;
  description?: string | null;
  logo_url?: string | null;
  is_hiring: boolean;
  open_roles_count?: number;
  role_families?: Record<string, number>;
  roles?: Array<{
    id: string;
    title: string;
    location?: string | null;
    remote?: boolean | null;
    employment_type?: string | null;
    seniority?: string | null;
    salary_min?: number | null;
    salary_max?: number | null;
    url?: string | null;
    ghost_score?: number | null;
    posted_at?: string | null;
    role_family?: string | null;
  }>;
  jobCount: number;
  domains: string[];
  rolesSummary: RoleSummaryItem[];
  jobs: Job[];
  companyMeta: CompanyMeta;
  revenueCategory: string;
  revenue?: number | null;
  primaryCount?: number;
  mergedCount?: number;
  discrepancy?: number;
  jobSpyCount?: number;
  confidence?: "confirmed" | "enhanced";
  created_at: string;
};
