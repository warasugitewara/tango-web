import { zValidator } from '@hono/zod-validator'
import { Temporal } from '@js-temporal/polyfill'
import type { MergeCandidate, PrincipalRepository } from '@tango/db'
import { AppError, formatJst } from '@tango/shared'
import type { Context } from 'hono'
import { Hono } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { v7 as uuidv7 } from 'uuid'
import { z } from 'zod'
import type { AppEnv } from '../../middleware/request-context'
import type { MergeIntent, MergeIntentCodec } from './merge-intent'

/** 証明が有効な時間。OAuthを1往復する間だけ持てばよい。 */
const INTENT_COOKIE_MAX_AGE_SECONDS = 10 * 60

const confirmSchema = z.object({ keep: z.enum(['current', 'other']) }).strict()

/** `__Host-` はSecure必須。httpのローカル検証では保存されないため使わない。 */
export function mergeCookieName(secureOrigin: boolean): string {
  return secureOrigin ? '__Host-tango-merge' : 'tango-merge'
}

type MergeCandidateView = {
  userId: string
  name: string
  providers: readonly string[]
  decks: number
  cards: number
  reviews: number
  lastReviewedAt: string | null
}

function toView(candidate: MergeCandidate): MergeCandidateView {
  return {
    userId: candidate.userId,
    name: candidate.name,
    providers: candidate.providers,
    decks: candidate.decks,
    cards: candidate.cards,
    reviews: candidate.reviews,
    lastReviewedAt:
      candidate.lastReviewedAt === null
        ? null
        : formatJst(
            Temporal.Instant.fromEpochMilliseconds(
              candidate.lastReviewedAt.getTime(),
            ),
          ),
  }
}

export type MergeRoutesOptions = {
  repository: Pick<
    PrincipalRepository,
    'summarizeMergeCandidate' | 'mergeUsers'
  >
  codec: MergeIntentCodec
  cookieSecure: boolean
}

/**
 * 別々に作ってしまったアカウントを1つにまとめる。
 *
 * 片方の証明はセッション、もう片方は開始時に発行した署名付きCookieで持つ。
 * 両方が揃ってはじめて統合できる。証明には統合キーを載せてあり、
 * 再送しても同じ統合として扱われる。
 */
export function createMergeRoutes(options: MergeRoutesOptions) {
  const { repository, codec, cookieSecure } = options
  const cookieName = mergeCookieName(cookieSecure)

  function requireIntent(context: Context<AppEnv>): {
    intent: MergeIntent
    currentUserId: string
  } {
    // 先にログインを確かめる。証明だけでは何も起こせない。
    const formalSession = context.get('formalSession')
    if (formalSession === null) {
      throw new AppError('UNAUTHENTICATED')
    }

    const token = getCookie(context, cookieName) ?? null
    const intent =
      token === null ? null : codec.verify(token, context.get('now'))

    if (intent === null) {
      throw new AppError('VALIDATION_FAILED', {
        publicMessage:
          '統合の手続きが期限切れです。最初からやり直してください。',
      })
    }

    if (intent.userId === formalSession.userId) {
      throw new AppError('VALIDATION_FAILED', {
        publicMessage: '同じアカウント同士は統合できません。',
      })
    }

    return { intent, currentUserId: formalSession.userId }
  }

  return new Hono<AppEnv>()
    .post('/identity/merge/start', (context) => {
      const formalSession = context.get('formalSession')
      if (formalSession === null) {
        throw new AppError('UNAUTHENTICATED')
      }

      const token = codec.sign(
        { userId: formalSession.userId, mergeKey: uuidv7() },
        context.get('now'),
      )
      setCookie(context, cookieName, token, {
        path: '/',
        httpOnly: true,
        secure: cookieSecure,
        sameSite: 'Lax',
        maxAge: INTENT_COOKIE_MAX_AGE_SECONDS,
      })

      return context.body(null, 204)
    })
    .get('/identity/merge/preview', async (context) => {
      const { intent, currentUserId } = requireIntent(context)

      const [current, other] = await Promise.all([
        repository.summarizeMergeCandidate(currentUserId),
        repository.summarizeMergeCandidate(intent.userId),
      ])

      if (current === null || other === null) {
        throw new AppError('NOT_FOUND')
      }

      return context.json({ current: toView(current), other: toView(other) })
    })
    .post(
      '/identity/merge/confirm',
      zValidator('json', confirmSchema, (result) => {
        if (!result.success) {
          throw new AppError('VALIDATION_FAILED', {
            fieldErrors: z.flattenError(result.error).fieldErrors,
          })
        }
      }),
      async (context) => {
        const { intent, currentUserId } = requireIntent(context)
        const { keep } = context.req.valid('json')

        const targetUserId = keep === 'current' ? currentUserId : intent.userId
        const sourceUserId = keep === 'current' ? intent.userId : currentUserId

        await repository.mergeUsers({
          sourceUserId,
          targetUserId,
          // 証明に載せた鍵をそのまま使う。再送で二重に統合しないため。
          mergeKey: intent.mergeKey,
          now: new Date(context.get('now').epochMilliseconds),
        })

        deleteCookie(context, cookieName, {
          path: '/',
          httpOnly: true,
          secure: cookieSecure,
          sameSite: 'Lax',
        })

        // 取り込まれた側でログインしていたなら、そのセッションはもう無い。
        return context.json({ signedOut: keep === 'other' })
      },
    )
}
