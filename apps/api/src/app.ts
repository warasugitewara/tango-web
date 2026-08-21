import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { ContentRepository, StudyRepository } from '@tango/db'
import { AppError } from '@tango/shared'
import { Hono } from 'hono'
import { serveStatic } from 'hono/serve-static'
import type { ActorResolver } from './features/auth/actor-resolver'
import { createAuthRoutes } from './features/auth/auth-routes'
import type { Clock, GuestService } from './features/auth/guest-service'
import type { IdentityCompletionService } from './features/auth/identity-completion-service'
import { createOAuthErrorRoutes } from './features/auth/oauth-error-page'
import { createContentRoutes } from './features/content/content-routes'
import type { FsrsScheduler } from './features/study/fsrs-adapter'
import { createStudyRoutes } from './features/study/study-routes'
import { createStudyService } from './features/study/study-service'
import { errorHandler } from './middleware/error-handler'
import { jsonBodyGuard } from './middleware/json-body-guard'
import {
  type AppEnv,
  requestContext,
  requestId,
} from './middleware/request-context'
import { securityHeaders } from './middleware/security-headers'

export type AppDependencies = {
  clock: Clock
  guestService: GuestService
  actorResolver: ActorResolver
  identityCompletionService: IdentityCompletionService
  /** Better Authのリクエストハンドラ。`/api/auth/*` をそのまま委譲する。 */
  authHandler: (request: Request) => Promise<Response>
  /** 本番のHTTPS配信では true。ローカルのHTTP検証でのみ false にする。 */
  cookieSecure: boolean
  /** 認証境界だけを検証する既存テストでは省略できる。 */
  contentRepository?: ContentRepository
  studyRepository?: StudyRepository
  fsrsScheduler?: FsrsScheduler
  /** 本番ビルドで配信するSPA成果物。省略時はAPI専用で起動する。 */
  spaRoot?: string
}

function spaStatic(root: string, path?: string) {
  return serveStatic<AppEnv>({
    root,
    ...(path === undefined ? {} : { path }),
    join,
    async getContent(filePath) {
      try {
        return await readFile(filePath)
      } catch {
        return null
      }
    },
    async isDir(filePath) {
      try {
        return (await stat(filePath)).isDirectory()
      } catch {
        return false
      }
    },
  })
}

export function createApp(deps: AppDependencies) {
  const app = new Hono<AppEnv>()

  app.onError(errorHandler())
  app.use('*', requestId())
  // 認証やルーティングより先に付ける。エラー応答にも同じ制限を適用するため。
  app.use('*', securityHeaders({ secureOrigin: deps.cookieSecure }))

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

  if (deps.contentRepository !== undefined) {
    app.route(
      '/api',
      createContentRoutes({ repository: deps.contentRepository }),
    )
  }

  if (deps.studyRepository !== undefined && deps.fsrsScheduler !== undefined) {
    app.route(
      '/api',
      createStudyRoutes({
        service: createStudyService({
          repository: deps.studyRepository,
          scheduler: deps.fsrsScheduler,
        }),
      }),
    )
  }

  // 未知のAPIをindex.htmlへ落とさず、既存のJSONエラー契約を維持する。
  app.all('/api', () => {
    throw new AppError('NOT_FOUND')
  })
  app.all('/api/*', () => {
    throw new AppError('NOT_FOUND')
  })
  app.all('/health/*', () => {
    throw new AppError('NOT_FOUND')
  })

  // 既存ルートの後ろに置き、GETの画面遷移だけをSPAへフォールバックする。
  if (deps.spaRoot !== undefined) {
    app.get('*', spaStatic(deps.spaRoot))
    app.get('*', spaStatic(deps.spaRoot, 'index.html'))
  }

  return app
}
