# Tango Implementation Plan Index

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement one phase at a time. Do not begin the next phase until its Codex review gate passes.

**Goal:** `tango.warasugi.com`向けの日本語FSRS暗記Webアプリを、4つの独立レビュー区切りで安全に実装する。

**Architecture:** Bun workspaceでReact/Vite SPA、Hono API、共有Zod契約、Drizzle/PostgreSQLを分離する。Cloudflare Tunnel配下のApp LXCと、内部ネットワークだけで接続するDB LXCへDocker Composeで配置する。

**Tech Stack:** Bun 1.3.14、TypeScript 7.0.2、React 19.2.8、Vite 8.2.0、Hono 4.12.33、Better Auth 1.6.25、Drizzle ORM 0.45.2、PostgreSQL 18.4、ts-fsrs 5.4.1、Zod 4.4.3。

## Plan Set

1. [Phase 1: Foundation and Identity](./2026-08-01-tango-01-foundation-identity.md)
2. [Phase 2: Content and Portability](./2026-08-01-tango-02-content-portability.md)
3. [Phase 3: FSRS and Study UX](./2026-08-01-tango-03-fsrs-study-ux.md)
4. [Phase 4: Production Operations](./2026-08-01-tango-04-production-operations.md)

Source specification: [Tango Spaced Repetition Web App Design](../specs/2026-08-01-tango-spaced-repetition-design.md)

## Requirement Traceability

| Approved requirement | Owning implementation tasks | Acceptance evidence |
|---|---|---|
| Japanese-only multi-user, Google/GitHub, guest promotion/merge | Phase 1 Tasks 3–6; Phase 2 Task 6 | identity transaction tests, provider manual checks, guest conversion E2E |
| Generic front/back, safe Markdown, manual editing, trash | Phase 2 Tasks 1–3 and 6 | contract/API/UI tests, XSS fixtures, 30-day restore/purge tests |
| AI-produced JSON/CSV import, duplicate preview, output guide | Phase 2 Tasks 1, 4, 5, 7 | schema fixtures, atomic apply tests, `/docs/ai-import` route, export round-trip |
| FSRS-6, four ratings, configurable retention, retry/undo | Phase 3 Tasks 1–3 and 5 | characterization, concurrency/idempotency, append-only undo, backup round-trip |
| 04:00 JST learning day and all business time in Asia/Tokyo | Phase 1 Task 2; Phase 3 Tasks 1, 3, 4; Phase 4 Tasks 3–5 | 03:59/04:00 tests, dashboard/history/maintenance evidence |
| Dashboard-first, persistent default-hide, one-touch session toggle | Phase 3 Task 6 | component and desktop/mobile browser tests |
| `tango.warasugi.com`, Cloudflare Tunnel, no WAN App/DB exposure | Phase 4 Tasks 1, 2, 6, 7 | Compose policy, network table, security E2E, staged runbook |
| Debian 13 preferred and Debian 12 supported on separate App/DB LXC | Phase 4 Tasks 2 and 7 | non-privileged LXC preflight and two-version boot/health evidence |
| pgBackRest/WAL, pg_dump, RPO 15 min/RTO 2 h | Phase 4 Task 4 | isolated corruption/PITR/logical restore drill and measured duration |
| Uptime Kuma, Zabbix, Discord operations | Phase 4 Task 5 | health tests, check self-test, redacted notification/runbooks |
| Claude Task commits and Codex phase reviews | Every Task; each phase final Task | Task-to-commit map, exact range, review packet, no push without user instruction |

## Execution Rules

- Read `C:\Users\waras\.claude\CLAUDE.md` completely before any implementation action and apply it before this repository's specification, plans, and README. Stop and ask if it conflicts with a higher-level instruction.
- Before Phase 1, if this approved plan set is still untracked, inspect and stage only the design, index, and four Phase files under `docs/superpowers`, verify no other path is staged, and create the baseline commit `docs: Tango設計と段階別実装計画を追加`. This is the only pre-Phase commit and is covered by the user's 2026-08-01 Claude commit authorization. Do not include generated visualization files or push it.
- Execute phases and tasks in numeric order. Later plans consume exact interfaces produced by earlier plans.
- At the end of each phase, stop and provide the review packet defined in that plan. Do not silently continue.
- The user pre-authorized Claude on 2026-08-01 to create one scoped commit after every completed Task. Before each commit inspect `.gitignore`, `git status --short`, `git diff --check`, the Task diff, staged paths, and relevant passing tests; commit only that Task with its mapped Japanese Conventional Commit message.
- Do not push per Task. After a Phase passes Codex review, Claude presents the reviewed commit range/branch and asks the user to authenticate and authorize one normal push; only then may Claude push that named branch. Never force-push, rewrite history, open a PR, run production migrations, or change Cloudflare/Proxmox without separate explicit approval.
- Use TDD for domain behavior: failing focused test, observed failure, minimal implementation, passing focused test, then the phase-wide verification command.
- Preserve strict TypeScript. Never add `any`, `@ts-ignore`, broad type assertions, routine non-null assertions, or duplicate handwritten types for a Zod-generated contract.
- Do not add dependencies beyond the pinned list without explaining reason, benefit, disadvantage, alternative, and obtaining user approval.
- Use Nushell or shell-neutral Bun/Docker commands in host documentation. Host automation is TypeScript executed by Bun; POSIX shell is limited to scripts that execute inside Debian containers/LXC.

## Pinned Runtime and Packages

Resolve these exact versions in `bun.lock`; production container references must also be pinned to immutable digests during Phase 4.

| Package | Version |
|---|---:|
| `bun` / `@types/bun` | `1.3.14` |
| `typescript` | `7.0.2` |
| `hono` | `4.12.33` |
| `@hono/zod-validator` | `0.9.0` |
| `react` / `react-dom` | `19.2.8` |
| `@types/react` | `19.2.18` |
| `@types/react-dom` | `19.2.4` |
| `vite` | `8.2.0` |
| `@vitejs/plugin-react` | `6.0.5` |
| `react-router` | `8.3.0` |
| `@tanstack/react-query` | `5.101.4` |
| `react-markdown` | `10.1.0` |
| `rehype-sanitize` | `6.0.0` |
| `better-auth` / `@better-auth/drizzle-adapter` | `1.6.25` |
| `drizzle-orm` | `0.45.2` |
| `drizzle-kit` | `0.31.10` |
| `postgres` | `3.4.9` |
| `zod` | `4.4.3` |
| `ts-fsrs` | `5.4.1` |
| `@js-temporal/polyfill` | `0.5.1` |
| `uuid` | `14.0.1` |
| `csv-parse` | `7.0.1` |
| `csv-stringify` | `6.8.1` |
| `vitest` | `4.1.10` |
| `@testing-library/react` | `16.3.2` |
| `@testing-library/user-event` | `14.6.1` |
| `jsdom` | `30.0.1` |
| `@playwright/test` | `1.62.1` |
| `@axe-core/playwright` | `4.12.1` |
| `@biomejs/biome` | `2.5.6` |

Infrastructure baseline:

- App/DB LXC host: Debian 13; Debian 12 compatibility verification required.
- PostgreSQL image: `postgres:18.4-bookworm`; Phase 4 records the multi-architecture digest in the deployment environment file.
- Public origin: `https://tango.warasugi.com` only.
- Product timezone: `Asia/Tokyo`; learning-day boundary: `04:00 JST`.

## Locked File Structure

```text
apps/
  api/
    src/
      app.ts                 # middlewareとfeature routerの合成のみ
      index.ts               # Bun.serve起動のみ
      env.ts                 # Zod検証済み環境変数
      features/
        auth/                # Better Auth、actor解決、guest、merge
        content/             # decks/cards/tags/trash
        imports/             # preview/apply/export/restore
        study/               # FSRS、queue、review、dashboard/history
      middleware/            # error、request-id、csrf、rate-limit、audit
      jobs/                  # guest/trash/import purgeなどの明示コマンド
  web/
    src/
      app/                   # router、providers、app shell
      features/
        auth/
        content/
        imports/
        study/
      components/            # feature非依存UIのみ
      styles/                # design tokenとglobal CSS
packages/
  shared/
    src/
      contracts/             # ZodをSoTとするAPI/import契約
      errors/                # ApiError code/envelope
      time/                  # Asia/Tokyo・04:00ルール
  db/
    src/
      schema/                # responsibility別Drizzle table
      repositories/          # transaction-aware repositories
      client.ts
    migrations/
infra/
  app/                       # App/cloudflared ComposeとDockerfile
  db/                        # PostgreSQL/pgBackRest Composeと設定
  test/                      # integration test PostgreSQL
docs/
  ai-import/                 # 日本語AIスクレイピング出力ガイド
  operations/                # deploy、backup、restore、monitor、rollback
```

Feature files must remain responsibility-focused. Route files validate/authorize/dispatch only; business transactions live in services; SQL access lives in repositories. React route components compose hooks/components but do not call `fetch` directly.

## Cross-phase Public Interfaces

Phase 1 produces this base union:

```ts
export type Actor =
  | { kind: 'guest'; principalId: string; guestSessionId: string }
  | { kind: 'user'; principalId: string; userId: string }

export type AppErrorCode =
  | 'VALIDATION_FAILED'
  | 'UNAUTHENTICATED'
  | 'IDENTITY_SETUP_REQUIRED'
  | 'ACCOUNT_NOT_LINKED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'RATE_LIMITED'
  | 'INTERNAL_ERROR'

export type ServiceContext = {
  actor: Actor
  requestId: string
  now: Temporal.Instant
}
```

Error-code lifecycle is explicit: Phase 2 temporarily adds `BACKUP_SECTION_NOT_SUPPORTED_YET`; Phase 3 removes it when study backup restore becomes supported and adds `STUDY_STATE_CONFLICT | REVIEW_ALREADY_RECORDED | REVIEW_NOT_UNDOABLE | REVIEW_ALREADY_UNDONE`; Phase 4 adds `PAYLOAD_TOO_LARGE`. `STUDY_SESSION_EMPTY` is not an error—an empty queue returns a successful completed session.

Phase 2 adds content/import contracts and repository interfaces. Phase 3 consumes those interfaces and adds study/review contracts; it must not reach into auth or import internals. Phase 4 hardens and deploys the same public interfaces without changing product behavior.

## Review Gates

Every phase review packet contains:

1. Exact Task commit range and a Task-to-commit map.
2. Requirement-to-task checklist.
3. Migration names and SQL diff.
4. Commands run, exit codes, and relevant test totals.
5. Desktop/mobile screenshots for changed UI.
6. Security-sensitive decisions and secrets/configuration names added.
7. Known limitations that are explicitly inside the design's first-release exclusions.
8. Proposed interfaces for the next phase.

Codex reports P0-P3 findings. Claude fixes findings and returns the same packet with new evidence. Only a clean review advances the index.
