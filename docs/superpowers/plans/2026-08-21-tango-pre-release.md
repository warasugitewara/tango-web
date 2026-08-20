# Tango プレリリース Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ログイン導線を一切出さないまま、デッキ・カード・FSRS復習が実際に使えるプレリリースを `tango.warasugi.com` へ出せる状態にする。

**Architecture:** 確定済みの最終スキーマのままテーブルと列を作り、UIと機能だけを削る。復習取引だけは楽観ロック・冪等キー・追記専用イベントを最初から完全実装する。SPAはAPIと同一オリジンで配信する。

**Tech Stack:** Bun 1.3.14、TypeScript 7.0.2 strict、Hono 4.12.33、Drizzle ORM 0.45.2、PostgreSQL 18.4、Zod 4.4.3、ts-fsrs 5.4.1、React 19.2.8、react-router 8.3.0、@tanstack/react-query 5.101.4、react-markdown 10.1.0、rehype-sanitize 6.0.0、csv-parse 7.0.1、Vitest 4.1.10、@testing-library/react 16.3.2。

**Spec:** `docs/superpowers/specs/2026-08-21-tango-pre-release-design.md`（上位仕様は `docs/superpowers/specs/2026-08-01-tango-spaced-repetition-design.md`）

## Global Constraints

- `C:\Users\waras\.claude\CLAUDE.md` を最優先で読む。
- product timezone は `Asia/Tokyo`。公開する日時は `+09:00` を明示した RFC 3339。DB の instant は必ず `TIMESTAMPTZ`。学習日は 04:00:00 JST 起点。
- `any`、`@ts-ignore`、広い型 assertion（`as unknown as` を含む）、routine な非null assertion は禁止。
- ピン留めリスト外の依存を追加しない。追加してよいのは spec の「依存」表にある8件のみ。
- secret、raw token、Cookie 値、接続URL、カード本文を log・エラー・fixture・commit へ入れない。
- migration は前方専用。既存の `0000`〜`0006` を書き換えない。新規は `0007` から。
- 所有権の検査は SQL の述語かトランザクション内で行う。全件取得後にアプリケーションメモリで認可しない。
- 各 Task は RED → GREEN を記録し、Task ごとに日本語 Conventional Commit を1件作る。**push は禁止。**
- テストDBは `postgres://tango_test:tango_test@127.0.0.1:55432/tango_test`。停止していれば `infra/test/compose.yml` で起動する。
- 既存の `packages/shared` は1関数1行の named export を `src/index.ts` に並べる流儀。追加もこれに合わせる。

## File Structure

| ファイル | 責務 |
| --- | --- |
| `packages/shared/src/contracts/content.ts` | デッキ・カード・取り込みの Zod 契約 |
| `packages/shared/src/contracts/study.ts` | 学習セッション・レビューの Zod 契約 |
| `packages/db/src/schema/content.ts` | `decks` / `cards` テーブル定義 |
| `packages/db/src/schema/study.ts` | `card_schedules` / `review_events` / `study_sessions` テーブル定義 |
| `packages/db/src/repositories/content-repository.ts` | デッキ・カードの永続化と所有者境界 |
| `packages/db/src/repositories/study-repository.ts` | 出題キューとレビュー取引 |
| `apps/api/src/features/study/fsrs-adapter.ts` | ts-fsrs の隔離 |
| `apps/api/src/features/content/import-parser.ts` | JSON/CSV の解析 |
| `apps/api/src/features/content/content-routes.ts` | デッキ・カード・取り込みの HTTP 境界 |
| `apps/api/src/features/study/study-routes.ts` | 学習の HTTP 境界 |
| `apps/web/src/api/client.ts` | 型付き fetch クライアント |
| `apps/web/src/screens/DeckListScreen.tsx` | デッキ一覧とゲスト開始 |
| `apps/web/src/screens/DeckDetailScreen.tsx` | カード管理と取り込み |
| `apps/web/src/screens/StudyScreen.tsx` | 学習画面 |
| `infra/pre-release/compose.yml` | 配置用 Compose |
| `docs/todo/pre-release-deferred.md` | 端折った項目の一覧 |

---

### Task 1: デッキとカードの共有契約を追加する

**Files:**
- Create: `packages/shared/src/contracts/content.ts`
- Create: `packages/shared/src/contracts/content.test.ts`
- Modify: `packages/shared/src/index.ts`

**Interfaces:**
- Produces: `deckCreateSchema`、`deckUpdateSchema`、`cardContentSchema`、`importRequestSchema` と型 `DeckCreateInput`、`DeckUpdateInput`、`CardContentInput`、`ImportRequest`。
- Consumes: なし。

- [ ] **Step 1: 失敗するテストを書く**

```ts
import { describe, expect, test } from 'vitest'
import { cardContentSchema, deckCreateSchema } from './content'

describe('deckCreateSchema', () => {
  test('名前を受け付ける', () => {
    expect(deckCreateSchema.parse({ name: '英単語' })).toEqual({ name: '英単語' })
  })

  test('空の名前を拒否する', () => {
    expect(deckCreateSchema.safeParse({ name: '' }).success).toBe(false)
  })

  test('未知のキーを拒否する', () => {
    expect(deckCreateSchema.safeParse({ name: '英単語', owner: 'x' }).success).toBe(false)
  })
})

describe('cardContentSchema', () => {
  test('frontとbackを受け付ける', () => {
    expect(cardContentSchema.parse({ front: '表', back: '裏' }).front).toBe('表')
  })

  test('20000文字を超える本文を拒否する', () => {
    const tooLong = { front: 'あ'.repeat(20001), back: '裏' }
    expect(cardContentSchema.safeParse(tooLong).success).toBe(false)
  })

  test('生HTMLを含む本文を拒否する', () => {
    const withHtml = { front: '<script>x</script>', back: '裏' }
    expect(cardContentSchema.safeParse(withHtml).success).toBe(false)
  })
})
```

- [ ] **Step 2: テストを実行し失敗を確認する**

Run: `bunx vitest run packages/shared/src/contracts/content.test.ts`

Expected: FAIL（`./content` が存在しない）

- [ ] **Step 3: 契約を実装する**

```ts
import { z } from 'zod'

/** カード本文の上限。上位仕様が定める値。 */
const MAX_CARD_TEXT_LENGTH = 20_000

/** 描画時に無効化するが、保存前にも受け付けない。 */
const HTML_TAG_PATTERN = /<[a-zA-Z/!][^>]*>/

const cardTextSchema = z
  .string()
  .min(1)
  .max(MAX_CARD_TEXT_LENGTH)
  .refine((value) => !HTML_TAG_PATTERN.test(value), {
    message: 'HTMLタグは使用できません。',
  })

export const deckCreateSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    description: z.string().max(1_000).optional(),
    newCardLimit: z.number().int().min(0).max(1_000).optional(),
  })
  .strict()

export const deckUpdateSchema = deckCreateSchema.partial().strict()

export const cardContentSchema = z
  .object({ front: cardTextSchema, back: cardTextSchema })
  .strict()

export const importRequestSchema = z
  .object({
    format: z.enum(['json', 'csv']),
    payload: z.string().min(1).max(1_000_000),
  })
  .strict()

export type DeckCreateInput = z.infer<typeof deckCreateSchema>
export type DeckUpdateInput = z.infer<typeof deckUpdateSchema>
export type CardContentInput = z.infer<typeof cardContentSchema>
export type ImportRequest = z.infer<typeof importRequestSchema>
```

`packages/shared/src/index.ts` へ既存の流儀に合わせて re-export を追記する。

- [ ] **Step 4: テストを実行し成功を確認する**

Run: `bunx vitest run packages/shared/src/contracts/content.test.ts && bun run typecheck`

Expected: PASS、typecheck exit 0

- [ ] **Step 5: コミットする**

```bash
git add packages/shared/src/contracts/content.ts packages/shared/src/contracts/content.test.ts packages/shared/src/index.ts
git commit -m "feat: デッキとカードの共有契約を追加する"
```

---

### Task 2: 学習の共有契約と学習状態競合コードを追加する

**Files:**
- Create: `packages/shared/src/contracts/study.ts`
- Create: `packages/shared/src/contracts/study.test.ts`
- Modify: `packages/shared/src/errors/app-error.ts`
- Modify: `packages/shared/src/errors/app-error.test.ts`
- Modify: `packages/shared/src/index.ts`

**Interfaces:**
- Produces: `publicRatingSchema`、`fsrsStateSchema`、`scheduleSnapshotSchema`、`studySessionCreateSchema`、`reviewSubmitSchema`、型 `PublicRating`、`FsrsState`、`ScheduleSnapshot`、`ReviewSubmitInput`、エラーコード `STUDY_STATE_CONFLICT`。
- Consumes: Task 1 の契約スタイル。

- [ ] **Step 1: 失敗するテストを書く**

```ts
import { randomUUID } from 'node:crypto'
import { v7 as uuidv7 } from 'uuid'
import { describe, expect, test } from 'vitest'
import { reviewSubmitSchema, studySessionCreateSchema } from './study'

const base = {
  sessionId: uuidv7(),
  cardId: uuidv7(),
  rating: 3,
  expectedScheduleVersion: 1,
  idempotencyKey: randomUUID(),
}

describe('reviewSubmitSchema', () => {
  test('4段階の評価を受け付ける', () => {
    expect(reviewSubmitSchema.parse(base).rating).toBe(3)
  })

  test('評価0を拒否する', () => {
    expect(reviewSubmitSchema.safeParse({ ...base, rating: 0 }).success).toBe(false)
  })

  test('クライアント時刻を拒否する', () => {
    const withClientTime = { ...base, reviewedAt: '2026-08-21T00:00:00+09:00' }
    expect(reviewSubmitSchema.safeParse(withClientTime).success).toBe(false)
  })

  test('冪等キーの欠落を拒否する', () => {
    const { idempotencyKey: _omitted, ...withoutKey } = base
    expect(reviewSubmitSchema.safeParse(withoutKey).success).toBe(false)
  })
})

describe('studySessionCreateSchema', () => {
  test('allはデッキ指定を拒否する', () => {
    const input = { mode: 'all', deckIds: [uuidv7()] }
    expect(studySessionCreateSchema.safeParse(input).success).toBe(false)
  })

  test('selectedは1件以上のデッキを要求する', () => {
    const input = { mode: 'selected', deckIds: [] }
    expect(studySessionCreateSchema.safeParse(input).success).toBe(false)
  })
})
```

`app-error.test.ts` へ `new AppError('STUDY_STATE_CONFLICT').status` が 409 で、公開メッセージが日本語であることを検証するテストを追記する。

- [ ] **Step 2: テストを実行し失敗を確認する**

Run: `bunx vitest run packages/shared/src/contracts/study.test.ts packages/shared/src/errors/app-error.test.ts`

Expected: FAIL

- [ ] **Step 3: 契約とエラーコードを実装する**

```ts
import { z } from 'zod'

export const publicRatingSchema = z.union([
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
])

export const fsrsStateSchema = z.enum(['new', 'learning', 'review', 'relearning'])

export const scheduleSnapshotSchema = z
  .object({
    cardId: z.uuidv7(),
    dueAt: z.string(),
    stability: z.number().finite().nonnegative(),
    difficulty: z.number().finite().min(0).max(10),
    elapsedDays: z.number().int().nonnegative(),
    scheduledDays: z.number().int().nonnegative(),
    learningSteps: z.number().int().nonnegative(),
    reps: z.number().int().nonnegative(),
    lapses: z.number().int().nonnegative(),
    state: fsrsStateSchema,
    lastReviewAt: z.string().nullable(),
    scheduleVersion: z.number().int().positive(),
    schedulerVersion: z.literal('ts-fsrs@5.4.1/fsrs-6'),
    requestRetention: z.number().finite().min(0.7).max(0.97),
  })
  .strict()

export const studySessionCreateSchema = z
  .object({
    mode: z.enum(['all', 'selected']),
    deckIds: z.array(z.uuidv7()).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    // モードと指定内容の食い違いは、意図しない出題範囲につながる。
    if (value.mode === 'all' && value.deckIds !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['deckIds'],
        message: '全デッキ学習ではデッキを指定できません。',
      })
    }

    if (
      value.mode === 'selected' &&
      (value.deckIds === undefined || value.deckIds.length === 0)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['deckIds'],
        message: 'デッキを1つ以上指定してください。',
      })
    }
  })

export const reviewSubmitSchema = z
  .object({
    sessionId: z.uuidv7(),
    cardId: z.uuidv7(),
    rating: publicRatingSchema,
    expectedScheduleVersion: z.number().int().positive(),
    idempotencyKey: z.uuid(),
    responseDurationMs: z.number().int().min(0).max(3_600_000).optional(),
  })
  .strict()

export type PublicRating = z.infer<typeof publicRatingSchema>
export type FsrsState = z.infer<typeof fsrsStateSchema>
export type ScheduleSnapshot = z.infer<typeof scheduleSnapshotSchema>
export type ReviewSubmitInput = z.infer<typeof reviewSubmitSchema>
```

`app-error.ts` の `AppErrorCode` へ `'STUDY_STATE_CONFLICT'` を追加し、`APP_ERROR_DEFAULTS` へ `{ status: 409, message: '学習状態が更新されています。最新の状態を読み込み直してください。' }` を追加する。

- [ ] **Step 4: テストを実行し成功を確認する**

Run: `bunx vitest run packages/shared/src && bun run typecheck`

Expected: PASS

- [ ] **Step 5: コミットする**

```bash
git add packages/shared/src
git commit -m "feat: 学習の共有契約と学習状態競合コードを追加する"
```

---

### Task 3: デッキ・カード・学習のテーブルと migration を追加する

**Files:**
- Create: `packages/db/src/schema/content.ts`
- Create: `packages/db/src/schema/study.ts`
- Modify: `packages/db/src/schema/index.ts`
- Create: `packages/db/migrations/0007_content_study.sql`（`bun run db:generate` で生成）
- Create: `packages/db/src/schema/content.test.ts`

**Interfaces:**
- Produces: Drizzle テーブル `decks`、`cards`、`cardSchedules`、`reviewEvents`、`studySessions`。
- Consumes: `principals`（Phase 1）。

- [ ] **Step 1: 失敗する実DBテストを書く**

```ts
import { v7 as uuidv7 } from 'uuid'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { createTestDatabase, resetIdentityTables } from '../test/database'
import * as schema from './index'

describe('content schema', () => {
  let handle: Awaited<ReturnType<typeof createTestDatabase>>

  beforeAll(async () => {
    handle = await createTestDatabase()
  })

  afterAll(async () => {
    if (handle !== undefined) {
      await handle.close()
    }
  })

  beforeEach(async () => {
    await resetIdentityTables(handle)
  })

  test('同じdeckで同じsource_key/external_idの重複を拒否する', async () => {
    const principalId = uuidv7()
    await handle.db.insert(schema.principals).values({ id: principalId, kind: 'guest' })
    const deckId = uuidv7()
    await handle.db.insert(schema.decks).values({
      id: deckId,
      principalId,
      name: '英単語',
      normalizedName: '英単語',
    })

    const card = {
      deckId,
      front: '表',
      back: '裏',
      contentHash: 'hash',
      sourceKey: 'ai',
      externalId: 'e-1',
    }

    await handle.db.insert(schema.cards).values({ id: uuidv7(), ...card })
    await expect(
      handle.db.insert(schema.cards).values({ id: uuidv7(), ...card }),
    ).rejects.toThrow()
  })

  test('source_keyがnullなら同じ内容を複数入れられる', async () => {
    const principalId = uuidv7()
    await handle.db.insert(schema.principals).values({ id: principalId, kind: 'guest' })
    const deckId = uuidv7()
    await handle.db.insert(schema.decks).values({
      id: deckId,
      principalId,
      name: '英単語',
      normalizedName: '英単語',
    })

    const card = { deckId, front: '表', back: '裏', contentHash: 'hash' }
    await handle.db.insert(schema.cards).values({ id: uuidv7(), ...card })
    await handle.db.insert(schema.cards).values({ id: uuidv7(), ...card })

    const rows = await handle.db.select().from(schema.cards)
    expect(rows).toHaveLength(2)
  })
})
```

- [ ] **Step 2: テストを実行し失敗を確認する**

Run: `bunx vitest run packages/db/src/schema/content.test.ts`

Expected: FAIL（`decks` が存在しない）

- [ ] **Step 3: テーブルを定義する**

`packages/db/src/schema/content.ts` に `decks` と `cards` を定義する。既存の `principals.ts` の書き方（`pgTable`、`uuid`、`timestamp({ withTimezone: true, mode: 'date' })`、テーブル末尾の配列で index/constraint を返す）に完全に合わせる。

- `decks`: `id`（uuid PK）、`principalId`（uuid、`principals.id` へ FK、`onDelete: 'cascade'`）、`name`（text notNull）、`normalizedName`（text notNull）、`description`（text）、`sortOrder`（integer notNull default 0）、`newCardLimit`（integer notNull default 20）、`archivedAt`、`trashedAt`、`createdAt`、`updatedAt`
- `cards`: `id`、`deckId`（uuid、`decks.id` へ FK、`onDelete: 'cascade'`）、`front`（text notNull）、`back`（text notNull）、`metadata`（jsonb notNull default `'{}'`）、`contentHash`（text notNull）、`status`（text notNull default `'active'`）、`sourceKey`（text）、`externalId`（text）、`sourceUrl`（text）、`sourceTitle`（text）、`trashedAt`、`createdAt`、`updatedAt`

index は `decks_principal_id_idx`、`decks_trashed_at_idx`、`cards_deck_id_idx`、`cards_trashed_at_idx`、`cards_content_hash_idx`、および部分ユニーク `cards_external_identity_uidx` を `(deck_id, source_key, external_id)` に `where source_key is not null and external_id is not null` で張る。

`packages/db/src/schema/study.ts` に `cardSchedules`（`cardId` を PK 兼 FK、FSRS の各列、`version` integer notNull default 1、`schedulerVersion` text notNull、`requestRetention` は `doublePrecision` notNull）、`studySessions`、`reviewEvents`（`idempotencyKey` と `principalId` の複合ユニーク、`beforeSnapshot` / `afterSnapshot` jsonb）を定義する。

`packages/db/src/schema/index.ts` から両方を re-export する。

- [ ] **Step 4: migration を生成し適用する**

Run: `bun run db:generate --name=content_study`

生成された SQL を目視で確認し、既存 migration を書き換えていないこと、破壊的操作が無いことを確かめる。

Run: `bun run db:migrate`

Expected: 空DBに対して `0000`〜`0007` がクリーンに適用される

- [ ] **Step 5: テストを実行し成功を確認する**

Run: `bunx vitest run packages/db/src && bun run typecheck && bun run db:generate`

Expected: PASS、typecheck exit 0、`No schema changes`

- [ ] **Step 6: コミットする**

```bash
git add packages/db/src/schema packages/db/migrations
git commit -m "feat: デッキ・カード・学習状態の永続化モデルを追加する"
```

---

### Task 4: ContentRepository を追加する

**Files:**
- Create: `packages/db/src/repositories/content-repository.ts`
- Create: `packages/db/src/repositories/content-repository.test.ts`
- Modify: `packages/db/src/index.ts`
- Modify: `packages/db/src/repositories/principal-repository.ts`（`moveOwnedDomainRows`）
- Modify: `packages/db/src/repositories/principal-repository.test.ts`

**Interfaces:**
- Produces:

```ts
export type DeckSummary = {
  id: string
  name: string
  description: string | null
  newCardLimit: number
  cardCount: number
}

export interface ContentRepository {
  listDecks(principalId: string): Promise<readonly DeckSummary[]>
  createDeck(principalId: string, input: DeckCreateInput, now: Date): Promise<DeckSummary>
  updateDeck(principalId: string, deckId: string, input: DeckUpdateInput, now: Date): Promise<DeckSummary | null>
  trashDeck(principalId: string, deckId: string, now: Date): Promise<boolean>
  listCards(principalId: string, deckId: string, limit: number, offset: number): Promise<readonly CardRecord[]>
  createCard(principalId: string, deckId: string, input: CardContentInput, now: Date): Promise<CardRecord | null>
  updateCard(principalId: string, cardId: string, input: CardContentInput, now: Date): Promise<CardRecord | null>
  trashCard(principalId: string, cardId: string, now: Date): Promise<boolean>
  createCards(principalId: string, deckId: string, inputs: readonly CardContentInput[], now: Date): Promise<number>
}

export function createContentRepository(db: Database): ContentRepository
```

- Produces（型）:

```ts
export type CardRecord = {
  id: string
  deckId: string
  front: string
  back: string
  contentHash: string
  createdAt: Date
  updatedAt: Date
}
```

- Consumes: Task 1 の `DeckCreateInput` / `CardContentInput`、Task 3 のテーブル。

- [ ] **Step 1: 失敗する実DBテストを書く**

最低限これらを検証する。既存の `principal-repository.test.ts` の構成（`createTestDatabase`、`resetIdentityTables(handle)`、`afterAll` の null セーフな `close`）をそのまま踏襲する。

```ts
test('他人のデッキは読めない', async () => {
  const owner = await insertGuestPrincipal()
  const other = await insertGuestPrincipal()
  const deck = await repository.createDeck(owner, { name: '英単語' }, now)

  expect(await repository.listDecks(other)).toHaveLength(0)
  expect(await repository.updateDeck(other, deck.id, { name: '乗っ取り' }, now)).toBeNull()
  expect(await repository.trashDeck(other, deck.id, now)).toBe(false)
})

test('論理削除したデッキは一覧から消える', async () => {
  const owner = await insertGuestPrincipal()
  const deck = await repository.createDeck(owner, { name: '英単語' }, now)

  expect(await repository.trashDeck(owner, deck.id, now)).toBe(true)
  expect(await repository.listDecks(owner)).toHaveLength(0)
})

test('他人のデッキへカードを作れない', async () => {
  const owner = await insertGuestPrincipal()
  const other = await insertGuestPrincipal()
  const deck = await repository.createDeck(owner, { name: '英単語' }, now)

  expect(await repository.createCard(other, deck.id, { front: '表', back: '裏' }, now)).toBeNull()
})

test('統合でデッキが取り込み先へ移る', async () => {
  // principal-repository.test.ts 側に置く。
  // ゲストにデッキを作り、正式ユーザーへ統合したあと、
  // デッキが target principal から見えて、cascade で消えていないことを確認する。
})
```

- [ ] **Step 2: テストを実行し失敗を確認する**

Run: `bunx vitest run packages/db/src/repositories/content-repository.test.ts`

Expected: FAIL

- [ ] **Step 3: リポジトリを実装する**

所有権はすべて SQL の述語で表す。カード操作は `deckId` ではなく `cards.id` から `decks.principalId` へ join して所有者を確認する。取得後にアプリ側で判定しない。

```ts
// 所有者と論理削除の条件を1か所に閉じ込める。
function ownedDeck(principalId: string, deckId: string) {
  return and(
    eq(decks.id, deckId),
    eq(decks.principalId, principalId),
    isNull(decks.trashedAt),
  )
}
```

`createCards` はバッチINSERTを1トランザクションで行い、挿入件数を返す。`contentHash` は `front` と `back` を NFC 正規化して連結した SHA-256 の hex とする。

- [ ] **Step 4: `moveOwnedDomainRows` を実装する**

```ts
// 統合先へデッキごと移す。カードはdeck FKに従うため個別の移送は要らない。
await tx
  .update(decks)
  .set({ principalId: targetPrincipalId })
  .where(eq(decks.principalId, sourcePrincipalId))
```

- [ ] **Step 5: テストを実行し成功を確認する**

Run: `bunx vitest run packages/db/src && bun run typecheck`

Expected: PASS

- [ ] **Step 6: コミットする**

```bash
git add packages/db/src
git commit -m "feat: デッキとカードのリポジトリを追加する"
```

---

### Task 5: FSRS アダプタを追加する

**Files:**
- Create: `apps/api/src/features/study/fsrs-adapter.ts`
- Create: `apps/api/src/features/study/fsrs-adapter.test.ts`
- Modify: `apps/api/package.json`（`ts-fsrs` 5.4.1）

**Interfaces:**
- Produces:

```ts
export const SCHEDULER_VERSION = 'ts-fsrs@5.4.1/fsrs-6'
export const DEFAULT_REQUEST_RETENTION = 0.9

export type SchedulerState = {
  dueAt: Date
  stability: number
  difficulty: number
  elapsedDays: number
  scheduledDays: number
  learningSteps: number
  reps: number
  lapses: number
  state: FsrsState
  lastReviewAt: Date | null
}

export interface FsrsScheduler {
  initial(now: Date): SchedulerState
  preview(current: SchedulerState, now: Date): Record<PublicRating, SchedulerState>
}

export function createFsrsScheduler(requestRetention: number): FsrsScheduler
```

- Consumes: Task 2 の `PublicRating` / `FsrsState`。

- [ ] **Step 1: characterization テストを書く**

固定した現在時刻と初期状態に対し、4段階それぞれの `scheduledDays` と `state` を**具体値で**固定する。値はライブラリの実出力を1度取得して書き込む。目的はライブラリ更新時に出題間隔が黙って変わることの検知であり、値そのものの正しさの証明ではない。その旨をテストのコメントに書く。

```ts
test('新規カードの4段階の結果を固定する', () => {
  const scheduler = createFsrsScheduler(DEFAULT_REQUEST_RETENTION)
  const now = new Date('2026-08-21T00:00:00Z')
  const preview = scheduler.preview(scheduler.initial(now), now)

  // ライブラリ更新で出題間隔が変わったら気付けるようにするための固定値。
  expect(preview[1].state).toBe('learning')
  expect(preview[4].state).toBe('review')
  expect(preview[4].scheduledDays).toBeGreaterThan(0)
})

test('評価1は評価4より次回が早い', () => {
  const scheduler = createFsrsScheduler(DEFAULT_REQUEST_RETENTION)
  const now = new Date('2026-08-21T00:00:00Z')
  const preview = scheduler.preview(scheduler.initial(now), now)

  expect(preview[1].dueAt.getTime()).toBeLessThan(preview[4].dueAt.getTime())
})
```

- [ ] **Step 2: テストを実行し失敗を確認する**

Run: `bunx vitest run apps/api/src/features/study/fsrs-adapter.test.ts`

Expected: FAIL

- [ ] **Step 3: アダプタを実装する**

`ts-fsrs` の型は境界で自前の `SchedulerState` へ写像する。ライブラリの型をアプリ内部へ漏らさない。`fsrs()` の生成は `createFsrsScheduler` 内で1度だけ行う。

- [ ] **Step 4: テストを実行し成功を確認する**

Run: `bunx vitest run apps/api/src/features/study && bun run typecheck`

Expected: PASS

- [ ] **Step 5: コミットする**

```bash
git add apps/api/src/features/study apps/api/package.json bun.lock
git commit -m "feat: FSRSスケジューラのアダプタを追加する"
```

---

### Task 6: StudyRepository とレビュー取引を追加する

**Files:**
- Create: `packages/db/src/repositories/study-repository.ts`
- Create: `packages/db/src/repositories/study-repository.integration.test.ts`
- Modify: `packages/db/src/index.ts`

**Interfaces:**
- Produces:

```ts
export type QueuedCard = {
  cardId: string
  front: string
  back: string
  schedule: ScheduleRow
}

export type ReviewOutcome = {
  applied: boolean
  schedule: ScheduleRow
}

export interface StudyRepository {
  createSession(principalId: string, deckIds: readonly string[] | null, learningDay: string, now: Date): Promise<string>
  nextCard(principalId: string, sessionId: string, now: Date, learningDay: string): Promise<QueuedCard | null>
  countRemaining(principalId: string, sessionId: string, now: Date, learningDay: string): Promise<{ review: number; learning: number; new: number }>
  submitReview(input: SubmitReviewInput): Promise<ReviewOutcome>
  ensureSchedule(cardId: string, initial: ScheduleRow): Promise<void>
}
```

- Produces（型と例外）:

```ts
export type ScheduleRow = {
  cardId: string
  dueAt: Date
  stability: number
  difficulty: number
  elapsedDays: number
  scheduledDays: number
  learningSteps: number
  reps: number
  lapses: number
  state: FsrsState
  lastReviewAt: Date | null
  version: number
  schedulerVersion: string
  requestRetention: number
}

export type SubmitReviewInput = {
  principalId: string
  sessionId: string
  cardId: string
  rating: PublicRating
  expectedScheduleVersion: number
  idempotencyKey: string
  now: Date
  applied: Record<PublicRating, SchedulerState>
}

/** スケジュールが他の要求で進んでいた。呼び出し側は409へ写像する。 */
export class StudyStateConflictError extends Error {}

/** 所有者から見て対象カードが存在しない。呼び出し側は404へ写像する。 */
export class CardNotFoundError extends Error {}
```

`applied` は Task 5 のスケジューラが4段階分を先に計算した結果である。リポジトリは FSRS を直接呼ばない。

- Consumes: Task 3 のテーブル、Task 5 の `SchedulerState` と `PublicRating`、Task 2 の `FsrsState`。

- [ ] **Step 1: 失敗する並行性テストを書く**

```ts
test('同じ冪等キーの再送は二重に採点されない', async () => {
  const key = randomUUID()
  const first = await repository.submitReview({ ...input, idempotencyKey: key })
  const second = await repository.submitReview({ ...input, idempotencyKey: key })

  expect(first.applied).toBe(true)
  expect(second.applied).toBe(false)
  expect(second.schedule.version).toBe(first.schedule.version)

  const events = await handle.db.select().from(schema.reviewEvents)
  expect(events).toHaveLength(1)
})

test('古いバージョンでの投稿を拒否する', async () => {
  await repository.submitReview({ ...input, idempotencyKey: randomUUID() })

  await expect(
    repository.submitReview({
      ...input,
      idempotencyKey: randomUUID(),
      expectedScheduleVersion: 1,
    }),
  ).rejects.toBeInstanceOf(StudyStateConflictError)
})

test('他人のカードは出題されない', async () => {
  const other = await insertGuestPrincipal()
  expect(await repository.nextCard(other, sessionId, now, learningDay)).toBeNull()
})

test('新規カードは学習日あたりの上限で打ち切られる', async () => {
  // 上限2のデッキに新規3枚を置き、当日3枚目が出題されないことを確認する。
})
```

- [ ] **Step 2: テストを実行し失敗を確認する**

Run: `bunx vitest run packages/db/src/repositories/study-repository.integration.test.ts`

Expected: FAIL

- [ ] **Step 3: レビュー取引を実装する**

1トランザクションで次の順に行う。順序を変えない。

```ts
return db.transaction(async (tx) => {
  // 1. 冪等キーの再送は、スケジュールを比較する前に保存済みの結果を返す。
  const recorded = await findEventByKey(tx, principalId, idempotencyKey)
  if (recorded !== undefined) {
    return { applied: false, schedule: recorded.afterSnapshot }
  }

  // 2. 所有者を含めてロックする。
  const current = await lockScheduleForOwner(tx, principalId, cardId)
  if (current === undefined) {
    throw new CardNotFoundError()
  }

  // 3. バージョンが進んでいれば競合として打ち切る。
  if (current.version !== expectedScheduleVersion) {
    throw new StudyStateConflictError()
  }

  // 4-6. FSRS結果の適用、バージョン加算、イベント追記。
  const next = applied[rating]
  await updateSchedule(tx, cardId, next, current.version + 1)
  await insertReviewEvent(tx, { principalId, cardId, sessionId, rating, before: current, after: next, idempotencyKey, reviewedAt: now })

  return { applied: true, schedule: { ...next, version: current.version + 1 } }
})
```

出題順は「期限到来の review / relearning を due 昇順」→「新規を作成順」。新規の当日枚数は `review_events` を学習日で絞って数える。集計専用の可変テーブルは作らない。

- [ ] **Step 4: テストを実行し成功を確認する**

Run: `bunx vitest run packages/db/src && bun run typecheck`

Expected: PASS

- [ ] **Step 5: コミットする**

```bash
git add packages/db/src
git commit -m "feat: 出題キューとレビュー取引を追加する"
```

---

### Task 7: ゲスト開始が失効Cookieで失敗しないようにする

**Files:**
- Modify: `apps/api/src/middleware/request-context.ts`
- Modify: `apps/api/src/features/auth/auth-routes.test.ts`

**Interfaces:**
- Produces: 失効したゲストCookieを伴う `POST /api/guest/start` が 200 を返す挙動。
- Consumes: なし。

- [ ] **Step 1: 失敗するテストを書く**

```ts
test('失効したゲストCookieでも新しいゲストを開始できる', async () => {
  const response = await app.request('/api/guest/start', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: `${GUEST_COOKIE_NAME}=${EXPIRED_RAW_TOKEN}`,
    },
    body: JSON.stringify({ turnstileToken: 'ok' }),
  })

  expect(response.status).toBe(200)
  expect(response.headers.get('set-cookie')).toContain(GUEST_COOKIE_NAME)
})
```

- [ ] **Step 2: テストを実行し失敗を確認する**

Run: `bunx vitest run apps/api/src/features/auth/auth-routes.test.ts`

Expected: FAIL（401 が返る）

- [ ] **Step 3: 最小の実装を加える**

`requestContext` はゲスト解決に失敗したとき、`POST /api/guest/start` に限りCookieを破棄して actor を `null` のまま次へ進める。他の経路の挙動は変えない。判定はパスとメソッドの完全一致で行い、前方一致にしない。

- [ ] **Step 4: テストを実行し成功を確認する**

Run: `bunx vitest run apps/api/src && bun run typecheck`

Expected: PASS

- [ ] **Step 5: コミットする**

```bash
git add apps/api/src
git commit -m "fix: 失効したゲストCookieでもゲスト開始を通す"
```

---

### Task 8: デッキとカードの API を追加する

**Files:**
- Create: `apps/api/src/features/content/content-routes.ts`
- Create: `apps/api/src/features/content/content-routes.test.ts`
- Modify: `apps/api/src/app.ts`

**Interfaces:**
- Produces: `createContentRoutes(options: { repository: ContentRepository })`。`GET/POST /api/decks`、`PATCH/DELETE /api/decks/:deckId`、`GET/POST /api/decks/:deckId/cards`、`PATCH/DELETE /api/cards/:cardId`。
- Consumes: Task 1 の契約、Task 4 の `ContentRepository`。

- [ ] **Step 1: 失敗する HTTP テストを書く**

既存の `auth-routes.test.ts` の書き方（`createApp` にダミー実装を渡す）に合わせる。

```ts
test('actorが無ければ401を返す', async () => {
  const response = await app.request('/api/decks')
  expect(response.status).toBe(401)
})

test('他人のデッキ更新は404を返す', async () => {
  const response = await requestAs(otherActor, `/api/decks/${deckId}`, {
    method: 'PATCH',
    body: { name: '乗っ取り' },
  })
  expect(response.status).toBe(404)
})

test('20000文字を超える本文は400を返す', async () => {
  const response = await requestAs(actor, `/api/decks/${deckId}/cards`, {
    method: 'POST',
    body: { front: 'あ'.repeat(20001), back: '裏' },
  })
  expect(response.status).toBe(400)
})
```

- [ ] **Step 2: テストを実行し失敗を確認する**

Run: `bunx vitest run apps/api/src/features/content/content-routes.test.ts`

Expected: FAIL

- [ ] **Step 3: ルートを実装する**

`zValidator` の失敗ハンドラは既存の `auth-routes.ts` と同じく `AppError('VALIDATION_FAILED', { fieldErrors })` を投げる形にそろえる。actor は `requireServiceContext` 相当で取り出し、存在しなければ `AppError('UNAUTHENTICATED')`。リポジトリが `null` / `false` を返したら `AppError('NOT_FOUND')`。**他人のリソースと存在しないリソースを応答で区別しない。**

- [ ] **Step 4: テストを実行し成功を確認する**

Run: `bunx vitest run apps/api/src && bun run typecheck`

Expected: PASS

- [ ] **Step 5: コミットする**

```bash
git add apps/api/src
git commit -m "feat: デッキとカードのAPIを追加する"
```

---

### Task 9: JSON/CSV の一括取り込みを追加する

**Files:**
- Create: `apps/api/src/features/content/import-parser.ts`
- Create: `apps/api/src/features/content/import-parser.test.ts`
- Modify: `apps/api/src/features/content/content-routes.ts`
- Modify: `apps/api/src/features/content/content-routes.test.ts`
- Modify: `apps/api/package.json`（`csv-parse` 7.0.1）

**Interfaces:**
- Produces: `parseImportPayload(request: ImportRequest): readonly CardContentInput[]`。上位仕様の `tango.content` version 1 JSON と、`front,back` ヘッダを持つ CSV を受け付ける。
- Consumes: Task 1 の `importRequestSchema` / `cardContentSchema`。

- [ ] **Step 1: 失敗するテストを書く**

```ts
test('tango.content v1 のJSONを解析する', () => {
  const payload = JSON.stringify({
    schema: 'tango.content',
    version: 1,
    cards: [{ front: '表1', back: '裏1' }],
  })

  expect(parseImportPayload({ format: 'json', payload })).toEqual([
    { front: '表1', back: '裏1' },
  ])
})

test('front,backのCSVを解析する', () => {
  const payload = 'front,back\n表1,裏1\n表2,裏2\n'
  expect(parseImportPayload({ format: 'csv', payload })).toHaveLength(2)
})

test('1件でも不正なら全体を拒否する', () => {
  const payload = JSON.stringify({
    schema: 'tango.content',
    version: 1,
    cards: [{ front: '表1', back: '裏1' }, { front: '', back: '裏2' }],
  })

  expect(() => parseImportPayload({ format: 'json', payload })).toThrow()
})

test('壊れたJSONでも内容をエラーに載せない', () => {
  try {
    parseImportPayload({ format: 'json', payload: '{"secret":"s3cret"' })
    expect.unreachable('例外が発生するはず。')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    expect(message).not.toContain('s3cret')
  }
})
```

- [ ] **Step 2: テストを実行し失敗を確認する**

Run: `bunx vitest run apps/api/src/features/content/import-parser.test.ts`

Expected: FAIL

- [ ] **Step 3: 解析器とルートを実装する**

取り込みは全件が妥当なときだけ適用する。1件でも不正なら1枚も作らない。エラーメッセージに投入内容を含めない。`POST /api/decks/:deckId/import` は `createCards` を1トランザクションで呼び、作成件数を返す。重複検出は行わない。

- [ ] **Step 4: テストを実行し成功を確認する**

Run: `bunx vitest run apps/api/src && bun run typecheck`

Expected: PASS

- [ ] **Step 5: コミットする**

```bash
git add apps/api/src apps/api/package.json bun.lock
git commit -m "feat: JSONとCSVの一括取り込みを追加する"
```

---

### Task 10: 学習 API を追加する

**Files:**
- Create: `apps/api/src/features/study/study-routes.ts`
- Create: `apps/api/src/features/study/study-routes.test.ts`
- Create: `apps/api/src/features/study/study-service.ts`
- Modify: `apps/api/src/app.ts`

**Interfaces:**
- Produces: `POST /api/study/sessions`、`GET /api/study/sessions/:sessionId`、`POST /api/study/reviews`。応答は現在のカード、`schedule`、4通りの間隔プレビュー、`remainingReview` / `remainingLearning` / `remainingNew`、`learningDay`。
- Consumes: Task 2 の契約、Task 5 のスケジューラ、Task 6 の `StudyRepository`。

- [ ] **Step 1: 失敗する HTTP テストを書く**

```ts
test('古いバージョンの投稿は409とSTUDY_STATE_CONFLICTを返す', async () => {
  const response = await submitReview({ expectedScheduleVersion: 1 })

  expect(response.status).toBe(409)
  const body = await response.json()
  expect(body.error.code).toBe('STUDY_STATE_CONFLICT')
})

test('同じ冪等キーの再送で二重に進まない', async () => {
  const key = randomUUID()
  const first = await submitReview({ idempotencyKey: key })
  const second = await submitReview({ idempotencyKey: key })

  expect(await first.json()).toEqual(await second.json())
})

test('応答の日時は+09:00を明示する', async () => {
  const body = await (await currentCard()).json()
  expect(body.schedule.dueAt).toMatch(/\+09:00$/)
})
```

- [ ] **Step 2: テストを実行し失敗を確認する**

Run: `bunx vitest run apps/api/src/features/study/study-routes.test.ts`

Expected: FAIL

- [ ] **Step 3: サービスとルートを実装する**

`study-service.ts` が学習日の算出（`learningDayOf`）、スケジューラ呼び出し、リポジトリ呼び出しを束ねる。ルートは HTTP 境界だけを持つ。`StudyStateConflictError` を `AppError('STUDY_STATE_CONFLICT')` へ写像する。日時は `formatJst` で整形する。

- [ ] **Step 4: テストを実行し成功を確認する**

Run: `bunx vitest run apps/api/src && bun run typecheck`

Expected: PASS

- [ ] **Step 5: コミットする**

```bash
git add apps/api/src
git commit -m "feat: 学習セッションとレビュー投稿のAPIを追加する"
```

---

### Task 11: Web の土台とデッキ一覧画面を作る

**Files:**
- Modify: `apps/web/package.json`（`react-router`、`@tanstack/react-query`、`react-markdown`、`rehype-sanitize`、`@testing-library/react`、`jsdom`）
- Create: `apps/web/src/api/client.ts`
- Create: `apps/web/src/app/App.tsx`
- Create: `apps/web/src/screens/DeckListScreen.tsx`
- Create: `apps/web/src/screens/DeckListScreen.test.tsx`
- Modify: `apps/web/src/main.tsx`
- Modify: `apps/web/vite.config.ts`（`/api` の dev proxy）
- Create: `apps/web/vitest.config.mts`（jsdom 環境）

**Interfaces:**
- Produces: `apiClient` の型付きメソッド、ルーティング `/`、`/decks/:deckId`、`/study`。
- Consumes: Task 8 の API。

- [ ] **Step 1: 失敗するコンポーネントテストを書く**

```tsx
test('セッションが無ければ「はじめる」だけを出す', async () => {
  renderWithClient(<DeckListScreen />, { session: { authenticated: false } })

  expect(await screen.findByRole('button', { name: 'はじめる' })).toBeVisible()
  expect(screen.queryByText('デッキを作成')).toBeNull()
})

test('ログイン導線を一切出さない', async () => {
  renderWithClient(<DeckListScreen />, { session: guestSession })

  expect(screen.queryByText(/Google/)).toBeNull()
  expect(screen.queryByText(/ログイン/)).toBeNull()
})

test('Cookie削除でデータが戻せない旨を常時表示する', async () => {
  renderWithClient(<DeckListScreen />, { session: guestSession })

  expect(await screen.findByText(/復元できません/)).toBeVisible()
})
```

- [ ] **Step 2: テストを実行し失敗を確認する**

Run: `bunx vitest run apps/web/src`

Expected: FAIL

- [ ] **Step 3: 土台と画面を実装する**

`client.ts` は `credentials: 'same-origin'` を既定にし、共通エラーエンベロープ（`error.code` / `error.message`）を解釈して日本語メッセージをそのまま画面へ渡す。`react-query` の `QueryClientProvider` を `App.tsx` に置く。ゲスト開始ボタンは Turnstile のトークンを添えて `POST /api/guest/start` を呼ぶ。

- [ ] **Step 4: テストを実行し成功を確認する**

Run: `bunx vitest run apps/web/src && bun run typecheck && bun run build`

Expected: PASS

- [ ] **Step 5: コミットする**

```bash
git add apps/web bun.lock
git commit -m "feat: Webの土台とデッキ一覧画面を追加する"
```

---

### Task 12: デッキ詳細画面と取り込みUIを作る

**Files:**
- Create: `apps/web/src/screens/DeckDetailScreen.tsx`
- Create: `apps/web/src/screens/DeckDetailScreen.test.tsx`
- Create: `apps/web/src/components/CardMarkdown.tsx`
- Create: `apps/web/src/components/CardMarkdown.test.tsx`

**Interfaces:**
- Produces: カードの作成・編集・削除フォームと、JSON/CSV 貼り付け欄。
- Consumes: Task 8・9 の API。

- [ ] **Step 1: 失敗するテストを書く**

```tsx
test('生HTMLをそのまま描画しない', () => {
  render(<CardMarkdown text={'<img src=x onerror=alert(1)>'} />)

  expect(document.querySelector('img')).toBeNull()
})

test('カード作成後に一覧が更新される', async () => {
  renderWithClient(<DeckDetailScreen />, { deckId })

  await userEvent.type(screen.getByLabelText('表'), '表1')
  await userEvent.type(screen.getByLabelText('裏'), '裏1')
  await userEvent.click(screen.getByRole('button', { name: '追加' }))

  expect(await screen.findByText('表1')).toBeVisible()
})

test('削除は戻せない旨を確認してから実行する', async () => {
  // 確認ダイアログのテキストに「戻せません」が含まれることを検証する。
})
```

- [ ] **Step 2: テストを実行し失敗を確認する**

Run: `bunx vitest run apps/web/src`

Expected: FAIL

- [ ] **Step 3: 画面を実装する**

`CardMarkdown` は `react-markdown` に `rehype-sanitize` を通し、生HTMLを無効にしたまま描画する。取り込み欄は形式（JSON / CSV）を選び、貼り付けて送信すると作成件数を表示する。作成・削除後は `react-query` の invalidate で一覧を再取得する。

- [ ] **Step 4: テストを実行し成功を確認する**

Run: `bunx vitest run apps/web/src && bun run typecheck && bun run build`

Expected: PASS

- [ ] **Step 5: コミットする**

```bash
git add apps/web
git commit -m "feat: カード管理と一括取り込みの画面を追加する"
```

---

### Task 13: 学習画面を作る

**Files:**
- Create: `apps/web/src/screens/StudyScreen.tsx`
- Create: `apps/web/src/screens/StudyScreen.test.tsx`

**Interfaces:**
- Produces: 表 → 答えを見る → 4段階評価の流れ、残り枚数表示、間隔プレビュー表示。
- Consumes: Task 10 の API。

- [ ] **Step 1: 失敗するテストを書く**

```tsx
test('答えを見るまで裏を表示しない', async () => {
  renderWithClient(<StudyScreen />, { card })

  expect(screen.queryByText('裏1')).toBeNull()
  await userEvent.click(screen.getByRole('button', { name: '答えを見る' }))
  expect(await screen.findByText('裏1')).toBeVisible()
})

test('評価ボタンに次回間隔を表示する', async () => {
  renderWithClient(<StudyScreen />, { card })

  await userEvent.click(screen.getByRole('button', { name: '答えを見る' }))
  expect(screen.getByRole('button', { name: /かんたん/ })).toHaveTextContent('日')
})

test('サーバの応答前に次のカードへ進まない', async () => {
  // 応答を保留したまま評価を押し、カードが切り替わらないことを検証する。
})

test('409を受けたら状態を読み直す', async () => {
  // STUDY_STATE_CONFLICT を返したときに再取得が走ることを検証する。
})
```

- [ ] **Step 2: テストを実行し失敗を確認する**

Run: `bunx vitest run apps/web/src/screens/StudyScreen.test.tsx`

Expected: FAIL

- [ ] **Step 3: 画面を実装する**

評価の投稿には `crypto.randomUUID()` の冪等キーを使い、**再送時は同じキーを使い回す**。サーバの応答を受け取ってから次のカードを取得する。`STUDY_STATE_CONFLICT` を受けたらセッションを再取得して現在のカードを描き直す。

- [ ] **Step 4: テストを実行し成功を確認する**

Run: `bunx vitest run apps/web/src && bun run typecheck && bun run build`

Expected: PASS

- [ ] **Step 5: コミットする**

```bash
git add apps/web
git commit -m "feat: 学習画面を追加する"
```

---

### Task 14: SPA の同一オリジン配信と配置資材を追加する

**Files:**
- Modify: `apps/api/src/app.ts`（静的配信と SPA フォールバック）
- Create: `apps/api/src/middleware/spa-static.test.ts`
- Create: `infra/pre-release/compose.yml`
- Create: `infra/pre-release/Dockerfile`
- Create: `infra/pre-release/.env.example`
- Create: `infra/pre-release/backup.sh`
- Modify: `README.md`

**Interfaces:**
- Produces: `tango.warasugi.com` 単一オリジンで API と SPA を配信する構成。
- Consumes: Task 11〜13 のビルド成果物。

- [ ] **Step 1: 失敗するテストを書く**

```ts
test('APIのパスは静的配信にフォールバックしない', async () => {
  const response = await app.request('/api/unknown')
  expect(response.status).toBe(404)
  expect(response.headers.get('content-type')).toContain('application/json')
})

test('未知の画面パスはindex.htmlを返す', async () => {
  const response = await app.request('/decks/019fd000-0000-7000-8000-000000000000')
  expect(response.status).toBe(200)
  expect(response.headers.get('content-type')).toContain('text/html')
})
```

- [ ] **Step 2: テストを実行し失敗を確認する**

Run: `bunx vitest run apps/api/src/middleware/spa-static.test.ts`

Expected: FAIL

- [ ] **Step 3: 静的配信を実装する**

`/api/*` と `/health/*` と `/auth/error` は既存の扱いを維持し、それ以外の GET だけを `index.html` へフォールバックさせる。判定順を間違えると API が HTML を返すため、必ずルート登録の最後に置く。

- [ ] **Step 4: 配置資材を書く**

`compose.yml` は `tango-app` / `tango-postgres` / `cloudflared` の3サービス。Postgres はポートを公開せず内部ネットワークのみ。秘密値はファイルをマウントし `*_SECRET_FILE` で参照する。アプリ起動前に `db:migrate` をワンショットで流す。`backup.sh` は `pg_dump` を1日1回ローカルボリュームへ出力する。

- [ ] **Step 5: テストとビルドを実行する**

Run: `bunx vitest run apps/api/src && bun run build && bun run check`

Expected: PASS

- [ ] **Step 6: コミットする**

```bash
git add apps/api/src infra/pre-release README.md
git commit -m "feat: SPAの同一オリジン配信と配置資材を追加する"
```

---

### Task 15: TODO 一覧を作り最終ゲートを通す

**Files:**
- Create: `docs/todo/pre-release-deferred.md`
- Modify: `docs/superpowers/specs/2026-08-21-tango-pre-release-design.md`（実装で判明した差異があれば追記）

**Interfaces:**
- Produces: 端折った項目の一覧と、プレリリースのレビュー資料。

- [ ] **Step 1: TODO 一覧を書く**

各項目を「何を削ったか」「どのフェーズの何に相当するか」「無いと何が起きるか」の3列で書く。最低限これらを載せる。

タグと `card_tags`、ゴミ箱の復元UI、重複プレビュー付き取り込み（`import_batches` / `import_candidates`）、エクスポートと `tango.backup` envelope、undo、ダッシュボード集計、希望保持率の設定UI、カード検索と絞り込み、デッキ間のカード移動、カードのサスペンド、デッキのアーカイブUI、モバイル最適化、アクセシビリティ検査、E2Eテスト、App/DB LXC の分離、pgBackRest と PITR、Uptime Kuma と Zabbix、Discord 通知、イメージの digest ピン留め、ログイン導線と `/auth/complete` 画面。

- [ ] **Step 2: 全ゲートを実行する**

Run: `bun install --frozen-lockfile`

Run: `bun run check`

Run: `bun run build`

Run: 空DBへの `bun run db:migrate`

Run: `bun run db:generate`

Run: `bun run db:auth-schema:check`

Expected: すべて成功、`No schema changes`

- [ ] **Step 3: 受け入れ条件を手で確認する**

spec の受け入れ条件7項目を、ローカルで起動して1つずつ確認する。特に「別のブラウザから他人のデッキが見えないこと」と「04:00 JST を跨いだ新規枚数のリセット」を実際に確かめる。

- [ ] **Step 4: stage 範囲を監査してコミットする**

```bash
git status --short
git diff --check
git diff --cached --name-only
git add docs/todo/pre-release-deferred.md docs/superpowers/specs
git commit -m "docs: プレリリースで見送った項目を一覧化する"
```

**push は禁止。** 公開前に利用者へ Turnstile の資格情報、LXC の用意、Cloudflare Tunnel と DNS の設定を依頼する。
