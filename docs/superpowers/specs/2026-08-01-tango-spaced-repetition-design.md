# Tango Spaced Repetition Web App Design

- **Status:** User-approved design and written-spec review
- **Repository:** `warasugitewara/tango-web`
- **Production URL:** `https://tango.warasugi.com`
- **Target audience:** Japanese family and friends
- **Host OS:** Debian 13 recommended; Debian 12 supported

## Goal and Success Criteria

Tango is a Japanese-only, multi-user web application for memorizing vocabulary and other front/back knowledge with FSRS-based spaced repetition. Users can create cards manually, import AI-generated JSON or spreadsheet CSV, study due cards, and export their data without running scraping or an LLM inside Tango.

The first release is successful when:

- A guest can start studying without registration, receives a clear 90-day inactivity warning, and can promote or merge all data into a Google/GitHub account without losing cards or review history.
- A registered user can link both Google and GitHub explicitly and cannot accidentally merge accounts solely because emails match.
- Manual entry, JSON/CSV import, duplicate preview, portable export, and full backup restore work with Japanese content.
- The FSRS-6 review transition and immutable review history remain consistent under retries, double tabs, and stale clients.
- All business time uses `Asia/Tokyo`, and the learning day changes at 04:00 JST.
- The responsive dashboard defaults to progress-first presentation and can be temporarily collapsed into a study-first view.
- The service runs behind Cloudflare Tunnel on separate App and PostgreSQL LXC containers and has tested backup, monitoring, and rollback procedures.

## First-release Boundaries

Included:

- Generic front/back Markdown cards with tags and optional structured metadata.
- Manual deck/card management and batch operations.
- Google and GitHub OAuth; Discord is a future provider.
- Guest access with server-side data and a Host-only cookie.
- FSRS-6 with Again, Hard, Good, and Easy ratings.
- `tango.content` JSON, content CSV, and `tango.backup` JSON.
- Japanese UI, `Asia/Tokyo` timestamps, and a 04:00 JST learning-day boundary.
- Responsive desktop/mobile UI, keyboard operation, accessibility checks, and Japanese errors.

Explicitly excluded from the first release:

- Built-in scraping or LLM execution.
- Anki `.apkg` compatibility, custom note types/templates, and cloze deletion.
- Image/audio uploads or external media embeds.
- Offline study, PWA synchronization, and real-time multi-device synchronization.
- Personalized FSRS parameter optimization, bulk rescheduling, and learning-history merge into a non-empty account during backup restore.
- Email/password authentication and Discord OAuth.

## Architecture

Use a Bun workspace monorepo with these responsibility boundaries:

- `apps/web`: React/Vite SPA, React Router, TanStack Query, accessible UI, CSS design tokens, and CSS Modules.
- `apps/api`: Bun/Hono HTTP API, Better Auth integration, custom guest sessions, import/export orchestration, maintenance commands, and FSRS application services.
- `packages/shared`: Zod request/response/import schemas, generated JSON Schema, error contracts, and shared strict TypeScript types.
- `packages/db`: Drizzle PostgreSQL schema, migrations, repositories, and transaction boundaries.

Hono serves the Vite build and `/api/*` from the same origin. The application does not require cross-origin browser API access. TanStack Query owns server state; React local state owns only transient view state such as the current dashboard collapse. Do not add a global client store unless a later requirement demonstrates a need.

Use the following dependencies because their responsibilities are distinct:

- React/Vite for the stateful import preview, card management, and study interactions. Hono JSX/HTMX is the lighter alternative but was rejected because these screens need richer client state.
- Hono for the Bun HTTP boundary and typed middleware. Next.js was rejected as heavier and inconsistent with the preferred Bun/Hono stack.
- Drizzle for strict TypeScript schema/migrations without a heavyweight generated client.
- Better Auth core for OAuth, session cookies, and explicit provider links. Do not use its beta anonymous plugin; guest ownership remains an application domain concern.
- `ts-fsrs` for FSRS-6 scheduling. Do not reimplement the scheduling formulas.
- Zod as the runtime contract source; generate and check in the public JSON Schema from the same definitions.

All TypeScript uses strict mode. `any`, `@ts-ignore`, routine non-null assertions, and handwritten duplicates of generated API/import types are prohibited.

## Deployment Topology

Cloudflare terminates public TLS and routes `tango.warasugi.com` through Cloudflare Tunnel to the App LXC. No WAN port is opened.

- App LXC: Debian 13 preferred or Debian 12, unprivileged, Docker Compose, cloudflared, the Tango app, and scheduled maintenance commands. Hono listens only inside a private Docker network; no App host port is published.
- DB LXC: Debian 13 preferred or Debian 12, unprivileged, Docker Compose, PostgreSQL, pgBackRest, and backup commands.
- PostgreSQL listens only on the internal interface. Proxmox Firewall permits port 5432 only from the fixed App LXC address.
- PostgreSQL uses TLS with `sslmode=verify-full` and SCRAM-SHA-256.
- External base/service images are pinned by immutable version/digest. The Tango image is built from an exact approved Git SHA, tagged with that SHA, and its local image ID/config digest is recorded before deployment; no new registry is required for the first release.
- Secrets are Docker secret files outside the repository. `.env.example` contains names and safe defaults only.

Running Docker inside unprivileged LXC requires the minimum nesting capability supported by the operator's Proxmox version. Privileged LXC, broad host mounts, and exposed Docker sockets are prohibited. Before enabling nesting, snapshot the LXC and record the current configuration. Rollback is to stop the containers, restore the recorded LXC configuration, and restore the snapshot. If Docker/LXC compatibility proves unreliable, stop and separately propose either native systemd services or a Debian VM; neither fallback is implemented or authorized by this first-release plan.

## Identity and Authentication

Better Auth owns formal `users`, provider `accounts`, and authenticated `sessions`. Only Google and GitHub are enabled. Email/password is disabled.

- `BETTER_AUTH_URL` is `https://tango.warasugi.com`.
- OAuth callbacks are `/api/auth/callback/google` and `/api/auth/callback/github`.
- Session cookies are `Secure`, `HttpOnly`, `SameSite=Lax`, and Host-only; omit the `Domain` attribute.
- OAuth tokens are encrypted at rest with a secret provided outside the database.
- Disable implicit account linking. A signed-in user explicitly links another provider from account settings. Linking may use a provider with a different email because the existing authenticated session proves control.
- Prevent unlinking the last formal provider.

Every domain row belongs to a `principal`, not directly to a Better Auth user. A principal is either a guest or a formal user.

- Guest creation issues a 256-bit opaque token. Store only a cryptographic hash in `guest_sessions`.
- Guest cookies expire after 90 days of inactivity. Refresh last-seen and cookie expiry at most once per learning day to avoid excessive writes.
- Always show a concise guest-risk notice and account-link/export action. Show an expiry warning when 30 days or less remain.
- A guest promoted to a new OAuth user keeps the same principal, so no learning rows move.
- When a guest authenticates into an existing formal user, transactionally move the guest's decks and all descendants to the formal principal. Existing formal settings win. Rename colliding decks with `（ゲスト移行 YYYY-MM-DD）`. Discard unconfirmed import previews, invalidate the guest cookie, and delete the old guest principal only after the transfer succeeds.
- Give merge attempts an idempotency key so OAuth retries cannot duplicate data.
- A daily maintenance command purges inactive guests; no in-process timer performs retention deletion.

## Domain Model

Core tables and responsibilities:

- `principals`: guest/formal ownership and lifecycle.
- Better Auth `users`, `accounts`, `sessions`, and verification tables.
- `guest_sessions`: token hash, last seen, expiry, and revocation.
- `user_settings`: desired retention and dashboard default visibility. There is no user timezone field.
- `decks`: owner, name, description, sort order, new-card daily limit, archive/trash timestamps.
- `cards`: deck, front/back Markdown, metadata JSON, normalized content hash, status, source key/external ID, source URL/title, and trash timestamps.
- `tags` and `card_tags`: normalized tag storage and many-to-many assignment.
- `card_schedules`: the one-to-one FSRS state, due time, stability, difficulty, elapsed/scheduled days, repetitions, lapses, learning steps, last review, scheduler/parameter versions, and optimistic-lock version.
- `study_sessions`: owner, all/selected-deck scope, learning day, activity/completion timestamps, and no copied mutable queue.
- `review_events`: append-only review and compensating undo events with the before/after scheduling snapshot, rating, server review time, idempotency key, and optional bounded response duration used only for time estimates.
- `import_batches` and `import_candidates`: expiring validation preview, proposed action, matched card, and localized errors.
- `audit_logs`: authentication, provider link, merge, import, export, deletion, and administrative security events. Never store card/import content, session secrets, or OAuth tokens in audit logs.

Use UUIDv7 identifiers generated by the application. Use foreign keys and database constraints for ownership and lifecycle invariants. A partial unique index enforces non-null `(deck_id, source_key, external_id)` identity. Derive dashboard statistics from review logs; do not make a second mutable source of truth.

Deck and card deletion moves rows to a 30-day trash. Restore preserves the schedule and history. The purge command cascades only after the retention deadline. Account deletion requires a fresh OAuth authentication and explicit confirmation, then deletes domain and auth rows. Encrypted backups age out through the backup retention policy.

## Time Rules

- Fixed product timezone: `Asia/Tokyo`.
- PostgreSQL date-time columns use `TIMESTAMPTZ`; database/application sessions use `Asia/Tokyo` for formatting and business calculations.
- JSON and CSV timestamps use RFC 3339 with an explicit `+09:00` offset, for example `2026-08-01T12:30:00+09:00`.
- Never use `timestamp without time zone` for an instant.
- The learning day runs from 04:00:00 JST through 03:59:59.999... JST the next calendar day.
- Streaks, daily new-card limits, dashboard totals, and maintenance reporting use the learning day. Guest inactivity uses elapsed time, not the learning-day label.
- Review timestamps are server-generated. Client clocks are not authoritative.

## Scheduling and Study Sessions

Use FSRS-6 with default desired retention `0.90`, configurable per principal. A change affects reviews calculated after the change; first release does not bulk-reschedule existing due dates or optimize personal parameters.

Queue rules:

- Offer all-deck study and selected-deck study.
- Due review/relearning cards come before new cards, ordered by due time.
- The default new-card limit is 20 per learning day and can be overridden per deck.
- Do not impose a low artificial review cap; show backlog size and estimated time.

When serving a card, the API calculates all four rating previews. A review submission contains `cardId`, `scheduleVersion`, rating `1..4`, and a unique idempotency key. It does not contain an authoritative review time.

In one PostgreSQL transaction:

1. Authorize the principal/session/card relationship.
2. Return the prior result for an already-used idempotency key before comparing the now-advanced schedule.
3. Lock and verify the current schedule version.
4. Apply the selected FSRS result.
5. Update `card_schedules` with an incremented version.
6. Append the review event containing before/after state.
7. Return the saved transition result; after acknowledgement, the client reloads the session to obtain the next card.

A stale version returns `409 STUDY_STATE_CONFLICT` and reloads the current state. The client never advances before the server acknowledges the review. Network retries reuse the same idempotency key. A one-step undo appends a compensating event and restores the prior snapshot only when no later review exists for that card/session.

## Content and Import/Export Contracts

Card content requires `front` and `back` safe Markdown, up to 20,000 characters each. Raw HTML is rejected. Rendering never enables raw HTML and uses an allowlisted/sanitized Markdown component. Optional fields are tags, JSON metadata, and source information. Media attachments and embeds are not supported.

### `tango.content` version 1

- Public schema URL: `https://tango.warasugi.com/schemas/tango-content-v1.schema.json`
- Japanese guide URL: `https://tango.warasugi.com/docs/ai-import`

The root contains `$schema`, `format: "tango.content"`, `version: 1`, a `generatedAt` JST timestamp, optional source metadata, and `decks`. Each deck contains a name, optional description/external ID, and cards. Each card contains front/back, optional tags/metadata/external ID/source.

Core objects reject unknown properties. Arbitrary producer fields belong under `metadata`. The AI guide provides the schema, valid/invalid complete examples, and a copyable prompt requiring JSON-only output, no code fence, stable deterministic external IDs, one knowledge unit per card, preserved sources, and no invented facts.

### CSV content format

Use UTF-8 with BOM and RFC 4180 comma quoting. Required columns are `deck`, `front`, and `back`. Optional columns are `tags`, `external_id`, `source_key`, `source_url`, `source_title`, and `metadata`. Tags are semicolon-separated; semicolons are not valid inside a tag. `metadata` is a JSON object encoded inside the CSV cell. CSV never contains schedules or review history.

### `tango.backup` version 1

Full backup includes settings, decks/cards/tags, trash, study-session references, FSRS schedules, and all review events. It excludes provider IDs, authentication sessions, cookies, secrets, OAuth tokens, and audit logs. First-release restore is permitted only into an empty principal. Restore creates new internal IDs and remaps every reference in one transaction. Restoring schedules/history into a non-empty principal is a future feature.

### Import validation and duplicate preview

- Maximum 10 MiB, 100 decks, and 10,000 cards per file.
- Deck name 100 characters; description 2,000.
- Maximum 30 tags per card and 50 characters per tag.
- Metadata maximum 64 KiB serialized and four nesting levels.
- Source URLs allow only HTTP/HTTPS and at most 2,048 characters.
- Reject control characters, raw HTML, dangerous URL schemes, invalid core fields, and excessive limits.
- Match `(source_key, external_id)` first, then normalized `front + back` content hash.
- Preview create/update/skip per candidate; duplicate default is skip.
- Invalid candidates cannot be selected and can be downloaded as localized JSON/CSV errors.
- Apply selected valid candidates atomically, using internal batches of 500 rows inside one transaction.
- Updating content never resets the schedule or deletes review history.
- Preview rows expire after 24 hours.

## User Experience

The default desktop/mobile experience is progress-first, based on direction B from the design comparison without copying the reference image's blue visual language. Use warm neutral surfaces, a deep green accent, restrained metrics, Japanese typography, and clear keyboard focus.

Primary screens:

- Dashboard: today's completed/due/new counts, seven-day activity, streak, deck starts, and all-deck study.
- Study: front, reveal, four Japanese rating buttons with server-provided intervals, progress, time estimate, one-step undo, and keyboard controls (`Space`, `1`-`4`).
- Deck/card management: create/edit/duplicate/move/trash, search/filter, batch movement/tags/deletion, and new-card limits.
- Import wizard: select, validate, compare duplicates/actions, apply, and download errors.
- History: learning-day, rating, deck, and per-card review history.
- Settings/account: default progress visibility, retention, provider link/unlink, exports/backups, trash, guest conversion, and account deletion.

Progress is visible by default. A header control collapses/expands it for the current study session without changing settings. The persistent setting controls the initial state; even when disabled, the header can temporarily show the dashboard. On mobile, progress is a compact collapsible section above the card.

All errors are Japanese and include a recovery action when possible. The shared error envelope contains `code`, localized `message`, optional `fieldErrors`, and `requestId`. Never expose stack traces or SQL. Preserve the current card during network failure, retry with the same idempotency key, preserve guest data after OAuth failure, and explain that an expired/lost guest cookie may be unrecoverable.

Meet keyboard navigation, visible focus, ARIA labeling, non-color-only state, reduced-motion preference, responsive 320px+ layout, and automated axe checks.

## Security and Abuse Controls

- Cloudflare WAF plus application limits protect auth, guest creation, and import endpoints.
- Cloudflare Turnstile is required when creating a guest identity.
- Mutating API routes require same-origin checks and an application CSRF token; Better Auth protects its own auth routes.
- Apply strict security headers: same-origin CSP baseline, frame/object denial, minimal permissions policy, and conservative referrer policy.
- Reject unsafe Markdown and URL schemes before persistence and again at render boundaries.
- Use parameterized Drizzle queries, bounded request bodies, and structured validation.
- Redact secrets and content from logs; correlate with generated request IDs.
- Store only necessary provider profile fields and publish Japanese privacy/retention guidance before production OAuth approval.

## Backup, Monitoring, and Operations

Backup has two independent layers:

- pgBackRest archives WAL continuously to a separate failure domain and creates weekly full plus daily differential backups. Target RPO is 15 minutes and RTO is 2 hours.
- An authenticated-encrypted logical `pg_dump` runs daily at 02:00 JST for portability. Retain 7 daily, 4 weekly, and 6 monthly copies.

The backup repository must be PBS, NAS, or another host, never only the DB LXC or the same local Proxmox storage. Restore into an isolated PostgreSQL instance quarterly and record duration/result. Monitor WAL archive age and last successful logical backup.

Uptime Kuma checks the public live/ready endpoints and Google/GitHub OAuth start paths through the Tunnel. Zabbix monitors App/DB LXC resources, containers, PostgreSQL capacity/connections/long queries, WAL lag, backup freshness, cloudflared, and maintenance job results. Send outage, DB-unready, and backup-delay alerts to Discord immediately; send capacity/certificate warnings at warning severity and send recovery notices.

`/health/live` reports process liveness only. `/health/ready` checks database connectivity and migration compatibility without exposing details.

Deploy only after a verified backup. Use expand/migrate/contract migrations and never ship destructive schema cleanup with the application version that stops using the old schema. Keep the prior Git-SHA image. Application rollback selects the prior image while compatible schema remains. Firewall/Tunnel changes require configuration backup and LXC snapshot; document purpose, benefit, risk, and exact rollback before applying.

## Verification and Acceptance

Required automated coverage:

- Unit: FSRS mapping and state transitions, all four ratings, same-day reviews, 03:59/04:00 JST boundary, normalization/deduplication, validation, and guest expiry.
- Integration against PostgreSQL: transaction/idempotency conflicts, principal promotion/merge, trash/purge, import atomicity, migrations, Better Auth adapter behavior, and backup restore mapping.
- Contract fixtures: valid/invalid JSON Schema examples, CSV quoting/BOM/Japanese content, limits, unsafe Markdown/URLs, and the 10,000-card boundary.
- Playwright E2E: guest start, manual card creation, dashboard collapse/default, study/retry/undo, import preview/apply, export, account conversion, provider-link mock, and trash restore.
- Security/accessibility: CSRF/origin, rate limits, cookie flags, XSS payloads, axe, keyboard-only flow, reduced motion, and desktop/mobile visual snapshots.
- Operations: clean and previous-version migration, Debian 12/13 Compose boot and health, pgBackRest/PITR exercise, logical backup restore, and application rollback rehearsal.

No milestone is complete with hidden type errors, skipped relevant tests, unresolved critical/high security findings, untested migrations, or undocumented production settings.

## Claude Implementation and Codex Review Gates

Claude implements in four milestones and stops after each:

1. Foundation and identity: workspace, Compose, database, principal/guest lifecycle, Better Auth Google/GitHub, and account linking/merge.
2. Content and portability: decks, cards, tags, manual editing, JSON/CSV contracts, duplicate preview, content export, and full backup/empty restore.
3. FSRS and study UX: scheduler persistence, review/undo transactions, queues, dashboard, history, and responsive/accessibility behavior.
4. Production operations: Tunnel contract, security hardening, maintenance, pgBackRest/pg_dump, health, Zabbix/Uptime Kuma/Discord guidance, deployment, and rollback documentation.

At every gate Claude supplies the Task commit range, summary, migration diff, test commands/results, UI screenshots, known limitations, and next milestone's interface changes. The user pre-authorized one scoped Claude commit per completed Task on 2026-08-01; each commit still requires `.gitignore`, status, diff, staged-path, and test verification. After a clean Codex phase review, normal push requires the user's authenticated environment and explicit branch authorization. Force push, history rewriting, and production changes always require separate approval. Commit messages are Japanese Conventional Commits. Claude reads `C:\Users\waras\.claude\CLAUDE.md` first and applies it before repository-local instructions.

Codex performs read-only review at each gate, reporting P0-P3 findings for specification fit, type safety, data loss, authentication/ownership boundaries, security, migrations, and test evidence. Claude makes fixes; Codex re-reviews until findings are resolved. The final readiness review includes an actual restore/migration/rollback evidence check.

## References

- [Anki FSRS options](https://docs.ankiweb.net/deck-options.html)
- [Open Spaced Repetition ts-fsrs](https://github.com/open-spaced-repetition/ts-fsrs)
- [Hono Better Auth example](https://hono.dev/examples/better-auth)
- [Better Auth user/account linking](https://better-auth.com/docs/concepts/users-accounts)
- [Debian releases](https://www.debian.org/releases/)
