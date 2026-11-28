# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Hust Platform is an AI-powered job search platform where the primary UX is a conversational AI assistant. Users interact through a split-screen interface: AI chat on the left, dynamic jobs canvas on the right. Authentication is via LinkedIn OAuth.

**Domain**: hust.so | **License**: GNU AGPL-3.0-or-later (Copyright © 2026 Ever Co. LTD)

## Standalone-First Principle (optional Gauzy integration)

Hust is a **standalone product** — it must always build, run, and ship without any Gauzy product.
Its only hard external dependency is the **Ever Jobs API** (`packages/jobs-api/`). Hust owns its
own auth (BetterAuth + LinkedIn), users, database, and apply flow.

Hust *optionally* integrates with the wider **Ever Gauzy** platform for the agency/company
scenario, via two future seams — both through the **Gauzy AI API**, both off by default:

- **Auto-apply** — default is manual apply (open the apply URL); optional auto-apply delegates to
  Gauzy AI's `AutomationTask` queue + the Ever Gauzy AI Automation client.
- **Identity / employee / org / tenant sync (SSO)** — default is own BetterAuth + LinkedIn;
  optional SSO mirrors employees from Ever Gauzy API via a shared JWT and `external*Id` refs.

When working on any Gauzy-related feature: never make Gauzy a hard dependency, keep it behind a
flag + adapter with graceful fallback to standalone, and integrate via the Gauzy AI API. Full
design: [`docs/GAUZY-INTEGRATION.md`](docs/GAUZY-INTEGRATION.md).

## Package Manager

> [!CAUTION]
> **This project uses pnpm exclusively.** Do NOT use `npm` or `yarn` — they will fail to resolve workspace dependencies correctly. The root `package.json` pins the exact pnpm release in its `"packageManager"` field (pnpm 10), and workspaces are defined in `pnpm-workspace.yaml`.

## Commands

```bash
pnpm install              # Install all dependencies
pnpm dev                  # Start dev server (port 8443, Turbopack)
pnpm build                # Build all packages and apps (via Turborepo)
pnpm lint                 # Lint all packages (eslint --max-warnings 0)
pnpm check-types          # Type-check all packages
pnpm format               # Format with Prettier

# Testing
pnpm test                 # Run all Jest unit tests across packages
pnpm test -- --selectProjects ai          # Run tests for a single package
pnpm test -- --testPathPattern rate-limit  # Run a specific test file
pnpm test:e2e             # Run Playwright E2E tests (starts dev server automatically)

# Database (Drizzle ORM + Supabase PostgreSQL)
pnpm db:push              # Push schema changes to database
pnpm db:migrate           # Run database migrations
pnpm db:generate          # Generate migration files from schema changes
pnpm db:seed              # Seed database with test data
pnpm db:studio            # Open Drizzle Studio GUI

# Bundle analysis
ANALYZE=true pnpm build   # Generate bundle analysis report
```

## Tech Stack

- **Next.js 16.4** (App Router, React 19, Server Components, Turbopack)
- **Tailwind CSS 4.1** + **ShadCN UI** (components in `packages/ui/`)
- **Turborepo** monorepo with **pnpm 10** workspaces
- **BetterAuth v1** (LinkedIn OAuth, session cookies)
- **PostgreSQL** via Supabase, **Drizzle ORM** for schemas/queries
- **Vercel AI SDK v6** with Claude models (Anthropic direct or OpenRouter)
- **Langfuse** for AI observability (OTEL-based tracing, prompt management)
- **Stripe** for subscriptions, **Resend** + React Email for transactional email
- **Trigger.dev v3** for scheduled background tasks
- **In-memory rate limiting by default** (per-pod), with a Redis-ready path via `@ever-hust/rate-limit` (off unless `RATE_LIMIT_REDIS_URL` is set) and an Upstash path for AI search/cover-letter caps
- **Playwright** (E2E) + **Jest** with ts-jest (unit tests)

## Architecture

### Monorepo Structure

Turborepo with `apps/*` and `packages/*` workspaces. All packages use `@ever-hust/` namespace and are referenced via `workspace:*` protocol.

- **`apps/web/`** — Next.js application (the only app)
- **`packages/ai/`** — AI orchestrator agent, tools, model router, prompts, rate limits
- **`packages/db/`** — Drizzle ORM schemas, database client (lazy singleton via Proxy), and shared DB helpers (e.g. `escapeIlike`)
- **`packages/auth/`** — BetterAuth configuration with LinkedIn OAuth + welcome email hook
- **`packages/ui/`** — ShadCN components exported as `@ever-hust/ui/<component-name>`
- **`packages/stripe/`** — Stripe checkout, portal, webhook parsing, plan definitions
- **`packages/jobs-api/`** — Ever Jobs external API client with circuit breaker + retry
- **`packages/email/`** — React Email templates (welcome, job alert, subscription, verification, password reset, organization invitation) + Resend sender
- **`packages/triggers/`** — Trigger.dev scheduled tasks (job sync, alerts, cleanup)
- **`packages/supabase/`** — Supabase client for Realtime + Storage (`uploadFile` and `getPublicUrl` for the public `user-uploads` bucket, `uploadPrivateFile` / `downloadFile` for the private `cvs` bucket, `cvStorageObject`, `deleteFile`, `deleteUserFiles`)
- **`packages/cv-parser/`** — CV/resume parsing logic
- **`packages/eslint-config/`** — Shared ESLint configs (base, next, react-internal)
- **`packages/typescript-config/`** — Shared tsconfig presets

### AI Chat Flow

1. **Client**: `apps/web/app/(dashboard)/chat/page.tsx` renders `SplitScreen` with `ChatPanel` (left) + `JobsCanvas` (right)
2. **API Route**: `apps/web/app/api/ai/chat/route.ts` — authenticates user, applies rate limits, resolves the AI model and the credit key together via `getModelWithSelection()` (credits are metered on the model actually served, never the saved `aiModel` string; BYOK calls are not metered), streams response
3. **Model Router** (`packages/ai/src/model-router.ts`): Routes to correct model based on subscription tier and user preferences. BYOK users get direct Anthropic; platform users go through OpenRouter (if configured) or direct Anthropic. Free tier gets Haiku, paid tier gets Sonnet/Opus.
4. **Orchestrator** (`packages/ai/src/agents/orchestrator.ts`): Uses `streamText()` with 11 tools (searchJobs, favoriteJob, generateCoverLetter, interviewPrep, etc.). Max 5 agentic steps per turn.
5. **Canvas Sync**: Tool results flow back to the client via `useCanvasSync` hook, which updates the jobs canvas in real-time. Supabase Realtime pushes new jobs from background sync tasks.

### System Prompt Management

Prompts are managed through Langfuse with local fallbacks. The orchestrator system prompt can be edited in Langfuse Cloud (prompt name: `orchestrator-system`, label: `production`) or locally in `packages/ai/src/prompts.ts`.

For a member of an organization with an active AI config, the chat route passes the org's custom system prompt, temperature and max tokens to `createOrchestratorStream`: the custom prompt is appended after the base prompt under an `Organization instructions:` heading (never replacing it), and temperature / max output tokens are sent to the model only when the org set them. On Hust's platform key the org's max tokens can only lower the 8,192-token output cap (`DEFAULT_MAX_OUTPUT_TOKENS` in `credit-fallback.ts`), never raise it; BYOK calls get the org value as set.

### Routing & Auth

- **Route Groups**: `(marketing)` for public pages, `(auth)` for login/signup, `(dashboard)` for authenticated pages
- **Proxy** (`apps/web/proxy.ts`): Checks BetterAuth session cookie for protected routes (`/chat`, `/jobs`, `/profile`, `/settings`, `/applications`, `/favorites`), applies security headers (CSP, HSTS, etc.) to all responses. Migrated from `middleware.ts` per Next.js 16.1 convention.
- **Auth catch-all**: `apps/web/app/api/auth/[...all]/route.ts` proxies to BetterAuth
- **Production build**: 72 routes total (62 static/dynamic pages + API routes)
- **Job not-found page**: `apps/web/app/(dashboard)/jobs/[id]/not-found.tsx` — custom 404 page for invalid job IDs
- **Organization not-found page**: `apps/web/app/(dashboard)/organizations/[orgId]/not-found.tsx` — custom 404 for invalid org IDs
- **Invitation not-found page**: `apps/web/app/(dashboard)/organizations/invitations/[token]/not-found.tsx` — custom 404 for invalid/expired invitations
- **Admin loading skeleton**: `apps/web/app/(admin)/admin/loading.tsx` — skeleton UI shown while admin pages load

### Subscription & Rate Limiting

- Free tier: Haiku model, 5 searches/day, 1 cover letter/week, daily message limit
- Pro tier (Stripe): Configurable model, unlimited searches/cover letters/messages, job alerts, interview prep, application agent
- Rate limiting is **in-memory (per-pod) by default**; there are three limiters with different backends. The daily message cap (`apps/web/lib/subscription-gate.ts`) goes through `@ever-hust/rate-limit` and is **Redis-ready but off by default** (set `RATE_LIMIT_REDIS_URL`). The per-route API limiter (`apps/web/lib/rate-limit.ts`) is in-memory only. The AI search/cover-letter caps (`packages/ai/src/rate-limit.ts`) use Upstash when `UPSTASH_REDIS_REST_URL` is set. Full map + enable steps: `docs/internal/RATE_LIMITING.md`.

### Database Schema

Tables defined in `packages/db/src/schema/`: `users`, `sessions`, `accounts`, `verifications` (BetterAuth), `jobs`, `userJobs` (favorites), `userAlerts`, `chatSessions`, `chatMessages`, `agentInstances`, `subscriptions`, `applications`, `pushSubscriptions`, `referrals`, `referralCredits`, `apiKeys`, `organizations`, `organizationMembers`, `organizationInvitations`, `brandingConfigs`, `organizationAiConfigs`, `stripeWebhookEvents`.

A `userJobs` row with status `applied` (written by the apply tool with `appliedAt`; the profile's applied list and the inbox job matching read it) is never overwritten or deleted by the favorite and hide toggles: `POST /api/user/favorites` and `POST /api/user/hidden-jobs` answer 409 for it and change nothing, and `DELETE /api/user/favorites` deletes only a `favorited` row. The chat `favoriteJob` tool (`packages/ai/src/tools/favorite-job.ts`) reads the row with `.for("update")` inside its transaction, as the favorites POST does, and for an `applied` row writes nothing and answers `favorited: false` with the same message as that 409. The apply tool writes that row with one upsert on `(user_id, job_id)` (`onConflictDoUpdate` on `user_jobs_unique`) inside the transaction that creates the application, never with a select followed by an update or an insert: an unfavorite that deleted the row after the select left the update with no row (the application committed, no row said `applied`), and a favorite inserted after it made the insert hit the unique key and roll the whole application back. `apps/web/lib/__tests__/apply-job-user-jobs.integration.test.ts` races the apply against the favorite toggles on a real Postgres (opt-in: `APPLY_JOB_IT_DATABASE_URL` naming a pushed `*_it` / `*_test` database).

The apply tool refuses a second application for a job the user already has one for (any status but `failed`) and answers "You already have an active application for this job.". That duplicate check is a plain select, which does not block under READ COMMITTED, so the transaction first takes `pg_advisory_xact_lock(hashtext('apply-job:' || userId), jobId)`: without it, two applies for the same job (one step's parallel tool calls, or two tabs) both passed the check and both created an application. `applications_user_job_idx` on `(user_id, job_id)` is deliberately not unique, because existing rows may already be duplicated. `apps/web/lib/__tests__/apply-job-duplicate.integration.test.ts` races two applies on a real Postgres (opt-in: the same `APPLY_JOB_IT_DATABASE_URL`).

The DB client (`packages/db/src/client.ts`) is a lazy singleton using a Proxy pattern — it only connects when first accessed.

### API Route Patterns

API routes in `apps/web/app/api/` follow a consistent pattern:

- Authenticate with `requireSessionUser()` (throws NextResponse on failure)
- Apply rate limiting with `applyRateLimit(key, tier)` from `apps/web/lib/rate-limit.ts`. Available tiers: `authenticated` (100 req/min), `public` (20 req/min), `publicHighThroughput` (100 req/min), `chat` (30 req/min), `admin` (60 req/min), `adminWrite` (30 req/min), `export` (5 req/min). Uses in-memory sliding window (per-pod); not yet distributed — see `docs/internal/RATE_LIMITING.md` for the deferred Redis migration of this limiter.
- Validate request body with Zod schemas from `apps/web/lib/api-schemas.ts`
- Every table id is a Postgres `integer` (int4). Parse an id from a route segment or query parameter with `parsePositiveIntId` (`apps/web/lib/id-param.ts`), which accepts only `/^[1-9]\d*$/` up to `INT4_MAX` (2147483647) and returns null otherwise, and answer 400 for null before any query; an id in a JSON body is `z.number().int().positive().max(INT4_MAX)`. A larger id or `1.5` used to reach Postgres and come back as a 500
- `safeJsonParse` returns `null`, arrays and primitives as valid data. A route that reads fields off the body without a Zod schema checks `isJsonObject` (`apps/web/lib/api-response.ts`) first and answers 400 "Request body must be a JSON object"
- Return errors via `apiBadRequest()` / `apiError()` helpers from `apps/web/lib/api-response.ts` (including the Stripe webhook route, which uses these standardized helpers for consistent error responses)
- All API responses include default `Cache-Control: private, no-cache, no-store, must-revalidate` headers to prevent sensitive data caching
- Streaming AI routes set `export const maxDuration = 60` for Vercel

### Component Organization

- **`apps/web/components/canvas/`** — Jobs canvas, job cards (keyboard navigable in compare mode), filter bar
- **`apps/web/components/chat/`** — Chat panel, messages, input, tool approval, agent status
- **`apps/web/components/landing/`** — Marketing page sections (hero, features, pricing, etc.)
- **`apps/web/components/layout/`** — Sidebar, split-screen layout
- **`apps/web/components/settings/`** — Settings page cards (AI model, API keys, subscription, etc.)
- **`apps/web/components/shared/`** — Reusable components (dialogs, error states, keyboard shortcuts, theme-toggle, rate-limit-interceptor, Uppy upload components)
- **`apps/web/components/onboarding/`** — New user onboarding flow
- **`apps/web/lib/constants.ts`** — Shared application constants (AI limits, free-tier caps, canvas settings)
- **`packages/ui/src/alert-dialog.tsx`** — ShadCN AlertDialog component (imported as `@ever-hust/ui/alert-dialog`)

### Structured Data (JSON-LD)

All marketing pages include JSON-LD structured data: `Organization` (landing), `WebSite` (landing), `SoftwareApplication` (landing), `FAQPage` (pricing), `PricingTable`/`Offers` (pricing), and `Organization` (about). The structured data component escapes `</script>` to prevent XSS injection.

### Security Hardening

- **XSS sanitization**: Custom skill input is sanitized both client-side (onboarding dialog) and server-side (profile PATCH API schema strips HTML tags) to prevent stored XSS attacks
- **CV upload validation**: Rejects zero-byte files in addition to enforcing the 10MB max size and PDF type checks
- **Private CVs**: CVs go to the private `cvs` bucket (`public=false`, created by the infra SQL script, not by the app) with `Cache-Control: private, no-store`, never to the public `user-uploads` bucket, whose objects Cloudflare caches for hours. `users.cv_url` holds the object path (`{userId}/{uuid}.{ext}`), never a URL; the owner downloads their CV from `GET /api/cv/file`, which resolves the path with `cvStorageObject` (only a path in the caller's own folder, or a public `user-uploads/cvs/{userId}/` URL from before CVs were private) and answers `attachment` + `no-store`. Avatars stay public
- **CV upload errors**: `POST /api/cv/upload` parses before it stores anything. A file the parser cannot read (`CvUnreadableError` from `packages/cv-parser`) is a 422; any other parser failure is a 500, a Storage failure a 503 and a database failure a 500, each with its own message
- **Storage paths**: The CV upload stores files as `{userId}/{uuid}.{ext}` in the `cvs` bucket and never uses the client's file name (names with `/`, `\` or `..` get a 400); `uploadFile` and `uploadPrivateFile` in `packages/supabase` throw on `.`/`..` segments (also `%2e`), backslashes and control characters (the URL parser drops tab/CR/LF, so `.\t.` would become `..`), because the service-role upload puts the path into the URL unencoded
- **Uploaded files on delete**: `DELETE /api/user/account` calls `deleteUserFiles` after the user row is deleted (never on the 409 path), which removes every CV in `{userId}/` of the `cvs` bucket and in `cvs/{userId}/` of `user-uploads` (each listed page by page) and `avatars/{userId}.jpg|png|webp`; it logs failures and never throws. A CV upload saves its object path in `users.cv_url` and then removes the CV it replaced, only when `cvStorageObject` places the old value inside the user's own folder; an upload that finds the user row gone (the account was deleted meanwhile) removes its own new object. The avatar upload (`POST /api/user/avatar`, `avatars/{userId}.{ext}`) saves `users.photo_url` under a row lock with `update ... returning`: when no row matched it removes the object it just stored and answers 500, and when the extension changed it removes the previous avatar, only when that path is `avatars/{userId}.jpg|png|webp`. `linkAnonymousUser` calls `deleteUserFiles(guestId)` once the guest row is deleted (the move does not carry the guest's `cv_url` or `photo_url` over)
- **Guest self-delete**: a global BetterAuth before hook (`packages/auth/src/anonymous-self-delete-guard.ts`) refuses the anonymous plugin's `POST /api/auth/delete-anonymous-user` with 403, because deleting the guest row cascades through `organizations.created_by_id` to every organization the guest created. Guests delete their account with `DELETE /api/user/account`, which hands organizations to another member first. The plugin's `disableDeleteAnonymousUser` is on: after a guest signs up or signs in, `linkAnonymousUser` (`packages/auth/src/link-anonymous-user.ts`) moves the guest's work in one transaction and deletes the guest only once that committed, so a failed move keeps the guest and its data instead of cascading them away
- **BYOK key safety**: When `BYOK_ENCRYPTION_KEY` is absent, the model router detects encrypted ciphertext and falls through to the platform model instead of sending it as an API key
- **Preferences writes**: every writer of `users.preferences` (`PATCH /api/user/settings` and the `savePreferences`, `learnPreference` and `captureWritingStyle` tools) reads the row with `.for("update")` inside the transaction that writes the merged JSON back. A plain SELECT does not block another writer under READ COMMITTED, and the AI SDK runs one step's tool calls in parallel, so without the lock the later write put back a stale copy and a just-saved BYOK key, evaluation weights or writing style reverted. `apps/web/lib/__tests__/user-preferences-lock.integration.test.ts` races the writers on a real Postgres (opt-in: `USER_PREFS_IT_DATABASE_URL` naming a pushed `*_it` / `*_test` database)
- **LLM context hygiene**: `getUserProfile` tool strips encrypted API keys from preferences before returning data to LLM context
- **AI tool input bounds**: All AI tool Zod schemas enforce `.max()` constraints on string/array inputs to limit LLM-generated payload sizes
- **Service worker**: Includes `push` and `notificationclick` event handlers for Web Push notifications, offline caching with precached `/offline` page
- **Email verification**: BetterAuth `emailVerification` config for email/password signups only; OAuth providers are trusted
- **Auth emails**: The verification and password reset emails are rendered by React Email templates in `packages/email`, which escape the user name (sign-up accepts any name, and a reset can be requested for any address that has an account); never build them as raw HTML strings. The reset, verification and welcome emails take the greeting from `emailGreetingName` (`packages/auth/src/email-greeting-name.ts`): "there" until the address is verified, so a sign-up name such as "restore your account at evil.example" never reaches an inbox the signer does not own; for a verified user, the trimmed name capped at 100 characters, or the email local part when the name is blank
- **Organization invitations**: `POST /api/organizations/[orgId]/members` stores the invitation, then emails the accept link (`<app>/organizations/invitations/<token>`) with `sendOrganizationInvitationEmail` (Resend idempotency key `org-invitation/<id>/<createdAt ms>`) and answers 201 `{ invitation, emailSent, inviteUrl }`. A failed send never fails the invite, and its log line never carries the token. An inviter without a verified email (a guest) gets no email sent on their behalf. The org page says "Invitation sent" only when `emailSent` is true; otherwise it shows the invite link with a copy button. The org name and inviter name are inviter-chosen text going to an address that did not ask for it: the template escapes them, and the subject collapses whitespace and control characters to one space
- **Rate limit UX**: Global `RateLimitInterceptor` patches `window.fetch` to show toast on 429 responses

### Custom Hooks

Located in `apps/web/hooks/`. Key hooks:

- `useCanvasSync` — Manages jobs canvas state, syncs AI tool results to canvas
- `useRealtimeJobs` — Supabase Realtime subscription for live job updates with auto-reconnection (3 attempts with exponential backoff)
- `useFavorites` — Favorite job management
- `useChatPersistence` — Chat session persistence
- `useKeyboardShortcuts` — Global keyboard shortcut management
- `useReferralRedeem` — Auto-redeems referral codes stored in localStorage after authentication

### Testing

- **Jest**: 1120 unit tests across 35 suites, living alongside source files as `*.test.ts`. Projects configured for: `ai`, `stripe`, `cv-parser`, `jobs-api`, `db`, `utils`, `email`, `triggers`, `supabase`, `web-lib`. Uses `ts-jest` with `isolatedModules: true` to avoid OOM from complex AI SDK/Zod generics. Key test files include `model-router.test.ts`, `prompts.test.ts`, `rate-limit.test.ts`, `tool-schemas.test.ts`, `crypto.test.ts`, `api-client.test.ts`, `api-response.test.ts`, `api-schemas.test.ts`, `subscription-gate.test.ts`, `referral-utils.test.ts`, `format-date.test.ts`, `org-config.test.ts`, `webhook-idempotency.test.ts`, `orchestrator.test.ts`, `constants.test.ts`, `env.test.ts`, `startup-checks.test.ts`, `safe-url.test.ts`, `salary-insights.test.ts`, `resume-builder.test.ts`, `resume-helpers.test.ts`, `webhook.test.ts`, `checkout.test.ts`, `portal.test.ts`, `plans.test.ts`, `client.test.ts`, `types.test.ts`, `guidance-topics.test.ts`, `db-helpers.test.ts`, `map-job.test.ts`, `helpers.test.ts`.
- **Dependency bumps**: `apps/web/lib/__tests__/toolchain-versions.test.ts` fails when a Node bump misses a Dockerfile stage, a workflow, an `engines.node` or an `@types/node`, or when an `@next/*` package is off the exact `next` pin. `packages/auth/src/better-auth-contract.test.ts` builds a real better-auth instance on the Drizzle schema (the adapter's own schema check, the guest-delete guard, every field better-auth writes), and `apps/web/lib/__tests__/mail-smtp-sink.test.ts` runs `lib/mail.ts` with the real nodemailer against a local SMTP sink. A better-auth or nodemailer bump must pass both. `apps/web/lib/__tests__/repo-docs.test.ts` fails when `AGENTS.md` or `CLAUDE.md` name a pnpm major other than the root `packageManager`, so a pnpm major bump updates both docs.
- **Playwright**: 175 E2E tests across 8 spec files in `tests/e2e/`. Specs for: auth, landing, chat, jobs, profile, subscription. Runs against `http://localhost:8443`.

### UI Package Pattern

ShadCN components in `packages/ui/src/` are imported as `@ever-hust/ui/<component-name>` (e.g., `import { Button } from "@ever-hust/ui/button"`). The package uses direct file exports, not a barrel.

### Telemetry

Langfuse tracing is set up via `apps/web/instrumentation.ts` (Next.js instrumentation hook). OTEL spans from the Vercel AI SDK are automatically sent to Langfuse when `LANGFUSE_PUBLIC_KEY` and `LANGFUSE_SECRET_KEY` are configured.

### Environment & Startup

- **`.env.example`** — Reference file listing all environment variables with descriptions. Copy to `.env.local` to get started.
- **Build-time inlining**: Next.js replaces every literal `process.env.NEXT_PUBLIC_*` with its value at `next build`, in server bundles too, and the web image is built without the Supabase ones (the pods get them at runtime). Server code that needs one at runtime reads it through a variable (`process.env[name]`), as `getSupabaseServer` does (`SUPABASE_URL`, else `NEXT_PUBLIC_SUPABASE_URL`); `packages/supabase/src/server.test.ts` fails if `server.ts` or `storage.ts` reads `process.env.NEXT_PUBLIC_*` directly
- **Startup checks** (`apps/web/lib/startup-checks.ts`): Runs automatically via `instrumentation.ts` on server boot. Validates critical env vars (`DATABASE_URL`, `BETTER_AUTH_SECRET`) — missing ones throw and prevent startup. Logs warnings for recommended vars (Stripe, LinkedIn OAuth, Resend, Supabase, `NEXT_PUBLIC_APP_URL`) and info for optional vars (OpenRouter, Langfuse, Upstash, Trigger.dev). Also validates that at least one AI provider key is configured.
