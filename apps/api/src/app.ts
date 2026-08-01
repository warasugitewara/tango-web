import { Hono } from 'hono'
import type { ActorResolver } from './features/auth/actor-resolver'
import { createAuthRoutes } from './features/auth/auth-routes'
import type { Clock, GuestService } from './features/auth/guest-service'
import { errorHandler } from './middleware/error-handler'
import {
  type AppEnv,
  requestContext,
  requestId,
} from './middleware/request-context'

export type AppDependencies = {
  clock: Clock
  guestService: GuestService
  actorResolver: ActorResolver
  /** 本番のHTTPS配信では true。ローカルのHTTP検証でのみ false にする。 */
  cookieSecure: boolean
}

export function createApp(deps: AppDependencies) {
  const app = new Hono<AppEnv>()

  app.onError(errorHandler())
  app.use('*', requestId())
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
      cookieSecure: deps.cookieSecure,
    }),
  )

  return app
}
