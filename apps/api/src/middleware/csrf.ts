import { randomBytes, timingSafeEqual } from 'node:crypto'
import { AppError } from '@tango/shared'
import { Hono, type MiddlewareHandler } from 'hono'
import { getCookie, setCookie } from 'hono/cookie'
import type { AppEnv } from './request-context'

/** 二重送信トークンを載せるヘッダ。 */
export const CSRF_HEADER_NAME = 'X-Tango-CSRF'

/** トークンの長さ。256bitをbase64urlにすると43文字になる。 */
const CSRF_TOKEN_BYTES = 32

/** ボディを伴い状態を変えるメソッド。これ以外は検査しない。 */
const MUTATING_METHODS: ReadonlySet<string> = new Set([
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
])

/**
 * CookieにHttpOnlyを付けない理由:
 * 二重送信では、クライアントがCookieを読んでヘッダへ載せる必要がある。
 * このトークンは認証情報ではなく、同一オリジンからの操作である証明にすぎない。
 * actorやsessionのCookieはHttpOnlyのままで、CSRFトークンへ流用しない。
 */
export function csrfCookieName(secureOrigin: boolean): string {
  // `__Host-` はSecure必須。httpのローカル検証では保存されないため使わない。
  return secureOrigin ? '__Host-tango-csrf' : 'tango-csrf'
}

function createToken(): string {
  return randomBytes(CSRF_TOKEN_BYTES).toString('base64url')
}

/** 長さが違っても例外にせず、一致しない判定にする。 */
function equalsInConstantTime(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, 'utf8')
  const rightBytes = Buffer.from(right, 'utf8')

  if (leftBytes.length !== rightBytes.length || leftBytes.length === 0) {
    return false
  }

  return timingSafeEqual(leftBytes, rightBytes)
}

export type CsrfRoutesOptions = {
  /** HTTPSで配信しているときだけ true。 */
  secureOrigin: boolean
}

/**
 * トークンを発行する経路。
 * サーバ側に控えを持たず、Cookieとヘッダの一致だけで判定する。
 */
export function createCsrfRoutes(options: CsrfRoutesOptions) {
  return new Hono<AppEnv>().get('/csrf', (context) => {
    const token = createToken()

    setCookie(context, csrfCookieName(options.secureOrigin), token, {
      path: '/',
      secure: options.secureOrigin,
      sameSite: 'Lax',
    })

    return context.json({ csrfToken: token })
  })
}

export type OriginGuardOptions = {
  /** 唯一許可する公開オリジン。完全一致でのみ通す。 */
  appOrigin: string
  secureOrigin: boolean
}

/**
 * 状態を変える要求に、同一オリジン由来であることを要求する。
 * Originの完全一致、Fetch Metadataのcross-site拒否、
 * 二重送信トークンの一致を、すべて満たしたときだけ通す。
 *
 * Better Authは自前のorigin/CSRF保護を持つため、
 * このミドルウェアより前にマウントして除外する。
 */
export function originGuard(
  options: OriginGuardOptions,
): MiddlewareHandler<AppEnv> {
  const cookieName = csrfCookieName(options.secureOrigin)

  return async (context, next) => {
    if (!MUTATING_METHODS.has(context.req.method)) {
      return next()
    }

    const origin = context.req.header('Origin')

    if (origin !== options.appOrigin) {
      throw new AppError('FORBIDDEN', {
        publicMessage:
          'この操作は許可されていません。画面を再読み込みしてからやり直してください。',
      })
    }

    // ブラウザが付ける場合だけ見る。付かない環境では他の条件で守る。
    if (context.req.header('Sec-Fetch-Site') === 'cross-site') {
      throw new AppError('FORBIDDEN', {
        publicMessage:
          'この操作は許可されていません。画面を再読み込みしてからやり直してください。',
      })
    }

    const cookieToken = getCookie(context, cookieName)
    const headerToken = context.req.header(CSRF_HEADER_NAME)

    if (
      cookieToken === undefined ||
      headerToken === undefined ||
      !equalsInConstantTime(cookieToken, headerToken)
    ) {
      throw new AppError('FORBIDDEN', {
        publicMessage:
          'この操作は許可されていません。画面を再読み込みしてからやり直してください。',
      })
    }

    return next()
  }
}
