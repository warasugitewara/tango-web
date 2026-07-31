# Tango Phase 3 Implementation Plan: FSRS and Study UX

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development for each task and superpowers:verification-before-completion before the review gate. Execute this phase only after Phase 2 passes Codex review.

**Goal:** FSRS-6に基づく再現可能な学習状態遷移、04:00 JST基準の出題キュー、取り消し可能なレビュー履歴、ダッシュボード優先かつ即時に集中表示へ切り替えられる学習UIを完成させる。

**Architecture:** `ts-fsrs` を直接RouteやReactから呼ばず、共有契約と `FsrsScheduler` adapterを境界にする。カードごとのスケジュール更新とレビューイベント追記をPostgreSQLの同一トランザクションで行い、`scheduleVersion` と `idempotencyKey` で二重回答・多重タブ競合を検出する。日時はDBで `timestamptz`、内部計算で `Temporal.Instant`、API/JSON/CSVでRFC 3339の明示的な `+09:00`、画面と学習日の集計で `Asia/Tokyo` に統一する。

**Tech Stack:** Phase 1–2の固定スタック、ts-fsrs 5.4.1、`@js-temporal/polyfill` 0.5.1、Vitest 4.1.10、Testing Library、Playwright 1.62.1、axe-core。

**Source specification:** [Tango Spaced Repetition Web App Design](../specs/2026-08-01-tango-spaced-repetition-design.md)

---

## Entry Conditions and Locked Decisions

- Read `C:\Users\waras\.claude\CLAUDE.md` first and apply it before repository-local instructions.
- Phase 1・2のレビューゲートが通過し、`Actor`、`ServiceContext`、content repositories、full-backup v1 contractが確定していること。
- スケジューラは `ts-fsrs` のFSRS-6を使用し、希望保持率初期値は `request_retention: 0.9`（principal設定で0.70–0.97）、その他は `maximum_interval: 36500`、`enable_fuzz: true`、`enable_short_term: true`、`learning_steps: ['1m', '10m']`、`relearning_steps: ['10m']` とする。保持率変更は変更後の回答計算から反映し、既存dueを一括再計算しない。
- 評価は `Again=1`、`Hard=2`、`Good=3`、`Easy=4` の4つだけを公開する。`Manual=0` は内部復元以外のAPIで受け付けない。
- サーバー受信時刻を回答時刻のSoTにする。クライアント指定時刻は受け付けず、レスポンスに確定時刻と次回予定を返す。
- 出題優先度は「期限到来済みのlearning/relearning/review → 新規」。期限到来済み同士は状態で分断せず `dueAt ASC, cardId ASC` の安定順序とする。
- 1日の新規カード初期上限はデッキごとに20。学習日は04:00 JSTに切り替える。各デッキの上限は1–999に変更でき、全デッキ学習では対象デッキごとに消費数を判定する。
- ダッシュボード表示が標準。設定 `showDashboardByDefault=false` で進捗を標準非表示にでき、学習画面のワンタッチ切替は現在のセッションだけに効き設定値を書き換えない。
- Review eventは追記専用。Undoも元行を更新・削除せず、補償イベントを追加して直前状態を復元する。

## Phase 3 Error Codes

Task 1で共有unionへ次を追加し、このPhase中は文字列を個別に増やさない。

```ts
export type Phase3ErrorCode =
  | 'STUDY_STATE_CONFLICT'
  | 'REVIEW_ALREADY_RECORDED'
  | 'REVIEW_NOT_UNDOABLE'
  | 'REVIEW_ALREADY_UNDONE'
```

`STUDY_STATE_CONFLICT` はHTTP 409で最新 `scheduleVersion` を返す。冪等キーが同じかつpayloadが同じ再送は200で元レスポンスを返し、同じキーで異なるpayloadは `REVIEW_ALREADY_RECORDED` の409とする。

## Task Commit Map

各Taskの最終検証成功後、`.gitignore`、status、diff check、Task diff、staged paths、関連テストを確認し、そのTaskのファイルだけを次のmessageでcommitする。ユーザーは2026-08-01にこのTask単位commitを事前承認している。pushは行わない。

| Task | Commit message |
|---:|---|
| 1 | `feat(study): FSRS永続化と学習契約を追加` |
| 2 | `feat(study): FSRS-6スケジューラを追加` |
| 3 | `feat(study): 学習キューと回答トランザクションを追加` |
| 4 | `feat(study): 進捗ダッシュボードと履歴APIを追加` |
| 5 | `feat(backup): FSRS履歴の完全バックアップを追加` |
| 6 | `feat(web): ダッシュボード切替付き学習画面を追加` |
| 7 | `test(study): 学習フローのE2Eとレビュー資料を追加` |

---

### Task 1: Add study contracts, FSRS persistence, and migration invariants

**Files:**

- Create: `packages/shared/src/contracts/study.ts`
- Create: `packages/shared/src/contracts/study.test.ts`
- Modify: `packages/shared/src/contracts/index.ts`
- Modify: `packages/shared/src/errors/app-error.ts`
- Modify: `packages/shared/src/errors/app-error.test.ts`
- Create: `packages/db/src/schema/study.ts`
- Create: `packages/db/src/schema/study.test.ts`
- Modify: `packages/db/src/schema/index.ts`
- Create: `packages/db/migrations/0002_study_fsrs.sql`
- Create: `packages/db/src/repositories/study-repository.ts`
- Create: `packages/db/src/repositories/study-repository.integration.test.ts`
- Modify: `packages/db/src/repositories/principal-repository.ts`
- Modify: `packages/db/src/repositories/principal-repository.test.ts`

**Step 1: Write failing contract tests**

Define and test Zod schemas for these exact public values:

```ts
export const publicRatingSchema = z.union([
  z.literal(1), z.literal(2), z.literal(3), z.literal(4),
])

export const fsrsStateSchema = z.enum(['new', 'learning', 'review', 'relearning'])

export const scheduleSnapshotSchema = z.object({
  cardId: uuidV7Schema,
  dueAt: instantStringSchema,
  stability: z.number().finite().nonnegative(),
  difficulty: z.number().finite().min(0).max(10),
  elapsedDays: z.number().int().nonnegative(),
  scheduledDays: z.number().int().nonnegative(),
  learningSteps: z.number().int().nonnegative(),
  reps: z.number().int().nonnegative(),
  lapses: z.number().int().nonnegative(),
  state: fsrsStateSchema,
  lastReviewAt: instantStringSchema.nullable(),
  scheduleVersion: z.number().int().positive(),
  schedulerVersion: z.literal('ts-fsrs@5.4.1/fsrs-6'),
  requestRetention: z.number().finite().min(0.70).max(0.97),
}).strict()
```

Add request/response schemas for `studySessionCreate`, `studySession`, `reviewSubmit`, `reviewResult`, `reviewUndo`, `dashboardSummary`, and paginated `reviewHistory`. Assert that rating 0, client timestamps, unknown keys, invalid UUIDs, negative metrics, and absent idempotency keys fail.

Run:

```powershell
bun test packages/shared/src/contracts/study.test.ts packages/shared/src/errors/app-error.test.ts
```

Expected: failure because study contracts and Phase 3 codes do not exist.

**Step 2: Implement the smallest shared contracts**

Use strict Zod objects. `reviewSubmitSchema` is exactly:

```ts
z.object({
  sessionId: uuidV7Schema,
  cardId: uuidV7Schema,
  rating: publicRatingSchema,
  expectedScheduleVersion: z.number().int().positive(),
  idempotencyKey: z.uuid(),
  responseDurationMs: z.number().int().min(0).max(3_600_000).optional(),
}).strict()
```

`studySessionCreateSchema` accepts `{ deckIds?: UUIDv7[], mode: 'all' | 'selected' }`; `selected` requires at least one deck ID and `all` rejects a supplied list. The response includes current card content, `schedule`, four interval previews, counts (`remainingReview`, `remainingLearning`, `remainingNew`), `estimatedMinutes`, `learningDay`, and `dashboardVisible`.

`reviewUndoSchema` is strict `{ sessionId: UUIDv7, idempotencyKey: UUID }`. Undo review events use the same principal-scoped idempotency uniqueness as normal reviews.

Add Phase 3 error codes to the shared union and Japanese public messages without leaking database values.

**Step 3: Write failing schema/repository integration tests**

Tests against the disposable PostgreSQL instance must prove:

- every active card gets exactly one `card_schedules` row;
- soft-deleted cards retain schedules but are excluded from due queries;
- `(principal_id, idempotency_key)` is unique in `review_events`;
- review events cannot be updated or deleted through repository exports;
- `study_sessions` belongs to one principal and stores a stable selection scope;
- deleting a principal cascades schedules, sessions, and review events;
- merging a guest into an existing formal principal moves schedules, study sessions, review/undo events, and card references in the same identity-completion transaction without changing event order or versions, including a forced idempotency-key collision fixture;
- `schedule_version` starts at 1 and can only be advanced by compare-and-swap;
- underlying instants represented with `+09:00` values straddling 04:00 JST remain distinct `timestamptz` instants.

Run:

```powershell
bun test packages/db/src/schema/study.test.ts packages/db/src/repositories/study-repository.integration.test.ts
```

Expected: failure before migration and repository implementation.

**Step 4: Implement migration and repository boundary**

Create:

- `card_schedules`: one row per card with the snapshot fields above, `principal_id`, `created_at`, `updated_at`;
- `study_sessions`: `id`, owner, `mode`, selected deck IDs as validated `uuid[]`, `learning_day date`, `created_at`, `last_activity_at`, `completed_at`;
- `review_events`: immutable event with `kind ('review'|'undo')`, nullable `undoes_review_event_id` for an undo target, request fingerprint, before/after schedule JSON validated by the service, rating nullable only for undo, optional bounded `response_duration_ms`, `reviewed_at`, `learning_day`, scheduler/config version. Duration never affects FSRS or authoritative timestamps.

Add indexes for owner/due/state, owner/learning_day, session activity, and review history. The runtime repository exposes append/read only for `review_events`; account deletion still uses foreign-key cascade, so do not add a trigger that would block cascades. Phase 4 grants the runtime DB role INSERT/SELECT but not UPDATE/DELETE. Repository methods accept a caller transaction:

```ts
interface StudyRepository {
  ensureSchedule(tx: DbTransaction, principalId: string, cardId: string, initial: ScheduleRecord): Promise<ScheduleRecord>
  listDueCandidates(tx: DbTransaction, query: DueCandidateQuery): Promise<readonly DueCandidate[]>
  compareAndSwapSchedule(tx: DbTransaction, before: ScheduleRecord, after: ScheduleRecord): Promise<boolean>
  appendReviewEvent(tx: DbTransaction, event: NewReviewEvent): Promise<ReviewEvent>
  findReviewByIdempotencyKey(tx: DbTransaction, principalId: string, key: string): Promise<ReviewEvent | null>
  findLastUndoableReview(tx: DbTransaction, principalId: string, sessionId: string): Promise<ReviewEvent | null>
}
```

Backfill existing non-deleted cards in the migration with New-state defaults and `due_at=created_at`; the adapter in Task 2 owns semantic conversion after migration.

Extend Phase 2 `moveOwnedDomainRows` so a post-Phase-3 guest merge updates the new study tables in foreign-key-safe order inside the caller's existing identity transaction. Existing formal settings still win; source review IDs, undo links, server timestamps, and schedule versions remain unchanged. Idempotency keys also remain unless the target already owns the same key; collision rows receive a server-generated replacement UUID before ownership changes, and the audit records only the collision count. The obsolete guest cookie is invalid after merge, so remapping cannot duplicate a valid retry. A forced failure after schedule movement must roll back content and history together.

**Step 5: Verify Task 1**

Run the two focused commands again, then:

```powershell
bun run db:generate
bun run db:migrate:test
bun run typecheck
```

Expected: generated migration is empty after checked-in `0002`, clean database migrates Phase 1–3 in order, all focused tests and typecheck pass.

---

### Task 2: Isolate and characterize the FSRS-6 scheduler adapter

**Files:**

- Create: `apps/api/src/features/study/fsrs-scheduler.ts`
- Create: `apps/api/src/features/study/fsrs-scheduler.test.ts`
- Create: `apps/api/src/features/study/study-types.ts`
- Create: `apps/api/src/features/study/test-fixtures.ts`

**Step 1: Write characterization tests before adapter code**

Use fixed instants and `enable_fuzz: false` only in deterministic tests. Cover:

- New card previews contain all four public ratings and increasing sensible intervals;
- Again from New remains Learning; Good follows configured learning steps; Easy can graduate;
- Again from Review increments lapses and enters Relearning;
- all results preserve non-negative metrics; difficulty is 0 only for an untouched New card and 1–10 after a review;
- `applyRating` output equals the selected entry returned by `previewRatings` for the same snapshot/instant/config;
- converting domain snapshot → ts-fsrs card → domain snapshot is lossless for every mapped field;
- `rollback` reconstructs the exact before snapshot recorded in a review event;
- production config enables fuzz while no API accepts a fuzz flag;
- retention 0.70 and 0.97 produce characterized next intervals, while an existing due date remains unchanged until another rating is applied.

Run:

```powershell
bun test apps/api/src/features/study/fsrs-scheduler.test.ts
```

Expected: module-not-found failure.

**Step 2: Implement an explicit adapter**

Export only:

```ts
interface FsrsScheduler {
  createInitial(cardId: string, createdAt: Temporal.Instant): ScheduleSnapshot
  previewRatings(schedule: ScheduleSnapshot, now: Temporal.Instant): RatingPreviewMap
  applyRating(schedule: ScheduleSnapshot, rating: PublicRating, now: Temporal.Instant): ScheduledReview
  rollback(review: StoredReviewTransition): ScheduleSnapshot
}

export function createFsrsScheduler(config: { requestRetention: number; deterministic?: boolean }): FsrsScheduler
```

Validate `requestRetention` against the shared user-settings contract and instantiate `fsrs()` with it plus the locked config. Map Date boundaries in two small pure functions; reject invalid Date values and unrecognized ts-fsrs enum members. Persist the actual library-produced `log` fields needed for rollback and the retention that produced the transition, but do not expose `ts-fsrs` types from this module. Increment `scheduleVersion` exactly once in `applyRating`; rollback produces a new version rather than rewinding the integer.

**Step 3: Add regression fixtures**

Record a compact table of expected transitions for New, Learning, Review, Relearning at fixed instants. These are Tango-owned behavioral fixtures, not snapshots of an entire library object. A future `ts-fsrs` upgrade must intentionally update this table and the scheduler version string.

**Step 4: Verify Task 2**

Run:

```powershell
bun test apps/api/src/features/study/fsrs-scheduler.test.ts
bun run typecheck
```

Expected: all characterization tests pass and no `ts-fsrs` type crosses the adapter boundary.

---

### Task 3: Implement the 04:00 JST queue and transactional review service

**Files:**

- Create: `apps/api/src/features/study/study-service.ts`
- Create: `apps/api/src/features/study/study-service.test.ts`
- Create: `apps/api/src/features/study/study-service.integration.test.ts`
- Create: `apps/api/src/features/study/study-routes.ts`
- Create: `apps/api/src/features/study/study-routes.test.ts`
- Modify: `apps/api/src/app.ts`
- Modify: `packages/db/src/repositories/study-repository.ts`
- Modify: `packages/db/src/repositories/settings-repository.ts`

**Step 1: Write failing queue policy tests**

At fixed JST boundary values test:

- `2026-08-01T03:59:59+09:00` belongs to learning day `2026-07-31`;
- `2026-08-01T04:00:00+09:00` belongs to `2026-08-01`;
- all due learning/relearning/review cards are ordered by due instant and precede new cards;
- suspended or soft-deleted cards never appear;
- selected mode includes only owned selected decks and rejects foreign IDs;
- new card count honors each selected deck's limit and completed-new count for the current learning day; reviews do not consume the limit;
- changing desired retention does not alter stored due dates immediately and the next submitted rating records/uses the new value;
- completing in one tab and requesting next in another never returns the already-advanced version;
- an empty queue returns a successful completed session summary rather than a 404.

Run:

```powershell
bun test apps/api/src/features/study/study-service.test.ts
```

Expected: failure because the service does not exist.

**Step 2: Implement session and queue selection**

Expose service methods:

```ts
createSession(ctx: ServiceContext, input: StudySessionCreate): Promise<StudySessionView>
getSession(ctx: ServiceContext, sessionId: string): Promise<StudySessionView>
submitReview(ctx: ServiceContext, input: ReviewSubmit): Promise<ReviewResult>
undoLastReview(ctx: ServiceContext, input: ReviewUndo): Promise<ReviewUndoResult>
```

Create missing schedules lazily inside the same transaction so imported/manual cards are immediately studyable. Select candidates with `FOR UPDATE SKIP LOCKED`, apply the stable priority policy, and release locks before returning the card. Do not persist a mutable precomputed queue; every next card is derived from current schedules and session scope, avoiding stale tabs.

`dashboardVisible` is computed at session creation from `settings.showDashboardByDefault` and can be toggled only in the client session state. It is not written on each toggle.

**Step 3: Write failing idempotency and conflict integration tests**

Use two independent DB connections. Prove:

- first submit atomically updates schedule and appends event;
- identical retry with same idempotency key returns the same stored transition result and creates no row;
- changed rating with reused key returns `REVIEW_ALREADY_RECORDED` and makes no write;
- two different keys against the same expected version yield one success and one `STUDY_STATE_CONFLICT`;
- transaction rollback leaves both schedule and events untouched when event insertion fails;
- actor cannot access another principal's session/card/event;
- server `ctx.now`, not a request field or database default, is the recorded review instant;
- undo restores the last review's before state as a new schedule version and appends one undo event;
- an identical undo retry with the same key returns the stored undo result and appends no row;
- a second undo attempt with a new key returns `REVIEW_ALREADY_UNDONE`;
- no eligible review or an older review shadowed by a newer event returns `REVIEW_NOT_UNDOABLE` without writes.

Run:

```powershell
bun test apps/api/src/features/study/study-service.integration.test.ts
```

Expected: failing tests before transaction implementation.

**Step 4: Implement transactional submit and undo**

Hash the canonical tuple `(sessionId, cardId, rating, expectedScheduleVersion, responseDurationMs ?? null)` for the stored request fingerprint. In one serializable transaction: authorize ownership, check existing idempotency event, lock current schedule, load the principal's current desired retention, compare version, create the scheduler with that retention, call it, CAS update, and append the event. `ReviewResult` contains the accepted event/after-schedule only; the client obtains the next current card through `GET /api/study/sessions/:sessionId` after acknowledgement. This keeps idempotent retries stable even if other cards change. Retry PostgreSQL serialization failure at most twice with bounded zero-randomness delays in tests; surface conflict after exhaustion.

Undo first resolves an existing event by its own idempotency key. Otherwise it locks the current schedule and target event, verifies it is the newest non-undone review in the same session, restores the stored before snapshot with `scheduleVersion=current+1`, and appends the compensating event carrying the undo request fingerprint. Never delete history.

**Step 5: Add and test Hono routes**

Routes:

- `POST /api/study/sessions`
- `GET /api/study/sessions/:sessionId`
- `POST /api/study/reviews`
- `POST /api/study/reviews/undo`

Routes use the common actor middleware and Zod validators, dispatch once, and serialize shared contracts. Add route tests for 400, 401, 403/404 non-disclosure, 409, and the common error envelope.

**Step 6: Verify Task 3**

Run:

```powershell
bun test apps/api/src/features/study
bun run typecheck
```

Expected: queue, concurrency, route, and undo suites pass.

---

### Task 4: Add dashboard summary and immutable review history

**Files:**

- Create: `apps/api/src/features/study/dashboard-service.ts`
- Create: `apps/api/src/features/study/dashboard-service.integration.test.ts`
- Create: `apps/api/src/features/study/dashboard-routes.ts`
- Create: `apps/api/src/features/study/dashboard-routes.test.ts`
- Modify: `apps/api/src/features/study/study-routes.ts`
- Modify: `packages/db/src/repositories/study-repository.ts`

**Step 1: Write failing aggregate tests**

Test dashboard results for no data, reviews/new/learning counts, 7-day activity cells, 12-day streak, next due instant, estimated minutes, and deck scope. Estimated minutes use the principal's median of the latest 100 non-undone durations with an 8-second/card fallback. Include reviews at 03:59 and 04:00 JST to prove learning-day grouping. Undo events subtract the undone review from effective daily counts but remain visible in detailed history.

Run:

```powershell
bun test apps/api/src/features/study/dashboard-service.integration.test.ts
```

Expected: failure before aggregate queries exist.

**Step 2: Implement bounded queries and routes**

Add:

- `GET /api/study/dashboard?deckId=` returning due/new/learning/completed-today, 7 activity days, streak, next due;
- `GET /api/study/history?cursor=&limit=` returning reverse chronological immutable events with cursor pagination, maximum 100.

Compute learning day using stored `learning_day`; never call PostgreSQL server-local timezone conversion without explicit `Asia/Tokyo`. Queries must scope by `principal_id` first and use the Task 1 indexes. Capture `EXPLAIN (ANALYZE, BUFFERS)` with 10,000 generated events and assert no sequential scan over all principals in the review packet; the fixture generator lives only under test helpers.

**Step 3: Verify Task 4**

Run:

```powershell
bun test apps/api/src/features/study/dashboard-service.integration.test.ts apps/api/src/features/study/dashboard-routes.test.ts
bun run typecheck
```

Expected: aggregate and authorization tests pass.

---

### Task 5: Complete full-backup schedule/history portability

**Files:**

- Modify: `packages/shared/src/contracts/backup-v1.ts`
- Modify: `packages/shared/src/contracts/backup-v1.test.ts`
- Modify: `apps/api/src/features/imports/backup-service.ts`
- Modify: `apps/api/src/features/imports/backup-service.integration.test.ts`
- Modify: `packages/db/src/repositories/study-repository.ts`
- Modify: `docs/ai-import/tango-json-v1.schema.json`

**Step 1: Replace Phase 2 temporary-guard tests with failing round-trip tests**

Remove the expectation for `BACKUP_SECTION_NOT_SUPPORTED_YET`. Add fixtures containing one card in each FSRS state, study-session scope, multiple reviews, an undo, settings, tags, and trashed content. Assert export → empty-principal restore → export is semantically equal after ID remapping, including due instants, schedule/config version, original learning days, event ordering, session references, and undo links.

Run:

```powershell
bun test packages/shared/src/contracts/backup-v1.test.ts apps/api/src/features/imports/backup-service.integration.test.ts
```

Expected: failure because non-empty study sections are still rejected.

**Step 2: Implement versioned study backup sections**

The v1 format stores `studySessions`, Tango schedule domain snapshots, and review events—not raw ts-fsrs objects. Restore validates every reference before opening the write transaction, creates old→new ID maps for cards/sessions/events, preserves timestamps, and writes events in ascending sequence. Recompute no FSRS results during restore. Reject scheduler versions unknown to this binary with `VALIDATION_FAILED` and a Japanese message instructing the user to upgrade Tango.

Keep the empty-principal requirement from Phase 2. Remove `BACKUP_SECTION_NOT_SUPPORTED_YET` from the shared error union after its last test/reference is gone.

**Step 3: Verify Task 5**

Run:

```powershell
bun test packages/shared/src/contracts/backup-v1.test.ts apps/api/src/features/imports/backup-service.integration.test.ts
bun run typecheck
```

Expected: full backup round-trip passes and all references are remapped.

---

### Task 6: Build the dashboard-first study experience with focus toggle

**Files:**

- Create: `apps/web/src/features/study/api.ts`
- Create: `apps/web/src/features/study/queries.ts`
- Create: `apps/web/src/features/study/StudyRoute.tsx`
- Create: `apps/web/src/features/study/StudyRoute.test.tsx`
- Create: `apps/web/src/features/study/DashboardPanel.tsx`
- Create: `apps/web/src/features/study/DashboardPanel.test.tsx`
- Create: `apps/web/src/features/study/StudyCard.tsx`
- Create: `apps/web/src/features/study/RatingControls.tsx`
- Create: `apps/web/src/features/study/useStudySession.ts`
- Create: `apps/web/src/features/study/useStudySession.test.tsx`
- Create: `apps/web/src/features/study/ReviewHistoryRoute.tsx`
- Modify: `apps/web/src/app/router.tsx`
- Modify: `apps/web/src/features/content/SettingsRoute.tsx`
- Modify: `apps/web/src/styles/tokens.css`
- Modify: `apps/web/src/styles/global.css`

**Step 1: Write failing interaction tests**

With mocked validated API responses, assert:

- dashboard is visible by default and shows due/new/learning/completed/streak and estimated-minute values;
- setting `showDashboardByDefault=false` starts the next session in focus mode;
- desired-retention setting accepts 0.70–0.97, explains that it affects future answers, and never claims immediate bulk rescheduling;
- the `進捗を隠す` / `進捗を表示` control toggles instantly and does not call the settings mutation;
- Space reveals the back; 1/2/3/4 submit Again/Hard/Good/Easy only after reveal;
- rating controls show server-provided next intervals and are disabled while mutation is pending;
- a network failure keeps the same card and reuses the same idempotency key and frozen response duration on retry;
- a 409 refetches the session and explains that another tab advanced the card;
- undo restores the previous card/result, retries with the same undo key after a network failure, and a new second undo attempt is rejected;
- completion view retains the dashboard and offers `デッキ一覧へ`;
- Markdown output is sanitized and never renders script, iframe, event handler, or unsafe URL.

Run:

```powershell
bun test apps/web/src/features/study
```

Expected: component/module failures before implementation.

**Step 2: Implement a server-acknowledged state machine**

`useStudySession` has explicit states `loading | front | back | submitting | conflict | complete | error`. Generate one UUID review idempotency key when entering `back`, retain it through retry, and replace it only after a successful server acknowledgement. Generate a separate undo key when undo starts and likewise retain it through retry. After acknowledgement, refetch the session before showing the next card. Never optimistically advance schedules or remaining counts.

The focus toggle is session-local React state initialized from `studySession.dashboardVisible`. The persistent setting is changed only on SettingsRoute with label `学習開始時に進捗ダッシュボードを表示する`.

**Step 3: Implement responsive and accessible UI**

Use semantic buttons, one `<main>`, visible focus rings, `aria-live="polite"` for result/count changes, and a non-color label for every rating. Desktop may show dashboard above the card; narrow screens stack summary, card, and a sticky rating bar. Do not reproduce the demo image literally; use existing design tokens and keep the card content as the visual focal point.

Render safe Markdown through the Phase 2 renderer with `rehype-sanitize`; no raw HTML plugin. Respect reduced motion. Keyboard shortcuts are ignored while focus is in input/textarea/select/contenteditable or a dialog.

**Step 4: Implement history and settings integration**

History groups by learning day in JST, shows review/undo badges, rating, old→new interval, and timestamp. It does not offer event deletion. The client freezes optional response duration on the first submit and reuses it with the same idempotency key. Settings validates desired retention 0.70–0.97 and dashboard default; deck editing validates its new-card limit 1–999 through shared contracts.

**Step 5: Verify Task 6**

Run:

```powershell
bun test apps/web/src/features/study
bun run typecheck
bun run lint
```

Expected: interaction, accessibility-unit, typing, and lint checks pass.

---

### Task 7: Run cross-layer acceptance tests and produce the Phase 3 review packet

**Files:**

- Create: `e2e/study-flow.spec.ts`
- Create: `e2e/study-concurrency.spec.ts`
- Create: `e2e/study-accessibility.spec.ts`
- Create: `docs/reviews/phase-3-review-template.md`
- Modify: `README.md`

**Step 1: Write browser acceptance tests**

Against a disposable PostgreSQL database, cover:

1. guest creates a deck/card, studies with all four ratings, refreshes, and sees persisted counts;
2. formal user imports cards and studies them immediately;
3. dashboard default is visible, persistent setting hides it for a new session, one-touch toggle shows it for only the current session;
4. two pages answer the same card and one gets the recoverable conflict UI;
5. offline failure/retry creates one review event;
6. undo restores the previous schedule and appears in history;
7. activity around 04:00 JST falls on the correct learning day;
8. desktop 1440×900 and mobile 390×844 layouts have no clipped controls;
9. axe has no serious or critical violations on dashboard, front, back, conflict, and completion states.

Run:

```powershell
bun run e2e -- e2e/study-flow.spec.ts e2e/study-concurrency.spec.ts e2e/study-accessibility.spec.ts
```

Expected: all scenarios pass with traces retained only on failure.

**Step 2: Run the complete Phase 3 verification matrix**

```powershell
bun run format:check
bun run lint
bun run typecheck
bun test
bun run test:integration
bun run build
bun run e2e -- e2e/study-flow.spec.ts e2e/study-concurrency.spec.ts e2e/study-accessibility.spec.ts
git diff --check
git status --short
```

Record command, exit code, and test totals. Save screenshots for dashboard-visible desktop, focus desktop, dashboard-visible mobile, focus mobile, conflict, and completion.

**Step 3: Prepare the review packet, create the Task commit, and stop**

Fill `docs/reviews/phase-3-review-template.md` with:

- exact Task 1–6 commit range/map;
- requirement-to-test mapping;
- `0002_study_fsrs.sql` and rollback evidence;
- FSRS locked configuration and characterization fixture results;
- transaction/idempotency/concurrency evidence;
- 04:00 JST boundary evidence;
- backup study-section round-trip evidence;
- screenshots and axe report;
- known first-release limitations;
- proposed Phase 4 infrastructure inputs.

After the required Task commit checks, stage only Task 7 paths and commit `test(study): 学習フローのE2Eとレビュー資料を追加`. Do not push. Stop for Codex review; do not begin Phase 4.

## Phase 3 Exit Criteria

- Every active card has an owner-scoped FSRS schedule and no UI/API depends directly on `ts-fsrs` types.
- Review submit is atomic, idempotent, conflict-safe, and server-time authoritative.
- Undo is append-only and restores exact prior schedule semantics using a new monotonic version.
- Due/new selection and every dashboard/history grouping obey 04:00 JST.
- Dashboard-first, persistent default-hide, and session-only one-touch toggle all have browser evidence.
- Full backup round-trips cards, schedules, review/undo events, and settings into an empty principal.
- All verification commands pass and the Codex review packet is complete.
