# Tango Phase 1: Foundation and Identity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the strict Bun workspace, shared JST/error contracts, PostgreSQL identity schema, secure guest lifecycle, and Better Auth Google/GitHub identity completion flow.

**Architecture:** Hono is created through a dependency-injected app factory so identity behavior is integration-testable without a live OAuth provider. Every request resolves an `Actor` backed by a domain `principal`; Better Auth sessions and the custom guest cookie meet only in one idempotent identity-completion transaction.

**Tech Stack:** Bun 1.3.14, TypeScript 7.0.2, Hono 4.12.33, Better Auth 1.6.25, Drizzle ORM 0.45.2, PostgreSQL 18.4, Zod 4.4.3, Temporal polyfill 0.5.1, Vitest 4.1.10, Biome 2.5.6.

## Global Constraints

- Read `C:\Users\waras\.claude\CLAUDE.md` first and apply it before repository-local instructions.
- Repository is `warasugitewara/tango-web`; production origin is exactly `https://tango.warasugi.com`.
- Product timezone is fixed to `Asia/Tokyo`; the learning day changes at 04:00 JST.
- Host support is Debian 13 preferred and Debian 12 compatible; deployment implementation waits for Phase 4.
- Only Google and GitHub OAuth are enabled. Email/password and implicit same-email linking are disabled.
- Guest identities expire after 90 days of inactivity; only a cryptographic token hash is persisted.
- Cookies are Host-only, `Secure`, `HttpOnly`, and `SameSite=Lax` in production.
- Strict TypeScript: no `any`, `@ts-ignore`, broad assertions, routine non-null assertions, or hidden type errors.
- The user pre-authorized one scoped Claude commit per completed Task on 2026-08-01. Verify `.gitignore`, status, diff check, Task diff, staged paths, and tests before committing. Never push without the user's authenticated environment and explicit branch instruction.

---

### Task 1: Scaffold the Bun workspace and quality gates

**Files:**
- Create: `.gitignore`
- Create: `.env.example`
- Create: `package.json`
- Create: `bunfig.toml`
- Create: `tsconfig.base.json`
- Create: `biome.json`
- Create: `apps/api/package.json`
- Create: `apps/api/tsconfig.json`
- Create: `apps/api/src/index.ts`
- Create: `apps/api/src/app.ts`
- Create: `apps/api/src/env.ts`
- Create: `apps/web/package.json`
- Create: `apps/web/tsconfig.json`
- Create: `apps/web/index.html`
- Create: `apps/web/src/main.tsx`
- Create: `packages/shared/package.json`
- Create: `packages/shared/tsconfig.json`
- Create: `packages/shared/src/index.ts`
- Create: `packages/db/package.json`
- Create: `packages/db/tsconfig.json`
- Create: `packages/db/src/index.ts`
- Create: `tests/config/workspace.test.ts`
- Create: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: Pinned versions and file layout from `2026-08-01-tango-implementation-index.md`.
- Produces: workspace scripts `check`, `typecheck`, `test`, `build`, `db:generate`, `db:migrate`; `createApp(deps)` and `Env` stubs consumed by later tasks.

- [ ] **Step 1: Write the failing workspace smoke test**

```ts
// tests/config/workspace.test.ts
import { describe, expect, test } from 'vitest'
import rootPackage from '../../package.json'

describe('workspace contract', () => {
  test('locks the four workspace packages and required scripts', () => {
    expect(rootPackage.workspaces).toEqual([
      'apps/*',
      'packages/*',
    ])
    expect(Object.keys(rootPackage.scripts)).toEqual(
      expect.arrayContaining(['check', 'typecheck', 'test', 'build']),
    )
  })
})
```

- [ ] **Step 2: Run the test and observe the missing root manifest**

Run: `bunx vitest@4.1.10 run tests/config/workspace.test.ts`
Expected: FAIL because `package.json` and/or its workspace fields do not exist.

- [ ] **Step 3: Create the root manifest and exact dependency baseline**

Use this script contract; list dependencies under the package that imports them rather than placing all runtime dependencies at root.

```json
{
  "name": "tango-web",
  "private": true,
  "packageManager": "bun@1.3.14",
  "workspaces": ["apps/*", "packages/*"],
  "scripts": {
    "dev": "bun --filter '*' dev",
    "check": "biome check . && bun run typecheck && bun run test",
    "check:fix": "biome check --write .",
    "typecheck": "bun --filter '*' typecheck",
    "test": "vitest run",
    "test:watch": "vitest",
    "build": "bun --filter '*' build",
    "db:generate": "bun --filter @tango/db db:generate",
    "db:migrate": "bun --filter @tango/db db:migrate"
  },
  "devDependencies": {
    "@biomejs/biome": "2.5.6",
    "@types/bun": "1.3.14",
    "typescript": "7.0.2",
    "vitest": "4.1.10"
  }
}
```

Create package manifests with these Phase 1 dependencies:

- `apps/api`: `hono@4.12.33`, `@hono/zod-validator@0.9.0`, `better-auth@1.6.25`, `@better-auth/drizzle-adapter@1.6.25`, `@tango/shared@workspace:*`, `@tango/db@workspace:*`, `zod@4.4.3`, `@js-temporal/polyfill@0.5.1`, `uuid@14.0.1`.
- `apps/web`: React/Vite dependencies pinned in the index; render only a semantic `Tango` placeholder in this phase.
- `packages/shared`: `zod@4.4.3`, `@js-temporal/polyfill@0.5.1`.
- `packages/db`: `drizzle-orm@0.45.2`, `drizzle-kit@0.31.10`, `postgres@3.4.9`, `uuid@14.0.1`, `@better-auth/cli@1.6.25` as a development dependency.

- [ ] **Step 4: Add strict compiler, formatter, ignore, and environment contracts**

`tsconfig.base.json` must set `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, `useUnknownInCatchVariables`, `verbatimModuleSyntax`, `moduleResolution: "Bundler"`, and `noEmit`. `biome.json` must reject unused imports and use two-space indentation/single quotes where the parser allows. `.gitignore` must include:

```gitignore
node_modules/
dist/
coverage/
playwright-report/
test-results/
.env
.env.*
!.env.example
secrets/
.superpowers/
```

`.env.example` names only safe configuration keys:

```dotenv
APP_ENV=development
APP_ORIGIN=http://localhost:3000
DATABASE_URL=postgres://tango:tango@127.0.0.1:5432/tango
BETTER_AUTH_SECRET_FILE=
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET_FILE=
GITHUB_CLIENT_ID=
GITHUB_CLIENT_SECRET_FILE=
TURNSTILE_SITE_KEY=
TURNSTILE_SECRET_FILE=
```

`apps/api/src/env.ts` parses environment variables with Zod and returns a readonly `Env`; it must fail at startup with key names but never values.

- [ ] **Step 5: Add minimal app factory and Bun entrypoint**

```ts
// apps/api/src/app.ts
import { Hono } from 'hono'

export type AppDependencies = Readonly<Record<never, never>>

export function createApp(_deps: AppDependencies) {
  return new Hono().get('/health/live', (context) =>
    context.json({ status: 'ok' as const }),
  )
}
```

`index.ts` is the only file that calls `Bun.serve`. Keep startup out of imports so tests can use `app.request()`.

- [ ] **Step 6: Install, generate the lockfile, and run baseline checks**

Run: `bun install`
Run: `bun run check`
Run: `bun run build`
Expected: all commands exit 0 and `bun.lock` records only pinned versions.

- [ ] **Step 7: Add a non-mutating GitHub Actions gate**

`.github/workflows/ci.yml` must use `oven-sh/setup-bun@v2` with `bun-version: 1.3.14`, run `bun install --frozen-lockfile`, `bun run check`, and `bun run build` on pushes/PRs. Do not add deployment credentials or deployment jobs.

- [ ] **Step 8: Create the Task commit**

Show `git status --short`, `git diff --check`, and `git diff --stat`; stage only Task 1 paths and commit `chore: Bunワークスペースと品質ゲートを初期化`. Do not push.

### Task 2: Implement shared JST, actor, and error contracts

**Files:**
- Create: `packages/shared/src/time/learning-day.ts`
- Create: `packages/shared/src/time/learning-day.test.ts`
- Create: `packages/shared/src/errors/app-error.ts`
- Create: `packages/shared/src/errors/app-error.test.ts`
- Create: `packages/shared/src/contracts/actor.ts`
- Modify: `packages/shared/src/index.ts`

**Interfaces:**
- Consumes: `Temporal` from `@js-temporal/polyfill`.
- Produces: `learningDayOf`, `formatJst`, `Actor`, `ServiceContext`, `AppError`, `ApiErrorEnvelope`, and `toApiErrorEnvelope` used by every later phase.

- [ ] **Step 1: Write boundary and error-envelope tests**

```ts
import { Temporal } from '@js-temporal/polyfill'
import { describe, expect, test } from 'vitest'
import { formatJst, learningDayOf } from './learning-day'

describe('learningDayOf', () => {
  test.each([
    ['2026-08-01T03:59:59+09:00', '2026-07-31'],
    ['2026-08-01T04:00:00+09:00', '2026-08-01'],
    ['2027-01-01T03:59:59+09:00', '2026-12-31'],
  ])('%s belongs to %s', (input, expected) => {
    expect(learningDayOf(Temporal.Instant.from(input))).toBe(expected)
  })

  test('formats an explicit JST offset', () => {
    expect(formatJst(Temporal.Instant.from('2026-08-01T03:30:00Z')))
      .toBe('2026-08-01T12:30:00+09:00')
  })
})
```

Also test that `toApiErrorEnvelope(new AppError(...), 'req-1')` exposes `code`, Japanese message, field errors, and request ID but not the cause/stack.

- [ ] **Step 2: Run focused tests and observe missing modules**

Run: `bunx vitest run packages/shared/src/time/learning-day.test.ts packages/shared/src/errors/app-error.test.ts`
Expected: FAIL because the shared modules do not exist.

- [ ] **Step 3: Implement exact time contracts**

```ts
export const PRODUCT_TIME_ZONE = 'Asia/Tokyo' as const
export const LEARNING_DAY_START_HOUR = 4 as const

export function learningDayOf(instant: Temporal.Instant): string
export function formatJst(instant: Temporal.Instant): string
export function parseJstInstant(value: string): Temporal.Instant
```

`parseJstInstant` rejects timestamps without an explicit `+09:00` offset at import/API boundaries. Implement the learning day by converting to `Asia/Tokyo`, subtracting four hours, and returning the resulting plain date.

- [ ] **Step 4: Implement actor and service context types**

```ts
export type Actor =
  | { kind: 'guest'; principalId: string; guestSessionId: string }
  | { kind: 'user'; principalId: string; userId: string }

export type ServiceContext = {
  actor: Actor
  requestId: string
  now: Temporal.Instant
}
```

- [ ] **Step 5: Implement stable application errors**

Define the Phase 1 code union `VALIDATION_FAILED | UNAUTHENTICATED | IDENTITY_SETUP_REQUIRED | ACCOUNT_NOT_LINKED | FORBIDDEN | NOT_FOUND | CONFLICT | RATE_LIMITED | INTERNAL_ERROR`. `AppError` carries an HTTP status, Japanese public message, optional `Record<string, string[]>` field errors, and an internal `cause`. Only the public fields reach JSON.

- [ ] **Step 6: Run focused and package checks**

Run: `bunx vitest run packages/shared/src`
Run: `bun --filter @tango/shared typecheck`
Expected: PASS with the three learning-day cases and error redaction covered.

- [ ] **Step 7: Create the Task commit**

After the required scope/diff/test checks, stage only Task 2 paths and commit `feat: JST学習日と共通エラー契約を追加`. Do not push.

### Task 3: Create the PostgreSQL identity schema and migration harness

**Files:**
- Create: `packages/db/drizzle.config.ts`
- Create: `packages/db/src/client.ts`
- Create: `packages/db/src/schema/auth.generated.ts`
- Create: `packages/db/src/schema/principals.ts`
- Create: `packages/db/src/schema/audit.ts`
- Create: `packages/db/src/schema/index.ts`
- Create: `packages/db/src/repositories/principal-repository.ts`
- Create: `packages/db/src/repositories/principal-repository.test.ts`
- Create: `packages/db/src/test/database.ts`
- Create: `infra/test/compose.yml`
- Create: `packages/db/migrations/0000_identity.sql`
- Modify: `packages/db/src/index.ts`
- Modify: `packages/db/package.json`

**Interfaces:**
- Consumes: Better Auth 1.6.25 generated Drizzle schema and shared `Actor`.
- Produces: `Database`, `DatabaseTransaction`, `PrincipalRepository`, identity tables, and deterministic migration commands.

- [ ] **Step 1: Start the isolated test database**

`infra/test/compose.yml` uses `postgres:18.4-bookworm`, database/user/password `tango_test`, a named test-only volume, `TZ=Asia/Tokyo`, health check `pg_isready`, and binds `127.0.0.1:55432`. It must not reuse production names or secret paths.

Run: `docker compose -f infra/test/compose.yml up -d --wait`
Expected: PostgreSQL becomes healthy on port 55432.

- [ ] **Step 2: Generate Better Auth schema with the pinned CLI**

Create `apps/api/src/features/auth/better-auth.config.ts` with the Drizzle adapter and Phase 1 social provider configuration placeholders read from validated env. Run:

```powershell
bunx @better-auth/cli@1.6.25 generate --config apps/api/src/features/auth/better-auth.config.ts --output packages/db/src/schema/auth.generated.ts
```

Review the generated file; do not hand-edit generated auth tables. Add a script that regenerates to a temporary path and fails CI if the checked-in schema differs.

- [ ] **Step 3: Write repository tests before domain tables**

Cover these cases against the real test database:

```ts
test('creates one formal principal for a user under concurrent calls')
test('promotes a guest principal when the user has no formal principal')
test('returns the existing principal when completion is retried')
test('rejects a second live guest session for the same principal')
```

Run: `bunx vitest run packages/db/src/repositories/principal-repository.test.ts`
Expected: FAIL because tables/repository/migration are absent.

- [ ] **Step 4: Define identity tables and constraints**

Use these domain shapes:

```ts
export type PrincipalKind = 'guest' | 'user'

export type PrincipalRecord = {
  id: string
  kind: PrincipalKind
  userId: string | null
  createdAt: Date
  updatedAt: Date
}

export type GuestSessionRecord = {
  id: string
  principalId: string
  tokenHash: string
  lastSeenAt: Date
  expiresAt: Date
  revokedAt: Date | null
}
```

Tables:

- `principals`: UUIDv7 PK, kind check, nullable unique Better Auth user FK with `ON DELETE CASCADE`, timestamps.
- `guest_sessions`: UUIDv7 PK, unique principal FK, unique token hash, last-seen/expiry/revocation, timestamps.
- `user_settings`: principal PK/FK, numeric desired retention default `0.9000` constrained `0.70..0.97`, boolean `show_progress_by_default` default true.
- `identity_merges`: idempotency key unique, source/target principals, status, completed timestamp.
- `audit_logs`: actor principal/user nullable with `ON DELETE SET NULL`, request ID, event type, JSON metadata with content-redaction rule, timestamp.

All instants use `TIMESTAMPTZ`; the connection startup command sets `TimeZone=Asia/Tokyo`. Use foreign keys and explicit indexes on expiry/user lookup.

- [ ] **Step 5: Generate and inspect the initial migration**

Run: `bun run db:generate`
Inspect generated SQL for unique/FK/check/index clauses and rename it deterministically to `0000_identity.sql` if Drizzle emits a random label. Do not include destructive statements.

- [ ] **Step 6: Implement transaction-aware principal repository**

```ts
export interface PrincipalRepository {
  findByUserId(userId: string): Promise<PrincipalRecord | null>
  findActiveGuestByTokenHash(tokenHash: string, now: Date): Promise<GuestSessionRecord | null>
  createGuest(input: { tokenHash: string; now: Date; expiresAt: Date }): Promise<GuestSessionRecord>
  completeIdentity(input: {
    userId: string
    guestTokenHash: string | null
    mergeKey: string
    now: Date
  }): Promise<{ principal: PrincipalRecord; outcome: 'created' | 'promoted' | 'merged' | 'existing' }>
  touchGuest(input: { sessionId: string; now: Date; expiresAt: Date }): Promise<void>
  revokeGuest(sessionId: string, now: Date): Promise<void>
}
```

`completeIdentity` is one database transaction. Use unique constraints plus retry-on-unique-conflict, not an in-memory lock.

- [ ] **Step 7: Apply migrations and run integration tests**

Run from Nushell: `with-env { DATABASE_URL: 'postgres://tango_test:tango_test@127.0.0.1:55432/tango_test' } { bun run db:migrate }`.
Run: `bunx vitest run packages/db/src/repositories/principal-repository.test.ts`
Expected: PASS, including concurrent/idempotent cases.

- [ ] **Step 8: Create the Task commit**

After the required scope/diff/test checks, stage only Task 3 paths and commit `feat: 認証主体とゲストセッションのDB基盤を追加`; retain the migration diff for the review packet. Do not push.

### Task 4: Implement secure guest start, actor resolution, and expiry job

**Files:**
- Create: `apps/api/src/features/auth/guest-service.ts`
- Create: `apps/api/src/features/auth/guest-service.test.ts`
- Create: `apps/api/src/features/auth/turnstile-client.ts`
- Create: `apps/api/src/features/auth/actor-resolver.ts`
- Create: `apps/api/src/features/auth/auth-routes.ts`
- Create: `apps/api/src/features/auth/auth-routes.test.ts`
- Create: `apps/api/src/middleware/request-context.ts`
- Create: `apps/api/src/middleware/error-handler.ts`
- Create: `apps/api/src/jobs/purge-expired-guests.ts`
- Modify: `apps/api/src/app.ts`
- Modify: `apps/api/src/env.ts`

**Interfaces:**
- Consumes: `PrincipalRepository`, `Actor`, `AppError`, Temporal clock.
- Produces: `GuestService`, `ActorResolver`, `POST /api/guest/start`, `GET /api/session`, request `ServiceContext`, and purge command.

- [ ] **Step 1: Write guest lifecycle tests with fake clock and Turnstile**

Test exact outcomes:

- valid Turnstile creates a guest, sets `tango_guest` with 90-day max age, and returns the risk notice.
- invalid Turnstile returns `VALIDATION_FAILED` without DB writes.
- the stored value is a SHA-256/HMAC-derived hash, never the raw 32-byte token.
- an active guest resolves to `Actor.kind === 'guest'`.
- a revoked/expired cookie returns `UNAUTHENTICATED` and clears the cookie.
- `touchGuest` runs at most once per learning day and extends expiry from current server time.
- production cookie has Secure/HttpOnly/SameSite=Lax and no Domain attribute.

Run: `bunx vitest run apps/api/src/features/auth/guest-service.test.ts apps/api/src/features/auth/auth-routes.test.ts`
Expected: FAIL because services/routes are absent.

- [ ] **Step 2: Define injected security interfaces**

```ts
export interface Clock {
  now(): Temporal.Instant
}

export interface TurnstileVerifier {
  verify(input: { token: string; remoteIp: string | null }): Promise<boolean>
}

export interface GuestTokenCodec {
  generate(): { rawToken: string; tokenHash: string }
  hash(rawToken: string): string
}
```

Generate 32 random bytes with Web Crypto, encode base64url, and hash with HMAC-SHA-256 using a separate guest-token pepper secret. Add `GUEST_TOKEN_PEPPER_FILE` to env example.

- [ ] **Step 3: Implement guest routes and actor middleware**

`POST /api/guest/start` accepts `{ turnstileToken: string }`, verifies before insertion, and refuses to replace a currently authenticated formal session. `GET /api/session` returns:

```ts
type SessionView =
  | { authenticated: false }
  | { authenticated: true; kind: 'guest'; expiresAt: string; warning: string }
  | { authenticated: true; kind: 'user'; user: { id: string; name: string; image: string | null }; providers: Array<'google' | 'github'> }
```

Request middleware resolves Better Auth first, then guest. A Better Auth user without a principal gets `IDENTITY_SETUP_REQUIRED` on domain routes but may call identity completion.

- [ ] **Step 4: Implement centralized error serialization**

Hono `onError` maps `AppError` to its declared status/envelope and maps unknown exceptions to `INTERNAL_ERROR`. Log request ID, code, and stack internally; never log cookie/request body. Add `requestId()` middleware before actor resolution.

- [ ] **Step 5: Implement the purge command as a finite process**

`purge-expired-guests.ts` accepts `--now=<RFC3339 +09:00>` only in test mode; production uses the injected clock. In one bounded loop, delete expired guest principals only when no formal user is attached and cascade guest-owned rows. Emit JSON counts and exit nonzero on failure. It must not run from the web process timer.

- [ ] **Step 6: Run focused and API tests**

Run: `bunx vitest run apps/api/src/features/auth apps/api/src/middleware`
Run: `bun --filter @tango/api typecheck`
Expected: PASS with cookie attributes and redaction assertions.

- [ ] **Step 7: Create the Task commit**

After the required scope/diff/test checks, stage only Task 4 paths and commit `feat: 安全なゲスト認証と期限管理を追加`. Do not push.

### Task 5: Integrate Better Auth and idempotent guest-to-user completion

**Files:**
- Modify: `apps/api/src/features/auth/better-auth.config.ts`
- Create: `apps/api/src/features/auth/better-auth.ts`
- Create: `apps/api/src/features/auth/formal-session-reader.ts`
- Create: `apps/api/src/features/auth/identity-completion-service.ts`
- Create: `apps/api/src/features/auth/identity-completion-service.test.ts`
- Create: `apps/api/src/features/auth/provider-routes.test.ts`
- Modify: `apps/api/src/features/auth/auth-routes.ts`
- Modify: `apps/api/src/app.ts`
- Modify: `packages/db/src/repositories/principal-repository.ts`
- Modify: `.env.example`

**Interfaces:**
- Consumes: Better Auth tables/session, guest cookie hash, `PrincipalRepository.completeIdentity`.
- Produces: mounted `/api/auth/*`, explicit provider link flow, `POST /api/identity/complete`, and stable formal `Actor` resolution.

- [ ] **Step 1: Write configuration and completion tests**

Assert the exported auth options have:

```ts
expect(options.baseURL).toBe('https://tango.warasugi.com')
expect(options.emailAndPassword?.enabled).toBe(false)
expect(options.account?.encryptOAuthTokens).toBe(true)
expect(options.account?.storeStateStrategy).toBe('database')
expect(options.account?.accountLinking).toMatchObject({
  enabled: true,
  disableImplicitLinking: true,
  allowDifferentEmails: true,
  allowUnlinkingAll: false,
})
expect(options.advanced?.disableCSRFCheck).toBe(false)
expect(options.advanced?.disableOriginCheck).toBe(false)
expect(options.advanced?.useSecureCookies).toBe(true)
expect(options.advanced?.defaultCookieAttributes).toMatchObject({
  httpOnly: true,
  secure: true,
  sameSite: 'lax',
  path: '/',
})
expect(options.session?.freshAge).toBe(600)
```

Service tests cover new user without guest (`created`), new user with guest (`promoted`), existing user plus guest (`merged`), repeat callback (`existing`), invalid/expired guest cookie, and a same-email unlinked provider error that never merges implicitly. Handler integration asserts formal session cookies contain Secure/HttpOnly/SameSite=Lax/Path and omit Domain; cross-subdomain cookies remain disabled.

- [ ] **Step 2: Run focused tests and observe missing integration**

Run: `bunx vitest run apps/api/src/features/auth/identity-completion-service.test.ts apps/api/src/features/auth/provider-routes.test.ts`
Expected: FAIL because Better Auth and completion service are not implemented.

- [ ] **Step 3: Configure Better Auth without beta guest support**

Use the Drizzle adapter with generated schema, `basePath: '/api/auth'`, `trustedOrigins` containing only the validated origin, Google/GitHub credentials, disabled email/password, 30-day rolling formal sessions with `freshAge: 600`, `account.encryptOAuthTokens: true`, `account.storeStateStrategy: 'database'`, enabled CSRF/origin checks, and the account-linking object from the test. Better Auth's validated secret performs its native token encryption; do not add a parallel custom encryption hook or load the anonymous plugin. User deletion remains disabled until Phase 4 installs its confirmation guard.

Mount:

```ts
app.on(['GET', 'POST'], '/api/auth/*', (context) =>
  auth.handler(context.req.raw),
)
```

The web client later calls `signIn.social({ provider, callbackURL: '/auth/complete' })`, `linkSocial`, `listAccounts`, and `unlinkAccount`. Phase 1 API tests validate the server contract; real-provider browser checks occur in the review packet using development OAuth apps.

- [ ] **Step 4: Implement identity completion as the only principal bootstrap**

```ts
export interface IdentityCompletionService {
  complete(input: {
    userId: string
    guestRawToken: string | null
    mergeKey: string
    now: Temporal.Instant
  }): Promise<{ actor: Extract<Actor, { kind: 'user' }>; outcome: 'created' | 'promoted' | 'merged' | 'existing' }>
}
```

`POST /api/identity/complete` requires a valid Better Auth session and a UUIDv7 `mergeKey`. It hashes the optional guest cookie, calls the repository transaction, clears the guest cookie only after success, and returns the formal actor/outcome. No other route auto-creates a principal.

For Phase 1 there are no deck rows yet; the repository must expose a transaction hook `moveOwnedDomainRows(sourcePrincipalId, targetPrincipalId, tx)` that currently records the merge and is extended atomically by Phase 2 migrations/tests.

- [ ] **Step 5: Expose provider account management safely**

Use Better Auth client/server methods rather than direct account-table writes. Return a Japanese `ACCOUNT_NOT_LINKED` mapping for implicit-link rejection. Disallow unlinking when only one provider remains; after linking, preserve the original Tango profile name/email.

- [ ] **Step 6: Run auth, database, and full checks**

Run: `bunx vitest run apps/api/src/features/auth packages/db/src/repositories/principal-repository.test.ts`
Run: `bun run check`
Run: `bun run build`
Expected: PASS; no beta anonymous package or email/password route appears in the built configuration.

- [ ] **Step 7: Create the Task commit**

After the required scope/diff/test checks, stage only Task 5 paths and commit `feat: GoogleとGitHubの正式アカウント連携を追加`. Do not push.

### Task 6: Complete Phase 1 verification and review packet

**Files:**
- Create: `apps/api/src/features/auth/identity-flow.integration.test.ts`
- Create: `docs/reviews/phase-1-review.md`
- Modify: `.github/workflows/ci.yml`
- Modify: `README.md`

**Interfaces:**
- Consumes: all Phase 1 commands and identity interfaces.
- Produces: reproducible CI evidence and the Phase 1 Codex review packet; no Phase 2 implementation.

- [ ] **Step 1: Add end-to-end service integration scenarios**

Using a real test PostgreSQL database plus injected fake Better Auth session reader/Turnstile, test the complete HTTP flow: start guest, resolve session, complete into new user, retry completion, start another guest and merge into existing user, and verify no raw guest token exists in DB/log captures.

- [ ] **Step 2: Add CI PostgreSQL service and migration checks**

CI uses `postgres:18.4-bookworm`, waits for health, applies migrations from empty, runs auth integration tests, regenerates Better Auth schema to compare, then runs `check` and `build`.

- [ ] **Step 3: Run the complete Phase 1 verification**

Run:

```powershell
bun install --frozen-lockfile
bun run db:migrate
bun run check
bun run build
```

Expected: all exit 0. Record exact test totals and migration name rather than writing only “passed”.

- [ ] **Step 4: Perform manual development OAuth checks**

With localhost Google/GitHub OAuth apps and secrets outside Git:

1. New Google login reaches `/auth/complete` and creates a formal principal.
2. Logged-in Google user explicitly links GitHub.
3. GitHub unlink succeeds only while Google remains.
4. Same-email unlinked provider sign-in displays the Japanese link instruction.
5. Guest data principal promotes/merges and the guest cookie clears only after success.

Capture redacted screenshots and request IDs; never include provider secrets/tokens.

- [ ] **Step 5: Write the review packet**

`docs/reviews/phase-1-review.md` must contain the Task 1–5 commit range/map, migration SQL summary, commands/results, OAuth manual outcomes, security-sensitive config names, known first-release exclusions, and the Phase 2 interfaces (`Actor`, `ServiceContext`, `PrincipalRepository`, `DatabaseTransaction`).

- [ ] **Step 6: Create the Task commit**

After the required scope/diff/test checks, stage only Task 6 paths and commit `test: 認証基盤の統合検証とレビュー資料を追加`. Do not push.

- [ ] **Step 7: Stop for Codex review**

Do not start Phase 2. Provide the packet and ask Codex to review specification fit, identity races, cookie/token handling, Better Auth configuration, migrations, and test evidence.
