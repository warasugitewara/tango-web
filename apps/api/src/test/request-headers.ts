import { CSRF_HEADER_NAME, csrfCookieName } from '../middleware/csrf'

/** テストのcreateApp依存と揃える公開オリジン。 */
export const TEST_APP_ORIGIN = 'https://tango.warasugi.com'

/**
 * 二重送信トークンはサーバに控えを持たない。
 * Cookieとヘッダが一致していればよいので、固定値で足りる。
 */
const TEST_CSRF_TOKEN = 'test-csrf-token-0123456789abcdefghijklmnopq'

/**
 * 状態を変える要求に必要なヘッダを組み立てる。
 * 追加のCookieがある場合は同じCookieヘッダへ連結する。
 */
export function mutationHeaders(
  extraCookies: readonly string[] = [],
  extra: Record<string, string> = {},
  secureOrigin = true,
): Record<string, string> {
  const cookies = [
    `${csrfCookieName(secureOrigin)}=${TEST_CSRF_TOKEN}`,
    ...extraCookies,
  ]

  return {
    origin: TEST_APP_ORIGIN,
    cookie: cookies.join('; '),
    [CSRF_HEADER_NAME.toLowerCase()]: TEST_CSRF_TOKEN,
    ...extra,
  }
}
