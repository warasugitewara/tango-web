import { randomUUID } from 'node:crypto'
import { Temporal } from '@js-temporal/polyfill'
import {
  type ScheduleRow,
  type StudyRepository,
  StudyStateConflictError,
} from '@tango/db'
import { AppError } from '@tango/shared'
import { describe, expect, test } from 'vitest'
import { z } from 'zod'
import { createApp } from '../../app'
import { mutationHeaders } from '../../test/request-headers'
import type { ActorResolver } from '../auth/actor-resolver'
import { GUEST_COOKIE_NAME, type GuestService } from '../auth/guest-service'
import type { FsrsScheduler, SchedulerState } from './fsrs-adapter'
import { SCHEDULER_VERSION } from './fsrs-adapter'

const NOW = Temporal.Instant.from('2026-08-21T03:00:00Z')
const NOW_DATE = new Date(NOW.epochMilliseconds)
const RAW_TOKEN = 'study-route-token'
const SESSION_ID = '019fd000-0000-7000-8000-000000000001'
const CARD_ID = '019fd000-0000-7000-8000-000000000002'
const DECK_ID = '019fd000-0000-7000-8000-000000000003'

const SCHEDULE: ScheduleRow = {
  cardId: CARD_ID,
  dueAt: NOW_DATE,
  stability: 0,
  difficulty: 0,
  elapsedDays: 0,
  scheduledDays: 0,
  learningSteps: 0,
  reps: 0,
  lapses: 0,
  state: 'new',
  lastReviewAt: null,
  version: 1,
  schedulerVersion: SCHEDULER_VERSION,
  requestRetention: 0.9,
}

function schedulerState(days: number): SchedulerState {
  return {
    dueAt: new Date(NOW_DATE.getTime() + days * 86_400_000),
    stability: days,
    difficulty: 5,
    elapsedDays: 0,
    scheduledDays: days,
    learningSteps: 0,
    reps: 1,
    lapses: 0,
    state: days < 4 ? 'learning' : 'review',
    lastReviewAt: NOW_DATE,
    schedulerVersion: SCHEDULER_VERSION,
    requestRetention: 0.9,
  }
}

function createScheduler(): FsrsScheduler {
  return {
    initial() {
      return {
        ...SCHEDULE,
        schedulerVersion: SCHEDULER_VERSION,
      }
    },
    preview() {
      return {
        1: schedulerState(0),
        2: schedulerState(1),
        3: schedulerState(4),
        4: schedulerState(7),
      }
    },
  }
}

function createRepository(
  options: { conflict?: boolean } = {},
): StudyRepository {
  const recorded = new Map<string, ScheduleRow>()

  return {
    async createSession() {
      return SESSION_ID
    },
    async nextCard() {
      return {
        cardId: CARD_ID,
        deckId: DECK_ID,
        front: '表1',
        back: '裏1',
        schedule: SCHEDULE,
      }
    },
    async countRemaining() {
      return { review: 2, learning: 1, new: 3 }
    },
    async countDeckQueues() {
      return [{ deckId: DECK_ID, review: 4, learning: 1, new: 2 }]
    },
    async submitReview(input) {
      if (options.conflict === true) {
        throw new StudyStateConflictError()
      }
      const replay = recorded.get(input.idempotencyKey)
      if (replay !== undefined) {
        return { applied: false, schedule: replay }
      }
      const next = input.apply(SCHEDULE)[input.rating]
      const schedule = {
        ...next,
        cardId: input.cardId,
        version: SCHEDULE.version + 1,
      }
      recorded.set(input.idempotencyKey, schedule)
      return { applied: true, schedule }
    },
  }
}

function createHarness(repository: StudyRepository = createRepository()) {
  const guestService: GuestService = {
    async start() {
      throw new Error('このテストでは使用しない。')
    },
    async resolve(rawToken) {
      if (rawToken !== RAW_TOKEN) {
        throw new AppError('UNAUTHENTICATED')
      }
      return {
        actor: {
          kind: 'guest',
          principalId: 'principal-study',
          guestSessionId: 'guest-session-study',
        },
        expiresAt: NOW.add({ hours: 24 }),
        refreshed: false,
      }
    },
    async revoke() {
      // 何もしない。
    },
  }
  const actorResolver: ActorResolver = {
    async resolveFormal() {
      return null
    },
  }

  return createApp({
    clock: { now: () => NOW },
    guestService,
    actorResolver,
    identityCompletionService: {
      async complete() {
        throw new Error('このテストでは使用しない。')
      },
    },
    authHandler: async () => new Response(null, { status: 204 }),
    cookieSecure: true,
    appOrigin: 'https://tango.warasugi.com',
    studyRepository: repository,
    fsrsScheduler: createScheduler(),
  })
}

// 状態を変える要求にはOriginと二重送信トークンが要る。
const headers = mutationHeaders([`${GUEST_COOKIE_NAME}=${RAW_TOKEN}`], {
  'content-type': 'application/json',
})

describe('study routes', () => {
  test('デッキごとの当日残数を学習日つきで返す', async () => {
    const response = await createHarness().request('/api/study/decks', {
      headers: { cookie: `${GUEST_COOKIE_NAME}=${RAW_TOKEN}` },
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      learningDay: '2026-08-21',
      decks: [
        {
          deckId: DECK_ID,
          remainingReview: 4,
          remainingLearning: 1,
          remainingNew: 2,
        },
      ],
    })
  })

  test('ゲストCookieが無ければデッキごとの残数を返さない', async () => {
    const response = await createHarness().request('/api/study/decks')

    expect(response.status).toBe(401)
  })

  test('セッション開始時に現在カードと残り枚数を返す', async () => {
    const response = await createHarness().request('/api/study/sessions', {
      method: 'POST',
      headers,
      body: JSON.stringify({ mode: 'all' }),
    })

    expect(response.status).toBe(201)
    expect(await response.json()).toMatchObject({
      sessionId: SESSION_ID,
      learningDay: '2026-08-21',
      card: { id: CARD_ID, front: '表1', back: '裏1' },
      remainingReview: 2,
      remainingLearning: 1,
      remainingNew: 3,
    })
  })

  test('応答の日時は+09:00を明示する', async () => {
    const response = await createHarness().request(
      `/api/study/sessions/${SESSION_ID}`,
      { headers },
    )
    const body = z
      .object({
        schedule: z.object({ dueAt: z.string() }),
        intervalPreviews: z.object({
          4: z.object({ dueAt: z.string() }),
        }),
      })
      .parse(await response.json())

    expect(response.status).toBe(200)
    expect(body.schedule.dueAt).toMatch(/\+09:00$/)
    expect(body.intervalPreviews['4'].dueAt).toMatch(/\+09:00$/)
  })

  test('古いバージョンの投稿は409とSTUDY_STATE_CONFLICTを返す', async () => {
    const response = await createHarness(
      createRepository({ conflict: true }),
    ).request('/api/study/reviews', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        sessionId: SESSION_ID,
        cardId: CARD_ID,
        rating: 3,
        expectedScheduleVersion: 1,
        idempotencyKey: randomUUID(),
      }),
    })

    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({
      error: { code: 'STUDY_STATE_CONFLICT' },
    })
  })

  test('同じ冪等キーの再送で同じ応答を返す', async () => {
    const app = createHarness()
    const idempotencyKey = randomUUID()
    const request = () =>
      app.request('/api/study/reviews', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          sessionId: SESSION_ID,
          cardId: CARD_ID,
          rating: 3,
          expectedScheduleVersion: 1,
          idempotencyKey,
        }),
      })

    const first = await request()
    const second = await request()

    expect(first.status).toBe(200)
    expect(await first.json()).toEqual(await second.json())
  })
})
