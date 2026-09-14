import { randomUUID } from 'node:crypto'
import { v7 as uuidv7 } from 'uuid'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import * as schema from '../schema'
import type { TestDatabaseHandle } from '../test/database'
import { createTestDatabase, resetIdentityTables } from '../test/database'
import type { ContentRepository } from './content-repository'
import { createContentRepository } from './content-repository'
import type { ScheduleRow, StudyRepository } from './study-repository'
import {
  createStudyRepository,
  StudyStateConflictError,
  UndoUnavailableError,
} from './study-repository'

const SCHEDULER_VERSION = 'ts-fsrs@5.4.1/fsrs-6'
const LEARNING_DAY = '2026-08-21'
const NOW = new Date('2026-08-21T03:00:00Z')

/** 新規カードへ最初に与えるスケジュール。FSRSの初期状態と同じ形。 */
const INITIAL_SEED = {
  dueAt: NOW,
  stability: 0,
  difficulty: 0,
  schedulerVersion: SCHEDULER_VERSION,
  requestRetention: 0.9,
}

describe('StudyRepository', () => {
  let handle: TestDatabaseHandle
  let content: ContentRepository
  let repository: StudyRepository

  beforeAll(async () => {
    handle = await createTestDatabase()
    content = createContentRepository(handle.db)
    repository = createStudyRepository(handle.db)
  })

  afterAll(async () => {
    if (handle !== undefined) {
      await handle.close()
    }
  })

  beforeEach(async () => {
    await resetIdentityTables(handle)
  })

  async function insertGuestPrincipal(): Promise<string> {
    const id = uuidv7()
    await handle.db.insert(schema.principals).values({ id, kind: 'guest' })
    return id
  }

  /** デッキと指定枚数のカードを作る。 */
  async function seedDeck(
    principalId: string,
    cardCount: number,
    newCardLimit?: number,
  ): Promise<{ deckId: string; cardIds: string[] }> {
    const deck = await content.createDeck(
      principalId,
      {
        name: `デッキ${uuidv7().slice(0, 8)}`,
        ...(newCardLimit === undefined ? {} : { newCardLimit }),
      },
      NOW,
    )

    const cardIds: string[] = []
    for (let index = 0; index < cardCount; index += 1) {
      const card = await content.createCard(
        principalId,
        deck.id,
        { front: `表${index}`, back: `裏${index}` },
        NOW,
      )
      if (card !== null) {
        cardIds.push(card.id)
      }
    }

    return { deckId: deck.id, cardIds }
  }

  async function startSession(
    principalId: string,
    deckIds: readonly string[] | null = null,
  ): Promise<string> {
    return repository.createSession({
      principalId,
      deckIds,
      learningDay: LEARNING_DAY,
      now: NOW,
    })
  }

  /** 4段階のうち評価3だけを使う、決定的な適用結果。 */
  function applied(current: ScheduleRow, now: Date) {
    const next = {
      dueAt: new Date(now.getTime() + 24 * 60 * 60 * 1000),
      stability: current.stability + 1,
      difficulty: 5,
      elapsedDays: 0,
      scheduledDays: 1,
      learningSteps: 0,
      reps: current.reps + 1,
      lapses: current.lapses,
      state: 'review' as const,
      lastReviewAt: now,
      schedulerVersion: SCHEDULER_VERSION,
      requestRetention: 0.9,
    }

    return { 1: next, 2: next, 3: next, 4: next }
  }

  describe('出題キュー', () => {
    test('スケジュールが無いカードにも初期状態を与えて出題する', async () => {
      const owner = await insertGuestPrincipal()
      await seedDeck(owner, 1)
      const sessionId = await startSession(owner)

      const card = await repository.nextCard({
        principalId: owner,
        sessionId,
        now: NOW,
        learningDay: LEARNING_DAY,
        initialSchedule: INITIAL_SEED,
      })

      expect(card).not.toBeNull()
      expect(card?.schedule.state).toBe('new')
      expect(card?.schedule.version).toBe(1)

      const rows = await handle.db.select().from(schema.cardSchedules)
      expect(rows).toHaveLength(1)
    })

    test('他人のカードは出題されない', async () => {
      const owner = await insertGuestPrincipal()
      const other = await insertGuestPrincipal()
      await seedDeck(owner, 1)
      const sessionId = await startSession(owner)

      const card = await repository.nextCard({
        principalId: other,
        sessionId,
        now: NOW,
        learningDay: LEARNING_DAY,
        initialSchedule: INITIAL_SEED,
      })

      expect(card).toBeNull()
    })

    test('削除済みカードは出題されない', async () => {
      const owner = await insertGuestPrincipal()
      const { cardIds } = await seedDeck(owner, 1)
      const [cardId] = cardIds
      expect(cardId).toBeDefined()
      if (cardId === undefined) {
        return
      }
      await content.trashCard(owner, cardId, NOW)
      const sessionId = await startSession(owner)

      expect(
        await repository.nextCard({
          principalId: owner,
          sessionId,
          now: NOW,
          learningDay: LEARNING_DAY,
          initialSchedule: INITIAL_SEED,
        }),
      ).toBeNull()
    })

    test('選択デッキ以外のカードは出題されない', async () => {
      const owner = await insertGuestPrincipal()
      const selected = await seedDeck(owner, 1)
      const excluded = await seedDeck(owner, 1)
      const sessionId = await startSession(owner, [selected.deckId])

      const card = await repository.nextCard({
        principalId: owner,
        sessionId,
        now: NOW,
        learningDay: LEARNING_DAY,
        initialSchedule: INITIAL_SEED,
      })

      expect(selected.cardIds).toContain(card?.cardId)
      expect(excluded.cardIds).not.toContain(card?.cardId)
    })

    test('期限到来の復習カードを新規より先に出す', async () => {
      const owner = await insertGuestPrincipal()
      const { cardIds } = await seedDeck(owner, 2)
      const [dueCardId] = cardIds
      expect(dueCardId).toBeDefined()
      if (dueCardId === undefined) {
        return
      }

      await handle.db.insert(schema.cardSchedules).values({
        cardId: dueCardId,
        dueAt: new Date(NOW.getTime() - 60_000),
        stability: 1,
        difficulty: 5,
        state: 'review',
        schedulerVersion: SCHEDULER_VERSION,
        requestRetention: 0.9,
      })

      const sessionId = await startSession(owner)
      const card = await repository.nextCard({
        principalId: owner,
        sessionId,
        now: NOW,
        learningDay: LEARNING_DAY,
        initialSchedule: INITIAL_SEED,
      })

      expect(card?.cardId).toBe(dueCardId)
      expect(card?.schedule.state).toBe('review')
    })

    test('期限が来ていない復習カードは出さない', async () => {
      const owner = await insertGuestPrincipal()
      const { cardIds } = await seedDeck(owner, 1)
      const [cardId] = cardIds
      expect(cardId).toBeDefined()
      if (cardId === undefined) {
        return
      }

      await handle.db.insert(schema.cardSchedules).values({
        cardId,
        dueAt: new Date(NOW.getTime() + 60 * 60 * 1000),
        stability: 1,
        difficulty: 5,
        state: 'review',
        schedulerVersion: SCHEDULER_VERSION,
        requestRetention: 0.9,
      })

      const sessionId = await startSession(owner)

      expect(
        await repository.nextCard({
          principalId: owner,
          sessionId,
          now: NOW,
          learningDay: LEARNING_DAY,
          initialSchedule: INITIAL_SEED,
        }),
      ).toBeNull()
    })

    test('新規カードは学習日あたりの上限で打ち切られる', async () => {
      const owner = await insertGuestPrincipal()
      const { deckId, cardIds } = await seedDeck(owner, 3, 2)
      const sessionId = await startSession(owner, [deckId])

      // 当日すでに2枚の新規を出したことにする。
      for (const cardId of cardIds.slice(0, 2)) {
        await handle.db.insert(schema.cardSchedules).values({
          cardId,
          dueAt: new Date(NOW.getTime() + 60 * 60 * 1000),
          stability: 1,
          difficulty: 5,
          state: 'learning',
          schedulerVersion: SCHEDULER_VERSION,
          requestRetention: 0.9,
        })
        await handle.db.insert(schema.reviewEvents).values({
          id: uuidv7(),
          principalId: owner,
          cardId,
          sessionId,
          rating: 3,
          beforeSnapshot: { state: 'new' },
          afterSnapshot: { state: 'learning' },
          reviewedAt: NOW,
          learningDay: LEARNING_DAY,
          idempotencyKey: randomUUID(),
        })
      }

      expect(
        await repository.nextCard({
          principalId: owner,
          sessionId,
          now: NOW,
          learningDay: LEARNING_DAY,
          initialSchedule: INITIAL_SEED,
        }),
      ).toBeNull()
    })

    test('学習日が変われば新規の上限は戻る', async () => {
      const owner = await insertGuestPrincipal()
      const { deckId, cardIds } = await seedDeck(owner, 3, 2)
      const sessionId = await startSession(owner, [deckId])

      for (const cardId of cardIds.slice(0, 2)) {
        await handle.db.insert(schema.reviewEvents).values({
          id: uuidv7(),
          principalId: owner,
          cardId,
          sessionId,
          rating: 3,
          beforeSnapshot: { state: 'new' },
          afterSnapshot: { state: 'learning' },
          reviewedAt: NOW,
          learningDay: LEARNING_DAY,
          idempotencyKey: randomUUID(),
        })
      }

      const nextDay = await repository.nextCard({
        principalId: owner,
        sessionId,
        now: NOW,
        learningDay: '2026-08-22',
        initialSchedule: INITIAL_SEED,
      })

      expect(nextDay).not.toBeNull()
    })

    test('残り枚数を種類ごとに数える', async () => {
      const owner = await insertGuestPrincipal()
      const { cardIds } = await seedDeck(owner, 3)
      const [dueCardId] = cardIds
      expect(dueCardId).toBeDefined()
      if (dueCardId === undefined) {
        return
      }

      await handle.db.insert(schema.cardSchedules).values({
        cardId: dueCardId,
        dueAt: new Date(NOW.getTime() - 60_000),
        stability: 1,
        difficulty: 5,
        state: 'review',
        schedulerVersion: SCHEDULER_VERSION,
        requestRetention: 0.9,
      })

      const sessionId = await startSession(owner)
      const remaining = await repository.countRemaining({
        principalId: owner,
        sessionId,
        now: NOW,
        learningDay: LEARNING_DAY,
      })

      expect(remaining.review).toBe(1)
      expect(remaining.new).toBe(2)
    })
  })

  describe('デッキごとの残り枚数', () => {
    test('復習と新規をデッキごとに数え、他人のデッキは含めない', async () => {
      const owner = await insertGuestPrincipal()
      const other = await insertGuestPrincipal()
      const first = await seedDeck(owner, 3)
      const second = await seedDeck(owner, 2)
      await seedDeck(other, 5)
      const [dueCardId] = first.cardIds
      expect(dueCardId).toBeDefined()
      if (dueCardId === undefined) {
        return
      }

      await handle.db.insert(schema.cardSchedules).values({
        cardId: dueCardId,
        dueAt: new Date(NOW.getTime() - 60_000),
        stability: 1,
        difficulty: 5,
        state: 'review',
        schedulerVersion: SCHEDULER_VERSION,
        requestRetention: 0.9,
      })

      const counts = await repository.countDeckQueues({
        principalId: owner,
        now: NOW,
        learningDay: LEARNING_DAY,
      })

      expect(counts).toHaveLength(2)
      expect(counts.find((deck) => deck.deckId === first.deckId)).toEqual({
        deckId: first.deckId,
        review: 1,
        learning: 0,
        new: 2,
      })
      expect(counts.find((deck) => deck.deckId === second.deckId)).toEqual({
        deckId: second.deckId,
        review: 0,
        learning: 0,
        new: 2,
      })
    })

    test('新規の残りは1日の上限を超えない', async () => {
      const owner = await insertGuestPrincipal()
      const { deckId } = await seedDeck(owner, 5, 2)

      const counts = await repository.countDeckQueues({
        principalId: owner,
        now: NOW,
        learningDay: LEARNING_DAY,
      })

      expect(counts.find((deck) => deck.deckId === deckId)?.new).toBe(2)
    })

    test('当日すでに出した新規は残りから引く', async () => {
      const owner = await insertGuestPrincipal()
      const { deckId } = await seedDeck(owner, 5, 2)
      const sessionId = await startSession(owner)
      const card = await repository.nextCard({
        principalId: owner,
        sessionId,
        now: NOW,
        learningDay: LEARNING_DAY,
        initialSchedule: INITIAL_SEED,
      })
      expect(card).not.toBeNull()
      if (card === null) {
        return
      }

      await repository.submitReview({
        principalId: owner,
        sessionId,
        cardId: card.cardId,
        rating: 3,
        expectedScheduleVersion: card.schedule.version,
        idempotencyKey: randomUUID(),
        now: NOW,
        learningDay: LEARNING_DAY,
        apply: (current) => applied(current, NOW),
      })

      const counts = await repository.countDeckQueues({
        principalId: owner,
        now: NOW,
        learningDay: LEARNING_DAY,
      })

      expect(counts.find((deck) => deck.deckId === deckId)?.new).toBe(1)
    })

    test('削除したデッキは数えない', async () => {
      const owner = await insertGuestPrincipal()
      const { deckId } = await seedDeck(owner, 2)
      await content.trashDeck(owner, deckId, NOW)

      const counts = await repository.countDeckQueues({
        principalId: owner,
        now: NOW,
        learningDay: LEARNING_DAY,
      })

      expect(counts).toEqual([])
    })
  })

  describe('レビュー取引', () => {
    async function prepareReview(): Promise<{
      principalId: string
      sessionId: string
      cardId: string
      schedule: ScheduleRow
    }> {
      const principalId = await insertGuestPrincipal()
      await seedDeck(principalId, 1)
      const sessionId = await startSession(principalId)
      const card = await repository.nextCard({
        principalId,
        sessionId,
        now: NOW,
        learningDay: LEARNING_DAY,
        initialSchedule: INITIAL_SEED,
      })

      if (card === null) {
        throw new Error('出題できませんでした。')
      }

      return {
        principalId,
        sessionId,
        cardId: card.cardId,
        schedule: card.schedule,
      }
    }

    test('評価を適用してバージョンを進める', async () => {
      const prepared = await prepareReview()

      const outcome = await repository.submitReview({
        principalId: prepared.principalId,
        sessionId: prepared.sessionId,
        cardId: prepared.cardId,
        rating: 3,
        expectedScheduleVersion: prepared.schedule.version,
        idempotencyKey: randomUUID(),
        now: NOW,
        learningDay: LEARNING_DAY,
        apply: (current) => applied(current, NOW),
      })

      expect(outcome.applied).toBe(true)
      expect(outcome.schedule.version).toBe(prepared.schedule.version + 1)
      expect(outcome.schedule.state).toBe('review')

      const events = await handle.db.select().from(schema.reviewEvents)
      expect(events).toHaveLength(1)
      expect(events[0]?.rating).toBe(3)
    })

    test('同じ冪等キーの再送は二重に採点されない', async () => {
      const prepared = await prepareReview()
      const idempotencyKey = randomUUID()
      let applyCalls = 0
      const input = {
        principalId: prepared.principalId,
        sessionId: prepared.sessionId,
        cardId: prepared.cardId,
        rating: 3 as const,
        expectedScheduleVersion: prepared.schedule.version,
        idempotencyKey,
        now: NOW,
        learningDay: LEARNING_DAY,
        apply(current: ScheduleRow) {
          applyCalls += 1
          return applied(current, NOW)
        },
      }

      const first = await repository.submitReview(input)
      const second = await repository.submitReview(input)

      expect(first.applied).toBe(true)
      expect(second.applied).toBe(false)
      expect(second.schedule.version).toBe(first.schedule.version)
      expect(applyCalls).toBe(1)

      const events = await handle.db.select().from(schema.reviewEvents)
      expect(events).toHaveLength(1)
    })

    test('古いバージョンでの投稿を競合として拒否する', async () => {
      const prepared = await prepareReview()
      await repository.submitReview({
        principalId: prepared.principalId,
        sessionId: prepared.sessionId,
        cardId: prepared.cardId,
        rating: 3,
        expectedScheduleVersion: prepared.schedule.version,
        idempotencyKey: randomUUID(),
        now: NOW,
        learningDay: LEARNING_DAY,
        apply: (current) => applied(current, NOW),
      })

      await expect(
        repository.submitReview({
          principalId: prepared.principalId,
          sessionId: prepared.sessionId,
          cardId: prepared.cardId,
          rating: 3,
          expectedScheduleVersion: prepared.schedule.version,
          idempotencyKey: randomUUID(),
          now: NOW,
          learningDay: LEARNING_DAY,
          apply: (current) => applied(current, NOW),
        }),
      ).rejects.toBeInstanceOf(StudyStateConflictError)

      const events = await handle.db.select().from(schema.reviewEvents)
      expect(events).toHaveLength(1)
    })

    test('他人のカードへは投稿できない', async () => {
      const prepared = await prepareReview()
      const other = await insertGuestPrincipal()

      await expect(
        repository.submitReview({
          principalId: other,
          sessionId: prepared.sessionId,
          cardId: prepared.cardId,
          rating: 3,
          expectedScheduleVersion: prepared.schedule.version,
          idempotencyKey: randomUUID(),
          now: NOW,
          learningDay: LEARNING_DAY,
          apply: (current) => applied(current, NOW),
        }),
      ).rejects.toThrow()

      const events = await handle.db.select().from(schema.reviewEvents)
      expect(events).toHaveLength(0)
    })

    test('選択セッションの範囲外カードへは投稿できない', async () => {
      const principalId = await insertGuestPrincipal()
      const selected = await seedDeck(principalId, 1)
      const outside = await seedDeck(principalId, 1)
      const selectedSessionId = await startSession(principalId, [
        selected.deckId,
      ])
      const outsideSessionId = await startSession(principalId, [outside.deckId])
      const outsideCard = await repository.nextCard({
        principalId,
        sessionId: outsideSessionId,
        now: NOW,
        learningDay: LEARNING_DAY,
        initialSchedule: INITIAL_SEED,
      })
      if (outsideCard === null) {
        throw new Error('範囲外カードを準備できませんでした。')
      }

      await expect(
        repository.submitReview({
          principalId,
          sessionId: selectedSessionId,
          cardId: outsideCard.cardId,
          rating: 3,
          expectedScheduleVersion: outsideCard.schedule.version,
          idempotencyKey: randomUUID(),
          now: NOW,
          learningDay: LEARNING_DAY,
          apply: (current) => applied(current, NOW),
        }),
      ).rejects.toThrow()

      expect(await handle.db.select().from(schema.reviewEvents)).toHaveLength(0)
    })

    test('並行投稿はどちらか一方だけが適用される', async () => {
      const prepared = await prepareReview()
      const submit = () =>
        repository.submitReview({
          principalId: prepared.principalId,
          sessionId: prepared.sessionId,
          cardId: prepared.cardId,
          rating: 3,
          expectedScheduleVersion: prepared.schedule.version,
          idempotencyKey: randomUUID(),
          now: NOW,
          learningDay: LEARNING_DAY,
          apply: (current) => applied(current, NOW),
        })

      const results = await Promise.allSettled([submit(), submit()])
      const fulfilled = results.filter(
        (result) => result.status === 'fulfilled',
      )

      expect(fulfilled).toHaveLength(1)

      const events = await handle.db.select().from(schema.reviewEvents)
      expect(events).toHaveLength(1)
    })

    test('レビュー履歴に学習日と前後の状態を残す', async () => {
      const prepared = await prepareReview()

      await repository.submitReview({
        principalId: prepared.principalId,
        sessionId: prepared.sessionId,
        cardId: prepared.cardId,
        rating: 4,
        expectedScheduleVersion: prepared.schedule.version,
        idempotencyKey: randomUUID(),
        now: NOW,
        learningDay: LEARNING_DAY,
        apply: (current) => applied(current, NOW),
      })

      const [event] = await handle.db.select().from(schema.reviewEvents)

      expect(event?.learningDay).toBe(LEARNING_DAY)
      expect(event?.beforeSnapshot).toMatchObject({ state: 'new' })
      expect(event?.afterSnapshot).toMatchObject({ state: 'review' })
      expect(event?.reviewedAt?.getTime()).toBe(NOW.getTime())
    })
  })

  describe('レビューの取り消し', () => {
    /** 1枚を出題して評価まで進め、取り消しの前提を作る。 */
    async function reviewOnce(): Promise<{
      principalId: string
      sessionId: string
      cardId: string
      before: ScheduleRow
      after: ScheduleRow
    }> {
      const principalId = await insertGuestPrincipal()
      await seedDeck(principalId, 1)
      const sessionId = await startSession(principalId)
      const card = await repository.nextCard({
        principalId,
        sessionId,
        now: NOW,
        learningDay: LEARNING_DAY,
        initialSchedule: INITIAL_SEED,
      })

      if (card === null) {
        throw new Error('出題できませんでした。')
      }

      const outcome = await repository.submitReview({
        principalId,
        sessionId,
        cardId: card.cardId,
        rating: 3,
        expectedScheduleVersion: card.schedule.version,
        idempotencyKey: randomUUID(),
        now: NOW,
        learningDay: LEARNING_DAY,
        apply: (current) => applied(current, NOW),
      })

      return {
        principalId,
        sessionId,
        cardId: card.cardId,
        before: card.schedule,
        after: outcome.schedule,
      }
    }

    test('直前の評価を評価前の状態へ戻す', async () => {
      const prepared = await reviewOnce()

      const outcome = await repository.undoLastReview({
        principalId: prepared.principalId,
        sessionId: prepared.sessionId,
        idempotencyKey: randomUUID(),
        now: NOW,
        learningDay: LEARNING_DAY,
      })

      expect(outcome.applied).toBe(true)
      expect(outcome.cardId).toBe(prepared.cardId)
      expect(outcome.schedule.state).toBe(prepared.before.state)
      expect(outcome.schedule.reps).toBe(prepared.before.reps)
      expect(outcome.schedule.dueAt.getTime()).toBe(
        prepared.before.dueAt.getTime(),
      )
    })

    test('バージョンは巻き戻さず前へ進める', async () => {
      // 巻き戻すと、古い版を握った並行要求が通ってしまう。
      const prepared = await reviewOnce()

      const outcome = await repository.undoLastReview({
        principalId: prepared.principalId,
        sessionId: prepared.sessionId,
        idempotencyKey: randomUUID(),
        now: NOW,
        learningDay: LEARNING_DAY,
      })

      expect(outcome.schedule.version).toBe(prepared.after.version + 1)
    })

    test('補正イベントを追記して評価は消さない', async () => {
      const prepared = await reviewOnce()

      await repository.undoLastReview({
        principalId: prepared.principalId,
        sessionId: prepared.sessionId,
        idempotencyKey: randomUUID(),
        now: NOW,
        learningDay: LEARNING_DAY,
      })

      const events = await handle.db
        .select({ kind: schema.reviewEvents.kind })
        .from(schema.reviewEvents)

      expect(events.map((row) => row.kind).sort()).toEqual(['review', 'undo'])
    })

    test('同じ冪等キーの再送で二重に戻さない', async () => {
      const prepared = await reviewOnce()
      const idempotencyKey = randomUUID()
      const input = {
        principalId: prepared.principalId,
        sessionId: prepared.sessionId,
        idempotencyKey,
        now: NOW,
        learningDay: LEARNING_DAY,
      }

      const first = await repository.undoLastReview(input)
      const second = await repository.undoLastReview(input)

      expect(first.applied).toBe(true)
      expect(second.applied).toBe(false)
      expect(second.schedule.version).toBe(first.schedule.version)

      const events = await handle.db.select().from(schema.reviewEvents)
      expect(events).toHaveLength(2)
    })

    test('戻せる評価が無ければ拒否する', async () => {
      const principalId = await insertGuestPrincipal()
      await seedDeck(principalId, 1)
      const sessionId = await startSession(principalId)

      await expect(
        repository.undoLastReview({
          principalId,
          sessionId,
          idempotencyKey: randomUUID(),
          now: NOW,
          learningDay: LEARNING_DAY,
        }),
      ).rejects.toBeInstanceOf(UndoUnavailableError)
    })

    test('二度続けて取り消せない', async () => {
      // 戻せるのは直前の1手だけ。
      const prepared = await reviewOnce()
      await repository.undoLastReview({
        principalId: prepared.principalId,
        sessionId: prepared.sessionId,
        idempotencyKey: randomUUID(),
        now: NOW,
        learningDay: LEARNING_DAY,
      })

      await expect(
        repository.undoLastReview({
          principalId: prepared.principalId,
          sessionId: prepared.sessionId,
          idempotencyKey: randomUUID(),
          now: NOW,
          learningDay: LEARNING_DAY,
        }),
      ).rejects.toBeInstanceOf(UndoUnavailableError)
    })

    test('他人のセッションは戻せない', async () => {
      const prepared = await reviewOnce()
      const other = await insertGuestPrincipal()

      await expect(
        repository.undoLastReview({
          principalId: other,
          sessionId: prepared.sessionId,
          idempotencyKey: randomUUID(),
          now: NOW,
          learningDay: LEARNING_DAY,
        }),
      ).rejects.toThrow()

      const events = await handle.db.select().from(schema.reviewEvents)
      expect(events).toHaveLength(1)
    })

    test('取り消すと当日の新規枠が戻る', async () => {
      // 新規1枚のデッキで1枚出して評価し、取り消したら再び出る。
      const principalId = await insertGuestPrincipal()
      const { deckId } = await seedDeck(principalId, 2, 1)
      const sessionId = await startSession(principalId, [deckId])
      const card = await repository.nextCard({
        principalId,
        sessionId,
        now: NOW,
        learningDay: LEARNING_DAY,
        initialSchedule: INITIAL_SEED,
      })

      if (card === null) {
        throw new Error('出題できませんでした。')
      }

      await repository.submitReview({
        principalId,
        sessionId,
        cardId: card.cardId,
        rating: 3,
        expectedScheduleVersion: card.schedule.version,
        idempotencyKey: randomUUID(),
        now: NOW,
        learningDay: LEARNING_DAY,
        apply: (current) => applied(current, NOW),
      })

      await repository.undoLastReview({
        principalId,
        sessionId,
        idempotencyKey: randomUUID(),
        now: NOW,
        learningDay: LEARNING_DAY,
      })

      const again = await repository.nextCard({
        principalId,
        sessionId,
        now: NOW,
        learningDay: LEARNING_DAY,
        initialSchedule: INITIAL_SEED,
      })

      expect(again).not.toBeNull()
    })
  })

  describe('進捗の集計', () => {
    /** 活動量に並べる学習日数。 */
    const DAYS = 7
    const YESTERDAY = '2026-08-20'
    const YESTERDAY_NOW = new Date(NOW.getTime() - 24 * 60 * 60 * 1000)

    /** キューの先頭を1枚評価する。評価そのものの挙動は別の節で見ている。 */
    async function reviewOne(
      principalId: string,
      sessionId: string,
      learningDay: string,
      now: Date,
    ): Promise<string | null> {
      const card = await repository.nextCard({
        principalId,
        sessionId,
        now,
        learningDay,
        initialSchedule: INITIAL_SEED,
      })
      if (card === null) {
        return null
      }

      await repository.submitReview({
        principalId,
        sessionId,
        cardId: card.cardId,
        rating: 3,
        expectedScheduleVersion: card.schedule.version,
        idempotencyKey: randomUUID(),
        now,
        learningDay,
        apply: (current) => applied(current, now),
      })

      return card.cardId
    }

    function summarize(principalId: string) {
      return repository.summarizeProgress({
        principalId,
        learningDay: LEARNING_DAY,
        days: DAYS,
        now: NOW,
      })
    }

    test('履歴が無ければすべて0で次回期限も無い', async () => {
      const owner = await insertGuestPrincipal()

      const summary = await summarize(owner)

      expect(summary.completedToday).toBe(0)
      expect(summary.streakDays).toBe(0)
      expect(summary.nextDueAt).toBeNull()
      expect(summary.activity).toHaveLength(DAYS)
      expect(summary.activity.every((day) => day.reviews === 0)).toBe(true)
    })

    test('当日に評価した枚数を数える', async () => {
      const owner = await insertGuestPrincipal()
      await seedDeck(owner, 2)
      const sessionId = await startSession(owner)
      await reviewOne(owner, sessionId, LEARNING_DAY, NOW)
      await reviewOne(owner, sessionId, LEARNING_DAY, NOW)

      expect((await summarize(owner)).completedToday).toBe(2)
    })

    test('取り消した評価は当日の枚数から引く', async () => {
      // 追記専用の履歴から差し引きで出す。取り消しても行は消さない。
      const owner = await insertGuestPrincipal()
      await seedDeck(owner, 2)
      const sessionId = await startSession(owner)
      await reviewOne(owner, sessionId, LEARNING_DAY, NOW)
      await reviewOne(owner, sessionId, LEARNING_DAY, NOW)
      await repository.undoLastReview({
        principalId: owner,
        sessionId,
        idempotencyKey: randomUUID(),
        now: NOW,
        learningDay: LEARNING_DAY,
      })

      expect((await summarize(owner)).completedToday).toBe(1)
    })

    test('活動量は指定日数ぶんを古い順に並べ、評価の無い日は0にする', async () => {
      const owner = await insertGuestPrincipal()
      await seedDeck(owner, 1)
      const sessionId = await startSession(owner)
      await reviewOne(owner, sessionId, LEARNING_DAY, NOW)

      const activity = (await summarize(owner)).activity

      expect(activity).toHaveLength(DAYS)
      expect(activity[0]?.learningDay).toBe('2026-08-15')
      expect(activity[DAYS - 1]?.learningDay).toBe(LEARNING_DAY)
      expect(activity[DAYS - 1]?.reviews).toBe(1)
      expect(activity[DAYS - 2]?.reviews).toBe(0)
    })

    test('連続した学習日を数える', async () => {
      const owner = await insertGuestPrincipal()
      await seedDeck(owner, 2)
      const yesterdaySession = await repository.createSession({
        principalId: owner,
        deckIds: null,
        learningDay: YESTERDAY,
        now: YESTERDAY_NOW,
      })
      await reviewOne(owner, yesterdaySession, YESTERDAY, YESTERDAY_NOW)
      const sessionId = await startSession(owner)
      await reviewOne(owner, sessionId, LEARNING_DAY, NOW)

      expect((await summarize(owner)).streakDays).toBe(2)
    })

    test('当日が未着手でも前日までの連続は途切れない', async () => {
      // 朝いちで0日と出すと、続いている実感を壊す。
      const owner = await insertGuestPrincipal()
      await seedDeck(owner, 1)
      const yesterdaySession = await repository.createSession({
        principalId: owner,
        deckIds: null,
        learningDay: YESTERDAY,
        now: YESTERDAY_NOW,
      })
      await reviewOne(owner, yesterdaySession, YESTERDAY, YESTERDAY_NOW)

      const summary = await summarize(owner)

      expect(summary.completedToday).toBe(0)
      expect(summary.streakDays).toBe(1)
    })

    test('次回期限は未来のスケジュールのうち最も早いものを返す', async () => {
      const owner = await insertGuestPrincipal()
      await seedDeck(owner, 1)
      const sessionId = await startSession(owner)
      await reviewOne(owner, sessionId, LEARNING_DAY, NOW)

      const summary = await summarize(owner)

      expect(summary.nextDueAt?.getTime()).toBe(
        NOW.getTime() + 24 * 60 * 60 * 1000,
      )
    })

    test('他人の履歴は混ざらない', async () => {
      const owner = await insertGuestPrincipal()
      const other = await insertGuestPrincipal()
      await seedDeck(other, 1)
      const otherSession = await startSession(other)
      await reviewOne(other, otherSession, LEARNING_DAY, NOW)

      const summary = await summarize(owner)

      expect(summary.completedToday).toBe(0)
      expect(summary.nextDueAt).toBeNull()
    })
  })
})
