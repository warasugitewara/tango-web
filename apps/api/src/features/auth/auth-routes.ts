import { zValidator } from '@hono/zod-validator'
import { AppError } from '@tango/shared'
import { Hono } from 'hono'
import { getCookie } from 'hono/cookie'
import { z } from 'zod'
import {
  type AppEnv,
  clearGuestCookie,
  setGuestCookie,
} from '../../middleware/request-context'
import {
  type SessionView,
  toGuestSessionView,
  toUserSessionView,
} from './actor-resolver'
import {
  GUEST_COOKIE_NAME,
  GUEST_RISK_NOTICE,
  type GuestService,
} from './guest-service'
import type { IdentityCompletionService } from './identity-completion-service'

const guestStartSchema = z.object({
  turnstileToken: z.string().min(1),
})

const identityCompleteSchema = z.object({
  /** OAuthコールバックごとに一意な冪等性キー。 */
  mergeKey: z.uuid(),
})

export type AuthRoutesOptions = {
  guestService: GuestService
  identityCompletionService: IdentityCompletionService
  cookieSecure: boolean
}

export function createAuthRoutes(options: AuthRoutesOptions) {
  const { guestService, identityCompletionService, cookieSecure } = options

  return new Hono<AppEnv>()
    .post(
      '/guest/start',
      zValidator('json', guestStartSchema, (result) => {
        if (!result.success) {
          throw new AppError('VALIDATION_FAILED', {
            fieldErrors: z.flattenError(result.error).fieldErrors,
          })
        }
      }),
      async (context) => {
        // 正式セッションを持つ利用者をゲストへ落とさない。
        if (context.get('formalSession') !== null) {
          throw new AppError('CONFLICT', {
            publicMessage:
              'すでにログイン済みです。ゲストとして開始する場合は先にログアウトしてください。',
          })
        }

        // 既に有効なゲストがいる場合は新しいトークンを発行しない。
        // Cookieを上書きすると旧principalの学習データへ到達する唯一の手段を失う。
        const actor = context.get('actor')
        const currentExpiresAt = context.get('guestExpiresAt')

        if (
          actor !== null &&
          actor.kind === 'guest' &&
          currentExpiresAt !== null
        ) {
          return context.json(
            toGuestSessionView(currentExpiresAt, GUEST_RISK_NOTICE),
          )
        }

        const { turnstileToken } = context.req.valid('json')
        const started = await guestService.start({
          turnstileToken,
          remoteIp: context.req.header('cf-connecting-ip') ?? null,
        })

        setGuestCookie(context, started.rawToken, cookieSecure)

        return context.json(
          toGuestSessionView(started.expiresAt, started.warning),
        )
      },
    )
    .get('/session', (context) => {
      const formalSession = context.get('formalSession')

      if (formalSession !== null) {
        return context.json(toUserSessionView(formalSession))
      }

      const actor = context.get('actor')
      const guestExpiresAt = context.get('guestExpiresAt')

      if (actor !== null && actor.kind === 'guest' && guestExpiresAt !== null) {
        return context.json(
          toGuestSessionView(guestExpiresAt, GUEST_RISK_NOTICE),
        )
      }

      return context.json({ authenticated: false } satisfies SessionView)
    })
    .post(
      '/identity/complete',
      zValidator('json', identityCompleteSchema, (result) => {
        if (!result.success) {
          throw new AppError('VALIDATION_FAILED', {
            fieldErrors: z.flattenError(result.error).fieldErrors,
          })
        }
      }),
      async (context) => {
        const formalSession = context.get('formalSession')

        if (formalSession === null) {
          throw new AppError('UNAUTHENTICATED')
        }

        const { mergeKey } = context.req.valid('json')
        const guestRawToken = getCookie(context, GUEST_COOKIE_NAME) ?? null

        const { outcome } = await identityCompletionService.complete({
          userId: formalSession.userId,
          guestRawToken,
          mergeKey,
          now: context.get('now'),
        })

        // 取り込みが成功したあとだけゲストCookieを捨てる。
        if (guestRawToken !== null) {
          clearGuestCookie(context, cookieSecure)
        }

        return context.json({ outcome })
      },
    )
}
