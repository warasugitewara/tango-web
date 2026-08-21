import { Hono } from 'hono'
import { describe, expect, test } from 'vitest'
import type { AppEnv } from './request-context'
import { securityHeaders } from './security-headers'

/** ヘッダだけを検証する最小のアプリ。 */
function createApp(secureOrigin: boolean) {
  return new Hono<AppEnv>()
    .use('*', securityHeaders({ secureOrigin }))
    .get('/api/ping', (context) => context.json({ ok: true }))
    .get('/', (context) => context.html('<p>画面</p>'))
}

async function headersOf(path: string, secureOrigin = true) {
  const response = await createApp(secureOrigin).request(path)
  return response.headers
}

describe('securityHeaders', () => {
  test.each(['/api/ping', '/'])('%s にも共通ヘッダを付ける', async (path) => {
    const headers = await headersOf(path)

    expect(headers.get('referrer-policy')).toBe('no-referrer')
    expect(headers.get('x-content-type-options')).toBe('nosniff')
    expect(headers.get('content-security-policy')).not.toBeNull()
  })

  test('自分自身以外からの読み込みを既定で禁じる', async () => {
    const csp = (await headersOf('/api/ping')).get('content-security-policy')

    expect(csp).toContain("default-src 'self'")
    expect(csp).toContain("object-src 'none'")
    expect(csp).toContain("base-uri 'none'")
    expect(csp).toContain("frame-ancestors 'none'")
    expect(csp).toContain("form-action 'self'")
  })

  test('Turnstileの読み込み元を許可する', async () => {
    // 許可しないとゲスト開始が動かなくなる。widgetはiframeで描画される。
    const csp = (await headersOf('/api/ping')).get('content-security-policy')

    expect(csp).toContain("script-src 'self' https://challenges.cloudflare.com")
    expect(csp).toContain('frame-src https://challenges.cloudflare.com')
    expect(csp).toContain(
      "connect-src 'self' https://challenges.cloudflare.com",
    )
  })

  test('カメラなど不要な機能を明示的に無効化する', async () => {
    const policy = (await headersOf('/api/ping')).get('permissions-policy')

    for (const feature of [
      'camera',
      'microphone',
      'geolocation',
      'payment',
      'usb',
    ]) {
      expect(policy).toContain(`${feature}=()`)
    }
  })

  test('OAuthのポップアップを壊さないopener方針を使う', async () => {
    const headers = await headersOf('/api/ping')

    expect(headers.get('cross-origin-opener-policy')).toBe(
      'same-origin-allow-popups',
    )
  })

  test('HTTPS配信のときだけHSTSを付ける', async () => {
    const secure = await headersOf('/api/ping', true)
    const insecure = await headersOf('/api/ping', false)

    expect(secure.get('strict-transport-security')).toContain('max-age=')
    expect(insecure.get('strict-transport-security')).toBeNull()
  })

  test('応答本文を変えない', async () => {
    const response = await createApp(true).request('/api/ping')

    expect(await response.json()).toEqual({ ok: true })
  })
})
