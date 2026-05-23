import {
  pgTable,
  uuid,
  text,
  boolean,
  integer,
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
    metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    isHiringIdx: index("companies_is_hiring_idx").on(t.isHiring),
    nameIdx: index("companies_name_idx").on(t.name),
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
    url: text("url"),
    source: text("source"),
    isActive: boolean("is_active").notNull().default(true),
    ghostScore: integer("ghost_score").notNull().default(0),
    postedAt: timestamp("posted_at", { withTimezone: true }),
    lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
    metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    companyIdx: index("roles_company_id_idx").on(t.companyId),
    activeIdx: index("roles_is_active_idx").on(t.isActive),
    ghostScoreIdx: index("roles_ghost_score_idx").on(t.ghostScore),
    companyExternalIdUq: uniqueIndex("roles_company_external_id_uq").on(
      t.companyId,
      t.externalId
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
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userIdx: index("rolodex_user_idx").on(t.userId),
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
