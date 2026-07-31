# Tango Phase 2: Content and Portability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver manual deck/card/tag management, safe Markdown rendering, AI-friendly JSON/CSV contracts, duplicate preview/apply, trash, content export, and the versioned backup envelope.

**Architecture:** One `CardContent` Zod contract is used by manual APIs, import candidates, exports, and the React editor. Import is a two-stage server workflow: immutable 24-hour preview rows followed by an owner-locked transaction applying selected create/update/skip actions.

**Tech Stack:** Phase 1 stack plus React 19.2.8, Vite 8.2.0, React Router 8.3.0, TanStack Query 5.101.4, react-markdown 10.1.0, rehype-sanitize 6.0.0, csv-parse 7.0.1, csv-stringify 6.8.1, Testing Library 16.3.2.

## Global Constraints

- Read `C:\Users\waras\.claude\CLAUDE.md` first and apply it before repository-local instructions.
- Phase 1 Codex review must be clean before this plan starts.
- All rows are scoped by `ServiceContext.actor.principalId`; IDs from the client never establish ownership.
- Card `front` and `back` are required safe Markdown; raw HTML and external media embeds are rejected.
- Core JSON objects reject unknown fields; arbitrary producer fields live only under `metadata`.
- Import maximums: 10 MiB, 100 decks, 10,000 cards, 30 tags/card, 64 KiB metadata/card, four metadata nesting levels.
- Duplicate priority is `(deck, sourceKey, externalId)`, then normalized `front + back`; default action is skip.
- Updating imported content preserves scheduling/history when Phase 3 adds them.
- Delete means 30-day trash. Permanent purge is a finite maintenance command.
- The user pre-authorized one scoped Claude commit per completed Task on 2026-08-01. Verify `.gitignore`, status, diff check, Task diff, staged paths, and tests before committing. Never push without the user's authenticated environment and explicit branch instruction.

---

### Task 1: Define content, package, CSV, and backup contracts

**Files:**
- Create: `packages/shared/src/contracts/json-value.ts`
- Create: `packages/shared/src/contracts/card-content.ts`
- Create: `packages/shared/src/contracts/card-content.test.ts`
- Create: `packages/shared/src/contracts/content-package-v1.ts`
- Create: `packages/shared/src/contracts/content-package-v1.test.ts`
- Create: `packages/shared/src/contracts/csv-content.ts`
- Create: `packages/shared/src/contracts/backup-package-v1.ts`
- Create: `packages/shared/src/contracts/api/content.ts`
- Create: `packages/shared/src/contracts/api/imports.ts`
- Create: `packages/shared/src/contracts/api/exports.ts`
- Create: `packages/shared/src/generated/tango-content-v1.schema.json`
- Create: `apps/web/public/schemas/tango-content-v1.schema.json`
- Create: `packages/shared/scripts/generate-json-schema.ts`
- Modify: `packages/shared/src/index.ts`
- Modify: `packages/shared/package.json`

**Interfaces:**
- Consumes: `formatJst`, common errors, Zod 4.
- Produces: `CardContentSchema`, `ContentPackageV1Schema`, `BackupPackageV1Schema`, API request/response schemas, and generated public JSON Schema.

- [ ] **Step 1: Write failing contract fixtures**

Create tests that accept this minimal card and reject missing fields, raw HTML, unsafe URLs, excessive metadata depth/size, tags containing semicolons, and unknown core properties:

```ts
const validCard = {
  externalId: 'article-123-abundant',
  front: 'abundant',
  back: '豊富な、十分にある',
  tags: ['英語', 'B2'],
  metadata: { partOfSpeech: 'adjective' },
  source: {
    key: 'example-article-123',
    url: 'https://example.com/article',
    title: '英単語教材',
  },
}
```

Test a complete `tango.content` object with explicit `+09:00`, maximum boundaries, and `additionalProperties: false` behavior.

- [ ] **Step 2: Run focused tests and observe missing contracts**

Run: `bunx vitest run packages/shared/src/contracts/card-content.test.ts packages/shared/src/contracts/content-package-v1.test.ts`
Expected: FAIL because schemas do not exist.

- [ ] **Step 3: Implement recursive JSON and card schemas**

```ts
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { readonly [key: string]: JsonValue }

export const CardContentSchema = z.strictObject({
  externalId: z.string().trim().min(1).max(200).optional(),
  front: SafeMarkdownSchema.min(1).max(20_000),
  back: SafeMarkdownSchema.min(1).max(20_000),
  tags: z.array(TagSchema).max(30).default([]),
  metadata: BoundedJsonObjectSchema.default({}),
  source: z.strictObject({
    key: z.string().trim().min(1).max(200),
    url: HttpUrlSchema.max(2_048).optional(),
    title: z.string().trim().max(500).optional(),
  }).optional(),
})

export type CardContent = z.infer<typeof CardContentSchema>
```

`SafeMarkdownSchema` parses Markdown syntax and rejects HTML nodes, image nodes, and links whose normalized protocol is not HTTP/HTTPS. It must not rely only on string regex for rendered safety.

- [ ] **Step 4: Implement versioned package schemas**

`ContentPackageV1Schema` has `$schema`, literal `format: 'tango.content'`, literal `version: 1`, `generatedAt` validated as explicit JST, optional root source, and 1..100 decks. Each deck has optional external ID, 1..100-character name, optional 2,000-character description, and cards; total-card limit is enforced by a root refinement.

`BackupPackageV1Schema` has literal `format: 'tango.backup'`, literal version 1, JST generated time, settings, decks/cards/tags/trash, `studySessions`, `schedules`, and `reviewEvents`. Phase 2 exports/imports empty study arrays; Phase 3 fills and restores them without changing the envelope.

- [ ] **Step 5: Define exact CSV headers and API schemas**

```ts
export const CSV_HEADERS = [
  'deck',
  'front',
  'back',
  'tags',
  'external_id',
  'source_key',
  'source_url',
  'source_title',
  'metadata',
] as const
```

Define request/response schemas for deck/card CRUD, import upload metadata, preview candidate/action, apply request/result, export selection, and empty-principal backup restore. Infer all TypeScript types from these schemas.

- [ ] **Step 6: Generate and verify the public JSON Schema**

Use Zod 4 `z.toJSONSchema(ContentPackageV1Schema)` and write deterministic sorted JSON. `bun run schema:generate` updates both checked-in copies byte-for-byte; `bun run schema:check` generates to memory/temp and fails on drift or copy mismatch. Vite serves the public copy at `/schemas/tango-content-v1.schema.json` with the canonical production `$id`.

Run: `bun run schema:generate`
Run: `bun run schema:check`
Run: `bunx vitest run packages/shared/src/contracts`
Expected: PASS and generated schema declares the canonical production `$id`.

- [ ] **Step 7: Create the Task commit**

After the required scope/diff/test checks, stage only Task 1 paths and commit `feat: カードとAI取込の共通契約を定義`. Do not push.

### Task 2: Add deck, card, tag, trash, and import-preview persistence

**Files:**
- Create: `packages/db/src/schema/content.ts`
- Create: `packages/db/src/schema/imports.ts`
- Create: `packages/db/src/repositories/content-repository.ts`
- Create: `packages/db/src/repositories/content-repository.test.ts`
- Create: `packages/db/src/repositories/import-repository.ts`
- Create: `packages/db/src/repositories/import-repository.test.ts`
- Create: `packages/db/migrations/0001_content_imports.sql`
- Modify: `packages/db/src/schema/index.ts`
- Modify: `packages/db/src/repositories/principal-repository.ts`

**Interfaces:**
- Consumes: `CardContent`, `DatabaseTransaction`, Phase 1 principal merge hook.
- Produces: `ContentRepository`, `ImportRepository`, content/import tables, and principal ownership movement.

- [ ] **Step 1: Write real-PostgreSQL repository tests**

Cover:

- owner-scoped deck/card reads cannot cross principals.
- normalized same-name deck suffix selection for guest merge is deterministic.
- partial unique `(deck_id, source_key, external_id)` permits null IDs but rejects duplicate non-null IDs.
- tags normalize Unicode NFC and trimmed case-preserving display while using a normalized unique key.
- trash hides rows from normal reads and restores descendants.
- import candidate rows expire after 24 hours and action defaults to skip for duplicates.
- moving a guest principal transfers decks/tags/import ownership without leaving orphan rows.

Run: `bunx vitest run packages/db/src/repositories/content-repository.test.ts packages/db/src/repositories/import-repository.test.ts`
Expected: FAIL before schema/repositories exist.

- [ ] **Step 2: Define content tables and indexes**

Tables:

- `decks`: UUIDv7, principal FK, name, normalized name, description, sort order, new-card limit default 20, archived/trash timestamps, timestamps.
- `cards`: UUIDv7, deck FK, front/back Markdown, metadata JSONB, content hash, active/suspended status, source key/external ID/URL/title, trash timestamps, timestamps.
- `tags`: UUIDv7, principal FK, display name, normalized unique name.
- `card_tags`: card/tag composite PK and FKs.
- `import_batches`: UUIDv7, principal FK, source format, payload SHA-256, status `preview|applying|applied|expired|failed`, counts, expiry, timestamps.
- `import_candidates`: batch/ordinal unique, proposed deck/card JSONB validated before write, match type/card ID, default/current action, localized errors JSONB.

Add indexes for principal/deck/trash, card content hash, import expiry, and the partial external identity unique constraint.

- [ ] **Step 3: Implement repository interfaces**

```ts
export interface ContentRepository {
  listDecks(principalId: string): Promise<readonly DeckSummary[]>
  createDeck(principalId: string, input: CreateDeckInput): Promise<Deck>
  updateDeck(principalId: string, deckId: string, input: UpdateDeckInput): Promise<Deck>
  listCards(principalId: string, input: CardSearchInput): Promise<CardPage>
  createCard(principalId: string, deckId: string, input: CardContent): Promise<Card>
  updateCard(principalId: string, cardId: string, input: CardContent): Promise<Card>
  moveCards(principalId: string, cardIds: readonly string[], targetDeckId: string): Promise<number>
  trashCards(principalId: string, cardIds: readonly string[], now: Date): Promise<number>
  restoreTrash(principalId: string, ids: readonly string[]): Promise<number>
}
```

Every mutation checks owner in the SQL predicate/transaction; never fetch globally then authorize in application memory.

- [ ] **Step 4: Extend the Phase 1 principal merge transaction**

Implement `moveOwnedDomainRows` to move decks and tags to the target principal, rename deck collisions to `（ゲスト移行 YYYY-MM-DD）`, remap tag links to existing target tags by normalized key, discard preview/import candidate rows, then remove obsolete tag rows. Test rollback on a forced mid-merge failure.

- [ ] **Step 5: Generate, inspect, apply, and test migration**

Run: `bun run db:generate`
Run: `bun run db:migrate` against the test DB
Run: `bunx vitest run packages/db/src/repositories`
Expected: PASS; migration has no unscoped cascade from Better Auth users directly to content.

- [ ] **Step 6: Create the Task commit**

After the required scope/diff/test checks, stage only Task 2 paths and commit `feat: デッキとカードの永続化モデルを追加`; retain `0001_content_imports.sql` for the review packet. Do not push.

### Task 3: Implement manual content APIs and trash lifecycle

**Files:**
- Create: `apps/api/src/features/content/content-service.ts`
- Create: `apps/api/src/features/content/content-service.test.ts`
- Create: `apps/api/src/features/content/content-routes.ts`
- Create: `apps/api/src/features/content/content-routes.test.ts`
- Create: `apps/api/src/jobs/purge-trash.ts`
- Modify: `apps/api/src/app.ts`
- Modify: `packages/shared/src/errors/app-error.ts`

**Interfaces:**
- Consumes: `Actor`, content Zod contracts, `ContentRepository`.
- Produces: owner-scoped `/api/decks`, `/api/cards`, `/api/trash` endpoints and 30-day purge command.

- [ ] **Step 1: Write route/service tests**

Test creation/edit/duplicate/move/batch tag/batch trash/restore, Japanese validation fields, pagination, query/tag/status filters, inaccessible foreign IDs returning `NOT_FOUND`, and suspended cards remaining editable but excluded from future study.

- [ ] **Step 2: Run focused tests and observe missing routes**

Run: `bunx vitest run apps/api/src/features/content`
Expected: FAIL before service/router exists.

- [ ] **Step 3: Implement validated route contracts**

Expose:

```text
GET    /api/decks
POST   /api/decks
GET    /api/decks/:deckId
PATCH  /api/decks/:deckId
DELETE /api/decks/:deckId
GET    /api/cards
POST   /api/decks/:deckId/cards
PATCH  /api/cards/:cardId
POST   /api/cards/batch/move
POST   /api/cards/batch/tags
POST   /api/cards/batch/trash
GET    /api/trash
POST   /api/trash/restore
DELETE /api/trash/:id
```

All writes return parsed shared response schemas. Limit batch operations to 500 card IDs/request. A deck/card `DELETE` sets trash timestamps; only the trash permanent endpoint deletes one explicitly confirmed item.

- [ ] **Step 4: Implement finite trash purge**

Delete only rows whose trash timestamp is at least 30 elapsed days old. Emit JSON counts by table. Use small transactions and retry-safe selection so interruption leaves remaining rows for the next run.

- [ ] **Step 5: Run API and full package tests**

Run: `bunx vitest run apps/api/src/features/content packages/db/src/repositories/content-repository.test.ts`
Run: `bun run typecheck`
Expected: PASS with owner-boundary assertions.

- [ ] **Step 6: Create the Task commit**

After the required scope/diff/test checks, stage only Task 3 paths and commit `feat: 手動カード管理とゴミ箱APIを追加`. Do not push.

### Task 4: Implement JSON/CSV parsing and duplicate preview

**Files:**
- Create: `apps/api/src/features/imports/content-normalizer.ts`
- Create: `apps/api/src/features/imports/content-normalizer.test.ts`
- Create: `apps/api/src/features/imports/json-import-parser.ts`
- Create: `apps/api/src/features/imports/json-import-parser.test.ts`
- Create: `apps/api/src/features/imports/csv-import-parser.ts`
- Create: `apps/api/src/features/imports/csv-import-parser.test.ts`
- Create: `apps/api/src/features/imports/import-preview-service.ts`
- Create: `apps/api/src/features/imports/import-preview-service.test.ts`
- Create: `apps/api/src/features/imports/import-routes.ts`
- Modify: `apps/api/src/app.ts`

**Interfaces:**
- Consumes: content/package schemas, `ContentRepository`, `ImportRepository`.
- Produces: `POST /api/imports/preview`, `GET/PATCH /api/imports/:batchId`, deterministic candidate matches, and error download.

- [ ] **Step 1: Add valid/invalid fixture files**

Create compact fixtures under `apps/api/src/features/imports/fixtures/` for valid Japanese JSON, UTF-8 BOM CSV, embedded commas/newlines/quotes, unknown fields, invalid metadata JSON, unsafe Markdown, duplicate external ID, and content-hash duplicate.

- [ ] **Step 2: Write failing parser/normalizer tests**

Normalization rules are exact:

- Unicode NFC.
- trim outer whitespace and normalize CRLF to LF.
- preserve Markdown-significant internal whitespace.
- content hash is SHA-256 of `normalizedFront + U+001F + normalizedBack`.
- deck name matching uses NFC, trim, and locale-independent lowercase; display spelling is preserved.

Run focused tests; expect missing implementations.

- [ ] **Step 3: Implement bounded streaming parsers**

Reject request bodies over 10 MiB before parsing. JSON parser validates root/version before flattening cards. CSV parser requires the three required headers, accepts BOM, parses RFC 4180 quoting with `csv-parse`, splits semicolon tags, and parses metadata as a JSON object. Stop with a file-level error after 10,000 cards or 100 distinct decks; card-level errors remain candidates with selection disabled.

- [ ] **Step 4: Implement duplicate matching and persisted preview**

For every valid candidate:

1. Match exact deck plus non-null `(sourceKey, externalId)`.
2. Otherwise match deck plus content hash.
3. Mark no match as `create` default.
4. Mark one match as `skip` default and include before/after comparison.
5. Mark multiple content-hash matches as ambiguous `skip`; user may choose one explicit target or create.

Store payload hash and candidate rows with 24-hour expiry. A repeated preview with the same principal/payload hash may reuse the still-valid batch.

- [ ] **Step 5: Implement preview routes**

Upload uses `multipart/form-data` with exactly one file. `PATCH /api/imports/:batchId` accepts candidate action changes validated against the current match/ownership. Error download emits Japanese JSON for JSON input and UTF-8 BOM CSV for CSV input.

- [ ] **Step 6: Run parser, preview, and limit tests**

Run: `bunx vitest run apps/api/src/features/imports`
Expected: PASS for fixture matrix and 10,000/10,001 boundary.

- [ ] **Step 7: Create the Task commit**

After the required scope/diff/test checks, stage only Task 4 paths and commit `feat: JSONとCSVの取込プレビューを追加`. Do not push.

### Task 5: Apply imports atomically and implement exports/backups

**Files:**
- Create: `apps/api/src/features/imports/import-apply-service.ts`
- Create: `apps/api/src/features/imports/import-apply-service.test.ts`
- Create: `apps/api/src/features/imports/export-service.ts`
- Create: `apps/api/src/features/imports/export-service.test.ts`
- Create: `apps/api/src/features/imports/backup-restore-service.ts`
- Create: `apps/api/src/features/imports/backup-restore-service.test.ts`
- Create: `apps/api/src/features/imports/export-routes.ts`
- Modify: `apps/api/src/features/imports/import-routes.ts`
- Modify: `apps/api/src/app.ts`
- Modify: `packages/shared/src/errors/app-error.ts`
- Create: `apps/api/src/jobs/purge-import-previews.ts`

**Interfaces:**
- Consumes: persisted candidate actions and versioned package contracts.
- Produces: atomic import apply, content JSON/CSV download, `tango.backup` v1 download, and empty-principal restore.

- [ ] **Step 1: Write atomicity/idempotency tests**

Cover all-create, mixed create/update/skip, stale/expired batch, ownership violation, forced row-500 failure with total rollback, retry after applied batch returning the original result, update preserving unrelated row fields, and concurrent apply yielding exactly one result.

- [ ] **Step 2: Run focused tests and observe missing service**

Run: `bunx vitest run apps/api/src/features/imports/import-apply-service.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement apply transaction**

`POST /api/imports/:batchId/apply` accepts an idempotency key. Lock batch and principal, revalidate candidate ownership/actions, process 500-row SQL batches inside one transaction, update status/result counts, and return `{ created, updated, skipped, invalid }`. Existing card IDs survive update; do not trash absent source cards.

- [ ] **Step 4: Implement deterministic content exports**

JSON export orders decks by sort/name and cards by creation/ID, uses the production schema URL, and emits JST timestamps. CSV export uses exact headers, UTF-8 BOM, RFC 4180 quoting, semicolon tags, and compact sorted metadata JSON. Stream response generation so export does not materialize the whole library twice.

- [ ] **Step 5: Implement backup envelope and empty restore**

Phase 2 backup contains settings, content/trash, and empty `studySessions`/`schedules`/`reviewEvents` arrays. It contains no Better Auth user/provider/session/token/audit data. Restore requires `ContentRepository.countOwnedRows(principalId) === 0`, allocates new UUIDv7 IDs, remaps references, and applies in one transaction. Task 5 adds the temporary shared code `BACKUP_SECTION_NOT_SUPPORTED_YET`; if any study array is non-empty before Phase 3, return that code without writes. Phase 3 removes the guard, code, and test.

- [ ] **Step 6: Implement preview purge and run tests**

Purge only expired, non-applying batches and candidates. Run import/export/restore tests plus `bun run check`; expected PASS.

- [ ] **Step 7: Create the Task commit**

After the required scope/diff/test checks, stage only Task 5 paths and commit `feat: 取込確定とデータ出力を追加`. Do not push.

### Task 6: Build the React shell, auth completion, and manual content UI

**Files:**
- Create: `apps/web/vite.config.ts`
- Create: `apps/web/src/app/router.tsx`
- Create: `apps/web/src/app/providers.tsx`
- Create: `apps/web/src/app/api-client.ts`
- Create: `apps/web/src/app/app-shell.tsx`
- Create: `apps/web/src/app/app-shell.test.tsx`
- Create: `apps/web/src/features/auth/auth-client.ts`
- Create: `apps/web/src/features/auth/guest-start-page.tsx`
- Create: `apps/web/src/features/auth/auth-complete-page.tsx`
- Create: `apps/web/src/features/auth/account-panel.tsx`
- Create: `apps/web/src/features/content/deck-list-page.tsx`
- Create: `apps/web/src/features/content/deck-editor.tsx`
- Create: `apps/web/src/features/content/card-list-page.tsx`
- Create: `apps/web/src/features/content/card-editor.tsx`
- Create: `apps/web/src/features/content/trash-page.tsx`
- Create: `apps/web/src/features/content/content-ui.test.tsx`
- Create: `apps/web/src/components/markdown-content.tsx`
- Create: `apps/web/src/features/account/privacy-route.tsx`
- Create: `apps/web/src/features/account/privacy-route.test.tsx`
- Create: `apps/api/src/features/public/public-routes.ts`
- Create: `apps/api/src/features/public/public-routes.test.ts`
- Create: `packages/shared/src/contracts/api/public-config.ts`
- Create: `docs/privacy/ja.md`
- Create: `apps/web/src/styles/tokens.css`
- Create: `apps/web/src/styles/global.css`
- Modify: `apps/web/src/main.tsx`
- Modify: `apps/api/src/app.ts`
- Modify: `.env.example`

**Interfaces:**
- Consumes: Phase 1 session/auth endpoints and Phase 2 content contracts.
- Produces: responsive authenticated shell, guest warning/conversion, explicit provider links, public Japanese privacy/retention notice, and complete manual card/deck workflows.

- [ ] **Step 1: Write component behavior tests**

Testing Library tests cover semantic navigation, persistent guest warning/expiry, identity-completion retry, Google/GitHub buttons, last-provider unlink prevention, deck creation and per-deck new-card limit 1–999, safe Markdown preview, batch selection/move/tags/trash, keyboard focus, Japanese field errors, and a public privacy/retention route.

- [ ] **Step 2: Run focused tests and observe missing UI**

Run: `bunx vitest run apps/api/src/features/public apps/web/src/app apps/web/src/features/auth apps/web/src/features/account apps/web/src/features/content`
Expected: FAIL.

- [ ] **Step 3: Implement typed API client and route tree**

The API client takes a request Zod schema and response Zod schema, sends same-origin credentials, parses errors into `AppErrorCode`, and never exposes raw `Response` to feature components. Routes: `/`, `/auth/complete`, `/decks`, `/decks/:deckId/cards`, `/trash`, `/imports`, `/history`, `/settings`, `/privacy`.

- [ ] **Step 4: Implement auth and content flows**

Guest start sends Turnstile token. OAuth buttons use Better Auth client with `/auth/complete`. Completion posts a fresh UUIDv7 merge key and remains retryable. Account panel uses `linkSocial`, `listAccounts`, and `unlinkAccount`.

Deck/card forms use shared schemas, never raw HTML preview. `MarkdownContent` renders `react-markdown` with `rehype-sanitize`, no `rehype-raw`, and a link renderer restricted to HTTP/HTTPS with `rel="noopener noreferrer"`.

Expose public `GET /api/public/config` with only validated non-secret `privacyContactUrl`, then render `/privacy` from checked-in `docs/privacy/ja.md` plus that contact link. The Japanese notice covers provider profile fields, domain content/review data, purposes, 90-day guest expiry, 30-day trash, security-audit retention, backup aging, exports/deletion, cookies, third-party Google/GitHub/Cloudflare processing, and the operator contact. It includes no provider ID/token and remains reachable before login. Production requires an operator-supplied HTTPS `PRIVACY_CONTACT_URL`; do not invent one. Phase 4 updates the deployed notice/config check with the final 180-day default and actual backup retention before OAuth production approval.

- [ ] **Step 5: Implement design tokens and responsive shell**

Use warm neutral surfaces, deep green accent, Japanese system font stack, visible focus, no color-only status, reduced-motion query, and 320px layout. Desktop has sidebar; mobile has bottom/compact navigation. Do not create dashboard metrics until Phase 3.

- [ ] **Step 6: Run UI checks**

Run: `bunx vitest run apps/web/src`
Run: `bun --filter @tango/web typecheck`
Run: `bun --filter @tango/web build`
Expected: PASS.

- [ ] **Step 7: Create the Task commit**

After the required scope/diff/test checks, stage only Task 6 paths and commit `feat: 手動カード管理画面とアカウント導線を追加`. Do not push.

### Task 7: Build import/export UI, AI guide, and Phase 2 review packet

**Files:**
- Create: `apps/web/src/features/imports/import-page.tsx`
- Create: `apps/web/src/features/imports/import-preview-table.tsx`
- Create: `apps/web/src/features/imports/export-panel.tsx`
- Create: `apps/web/src/features/imports/import-ui.test.tsx`
- Create: `apps/web/src/features/imports/ai-import-guide-route.tsx`
- Create: `apps/web/src/features/imports/ai-import-guide-route.test.tsx`
- Create: `docs/ai-import/index.md`
- Create: `docs/ai-import/examples/valid-tango-content-v1.json`
- Create: `docs/ai-import/examples/invalid-tango-content-v1.json`
- Create: `apps/api/src/features/imports/import-flow.integration.test.ts`
- Create: `docs/reviews/phase-2-review.md`
- Modify: `README.md`
- Modify: `.github/workflows/ci.yml`
- Modify: `apps/web/src/app/router.tsx`
- Modify: `apps/web/vite.config.ts`

**Interfaces:**
- Consumes: all Phase 2 import/export routes/contracts.
- Produces: complete user import workflow, public Japanese AI format guide, schema fixture checks, and review evidence.

- [ ] **Step 1: Write import wizard tests**

Cover file selection, validation summary, disabled invalid rows, duplicate default skip, per-row and bulk action change, before/after comparison, expired preview recovery, atomic apply result, error download, JSON/CSV export, and non-empty backup restore rejection.

- [ ] **Step 2: Implement the four-step wizard**

Steps are `ファイル選択 → 検証 → 重複確認 → 完了`. Keep batch ID in URL/search state so refresh can resume a live preview. Require explicit confirmation before update actions. Do not advance on apply network failure; retry the same idempotency key.

- [ ] **Step 3: Write the Japanese AI scraping output guide**

The guide must contain:

- purpose and non-goals (Tango does not scrape or call an LLM),
- canonical schema URL,
- exact limits and field descriptions,
- complete valid/invalid examples,
- a copyable prompt requiring JSON only/no code fence/stable external IDs/one knowledge item/source/no invention,
- validation/import steps,
- copyright and user-responsibility notice.

The valid example must parse with `ContentPackageV1Schema`; the invalid example must fail for documented reasons in an automated test.

Expose the same checked-in Markdown at the public SPA route `/docs/ai-import`. `ai-import-guide-route.tsx` imports `docs/ai-import/index.md` as raw build input and renders it through the existing sanitized Markdown component. `vite.config.ts` allowlists only the exact `docs/ai-import` and `docs/privacy` directories for development reads; no arbitrary filesystem path is served. Add a route test for the canonical URL and unsafe-HTML rejection.

- [ ] **Step 4: Add full import integration and CI schema checks**

Integration test runs JSON and CSV from upload through preview/action/apply/export and compares normalized content. Browser/API acceptance fetches `/schemas/tango-content-v1.schema.json`, checks JSON content type, `$id`, and equality with the generated shared schema. CI runs `schema:check`, contract fixtures, API/web tests, typecheck, and build.

- [ ] **Step 5: Run Phase 2 verification**

```powershell
bun run schema:check
bun run db:migrate
bun run check
bun run build
```

Record test totals, import boundary timings, migration SQL, and desktop/mobile screenshots of deck/card/import screens.

- [ ] **Step 6: Write the review packet**

Document the Task 1–6 commit range/map, migration, commands, schema URL contract, duplicate semantics, UI screenshots, temporary empty schedule/review backup arrays, and exact Phase 3 interfaces.

- [ ] **Step 7: Create the Task commit and stop**

After the required scope/diff/test checks, stage only Task 7 paths and commit `feat: 取込画面とAI出力ガイドを追加`. Do not push. Stop for Codex review; do not begin FSRS implementation.
