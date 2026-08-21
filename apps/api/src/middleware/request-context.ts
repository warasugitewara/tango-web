import type { Temporal } from '@js-temporal/polyfill'
import { type Actor, AppError, type ServiceContext } from '@tango/shared'
import type { Context, MiddlewareHandler } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { v7 as uuidv7 } from 'uuid'
import type {
  ActorResolver,
  FormalSession,
} from '../features/auth/actor-resolver'
import {
  type Clock,
  GUEST_COOKIE_NAME,
  GUEST_SESSION_MAX_AGE_SECONDS,
  type GuestService,
} from '../features/auth/guest-service'

export const REQUEST_ID_HEADER = 'x-request-id'

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export type AppVariables = {
  requestId: string
  now: Temporal.Instant
  actor: Actor | null
  formalSession: FormalSession | null
  guestExpiresAt: Temporal.Instant | null
}

export type AppEnv = { Variables: AppVariables }

export type RequestContextOptions = {
  clock: Clock
  actorResolver: ActorResolver
  guestService: GuestService
  cookieSecure: boolean
}

/** 呼び出し元のリクエストIDを引き継ぐ。形式が不正なら自前で採番する。 */
export function requestId(): MiddlewareHandler<AppEnv> {
  return async (context, next) => {
    const supplied = context.req.header(REQUEST_ID_HEADER)
    const resolved =
      supplied !== undefined && UUID_PATTERN.test(supplied)
        ? supplied
        : uuidv7()

    context.set('requestId', resolved)
    context.header(REQUEST_ID_HEADER, resolved)
    await next()
  }
}

/**
 * ゲストCookieを発行する。発行元が1か所になるよう属性はここだけで定義する。
 * DB側の期限を延長したときは同じ生トークンで再発行し、
 * ブラウザ側のMax-Ageだけが先に尽きないようにする。
 */
export function setGuestCookie(
  context: Context<AppEnv>,
  rawToken: string,
  cookieSecure: boolean,
): void {
  setCookie(context, GUEST_COOKIE_NAME, rawToken, {
    path: '/',
    httpOnly: true,
    secure: cookieSecure,
    sameSite: 'Lax',
    maxAge: GUEST_SESSION_MAX_AGE_SECONDS,
  })
}

/** ゲストCookieを確実に消す。属性は発行時と揃える。 */
export function clearGuestCookie(
  context: Context<AppEnv>,
  cookieSecure: boolean,
): void {
  deleteCookie(context, GUEST_COOKIE_NAME, {
    path: '/',
    httpOnly: true,
    secure: cookieSecure,
    sameSite: 'Lax',
  })
}

/**
 * 実行文脈を組み立てる。正式セッションを先に解決し、無い場合だけゲストを見る。
 * 失効したゲストCookieは残さず消す。
 */
export function requestContext(
  options: RequestContextOptions,
): MiddlewareHandler<AppEnv> {
  const { clock, actorResolver, guestService, cookieSecure } = options

  return async (context, next) => {
    context.set('now', clock.now())
    context.set('actor', null)
    context.set('formalSession', null)
    context.set('guestExpiresAt', null)

    const formal = await actorResolver.resolveFormal(context.req.raw)

    if (formal !== null) {
      context.set('formalSession', formal.session)
      context.set('actor', formal.actor)
      await next()
      return
    }

    const rawToken = getCookie(context, GUEST_COOKIE_NAME)

    if (rawToken === undefined || rawToken === '') {
      await next()
      return
    }

    try {
      const resolution = await guestService.resolve(rawToken)
      context.set('actor', resolution.actor)
      context.set('guestExpiresAt', resolution.expiresAt)

      // DB側の期限を延長できたときはCookieのMax-Ageも同じだけ延ばす。
      // これがないと毎日利用していても作成から90日でブラウザがCookieを捨てる。
      if (resolution.refreshed) {
        setGuestCookie(context, rawToken, cookieSecure)
      }
    } catch (error) {
      // 失効・取り消しが確定したときだけCookieを取り除く。
      // DB障害のような一時的な失敗で消すと、唯一の生トークンを失って
      // ゲストの学習データへ二度と到達できなくなる。
      if (error instanceof AppError && error.code === 'UNAUTHENTICATED') {
        clearGuestCookie(context, cookieSecure)

        // ゲスト開始だけは、失効Cookieを匿名状態として扱い新規発行へ進める。
        if (
          context.req.method === 'POST' &&
          context.req.path === '/api/guest/start'
        ) {
          await next()
          return
        }
      }
      throw error
    }

    await next()
  }
}

/** ドメイン処理向けに実行主体を要求する。 */
export function requireServiceContext(
  context: Context<AppEnv>,
): ServiceContext {
  const actor = context.get('actor')

  if (actor === null) {
    if (context.get('formalSession') !== null) {
      throw new AppError('IDENTITY_SETUP_REQUIRED')
    }
    throw new AppError('UNAUTHENTICATED')
  }

  return {
    actor,
    requestId: context.get('requestId'),
    now: context.get('now'),
  }
}
