# Tango Phase 1 Final Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Phase 1全体レビューのImportant 6件を解消し、Phase 2開始判定に必要な自動ゲートとレビュー資料を完成させる。

**Architecture:** 認証永続化、identity冪等性、test DB破壊境界、maintenance CLIを独立した4タスクとしてTDDで修正し、各タスクを別Sub-agentと別レビュアーで検証する。schema変更は既存migrationを書き換えず前方migrationで行い、最後に全差分を1 commitへまとめる。

**Tech Stack:** TypeScript strict、Bun 1.3.14、Hono、Better Auth 1.6.25、Drizzle ORM/PostgreSQL、Vitest、Biome。

## Global Constraints

- `C:\Users\waras\.claude\CLAUDE.md`を最優先で読む。
- 依存追加・Better Auth更新・Phase 2/4機能実装は禁止。
- `any`、`@ts-ignore`、広い型assertion、routine non-null assertionは禁止。
- product timezoneは`Asia/Tokyo`、公開timestampは`+09:00`、DB instantはTIMESTAMPTZ。
- secret、raw token、Cookie、connection URL、provider response、card/import contentをlog・fixture・commitへ入れない。
- 各タスクでRED→GREENを記録する。Task単位ではcommitせず、最終Taskで全対象を1 commitにする。pushは禁止。

---

### Task 1: Better Authのtoken保存・logger・provider identityを安全化する

**Files:**
- Modify: `apps/api/src/features/auth/better-auth.ts`
- Modify: `apps/api/src/features/auth/provider-routes.test.ts`
- Modify: `apps/api/src/features/auth/oauth-callback.integration.test.ts`
- Modify: `packages/db/scripts/auth-schema.ts`
- Modify: `packages/db/scripts/auth-schema.test.ts`
- Modify: `packages/db/src/schema/auth.generated.ts`（generator経由のみ）
- Create: `packages/db/src/schema/account-identity.test.ts`
- Create: `packages/db/migrations/0005_*.sql`
- Create/Modify: `packages/db/migrations/meta/0005_snapshot.json`, `meta/_journal.json`

**Interfaces:**
- Produces: account create/update hook that persists `idToken: null`; safe Better Auth logger; unique `(provider_id, account_id)` DB index.
- Preserves: access/refresh token encryption、same-email implicit linking拒否、TIMESTAMPTZ 12列。

- [ ] **Step 1: RED — token/logger/success callbackを追加する**

  実callback testで既知のaccess/refresh/ID tokenをprovider mockから返し、session Cookieが`Secure; HttpOnly; SameSite=Lax; Path=/`かつ`Domain`なし、DBのaccess/refreshがrawと異なり、`id_token is null`を期待する。safe logger testではsecretを含む`Error`を渡し、serialized logにsecret、message、stackが含まれないことを期待する。

- [ ] **Step 2: RED — provider identity複合一意性と変換完全性を追加する**

  2 userへ同じ`providerId/accountId`を並行insertし、1件だけ成功することを期待する。schema transform testはTIMESTAMPTZ列集合が正確に12列で、account unique indexが1件だけ生成されることを期待する。

- [ ] **Step 3: GREEN — database hookとsafe loggerを実装する**

  `databaseHooks.account.create.before`と`update.before`は元dataを保ったまま`idToken: null`を返す。loggerはlibraryのmessage/argsを使用せず、`{ component: 'better-auth', level, errorId }`だけをsinkへ渡す。

- [ ] **Step 4: GREEN — 生成変換と前方migrationを追加する**

  pinned Node CLI出力へ`uniqueIndex` importと`account_providerId_accountId_uidx`を決定的に追加し、期待timestamp列集合・件数・unique index挿入点が変わればfail closedにする。`bun run db:auth-schema`と`bun run db:generate`で生成し、既存重複を削除しないunique index migrationを作る。

- [ ] **Step 5: focused verification**

  Run: `bunx vitest run apps/api/src/features/auth/provider-routes.test.ts apps/api/src/features/auth/oauth-callback.integration.test.ts packages/db/scripts/auth-schema.test.ts packages/db/src/schema/account-identity.test.ts`

  Run: `bun run db:auth-schema:check`

  Expected: PASS、raw token/secret patternなし、`bun run db:generate`は`No schema changes`。

---

### Task 2: mergeKeyをsource guest fingerprintへbindingする

**Files:**
- Modify: `packages/db/src/schema/principals.ts`
- Modify: `packages/db/src/repositories/principal-repository.ts`
- Modify: `packages/db/src/repositories/principal-repository.test.ts`
- Modify: `apps/api/src/features/auth/identity-flow.integration.test.ts`
- Create: `packages/db/migrations/0006_*.sql`
- Create/Modify: `packages/db/migrations/meta/0006_snapshot.json`, `meta/_journal.json`

**Interfaces:**
- Produces: nullable `identity_merges.source_guest_token_hash`; replay contract `userId + guestTokenHash` exact match.
- Preserves: same key/same source response-loss retry、source principal削除、raw token非保存。

- [ ] **Step 1: RED — source mismatch matrixを追加する**

  same key/same guestは`existing`、same key/different guest、same key guest→no guest、no guest→guestは`CONFLICT`を期待する。HTTP testはconflict時に別guest Cookieを削除せず、そのguest sessionが引き続き解決できることを期待する。

- [ ] **Step 2: RED — HMAC fingerprint保存を検証する**

  merge後にsource principalが削除されても`source_guest_token_hash`が入力HMACと一致し、生tokenがDB dumpへ存在しないことを期待する。

- [ ] **Step 3: GREEN — schema/repositoryを変更する**

  `recordMerge`へ`guestTokenHash`を渡し、記録済みmergeを返す前にtarget user所有者とsource hashを完全一致比較する。不一致は既存`IdentityMergeKeyConflictError`へ倒す。

- [ ] **Step 4: GREEN — 0006前方migrationを生成する**

  nullable text列を追加する。既存記録は推測backfillせずnullのまま、新しい記録から必ず入力source fingerprintを保存する。

- [ ] **Step 5: focused verification**

  Run: `bunx vitest run packages/db/src/repositories/principal-repository.test.ts apps/api/src/features/auth/identity-flow.integration.test.ts`

  Expected: concurrency/idempotency/security tests PASS、`bun run db:generate`は`No schema changes`。

---

### Task 3: test DB destructive helperを検証済みhandleへbindingする

**Files:**
- Modify: `packages/db/src/test/database.ts`
- Modify: `packages/db/src/test/database.test.ts`
- Modify: `packages/db/src/repositories/principal-repository.test.ts`
- Modify: `packages/db/src/schema/audit.test.ts`
- Modify: `packages/db/src/schema/auth-instant-migrations.test.ts`（必要な場合のみ）
- Modify: `apps/api/src/features/auth/identity-completion-service.test.ts`
- Modify: `apps/api/src/features/auth/identity-flow.integration.test.ts`
- Modify: `apps/api/src/features/auth/oauth-callback.integration.test.ts`

**Interfaces:**
- Produces: `TestDatabaseHandle`; `resetIdentityTables(handle: TestDatabaseHandle): Promise<void>`。
- Removes: arbitrary `Database`を破壊helperへ渡せる公開契約。

- [ ] **Step 1: RED — foreign handle拒否を追加する**

  `Reflect.apply(resetIdentityTables, undefined, [foreignHandle])`がTRUNCATE前に拒否されること、検証済みhandleの`current_database()`が期待名と異なる場合に拒否することを期待する。

- [ ] **Step 2: GREEN — runtime brandとDB名再検証を実装する**

  module-private `unique symbol`をhandleへ付け、Object.freezeする。`resetIdentityTables`はbrand、期待DB名の`_test`接尾辞、`select current_database()`一致を検査後だけTRUNCATEする。URL/credentialはエラーへ出さない。

- [ ] **Step 3: GREEN — 全call siteをhandle渡しへ変更する**

  `resetIdentityTables(database().db)`を`resetIdentityTables(database())`へ限定的に置換し、通常testのDBアクセスは既存`.db`を維持する。

- [ ] **Step 4: focused verification**

  Run: `bunx vitest run packages/db/src/test/database.test.ts packages/db/src/repositories/principal-repository.test.ts packages/db/src/schema/audit.test.ts apps/api/src/features/auth/identity-completion-service.test.ts apps/api/src/features/auth/identity-flow.integration.test.ts apps/api/src/features/auth/oauth-callback.integration.test.ts`

  Expected: foreign handleは破壊前拒否、実DB suites PASS。

---

### Task 4: env・purge CLI・job logをfail closedにする

**Files:**
- Modify: `apps/api/src/env.ts`
- Modify: `apps/api/src/env.test.ts`
- Modify: `apps/api/src/jobs/purge-expired-guests.ts`
- Modify: `apps/api/src/jobs/purge-expired-guests.test.ts`

**Interfaces:**
- Produces: PostgreSQL URL validator; closed argv parser; safe purge failure serializer.
- Preserves: test-only `--now`、明示`+09:00`、production system clock。

- [ ] **Step 1: RED — DATABASE_URL値非露出を追加する**

  malformed URL、`http:`、secretを含む入力を拒否し、error textが`DATABASE_URL`だけを含みsecret/入力値を含まないことを期待する。`postgres:`と`postgresql:`は受理する。

- [ ] **Step 2: RED — closed argv matrixを追加する**

  `--nwo=...`、`unexpected`、`--nowish=...`、valid now＋未知引数を`VALIDATION_FAILED`で拒否し、引数0件と単一valid nowだけを受理する。

- [ ] **Step 3: RED — raw error log非露出を追加する**

  connection URL、token、multi-line stackを含むErrorをfailure serializerへ渡し、serialized JSONに生値がなく、job、level、errorId、安全なerrorNameだけがあることを期待する。

- [ ] **Step 4: GREEN — 最小実装を追加する**

  envのcustom refinementでURL/protocolを検査する。resolveClockはargv全体をclosed parseする。top-level catchはsafe serializerだけを`console.error`へ渡す。

- [ ] **Step 5: focused verification**

  Run: `bunx vitest run apps/api/src/env.test.ts apps/api/src/jobs/purge-expired-guests.test.ts`

  Expected: PASS、raw secret patternなし。

---

### Task 5: review資料・全ゲート・単一commit

**Files:**
- Modify: `docs/reviews/phase-1-review.md`
- Modify: `docs/reviews/phase-1-codex-review.md`
- Modify: `docs/superpowers/plans/2026-08-01-tango-01-foundation-identity.md`（逸脱表現が必要な場合のみ）
- Include: `docs/superpowers/specs/2026-08-02-tango-phase-1-final-hardening-design.md`
- Include: `docs/superpowers/plans/2026-08-02-tango-phase-1-final-hardening.md`

**Interfaces:**
- Produces: Phase 1再レビューpacket、1つの日本語Conventional Commit。

- [ ] **Step 1: Task 1〜4を別Sub-agentで独立reviewする**

  各taskは仕様適合とコード品質を分離してPASSさせ、Important findingは同じimplementerへ差し戻す。

- [ ] **Step 2: review packetを更新する**

  migration 0000〜最新、fresh test総数、Important I-1〜I-6の解決根拠、実OAuth未実施、Minor/Phase 4残余を実ファイルと出力から記録する。

- [ ] **Step 3: fresh final gatesを実行する**

  Run: `bun install --frozen-lockfile`

  Run: `bun run check`

  Run: `bun run build`

  Run: dedicated DBへの`bun run db:migrate`

  Run: `bun run db:auth-schema:check`

  Run: `bun run db:generate`

  Run: `git diff --check`とsecret/`any`/ignore scan。

  Expected: すべてPASS、実OAuth 5シナリオだけmanual gateとして残る。

- [ ] **Step 4: final branch reviewを実行する**

  base `314264f`からworktree全体をfresh reviewerへ渡し、Critical/Important 0件を確認する。

- [ ] **Step 5: stage scopeを監査する**

  `.gitignore`、`git status --short`、`git diff --stat`、`git diff --cached --name-only`を確認する。`.superpowers/`、`.claude/settings.local.json`、secret、test一時物をstageしない。

- [ ] **Step 6: 全差分を1 commitにする**

  Commit: `fix: Phase 1レビュー指摘を一括解消する`

  pushは禁止。commit後に`git status --short`と`git show --stat --oneline HEAD`を確認する。
