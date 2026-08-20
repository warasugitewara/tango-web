import { z } from 'zod'

/** 利用者が押せる4段階の評価。0や5は受け付けない。 */
export const publicRatingSchema = z.union([
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
])

export const fsrsStateSchema = z.enum([
  'new',
  'learning',
  'review',
  'relearning',
])

/**
 * 出題スケジュールの公開表現。
 * 版を固定文字列で持ち、別アルゴリズムの結果が混ざれば検証で落ちる。
 */
export const scheduleSnapshotSchema = z
  .object({
    cardId: z.uuidv7(),
    dueAt: z.string(),
    stability: z.number().nonnegative(),
    difficulty: z.number().min(0).max(10),
    elapsedDays: z.number().int().nonnegative(),
    scheduledDays: z.number().int().nonnegative(),
    learningSteps: z.number().int().nonnegative(),
    reps: z.number().int().nonnegative(),
    lapses: z.number().int().nonnegative(),
    state: fsrsStateSchema,
    lastReviewAt: z.string().nullable(),
    scheduleVersion: z.number().int().positive(),
    schedulerVersion: z.literal('ts-fsrs@5.4.1/fsrs-6'),
    requestRetention: z.number().min(0.7).max(0.97),
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

/**
 * レビューの投稿。レビュー時刻は含めない。
 * 時刻はサーバが決め、クライアントの時計は信用しない。
 */
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
export type StudySessionCreateInput = z.infer<typeof studySessionCreateSchema>
export type ReviewSubmitInput = z.infer<typeof reviewSubmitSchema>
