import { sql } from 'drizzle-orm'
import {
  check,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { cards } from './content'
import { principals } from './principals'

/** 全ての時刻はTIMESTAMPTZで保持し、表示時にJSTへ変換する。 */
function instant(name: string) {
  return timestamp(name, { withTimezone: true, mode: 'date' })
}

export const FSRS_STATES = ['new', 'learning', 'review', 'relearning'] as const
export type FsrsStateValue = (typeof FSRS_STATES)[number]

export const STUDY_SESSION_MODES = ['all', 'selected'] as const
export type StudySessionMode = (typeof STUDY_SESSION_MODES)[number]

export type ScheduleSnapshotJson = Readonly<Record<string, unknown>>

/**
 * カード1枚のFSRS状態。カードと1対1で存在する。
 * versionは楽観ロック用で、レビューのたびに増える。
 */
export const cardSchedules = pgTable(
  'card_schedules',
  {
    cardId: uuid('card_id')
      .primaryKey()
      .references(() => cards.id, { onDelete: 'cascade' }),
    dueAt: instant('due_at').notNull(),
    stability: doublePrecision('stability').notNull(),
    difficulty: doublePrecision('difficulty').notNull(),
    elapsedDays: integer('elapsed_days').notNull().default(0),
    scheduledDays: integer('scheduled_days').notNull().default(0),
    learningSteps: integer('learning_steps').notNull().default(0),
    reps: integer('reps').notNull().default(0),
    lapses: integer('lapses').notNull().default(0),
    state: text('state').$type<FsrsStateValue>().notNull().default('new'),
    lastReviewAt: instant('last_review_at'),
    /** 楽観ロック。投稿側の期待値と一致しなければ競合として拒否する。 */
    version: integer('version').notNull().default(1),
    /** 出題間隔を計算したアルゴリズムの版。混在を検知するために残す。 */
    schedulerVersion: text('scheduler_version').notNull(),
    requestRetention: doublePrecision('request_retention').notNull(),
    createdAt: instant('created_at').notNull().defaultNow(),
    updatedAt: instant('updated_at').notNull().defaultNow(),
  },
  (table) => [
    check(
      'card_schedules_state_check',
      sql`${table.state} in ('new', 'learning', 'review', 'relearning')`,
    ),
    check('card_schedules_version_check', sql`${table.version} >= 1`),
    check(
      'card_schedules_request_retention_check',
      sql`${table.requestRetention} between 0.70 and 0.97`,
    ),
    // 出題キューはdue順に走査する。
    index('card_schedules_due_at_idx').on(table.dueAt),
  ],
)

/**
 * 学習セッション。可変のキューは持たず、範囲と学習日だけを記録する。
 * 出題はそのつどDBから決めるため、途中でカードを足しても矛盾しない。
 */
export const studySessions = pgTable(
  'study_sessions',
  {
    id: uuid('id').primaryKey(),
    principalId: uuid('principal_id')
      .notNull()
      .references(() => principals.id, { onDelete: 'cascade' }),
    mode: text('mode').$type<StudySessionMode>().notNull(),
    /** selectedのときだけ対象デッキのIDを持つ。allではnull。 */
    deckIds: jsonb('deck_ids').$type<readonly string[]>(),
    /** 04:00 JST起点の学習日。`YYYY-MM-DD`。 */
    learningDay: text('learning_day').notNull(),
    startedAt: instant('started_at').notNull().defaultNow(),
    lastActiveAt: instant('last_active_at').notNull().defaultNow(),
    completedAt: instant('completed_at'),
  },
  (table) => [
    check(
      'study_sessions_mode_check',
      sql`${table.mode} in ('all', 'selected')`,
    ),
    // モードと対象デッキの整合をDBで保証する。
    check(
      'study_sessions_deck_ids_check',
      sql`(${table.mode} = 'selected') = (${table.deckIds} is not null)`,
    ),
    index('study_sessions_principal_id_idx').on(table.principalId),
  ],
)

/**
 * レビューの追記専用ログ。ここが学習履歴の唯一の真実になる。
 * 集計はこのログから導出し、二つ目の可変な集計元を作らない。
 */
export const reviewEvents = pgTable(
  'review_events',
  {
    id: uuid('id').primaryKey(),
    principalId: uuid('principal_id')
      .notNull()
      .references(() => principals.id, { onDelete: 'cascade' }),
    cardId: uuid('card_id')
      .notNull()
      .references(() => cards.id, { onDelete: 'cascade' }),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => studySessions.id, { onDelete: 'cascade' }),
    rating: integer('rating').notNull(),
    beforeSnapshot: jsonb('before_snapshot')
      .$type<ScheduleSnapshotJson>()
      .notNull(),
    afterSnapshot: jsonb('after_snapshot')
      .$type<ScheduleSnapshotJson>()
      .notNull(),
    /** サーバが決めたレビュー時刻。クライアントの時計は使わない。 */
    reviewedAt: instant('reviewed_at').notNull(),
    /** 04:00 JST起点の学習日。当日の新規枚数はここから数える。 */
    learningDay: text('learning_day').notNull(),
    /** 再送を二重に採点しないための鍵。principal単位で一意。 */
    idempotencyKey: uuid('idempotency_key').notNull(),
    responseDurationMs: integer('response_duration_ms'),
    createdAt: instant('created_at').notNull().defaultNow(),
  },
  (table) => [
    check('review_events_rating_check', sql`${table.rating} between 1 and 4`),
    uniqueIndex('review_events_principal_idempotency_uidx').on(
      table.principalId,
      table.idempotencyKey,
    ),
    index('review_events_card_id_idx').on(table.cardId),
    // 当日の新規枚数を学習日で絞って数える。
    index('review_events_principal_learning_day_idx').on(
      table.principalId,
      table.learningDay,
    ),
  ],
)
