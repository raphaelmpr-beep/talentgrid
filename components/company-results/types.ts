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

export type CountDisplayMode =
  | "exact_source_total"
  | "filtered_matching_openings"
  | "deduped_role_rows"
  | "validation_pending"
  | "non_exact_sample_withheld"
  | "source_blocked";

export type CountDiagnostics = {
  total_source_openings: number | null;
  source_openings_exact: boolean;
  source_status: string | null;
  validation_status: "exact" | "pending" | "blocked" | "non_exact_sample" | "unknown";
  matching_openings_count: number;
  deduped_role_rows_count: number;
  count_display_mode: CountDisplayMode;
  filters_affect_counts: boolean;
  filtered_out_openings_count: number | null;
  applied_role_filters: string[];
  applied_domain_filters: string[];
};

export type DisplayCountType =
  | "total_active_openings"
  | "filtered_matching_openings"
  | "source_count_unavailable";

export type SourceInventoryStatus =
  | "exact_api_count"
  | "exact_stored_jobs_count"
  | "non_exact_html_withheld"
  | "source_unavailable"
  | "source_not_validated"
  | "source_stale"
  | "fetch_failed";

export type FilterDiagnostics = {
  has_active_filters: boolean;
  role_filter_applied: boolean;
  domain_filter_applied: boolean;
  revenue_filter_applied: boolean;
  search_filter_applied: boolean;
  matching_job_count: number;
  total_active_job_count: number;
  count_is_filtered: boolean;
  filtered_out_openings_count: number | null;
  ignored_filters: string[];
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
  active_openings_matching_filters?: number;
  active_openings_total?: number;
  latest_job_seen_at?: string | null;
  top_roles?: RoleSummaryItem[];
  revenue_band?: string;
  domain_tags?: string[];
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
  enhanced?: boolean;
  source_discrepancy?: boolean;
  indeedEstimate?: number;
  confidence?: "confirmed" | "enhanced" | "low";
  count_diagnostics?: CountDiagnostics;
  // Contract-named, backend-owned count fields (top level per company). The UI
  // reads these directly and never infers a count type or recomputes a count.
  exact_source_total?: number | null;
  exact_source_total_persisted?: boolean;
  exact_source_total_last_seen_at?: string | null;
  display_count?: number;
  display_count_type?: DisplayCountType;
  source_inventory_status?: SourceInventoryStatus;
  source_inventory_reason?: string | null;
  source_count_method?: string;
  filter_diagnostics?: FilterDiagnostics;
  created_at: string;
};
