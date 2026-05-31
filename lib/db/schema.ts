import {
  pgTable,
  uuid,
  text,
  boolean,
  integer,
  numeric,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const companies = pgTable(
  "companies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    domain: text("domain").unique(),
    description: text("description"),
    industry: text("industry"),
    size: text("size"),
    location: text("location"),
    logoUrl: text("logo_url"),
    website: text("website"),
    isHiring: boolean("is_hiring").notNull().default(false),
    revenueBand: text("revenue_band"),
    domainTags: text("domain_tags").array().notNull().default(sql`'{}'::text[]`),
    roleTags: text("role_tags").array().notNull().default(sql`'{}'::text[]`),
    monitor: boolean("monitor").notNull().default(false),
    metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    isHiringIdx: index("companies_is_hiring_idx").on(t.isHiring),
    nameIdx: index("companies_name_idx").on(t.name),
    revenueBandIdx: index("companies_revenue_band_idx").on(t.revenueBand),
    monitorIdx: index("companies_monitor_idx").on(t.monitor),
  })
);

export const roles = pgTable(
  "roles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    externalId: text("external_id"),
    title: text("title").notNull(),
    description: text("description"),
    location: text("location"),
    remote: boolean("remote").notNull().default(false),
    employmentType: text("employment_type"),
    seniority: text("seniority"),
    salaryMin: integer("salary_min"),
    salaryMax: integer("salary_max"),
    // Compensation captured from an ATS/API source (numeric, never guessed).
    // See supabase/migrations/006_role_compensation_and_dates.sql.
    compensationMin: numeric("compensation_min"),
    compensationMax: numeric("compensation_max"),
    compensationCurrency: text("compensation_currency").default("USD"),
    compensationPeriod: text("compensation_period"),
    compensationText: text("compensation_text"),
    compensationSource: text("compensation_source"),
    compensationStatus: text("compensation_status").notNull().default("unavailable"),
    url: text("url"),
    source: text("source"),
    roleCategory: text("role_category"),
    domainCategory: text("domain_category"),
    isActive: boolean("is_active").notNull().default(true),
    ghostScore: integer("ghost_score").notNull().default(0),
    postedAt: timestamp("posted_at", { withTimezone: true }),
    postedStatus: text("posted_status").notNull().default("unavailable"),
    discoveredAt: timestamp("discovered_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
    metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    companyIdx: index("roles_company_id_idx").on(t.companyId),
    activeIdx: index("roles_is_active_idx").on(t.isActive),
    ghostScoreIdx: index("roles_ghost_score_idx").on(t.ghostScore),
    roleCategoryIdx: index("roles_role_category_idx").on(t.roleCategory),
    domainCategoryIdx: index("roles_domain_category_idx").on(t.domainCategory),
    companyExternalIdUq: uniqueIndex("roles_company_external_id_uq").on(
      t.companyId,
      t.externalId
    ),
    compensationPeriodCheck: check(
      "roles_compensation_period_check",
      sql`${t.compensationPeriod} is null or ${t.compensationPeriod} in ('year','hour','month','week','contract','unknown')`
    ),
    compensationSourceCheck: check(
      "roles_compensation_source_check",
      sql`${t.compensationSource} is null or ${t.compensationSource} in ('ats_api','job_description_parsed','unavailable')`
    ),
    compensationStatusCheck: check(
      "roles_compensation_status_check",
      sql`${t.compensationStatus} in ('exact_range','exact_single_value','text_only','parsed_from_description','unavailable')`
    ),
    postedStatusCheck: check(
      "roles_posted_status_check",
      sql`${t.postedStatus} in ('exact','inferred_from_discovered_at','unavailable')`
    ),
  })
);

export const favorites = pgTable(
  "favorites",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull(),
    companyId: uuid("company_id").references(() => companies.id, { onDelete: "cascade" }),
    roleId: uuid("role_id").references(() => roles.id, { onDelete: "cascade" }),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    targetCheck: check(
      "favorites_target_check",
      sql`(${t.companyId} is not null) or (${t.roleId} is not null)`
    ),
    userCompanyUq: uniqueIndex("favorites_user_company_uq")
      .on(t.userId, t.companyId)
      .where(sql`${t.companyId} is not null`),
    userRoleUq: uniqueIndex("favorites_user_role_uq")
      .on(t.userId, t.roleId)
      .where(sql`${t.roleId} is not null`),
  })
);

export const rolodexEntries = pgTable(
  "rolodex_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull(),
    companyId: uuid("company_id").references(() => companies.id, { onDelete: "set null" }),
    name: text("name").notNull(),
    title: text("title"),
    email: text("email"),
    linkedin: text("linkedin"),
    phone: text("phone"),
    notes: text("notes"),
    tags: text("tags").array().notNull().default(sql`'{}'::text[]`),
    // Recruiter Intel fields (migration 007). User-entered or routed context for
    // a likely recruiting contact saved from a job card. Never scraped/enriched.
    companyName: text("company_name"),
    jobOpeningId: uuid("job_opening_id").references(() => roles.id, {
      onDelete: "set null",
    }),
    jobTitle: text("job_title"),
    contactPathLabel: text("contact_path_label"),
    sourceType: text("source_type").notNull().default("manual_user_entry"),
    verificationStatus: text("verification_status")
      .notNull()
      .default("manual_review_required"),
    confidenceLevel: text("confidence_level"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userIdx: index("rolodex_user_idx").on(t.userId),
    jobOpeningIdx: index("rolodex_entries_job_opening_idx")
      .on(t.jobOpeningId)
      .where(sql`${t.jobOpeningId} is not null`),
    verificationStatusCheck: check(
      "rolodex_entries_verification_status_check",
      sql`${t.verificationStatus} in ('manual_review_required','manually_verified','unverified')`
    ),
    confidenceLevelCheck: check(
      "rolodex_entries_confidence_level_check",
      sql`${t.confidenceLevel} is null or ${t.confidenceLevel} in ('high','medium','low')`
    ),
  })
);

export const signals = pgTable(
  "signals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    detail: text("detail"),
    href: text("href"),
    companyId: uuid("company_id").references(() => companies.id, { onDelete: "cascade" }),
    roleId: uuid("role_id").references(() => roles.id, { onDelete: "cascade" }),
    metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    createdAtIdx: index("signals_created_at_idx").on(t.createdAt),
    companyIdx: index("signals_company_id_idx").on(t.companyId),
    kindIdx: index("signals_kind_idx").on(t.kind),
  })
);

// ATS source-candidate enrichment layer. Mirrors
// supabase/migrations/005_company_job_sources_candidate.sql — a staging table
// for ATS source mappings discovered from open-source datasets that are
// quarantined (fetch_enabled=false) until TalentGrid's own provider validates
// them against the live endpoint and promotes them. See
// docs/ats-source-candidates.md.
export const companyJobSourcesCandidate = pgTable(
  "company_job_sources_candidate",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").references(() => companies.id, {
      onDelete: "set null",
    }),
    companyName: text("company_name").notNull(),
    // Provenance.
    sourceOrigin: text("source_origin").notNull().default("other"),
    sourceOriginUrl: text("source_origin_url"),
    importedAt: timestamp("imported_at", { withTimezone: true }).notNull().defaultNow(),
    // Resolved ATS mapping.
    sourceName: text("source_name"),
    atsSlug: text("ats_slug"),
    careersUrl: text("careers_url"),
    apiUrl: text("api_url"),
    sourceType: text("source_type"),
    supportedFetchStrategy: text("supported_fetch_strategy").notNull().default("unsupported"),
    // Validation lifecycle.
    validationStatus: text("validation_status").notNull().default("imported_unvalidated"),
    validatedAt: timestamp("validated_at", { withTimezone: true }),
    validationError: text("validation_error"),
    confidenceScore: numeric("confidence_score", { precision: 4, scale: 3 }),
    // Trust / fetch gating.
    fetchEnabled: boolean("fetch_enabled").notNull().default(false),
    validationEnabled: boolean("validation_enabled").notNull().default(true),
    manuallyVerified: boolean("manually_verified").notNull().default(false),
    metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    dedupUq: uniqueIndex("company_job_sources_candidate_dedup_uq").on(
      sql`lower(${t.companyName})`,
      sql`coalesce(lower(${t.sourceName}), '')`,
      sql`coalesce(lower(${t.atsSlug}), '')`,
      sql`coalesce(lower(${t.apiUrl}), '')`
    ),
    fetchableIdx: index("company_job_sources_candidate_fetchable_idx")
      .on(t.validationStatus)
      .where(sql`${t.fetchEnabled} = true`),
    pendingIdx: index("company_job_sources_candidate_pending_idx").on(
      t.validationStatus,
      t.validatedAt
    ),
    companyIdx: index("company_job_sources_candidate_company_idx")
      .on(t.companyId)
      .where(sql`${t.companyId} is not null`),
    validationStatusCheck: check(
      "company_job_sources_candidate_validation_status_check",
      sql`${t.validationStatus} in ('imported_unvalidated','validated_fetchable','validation_failed','stale_import','source_changed','duplicate_source','unsupported_source_type')`
    ),
    fetchStrategyCheck: check(
      "company_job_sources_candidate_fetch_strategy_check",
      sql`${t.supportedFetchStrategy} in ('exact_api','html_only','unsupported')`
    ),
    confidenceRangeCheck: check(
      "company_job_sources_candidate_confidence_range",
      sql`${t.confidenceScore} is null or (${t.confidenceScore} >= 0 and ${t.confidenceScore} <= 1)`
    ),
  })
);

export type Company = typeof companies.$inferSelect;
export type NewCompany = typeof companies.$inferInsert;
export type Role = typeof roles.$inferSelect;
export type NewRole = typeof roles.$inferInsert;
export type Favorite = typeof favorites.$inferSelect;
export type NewFavorite = typeof favorites.$inferInsert;
export type RolodexEntry = typeof rolodexEntries.$inferSelect;
export type NewRolodexEntry = typeof rolodexEntries.$inferInsert;
export type Signal = typeof signals.$inferSelect;
export type NewSignal = typeof signals.$inferInsert;
export type CompanyJobSourceCandidate = typeof companyJobSourcesCandidate.$inferSelect;
export type NewCompanyJobSourceCandidate = typeof companyJobSourcesCandidate.$inferInsert;
