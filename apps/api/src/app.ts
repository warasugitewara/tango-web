import { Hono } from 'hono'
import type { ActorResolver } from './features/auth/actor-resolver'
import { createAuthRoutes } from './features/auth/auth-routes'
import type { Clock, GuestService } from './features/auth/guest-service'
import type { IdentityCompletionService } from './features/auth/identity-completion-service'
import { createOAuthErrorRoutes } from './features/auth/oauth-error-page'
import { errorHandler } from './middleware/error-handler'
import { jsonBodyGuard } from './middleware/json-body-guard'
import {
  type AppEnv,
  requestContext,
  requestId,
} from './middleware/request-context'

export type AppDependencies = {
  clock: Clock
  guestService: GuestService
  actorResolver: ActorResolver
  identityCompletionService: IdentityCompletionService
  /** Better Authのリクエストハンドラ。`/api/auth/*` をそのまま委譲する。 */
  authHandler: (request: Request) => Promise<Response>
  /** 本番のHTTPS配信では true。ローカルのHTTP検証でのみ false にする。 */
  cookieSecure: boolean
}

export function createApp(deps: AppDependencies) {
  const app = new Hono<AppEnv>()

  app.onError(errorHandler())
  app.use('*', requestId())

  app.route('/', createOAuthErrorRoutes())

  // Better Authは自前の文脈解決より先に置く。
  // 失効したゲストCookieが残っていてもログインを妨げないようにするため。
  app.on(['GET', 'POST'], '/api/auth/*', (context) =>
    deps.authHandler(context.req.raw),
  )

  // Better Authは自前のボディ検証を持つため、その委譲より後ろに置く。
  app.use('/api/*', jsonBodyGuard())

  // ヘルスチェックは認証文脈を必要としないので /api 配下だけに適用する。
  app.use(
    '/api/*',
    requestContext({
      clock: deps.clock,
      actorResolver: deps.actorResolver,
      guestService: deps.guestService,
      cookieSecure: deps.cookieSecure,
    }),
  )

  app.get('/health/live', (context) => context.json({ status: 'ok' as const }))

  app.route(
    '/api',
    createAuthRoutes({
      guestService: deps.guestService,
      identityCompletionService: deps.identityCompletionService,
      cookieSecure: deps.cookieSecure,
    }),
  )

  return app
}
