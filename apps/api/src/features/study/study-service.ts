import { Temporal } from '@js-temporal/polyfill'
import type { AppliedSchedule, ScheduleRow, StudyRepository } from '@tango/db'
import { CardNotFoundError, StudyStateConflictError } from '@tango/db'
import {
  AppError,
  formatJst,
  learningDayOf,
  type ReviewSubmitInput,
  type ServiceContext,
  type StudySessionCreateInput,
} from '@tango/shared'
import type { FsrsScheduler, SchedulerState } from './fsrs-adapter'
import { SCHEDULER_VERSION } from './fsrs-adapter'

function toDate(instant: Temporal.Instant): Date {
  return new Date(instant.epochMilliseconds)
}

function toInstant(date: Date): Temporal.Instant {
  return Temporal.Instant.fromEpochMilliseconds(date.getTime())
}

function toSchedulerState(schedule: ScheduleRow): SchedulerState {
  if (schedule.schedulerVersion !== SCHEDULER_VERSION) {
    throw new Error('対応していないスケジューラ版です。')
  }

  return {
    dueAt: schedule.dueAt,
    stability: schedule.stability,
    difficulty: schedule.difficulty,
    elapsedDays: schedule.elapsedDays,
    scheduledDays: schedule.scheduledDays,
    learningSteps: schedule.learningSteps,
    reps: schedule.reps,
    lapses: schedule.lapses,
    state: schedule.state,
    lastReviewAt: schedule.lastReviewAt,
    schedulerVersion: schedule.schedulerVersion,
    requestRetention: schedule.requestRetention,
  }
}

function toScheduleView(schedule: ScheduleRow) {
  return {
    cardId: schedule.cardId,
    dueAt: formatJst(toInstant(schedule.dueAt)),
    stability: schedule.stability,
    difficulty: schedule.difficulty,
    elapsedDays: schedule.elapsedDays,
    scheduledDays: schedule.scheduledDays,
    learningSteps: schedule.learningSteps,
    reps: schedule.reps,
    lapses: schedule.lapses,
    state: schedule.state,
    lastReviewAt:
      schedule.lastReviewAt === null
        ? null
        : formatJst(toInstant(schedule.lastReviewAt)),
    scheduleVersion: schedule.version,
    schedulerVersion: schedule.schedulerVersion,
    requestRetention: schedule.requestRetention,
  }
}

function toIntervalPreviews(
  preview: Readonly<Record<1 | 2 | 3 | 4, AppliedSchedule>>,
) {
  const view = (schedule: AppliedSchedule) => ({
    dueAt: formatJst(toInstant(schedule.dueAt)),
    scheduledDays: schedule.scheduledDays,
  })

  return {
    1: view(preview[1]),
    2: view(preview[2]),
    3: view(preview[3]),
    4: view(preview[4]),
  }
}

export type StudySessionView = {
  sessionId: string
  learningDay: string
  card: { id: string; deckId: string; front: string; back: string } | null
  schedule: ReturnType<typeof toScheduleView> | null
  intervalPreviews: ReturnType<typeof toIntervalPreviews> | null
  remainingReview: number
  remainingLearning: number
  remainingNew: number
}

export interface StudyService {
  createSession(
    context: ServiceContext,
    input: StudySessionCreateInput,
  ): Promise<StudySessionView>
  getSession(
    context: ServiceContext,
    sessionId: string,
  ): Promise<StudySessionView>
  submitReview(
    context: ServiceContext,
    input: ReviewSubmitInput,
  ): Promise<{ schedule: ReturnType<typeof toScheduleView> }>
}

export function createStudyService(options: {
  repository: StudyRepository
  scheduler: FsrsScheduler
}): StudyService {
  const { repository, scheduler } = options

  async function getSession(context: ServiceContext, sessionId: string) {
    const now = toDate(context.now)
    const learningDay = learningDayOf(context.now)
    const initial = scheduler.initial(now)
    const queueInput = {
      principalId: context.actor.principalId,
      sessionId,
      now,
      learningDay,
    }
    const card = await repository.nextCard({
      ...queueInput,
      initialSchedule: {
        dueAt: initial.dueAt,
        stability: initial.stability,
        difficulty: initial.difficulty,
        schedulerVersion: initial.schedulerVersion,
        requestRetention: initial.requestRetention,
      },
    })
    const remaining = await repository.countRemaining(queueInput)

    if (card === null) {
      return {
        sessionId,
        learningDay,
        card: null,
        schedule: null,
        intervalPreviews: null,
        remainingReview: remaining.review,
        remainingLearning: remaining.learning,
        remainingNew: remaining.new,
      }
    }

    const preview = scheduler.preview(toSchedulerState(card.schedule), now)
    return {
      sessionId,
      learningDay,
      card: {
        id: card.cardId,
        deckId: card.deckId,
        front: card.front,
        back: card.back,
      },
      schedule: toScheduleView(card.schedule),
      intervalPreviews: toIntervalPreviews(preview),
      remainingReview: remaining.review,
      remainingLearning: remaining.learning,
      remainingNew: remaining.new,
    }
  }

  return {
    async createSession(context, input) {
      const sessionId = await repository.createSession({
        principalId: context.actor.principalId,
        deckIds: input.mode === 'all' ? null : (input.deckIds ?? []),
        learningDay: learningDayOf(context.now),
        now: toDate(context.now),
      })
      return getSession(context, sessionId)
    },
    getSession,
    async submitReview(context, input) {
      const now = toDate(context.now)
      try {
        const outcome = await repository.submitReview({
          principalId: context.actor.principalId,
          sessionId: input.sessionId,
          cardId: input.cardId,
          rating: input.rating,
          expectedScheduleVersion: input.expectedScheduleVersion,
          idempotencyKey: input.idempotencyKey,
          now,
          learningDay: learningDayOf(context.now),
          apply(current) {
            return scheduler.preview(toSchedulerState(current), now)
          },
          ...(input.responseDurationMs === undefined
            ? {}
            : { responseDurationMs: input.responseDurationMs }),
        })
        return { schedule: toScheduleView(outcome.schedule) }
      } catch (error) {
        if (error instanceof StudyStateConflictError) {
          throw new AppError('STUDY_STATE_CONFLICT', { cause: error })
        }
        if (error instanceof CardNotFoundError) {
          throw new AppError('NOT_FOUND', { cause: error })
        }
        throw error
      }
    },
  }
}
