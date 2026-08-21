import { and, asc, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'
import type { Database, DatabaseTransaction } from '../client'
import { cards, decks } from '../schema/content'
import type { FsrsStateValue } from '../schema/study'
import { cardSchedules, reviewEvents, studySessions } from '../schema/study'

export type Rating = 1 | 2 | 3 | 4

/** 出題スケジュールの1行。`version` は楽観ロックに使う。 */
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
  state: FsrsStateValue
  lastReviewAt: Date | null
  version: number
  schedulerVersion: string
  requestRetention: number
}

/** FSRSを適用した結果。リポジトリは計算せず、渡された値を保存する。 */
export type AppliedSchedule = {
  dueAt: Date
  stability: number
  difficulty: number
  elapsedDays: number
  scheduledDays: number
  learningSteps: number
  reps: number
  lapses: number
  state: FsrsStateValue
  lastReviewAt: Date | null
  schedulerVersion: string
  requestRetention: number
}

/** まだ出題していないカードへ与える初期スケジュール。 */
export type ScheduleSeed = {
  dueAt: Date
  stability: number
  difficulty: number
  schedulerVersion: string
  requestRetention: number
}

export type QueuedCard = {
  cardId: string
  deckId: string
  front: string
  back: string
  schedule: ScheduleRow
}

export type RemainingCounts = {
  review: number
  learning: number
  new: number
}

export type CreateSessionInput = {
  principalId: string
  deckIds: readonly string[] | null
  learningDay: string
  now: Date
}

export type QueueInput = {
  principalId: string
  sessionId: string
  now: Date
  learningDay: string
  initialSchedule: ScheduleSeed
}

export type CountInput = Omit<QueueInput, 'initialSchedule'>

export type SubmitReviewInput = {
  principalId: string
  sessionId: string
  cardId: string
  rating: Rating
  expectedScheduleVersion: number
  idempotencyKey: string
  now: Date
  learningDay: string
  applied: Readonly<Record<Rating, AppliedSchedule>>
  responseDurationMs?: number
}

export type ReviewOutcome = {
  /** 新たに適用したなら真。冪等キーの再送なら偽。 */
  applied: boolean
  schedule: ScheduleRow
}

/** スケジュールが他の要求で進んでいた。呼び出し側は409へ写像する。 */
export class StudyStateConflictError extends Error {
  constructor() {
    super('学習状態が更新されています。')
    this.name = 'StudyStateConflictError'
  }
}

/** 所有者から見て対象カードが存在しない。呼び出し側は404へ写像する。 */
export class CardNotFoundError extends Error {
  constructor() {
    super('対象のカードが見つかりません。')
    this.name = 'CardNotFoundError'
  }
}

/** 期限が来ていて出題対象になる状態。新規はここに含めない。 */
const DUE_STATES: readonly FsrsStateValue[] = [
  'learning',
  'review',
  'relearning',
]

export interface StudyRepository {
  createSession(input: CreateSessionInput): Promise<string>
  nextCard(input: QueueInput): Promise<QueuedCard | null>
  countRemaining(input: CountInput): Promise<RemainingCounts>
  submitReview(input: SubmitReviewInput): Promise<ReviewOutcome>
}

function toScheduleRow(row: typeof cardSchedules.$inferSelect): ScheduleRow {
  return {
    cardId: row.cardId,
    dueAt: row.dueAt,
    stability: row.stability,
    difficulty: row.difficulty,
    elapsedDays: row.elapsedDays,
    scheduledDays: row.scheduledDays,
    learningSteps: row.learningSteps,
    reps: row.reps,
    lapses: row.lapses,
    state: row.state,
    lastReviewAt: row.lastReviewAt,
    version: row.version,
    schedulerVersion: row.schedulerVersion,
    requestRetention: row.requestRetention,
  }
}

export function createStudyRepository(db: Database): StudyRepository {
  /** セッションの対象デッキ。所有者を必ず条件へ含める。 */
  async function resolveScope(
    executor: Database | DatabaseTransaction,
    principalId: string,
    sessionId: string,
  ): Promise<readonly string[]> {
    const [session] = await executor
      .select({ deckIds: studySessions.deckIds })
      .from(studySessions)
      .where(
        and(
          eq(studySessions.id, sessionId),
          eq(studySessions.principalId, principalId),
        ),
      )
      .limit(1)

    if (session === undefined) {
      return []
    }

    const owned = await executor
      .select({ id: decks.id })
      .from(decks)
      .where(and(eq(decks.principalId, principalId), isNull(decks.trashedAt)))

    const ownedIds = owned.map((row) => row.id)

    if (session.deckIds === null) {
      return ownedIds
    }

    // 選択デッキであっても、所有していないIDは黙って落とす。
    const selected = new Set(session.deckIds)
    return ownedIds.filter((id) => selected.has(id))
  }

  /** 対象デッキのうちスケジュール行が無いカードへ初期状態を入れる。 */
  async function ensureSchedules(
    deckIds: readonly string[],
    seed: ScheduleSeed,
  ): Promise<void> {
    if (deckIds.length === 0) {
      return
    }

    const missing = await db
      .select({ id: cards.id })
      .from(cards)
      .leftJoin(cardSchedules, eq(cardSchedules.cardId, cards.id))
      .where(
        and(
          inArray(cards.deckId, [...deckIds]),
          isNull(cards.trashedAt),
          isNull(cardSchedules.cardId),
        ),
      )

    if (missing.length === 0) {
      return
    }

    await db
      .insert(cardSchedules)
      .values(
        missing.map((row) => ({
          cardId: row.id,
          dueAt: seed.dueAt,
          stability: seed.stability,
          difficulty: seed.difficulty,
          state: 'new' as const,
          schedulerVersion: seed.schedulerVersion,
          requestRetention: seed.requestRetention,
        })),
      )
      .onConflictDoNothing()
  }

  /**
   * 当日すでに出した新規カードの枚数をデッキごとに数える。
   * 集計専用のテーブルは作らず、追記専用のレビュー履歴から導出する。
   */
  async function countTodaysNewByDeck(
    principalId: string,
    deckIds: readonly string[],
    learningDay: string,
  ): Promise<Map<string, number>> {
    if (deckIds.length === 0) {
      return new Map()
    }

    const rows = await db
      .select({ deckId: cards.deckId, value: sql<number>`count(*)::int` })
      .from(reviewEvents)
      .innerJoin(cards, eq(cards.id, reviewEvents.cardId))
      .where(
        and(
          eq(reviewEvents.principalId, principalId),
          eq(reviewEvents.learningDay, learningDay),
          inArray(cards.deckId, [...deckIds]),
          sql`${reviewEvents.beforeSnapshot} ->> 'state' = 'new'`,
        ),
      )
      .groupBy(cards.deckId)

    return new Map(rows.map((row) => [row.deckId, row.value]))
  }

  /** 新規をまだ出してよいデッキだけを残す。 */
  async function decksAcceptingNew(
    principalId: string,
    deckIds: readonly string[],
    learningDay: string,
  ): Promise<readonly string[]> {
    if (deckIds.length === 0) {
      return []
    }

    const limits = await db
      .select({ id: decks.id, newCardLimit: decks.newCardLimit })
      .from(decks)
      .where(inArray(decks.id, [...deckIds]))

    const introduced = await countTodaysNewByDeck(
      principalId,
      deckIds,
      learningDay,
    )

    return limits
      .filter((deck) => (introduced.get(deck.id) ?? 0) < deck.newCardLimit)
      .map((deck) => deck.id)
  }

  return {
    async createSession(input) {
      const id = uuidv7()

      await db.insert(studySessions).values({
        id,
        principalId: input.principalId,
        mode: input.deckIds === null ? 'all' : 'selected',
        deckIds: input.deckIds === null ? null : [...input.deckIds],
        learningDay: input.learningDay,
        startedAt: input.now,
        lastActiveAt: input.now,
      })

      return id
    },

    async nextCard(input) {
      const scope = await resolveScope(db, input.principalId, input.sessionId)

      if (scope.length === 0) {
        return null
      }

      await ensureSchedules(scope, input.initialSchedule)

      // 1. 期限到来の復習・再学習をdue順に出す。
      const [due] = await db
        .select({ card: cards, schedule: cardSchedules })
        .from(cardSchedules)
        .innerJoin(cards, eq(cards.id, cardSchedules.cardId))
        .where(
          and(
            inArray(cards.deckId, [...scope]),
            isNull(cards.trashedAt),
            inArray(cardSchedules.state, [...DUE_STATES]),
            lte(cardSchedules.dueAt, input.now),
          ),
        )
        .orderBy(asc(cardSchedules.dueAt), asc(cards.id))
        .limit(1)

      if (due !== undefined) {
        return {
          cardId: due.card.id,
          deckId: due.card.deckId,
          front: due.card.front,
          back: due.card.back,
          schedule: toScheduleRow(due.schedule),
        }
      }

      // 2. 残りは新規。当日の上限に達していないデッキからだけ出す。
      const acceptingDecks = await decksAcceptingNew(
        input.principalId,
        scope,
        input.learningDay,
      )

      if (acceptingDecks.length === 0) {
        return null
      }

      const [fresh] = await db
        .select({ card: cards, schedule: cardSchedules })
        .from(cardSchedules)
        .innerJoin(cards, eq(cards.id, cardSchedules.cardId))
        .where(
          and(
            inArray(cards.deckId, [...acceptingDecks]),
            isNull(cards.trashedAt),
            eq(cardSchedules.state, 'new'),
          ),
        )
        .orderBy(asc(cards.createdAt), asc(cards.id))
        .limit(1)

      if (fresh === undefined) {
        return null
      }

      return {
        cardId: fresh.card.id,
        deckId: fresh.card.deckId,
        front: fresh.card.front,
        back: fresh.card.back,
        schedule: toScheduleRow(fresh.schedule),
      }
    },

    async countRemaining(input) {
      const scope = await resolveScope(db, input.principalId, input.sessionId)

      if (scope.length === 0) {
        return { review: 0, learning: 0, new: 0 }
      }

      const rows = await db
        .select({
          state: cardSchedules.state,
          value: sql<number>`count(*)::int`,
        })
        .from(cardSchedules)
        .innerJoin(cards, eq(cards.id, cardSchedules.cardId))
        .where(
          and(
            inArray(cards.deckId, [...scope]),
            isNull(cards.trashedAt),
            // 生SQLへDateを埋めると型変換を通らないため、演算子で組む。
            or(
              eq(cardSchedules.state, 'new'),
              lte(cardSchedules.dueAt, input.now),
            ),
          ),
        )
        .groupBy(cardSchedules.state)

      const byState = new Map(rows.map((row) => [row.state, row.value]))

      // スケジュール行がまだ無いカードも新規として数える。
      const [unscheduled] = await db
        .select({ value: sql<number>`count(*)::int` })
        .from(cards)
        .leftJoin(cardSchedules, eq(cardSchedules.cardId, cards.id))
        .where(
          and(
            inArray(cards.deckId, [...scope]),
            isNull(cards.trashedAt),
            isNull(cardSchedules.cardId),
          ),
        )

      return {
        review: byState.get('review') ?? 0,
        learning:
          (byState.get('learning') ?? 0) + (byState.get('relearning') ?? 0),
        new: (byState.get('new') ?? 0) + (unscheduled?.value ?? 0),
      }
    },

    async submitReview(input) {
      return db.transaction(async (tx) => {
        // 1. 冪等キーの再送は、スケジュールを比較する前に記録済みの結果を返す。
        const [recorded] = await tx
          .select({ afterSnapshot: reviewEvents.afterSnapshot })
          .from(reviewEvents)
          .where(
            and(
              eq(reviewEvents.principalId, input.principalId),
              eq(reviewEvents.idempotencyKey, input.idempotencyKey),
            ),
          )
          .limit(1)

        if (recorded !== undefined) {
          const [current] = await tx
            .select()
            .from(cardSchedules)
            .where(eq(cardSchedules.cardId, input.cardId))
            .limit(1)

          if (current === undefined) {
            throw new CardNotFoundError()
          }

          return { applied: false, schedule: toScheduleRow(current) }
        }

        // 2. 所有者を含めて対象行をロックする。
        const locked = await tx
          .select({ schedule: cardSchedules })
          .from(cardSchedules)
          .innerJoin(cards, eq(cards.id, cardSchedules.cardId))
          .innerJoin(decks, eq(decks.id, cards.deckId))
          .where(
            and(
              eq(cardSchedules.cardId, input.cardId),
              eq(decks.principalId, input.principalId),
              isNull(decks.trashedAt),
              isNull(cards.trashedAt),
            ),
          )
          .for('update', { of: cardSchedules })
          .limit(1)

        const current = locked[0]?.schedule

        if (current === undefined) {
          throw new CardNotFoundError()
        }

        // 3. ロック後にバージョンを突き合わせる。
        if (current.version !== input.expectedScheduleVersion) {
          throw new StudyStateConflictError()
        }

        // 4-5. 適用結果を書き戻し、バージョンを進める。
        const next = input.applied[input.rating]
        const nextVersion = current.version + 1

        await tx
          .update(cardSchedules)
          .set({
            dueAt: next.dueAt,
            stability: next.stability,
            difficulty: next.difficulty,
            elapsedDays: next.elapsedDays,
            scheduledDays: next.scheduledDays,
            learningSteps: next.learningSteps,
            reps: next.reps,
            lapses: next.lapses,
            state: next.state,
            lastReviewAt: next.lastReviewAt,
            version: nextVersion,
            schedulerVersion: next.schedulerVersion,
            requestRetention: next.requestRetention,
            updatedAt: input.now,
          })
          .where(eq(cardSchedules.cardId, input.cardId))

        const before = toScheduleRow(current)
        const after: ScheduleRow = {
          ...next,
          cardId: input.cardId,
          version: nextVersion,
        }

        // 6. 追記専用のレビュー履歴を残す。
        await tx.insert(reviewEvents).values({
          id: uuidv7(),
          principalId: input.principalId,
          cardId: input.cardId,
          sessionId: input.sessionId,
          rating: input.rating,
          beforeSnapshot: toSnapshotJson(before),
          afterSnapshot: toSnapshotJson(after),
          reviewedAt: input.now,
          learningDay: input.learningDay,
          idempotencyKey: input.idempotencyKey,
          ...(input.responseDurationMs === undefined
            ? {}
            : { responseDurationMs: input.responseDurationMs }),
        })

        await tx
          .update(studySessions)
          .set({ lastActiveAt: input.now })
          .where(eq(studySessions.id, input.sessionId))

        return { applied: true, schedule: after }
      })
    },
  }
}

/** 履歴へ残す形。Dateはミリ秒を落とさない文字列にする。 */
function toSnapshotJson(row: ScheduleRow): Readonly<Record<string, unknown>> {
  return {
    cardId: row.cardId,
    dueAt: row.dueAt.toISOString(),
    stability: row.stability,
    difficulty: row.difficulty,
    elapsedDays: row.elapsedDays,
    scheduledDays: row.scheduledDays,
    learningSteps: row.learningSteps,
    reps: row.reps,
    lapses: row.lapses,
    state: row.state,
    lastReviewAt:
      row.lastReviewAt === null ? null : row.lastReviewAt.toISOString(),
    version: row.version,
    schedulerVersion: row.schedulerVersion,
    requestRetention: row.requestRetention,
  }
}
