import type { MiddlewareHandler } from 'hono'
import type { AppEnv } from './request-context'

/**
 * Turnstileの配信元。
 * ゲスト開始のwidgetはここからスクリプトを読み、iframeを描画し、
 * 検証のために同じホストへ通信する。3つとも許可しないと開始できない。
 */
const TURNSTILE_ORIGIN = 'https://challenges.cloudflare.com'

/**
 * 同一オリジンを基本とする内容制限。
 * SPAとAPIを同じオリジンで配信しているため、外部由来の読み込みは
 * Turnstile以外に必要がない。
 */
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  `script-src 'self' ${TURNSTILE_ORIGIN}`,
  "style-src 'self'",
  "img-src 'self' data:",
  `connect-src 'self' ${TURNSTILE_ORIGIN}`,
  `frame-src ${TURNSTILE_ORIGIN}`,
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join('; ')

/** 使わない機能は明示的に落とす。将来の依存が黙って有効化しないようにする。 */
const PERMISSIONS_POLICY = [
  'camera=()',
  'microphone=()',
  'geolocation=()',
  'payment=()',
  'usb=()',
].join(', ')

/** 1年。プリロードは申請を伴うため、ここでは宣言しない。 */
const HSTS = 'max-age=31536000; includeSubDomains'

export type SecurityHeadersOptions = {
  /** HTTPSで配信しているときだけ true。ローカルのHTTP検証では false。 */
  secureOrigin: boolean
}

/**
 * すべての応答へ共通のセキュリティヘッダを付ける。
 * APIのJSONにもSPAのHTMLにも同じ制限を適用する。
 */
export function securityHeaders(
  options: SecurityHeadersOptions,
): MiddlewareHandler<AppEnv> {
  return async (context, next) => {
    await next()

    context.header('Content-Security-Policy', CONTENT_SECURITY_POLICY)
    context.header('Referrer-Policy', 'no-referrer')
    context.header('X-Content-Type-Options', 'nosniff')
    context.header('Permissions-Policy', PERMISSIONS_POLICY)
    // OAuthはポップアップを開く場合がある。same-originだと開いた先を見失う。
    context.header('Cross-Origin-Opener-Policy', 'same-origin-allow-popups')

    if (options.secureOrigin) {
      context.header('Strict-Transport-Security', HSTS)
    }
  }
}
