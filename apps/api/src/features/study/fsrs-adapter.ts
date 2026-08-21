import type { FsrsState, PublicRating } from '@tango/shared'
import type { Card, Grade } from 'ts-fsrs'
import { createEmptyCard, fsrs, generatorParameters, State } from 'ts-fsrs'

/**
 * 出題間隔を計算したアルゴリズムの版。
 * ライブラリを上げたら必ずこの値も変え、混在を検知できるようにする。
 */
export const SCHEDULER_VERSION = 'ts-fsrs@5.4.1/fsrs-6' as const

/** プレリリースで固定する希望保持率。設定UIは出さない。 */
export const DEFAULT_REQUEST_RETENTION = 0.9

/**
 * アプリ側が扱う出題状態。
 * ライブラリの型をこの境界から先へ漏らさない。
 */
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
  schedulerVersion: typeof SCHEDULER_VERSION
  requestRetention: number
}

export type SchedulerPreview = Readonly<Record<PublicRating, SchedulerState>>

export interface FsrsScheduler {
  /** まだ一度も出題していないカードの初期状態。 */
  initial(now: Date): SchedulerState
  /** 4段階すべてを適用した結果。UIの間隔プレビューにも使う。 */
  preview(current: SchedulerState, now: Date): SchedulerPreview
}

/** ライブラリのstate列挙を公開表現へ写す。 */
function toFsrsState(state: State): FsrsState {
  switch (state) {
    case State.New:
      return 'new'
    case State.Learning:
      return 'learning'
    case State.Review:
      return 'review'
    case State.Relearning:
      return 'relearning'
  }
}

/** 公開表現をライブラリのstate列挙へ戻す。 */
function toLibraryState(state: FsrsState): State {
  switch (state) {
    case 'new':
      return State.New
    case 'learning':
      return State.Learning
    case 'review':
      return State.Review
    case 'relearning':
      return State.Relearning
  }
}

export function createFsrsScheduler(requestRetention: number): FsrsScheduler {
  // パラメータの生成は1度だけ行う。呼び出しごとに作ると無駄が大きい。
  const instance = fsrs(
    generatorParameters({ request_retention: requestRetention }),
  )

  function toSchedulerState(card: Card): SchedulerState {
    return {
      dueAt: card.due,
      stability: card.stability,
      difficulty: card.difficulty,
      elapsedDays: card.elapsed_days,
      scheduledDays: card.scheduled_days,
      learningSteps: card.learning_steps,
      reps: card.reps,
      lapses: card.lapses,
      state: toFsrsState(card.state),
      lastReviewAt: card.last_review ?? null,
      schedulerVersion: SCHEDULER_VERSION,
      requestRetention,
    }
  }

  function toLibraryCard(state: SchedulerState): Card {
    return {
      due: state.dueAt,
      stability: state.stability,
      difficulty: state.difficulty,
      elapsed_days: state.elapsedDays,
      scheduled_days: state.scheduledDays,
      learning_steps: state.learningSteps,
      reps: state.reps,
      lapses: state.lapses,
      state: toLibraryState(state.state),
      ...(state.lastReviewAt === null
        ? {}
        : { last_review: state.lastReviewAt }),
    }
  }

  return {
    initial(now) {
      return toSchedulerState(createEmptyCard<Card>(now))
    },

    preview(current, now) {
      const recorded = instance.repeat(toLibraryCard(current), now)

      // Gradeの1..4はそのまま公開評価の1..4に対応する。
      return Object.freeze({
        1: toSchedulerState(recorded[1 satisfies Grade].card),
        2: toSchedulerState(recorded[2 satisfies Grade].card),
        3: toSchedulerState(recorded[3 satisfies Grade].card),
        4: toSchedulerState(recorded[4 satisfies Grade].card),
      })
    },
  }
}
