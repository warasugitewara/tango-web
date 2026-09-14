import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  lte,
  or,
  sql,
} from 'drizzle-orm'
import { v7 as uuidv7 } from 'uuid'
import type { Database, DatabaseTransaction } from '../client'
import { cards, decks } from '../schema/content'
import type { FsrsStateValue, ScheduleSnapshotJson } from '../schema/study'
import {
  cardSchedules,
  FSRS_STATES,
  reviewEvents,
  studySessions,
} from '../schema/study'

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

/** デッキ一覧に出す当日の残り枚数。新規は1日の上限を反映した後の値。 */
export type DeckQueueCounts = {
  deckId: string
  review: number
  learning: number
  new: number
}

export type DeckQueueInput = {
  principalId: string
  now: Date
  learningDay: string
}

/** 活動量の1日分。`reviews` は取り消しを差し引いた実効枚数。 */
export type ActivityDay = {
  learningDay: string
  reviews: number
}

/** ダッシュボードに出す進捗の集計。 */
export type ProgressSummary = {
  completedToday: number
  /** 古い順に `days` 件。評価の無い日も0で埋める。 */
  activity: readonly ActivityDay[]
  streakDays: number
  /** まだ期限が来ていないカードのうち、最も早い期限。 */
  nextDueAt: Date | null
}

export type ProgressInput = {
  principalId: string
  learningDay: string
  /** 活動量に並べる学習日数。 */
  days: number
  now: Date
}

export type SubmitReviewInput = {
  principalId: string
  sessionId: string
  cardId: string
  rating: Rating
  expectedScheduleVersion: number
  idempotencyKey: string
  now: Date
  learningDay: string
  /** ロック済みの現行状態から4段階の適用候補を計算する。 */
  apply(current: ScheduleRow): Readonly<Record<Rating, AppliedSchedule>>
  responseDurationMs?: number
}

export type UndoLastReviewInput = {
  principalId: string
  sessionId: string
  idempotencyKey: string
  now: Date
  learningDay: string
}

export type UndoOutcome = {
  /** 新たに取り消したなら真。冪等キーの再送なら偽。 */
  applied: boolean
  cardId: string
  schedule: ScheduleRow
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

/** 取り消せる評価がない。呼び出し側は409へ写像する。 */
export class UndoUnavailableError extends Error {
  constructor() {
    super('取り消せる評価がありません。')
    this.name = 'UndoUnavailableError'
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

/** 連続学習日をさかのぼる上限。無制限に走査させない。 */
const STREAK_SCAN_DAYS = 365

/**
 * 学習日 (`YYYY-MM-DD`) を日数ぶんずらす。
 * 学習日は既に04:00 JST起点で丸めた暦日なので、UTCの日付演算で足りる。
 */
function shiftLearningDay(learningDay: string, delta: number): string {
  const shifted = new Date(`${learningDay}T00:00:00Z`)
  shifted.setUTCDate(shifted.getUTCDate() + delta)
  return shifted.toISOString().slice(0, 10)
}

export interface StudyRepository {
  createSession(input: CreateSessionInput): Promise<string>
  nextCard(input: QueueInput): Promise<QueuedCard | null>
  countRemaining(input: CountInput): Promise<RemainingCounts>
  countDeckQueues(input: DeckQueueInput): Promise<readonly DeckQueueCounts[]>
  /** ダッシュボードの集計。追記専用の履歴から導出する。 */
  summarizeProgress(input: ProgressInput): Promise<ProgressSummary>
  submitReview(input: SubmitReviewInput): Promise<ReviewOutcome>
  undoLastReview(input: UndoLastReviewInput): Promise<UndoOutcome>
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
      .select({
        deckId: cards.deckId,
        // 取り消した分は枠を戻す。追記専用の履歴から差し引きで導出する。
        value: sql<number>`sum(
          case
            when ${reviewEvents.kind} = 'review'
              and ${reviewEvents.beforeSnapshot} ->> 'state' = 'new' then 1
            when ${reviewEvents.kind} = 'undo'
              and ${reviewEvents.afterSnapshot} ->> 'state' = 'new' then -1
            else 0
          end
        )::int`,
      })
      .from(reviewEvents)
      .innerJoin(cards, eq(cards.id, reviewEvents.cardId))
      .where(
        and(
          eq(reviewEvents.principalId, principalId),
          eq(reviewEvents.learningDay, learningDay),
          inArray(cards.deckId, [...deckIds]),
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

    /**
     * デッキ一覧のための当日残数。セッションを作らずに数える。
     * 新規は出題側と同じ規則で、1学習日あたりの上限から当日出した分を引く。
     */
    async countDeckQueues(input) {
      const owned = await db
        .select({ id: decks.id, newCardLimit: decks.newCardLimit })
        .from(decks)
        .where(
          and(
            eq(decks.principalId, input.principalId),
            isNull(decks.trashedAt),
          ),
        )
        .orderBy(asc(decks.sortOrder), asc(decks.createdAt))

      if (owned.length === 0) {
        return []
      }

      const deckIds = owned.map((deck) => deck.id)

      const scheduled = await db
        .select({
          deckId: cards.deckId,
          state: cardSchedules.state,
          value: sql<number>`count(*)::int`,
        })
        .from(cardSchedules)
        .innerJoin(cards, eq(cards.id, cardSchedules.cardId))
        .where(
          and(
            inArray(cards.deckId, deckIds),
            isNull(cards.trashedAt),
            or(
              eq(cardSchedules.state, 'new'),
              lte(cardSchedules.dueAt, input.now),
            ),
          ),
        )
        .groupBy(cards.deckId, cardSchedules.state)

      // スケジュール行がまだ無いカードも新規として数える。
      const unscheduled = await db
        .select({ deckId: cards.deckId, value: sql<number>`count(*)::int` })
        .from(cards)
        .leftJoin(cardSchedules, eq(cardSchedules.cardId, cards.id))
        .where(
          and(
            inArray(cards.deckId, deckIds),
            isNull(cards.trashedAt),
            isNull(cardSchedules.cardId),
          ),
        )
        .groupBy(cards.deckId)

      const introduced = await countTodaysNewByDeck(
        input.principalId,
        deckIds,
        input.learningDay,
      )

      const countOf = (deckId: string, state: FsrsStateValue): number =>
        scheduled.find((row) => row.deckId === deckId && row.state === state)
          ?.value ?? 0

      return owned.map((deck) => {
        const availableNew =
          countOf(deck.id, 'new') +
          (unscheduled.find((row) => row.deckId === deck.id)?.value ?? 0)
        const allowedNew = Math.max(
          0,
          deck.newCardLimit - (introduced.get(deck.id) ?? 0),
        )

        return {
          deckId: deck.id,
          review: countOf(deck.id, 'review'),
          learning:
            countOf(deck.id, 'learning') + countOf(deck.id, 'relearning'),
          new: Math.min(availableNew, allowedNew),
        }
      })
    },

    async summarizeProgress(input) {
      // 学習日ごとの実効枚数。取り消しは行を消さず差し引きで表す。
      const daily = await db
        .select({
          learningDay: reviewEvents.learningDay,
          reviews: sql<number>`sum(
            case
              when ${reviewEvents.kind} = 'review' then 1
              when ${reviewEvents.kind} = 'undo' then -1
              else 0
            end
          )::int`,
        })
        .from(reviewEvents)
        .where(eq(reviewEvents.principalId, input.principalId))
        .groupBy(reviewEvents.learningDay)
        .orderBy(desc(reviewEvents.learningDay))
        .limit(STREAK_SCAN_DAYS)

      const byDay = new Map(daily.map((row) => [row.learningDay, row.reviews]))
      const reviewsOn = (day: string): number => byDay.get(day) ?? 0

      const activity: ActivityDay[] = []
      for (let offset = input.days - 1; offset >= 0; offset -= 1) {
        const day = shiftLearningDay(input.learningDay, -offset)
        activity.push({
          learningDay: day,
          reviews: Math.max(reviewsOn(day), 0),
        })
      }

      // 当日がまだ未着手なら前日から数える。朝いちで0日と出さないため。
      let cursor =
        reviewsOn(input.learningDay) > 0
          ? input.learningDay
          : shiftLearningDay(input.learningDay, -1)
      let streakDays = 0
      while (reviewsOn(cursor) > 0 && streakDays < STREAK_SCAN_DAYS) {
        streakDays += 1
        cursor = shiftLearningDay(cursor, -1)
      }

      const [next] = await db
        .select({ dueAt: cardSchedules.dueAt })
        .from(cardSchedules)
        .innerJoin(cards, eq(cards.id, cardSchedules.cardId))
        .innerJoin(decks, eq(decks.id, cards.deckId))
        .where(
          and(
            eq(decks.principalId, input.principalId),
            isNull(decks.trashedAt),
            isNull(cards.trashedAt),
            gt(cardSchedules.dueAt, input.now),
          ),
        )
        .orderBy(asc(cardSchedules.dueAt))
        .limit(1)

      return {
        completedToday: Math.max(reviewsOn(input.learningDay), 0),
        activity,
        streakDays,
        nextDueAt: next?.dueAt ?? null,
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

        // 2. セッション範囲と所有者を含めて対象行をロックする。
        const scope = await resolveScope(tx, input.principalId, input.sessionId)
        if (scope.length === 0) {
          throw new CardNotFoundError()
        }

        const locked = await tx
          .select({ schedule: cardSchedules })
          .from(cardSchedules)
          .innerJoin(cards, eq(cards.id, cardSchedules.cardId))
          .innerJoin(decks, eq(decks.id, cards.deckId))
          .where(
            and(
              eq(cardSchedules.cardId, input.cardId),
              eq(decks.principalId, input.principalId),
              inArray(decks.id, [...scope]),
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
        const next = input.apply(toScheduleRow(current))[input.rating]
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

    async undoLastReview(input) {
      return db.transaction(async (tx) => {
        // 1. 冪等キーの再送は、履歴をたどる前に記録済みの結果を返す。
        const [recorded] = await tx
          .select({ cardId: reviewEvents.cardId })
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
            .where(eq(cardSchedules.cardId, recorded.cardId))
            .limit(1)

          if (current === undefined) {
            throw new CardNotFoundError()
          }

          return {
            applied: false,
            cardId: recorded.cardId,
            schedule: toScheduleRow(current),
          }
        }

        // 2. 他人のセッションを取り消せないよう、所有者ごと確かめる。
        const [session] = await tx
          .select({ id: studySessions.id })
          .from(studySessions)
          .where(
            and(
              eq(studySessions.id, input.sessionId),
              eq(studySessions.principalId, input.principalId),
            ),
          )
          .limit(1)

        if (session === undefined) {
          throw new CardNotFoundError()
        }

        // 3. セッションの直近1件だけを見る。それが評価でなければ戻せない。
        // 取り消しの直後に再び取り消す操作も、ここで止まる。
        const [latest] = await tx
          .select()
          .from(reviewEvents)
          .where(eq(reviewEvents.sessionId, input.sessionId))
          .orderBy(desc(reviewEvents.createdAt), desc(reviewEvents.id))
          .limit(1)

        if (latest === undefined || latest.kind !== 'review') {
          throw new UndoUnavailableError()
        }

        // 4. 対象カードのスケジュールを所有者込みでロックする。
        const locked = await tx
          .select({ schedule: cardSchedules })
          .from(cardSchedules)
          .innerJoin(cards, eq(cards.id, cardSchedules.cardId))
          .innerJoin(decks, eq(decks.id, cards.deckId))
          .where(
            and(
              eq(cardSchedules.cardId, latest.cardId),
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

        // 5. 別のセッションが同じカードを進めていたら戻さない。
        // 記録した直後の版と今の版が一致することを、ロック後に確かめる。
        const restored = fromSnapshotJson(latest.beforeSnapshot)
        const appliedVersion = readVersion(latest.afterSnapshot)

        if (current.version !== appliedVersion) {
          throw new UndoUnavailableError()
        }

        // 6. 版は巻き戻さず前へ進める。
        // 戻すと、古い版を握った並行要求がそのまま通ってしまう。
        const nextVersion = current.version + 1

        await tx
          .update(cardSchedules)
          .set({
            dueAt: restored.dueAt,
            stability: restored.stability,
            difficulty: restored.difficulty,
            elapsedDays: restored.elapsedDays,
            scheduledDays: restored.scheduledDays,
            learningSteps: restored.learningSteps,
            reps: restored.reps,
            lapses: restored.lapses,
            state: restored.state,
            lastReviewAt: restored.lastReviewAt,
            version: nextVersion,
            schedulerVersion: restored.schedulerVersion,
            requestRetention: restored.requestRetention,
            updatedAt: input.now,
          })
          .where(eq(cardSchedules.cardId, latest.cardId))

        const before = toScheduleRow(current)
        const after: ScheduleRow = {
          ...restored,
          cardId: latest.cardId,
          version: nextVersion,
        }

        // 7. 評価は消さず、打ち消しを追記する。履歴は追記専用のまま。
        await tx.insert(reviewEvents).values({
          id: uuidv7(),
          principalId: input.principalId,
          cardId: latest.cardId,
          sessionId: input.sessionId,
          rating: latest.rating,
          kind: 'undo',
          beforeSnapshot: toSnapshotJson(before),
          afterSnapshot: toSnapshotJson(after),
          reviewedAt: input.now,
          learningDay: input.learningDay,
          idempotencyKey: input.idempotencyKey,
        })

        await tx
          .update(studySessions)
          .set({ lastActiveAt: input.now })
          .where(eq(studySessions.id, input.sessionId))

        return { applied: true, cardId: latest.cardId, schedule: after }
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

/** 保存済みの状態名が現在の定義に含まれるかを判定する。 */
function isFsrsState(value: unknown): value is FsrsStateValue {
  return (
    typeof value === 'string' &&
    FSRS_STATES.some((candidate) => candidate === value)
  )
}

/** 履歴に残した値を読み戻す。壊れていれば復元しない。 */
function snapshotOf(value: ScheduleSnapshotJson, key: string): unknown {
  return value[key]
}

function readFiniteNumber(value: ScheduleSnapshotJson, key: string): number {
  const found = snapshotOf(value, key)
  if (typeof found !== 'number' || !Number.isFinite(found)) {
    throw new Error(`レビュー履歴の ${key} を読み取れません。`)
  }
  return found
}

function readInstant(value: ScheduleSnapshotJson, key: string): Date {
  const found = snapshotOf(value, key)
  if (typeof found !== 'string') {
    throw new Error(`レビュー履歴の ${key} を読み取れません。`)
  }
  const parsed = new Date(found)
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`レビュー履歴の ${key} を読み取れません。`)
  }
  return parsed
}

function readVersion(value: ScheduleSnapshotJson): number {
  return readFiniteNumber(value, 'version')
}

/**
 * 追記した before/after のスナップショットを復元する。
 * ライブラリの型ではなく、保存した形をそのまま検査する。
 */
function fromSnapshotJson(
  value: ScheduleSnapshotJson,
): Omit<ScheduleRow, 'cardId' | 'version'> {
  const state = snapshotOf(value, 'state')
  if (!isFsrsState(state)) {
    throw new Error('レビュー履歴の state を読み取れません。')
  }

  const schedulerVersion = snapshotOf(value, 'schedulerVersion')
  if (typeof schedulerVersion !== 'string') {
    throw new Error('レビュー履歴の schedulerVersion を読み取れません。')
  }

  const lastReviewAt = snapshotOf(value, 'lastReviewAt')

  return {
    dueAt: readInstant(value, 'dueAt'),
    stability: readFiniteNumber(value, 'stability'),
    difficulty: readFiniteNumber(value, 'difficulty'),
    elapsedDays: readFiniteNumber(value, 'elapsedDays'),
    scheduledDays: readFiniteNumber(value, 'scheduledDays'),
    learningSteps: readFiniteNumber(value, 'learningSteps'),
    reps: readFiniteNumber(value, 'reps'),
    lapses: readFiniteNumber(value, 'lapses'),
    state,
    lastReviewAt:
      lastReviewAt === null ? null : readInstant(value, 'lastReviewAt'),
    schedulerVersion,
    requestRetention: readFiniteNumber(value, 'requestRetention'),
  }
}
