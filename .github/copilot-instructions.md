# TalentGrid — Copilot / Agent Instructions

## Stack

- **Next.js 16** (App Router, TypeScript, server actions / route handlers)
- **Supabase** for auth + Postgres (with Row Level Security)
- **Drizzle ORM** for typed schema (mirrors `supabase/migrations/`)
- **Tailwind 4** + **Shadcn/UI** for styling
- **Zod** for input validation
- **BullMQ** + **Upstash Redis** (REST) and **ioredis** (workers) for background jobs

## Conventions

- All new API routes live under `app/api/**/route.ts` and use the App Router conventions.
- Use the Supabase server client (`lib/supabase/server.ts`) inside route handlers and server components; the browser client (`lib/supabase/client.ts`) only in client components.
- User-scoped data (favorites, rolodex) is enforced by Supabase RLS — server code always uses the authenticated user's session, never the service role for user-facing requests.
- Validate all `POST`/`PUT`/`PATCH` request bodies with Zod schemas from `lib/validators/`.
- Background work (ghost-job checks, enrichment) is enqueued through BullMQ queues defined in `workers/queues.js`.
- The Drizzle schema in `lib/db/schema.ts` must mirror the SQL in `supabase/migrations/001_initial_schema.sql`. If you change one, change the other.
- Pagination: `?page=1&pageSize=20` — default `pageSize=20`, max `100`.

## Don't

- Don't introduce a second ORM or query builder.
- Don't hardcode Supabase URLs / keys; read from `process.env`.
- Don't bypass RLS by using the service role key in user-facing routes.
