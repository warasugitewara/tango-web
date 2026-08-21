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
})
