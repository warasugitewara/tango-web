import { zValidator } from '@hono/zod-validator'
import { AppError } from '@tango/shared'
import { Hono } from 'hono'
import { setCookie } from 'hono/cookie'
import { z } from 'zod'
import type { AppEnv } from '../../middleware/request-context'
import {
  type SessionView,
  toGuestSessionView,
  toUserSessionView,
} from './actor-resolver'
import {
  GUEST_COOKIE_NAME,
  GUEST_RISK_NOTICE,
  GUEST_SESSION_MAX_AGE_SECONDS,
  type GuestService,
} from './guest-service'

const guestStartSchema = z.object({
  turnstileToken: z.string().min(1),
})

export type AuthRoutesOptions = {
  guestService: GuestService
  cookieSecure: boolean
}

export function createAuthRoutes(options: AuthRoutesOptions) {
  const { guestService, cookieSecure } = options

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

        const { turnstileToken } = context.req.valid('json')
        const started = await guestService.start({
          turnstileToken,
          remoteIp: context.req.header('cf-connecting-ip') ?? null,
        })

        setCookie(context, GUEST_COOKIE_NAME, started.rawToken, {
          path: '/',
          httpOnly: true,
          secure: cookieSecure,
          sameSite: 'Lax',
          maxAge: GUEST_SESSION_MAX_AGE_SECONDS,
        })

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
}
