import { describe, expect, test } from 'vitest'
import {
  publicRatingSchema,
  reviewSubmitSchema,
  scheduleSnapshotSchema,
  studySessionCreateSchema,
} from './study'

/** 版と variant を満たす固定のUUIDv7。共有パッケージは生成器に依存しない。 */
const SESSION_ID = '019fd000-0000-7000-8000-000000000001'
const CARD_ID = '019fd000-0000-7000-8000-000000000002'
const DECK_ID = '019fd000-0000-7000-8000-000000000003'

/** 版4のUUID。冪等キーには使えるが、UUIDv7を要求する項目には使えない。 */
const UUID_V4 = '11111111-1111-4111-8111-111111111111'

const baseReview = {
  sessionId: SESSION_ID,
  cardId: CARD_ID,
  rating: 3,
  expectedScheduleVersion: 1,
  idempotencyKey: UUID_V4,
}

describe('publicRatingSchema', () => {
  test.each([1, 2, 3, 4])('%s を受け付ける', (rating) => {
    expect(publicRatingSchema.parse(rating)).toBe(rating)
  })

  test.each([0, 5, -1, 1.5])('%s を拒否する', (rating) => {
    expect(publicRatingSchema.safeParse(rating).success).toBe(false)
  })
})

describe('reviewSubmitSchema', () => {
  test('4段階の評価を受け付ける', () => {
    expect(reviewSubmitSchema.parse(baseReview).rating).toBe(3)
  })

  test('評価0を拒否する', () => {
    expect(
      reviewSubmitSchema.safeParse({ ...baseReview, rating: 0 }).success,
    ).toBe(false)
  })

  test('クライアントが送る時刻を拒否する', () => {
    // レビュー時刻はサーバが決める。受け取れば改ざんの余地になる。
    const withClientTime = {
      ...baseReview,
      reviewedAt: '2026-08-21T00:00:00+09:00',
    }
    expect(reviewSubmitSchema.safeParse(withClientTime).success).toBe(false)
  })

  test('冪等キーの欠落を拒否する', () => {
    const { idempotencyKey: _omitted, ...withoutKey } = baseReview
    expect(reviewSubmitSchema.safeParse(withoutKey).success).toBe(false)
  })

  test('UUIDv7でないカードIDを拒否する', () => {
    expect(
      reviewSubmitSchema.safeParse({ ...baseReview, cardId: UUID_V4 }).success,
    ).toBe(false)
  })

  test('0以下のスケジュールバージョンを拒否する', () => {
    expect(
      reviewSubmitSchema.safeParse({
        ...baseReview,
        expectedScheduleVersion: 0,
      }).success,
    ).toBe(false)
  })

  test('応答時間は任意で、1時間を超える値を拒否する', () => {
    expect(
      reviewSubmitSchema.safeParse({ ...baseReview, responseDurationMs: 1_000 })
        .success,
    ).toBe(true)
    expect(
      reviewSubmitSchema.safeParse({
        ...baseReview,
        responseDurationMs: 3_600_001,
      }).success,
    ).toBe(false)
  })
})

describe('studySessionCreateSchema', () => {
  test('全デッキ学習を受け付ける', () => {
    expect(studySessionCreateSchema.parse({ mode: 'all' }).mode).toBe('all')
  })

  test('allはデッキ指定を拒否する', () => {
    const input = { mode: 'all', deckIds: [DECK_ID] }
    expect(studySessionCreateSchema.safeParse(input).success).toBe(false)
  })

  test('selectedは1件以上のデッキを要求する', () => {
    const input = { mode: 'selected', deckIds: [] }
    expect(studySessionCreateSchema.safeParse(input).success).toBe(false)
  })

  test('selectedはデッキ指定があれば通る', () => {
    const input = { mode: 'selected', deckIds: [DECK_ID] }
    expect(studySessionCreateSchema.safeParse(input).success).toBe(true)
  })

  test('未知のキーを拒否する', () => {
    const input = { mode: 'all', principalId: 'x' }
    expect(studySessionCreateSchema.safeParse(input).success).toBe(false)
  })
})

describe('scheduleSnapshotSchema', () => {
  const snapshot = {
    cardId: CARD_ID,
    dueAt: '2026-08-21T12:00:00+09:00',
    stability: 1.5,
    difficulty: 5,
    elapsedDays: 0,
    scheduledDays: 1,
    learningSteps: 0,
    reps: 1,
    lapses: 0,
    state: 'review',
    lastReviewAt: null,
    scheduleVersion: 2,
    schedulerVersion: 'ts-fsrs@5.4.1/fsrs-6',
    requestRetention: 0.9,
  }

  test('妥当なスナップショットを受け付ける', () => {
    expect(scheduleSnapshotSchema.parse(snapshot).scheduleVersion).toBe(2)
  })

  test('スケジューラ版が違えば拒否する', () => {
    // 版を固定しないと、別アルゴリズムの結果が混ざっても気付けない。
    const other = { ...snapshot, schedulerVersion: 'ts-fsrs@6.0.0/fsrs-6' }
    expect(scheduleSnapshotSchema.safeParse(other).success).toBe(false)
  })

  test('負の安定度を拒否する', () => {
    expect(
      scheduleSnapshotSchema.safeParse({ ...snapshot, stability: -1 }).success,
    ).toBe(false)
  })

  test('未知の状態を拒否する', () => {
    expect(
      scheduleSnapshotSchema.safeParse({ ...snapshot, state: 'archived' })
        .success,
    ).toBe(false)
  })
})
