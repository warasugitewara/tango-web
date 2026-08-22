import { AppError } from '@tango/shared'
import { Hono } from 'hono'
import { describe, expect, test } from 'vitest'
import { createCsrfRoutes, csrfCookieName, originGuard } from './csrf'
import { errorHandler } from './error-handler'
import type { AppEnv } from './request-context'

const APP_ORIGIN = 'https://tango.warasugi.com'

/**
 * Origin検査とCSRF検査だけを載せた最小のアプリ。
 * Better Authへの委譲は本物と同じく、検査より前に登録して除外する。
 */
function createApp(secureOrigin = true) {
  const app = new Hono<AppEnv>()
  app.onError(errorHandler())

  // Better Authは自前のCSRF保護を持つ。マウント済みハンドラごと除外する。
  app.on(['GET', 'POST'], '/api/auth/*', (context) =>
    context.json({ delegated: true }),
  )

  app.route('/api/security', createCsrfRoutes({ secureOrigin }))
  app.use('/api/*', originGuard({ appOrigin: APP_ORIGIN, secureOrigin }))

  app.get('/api/decks', (context) => context.json({ decks: [] }))
  app.post('/api/decks', (context) => context.json({ created: true }))
  app.delete('/api/decks/:id', (context) => context.json({ deleted: true }))

  return app
}

/** CSRFトークンを1つ発行し、Cookieとトークン本体を返す。 */
async function issueToken(secureOrigin = true) {
  const app = createApp(secureOrigin)
  const response = await app.request('/api/security/csrf', {
    headers: { origin: APP_ORIGIN },
  })
  const body = (await response.json()) as { csrfToken: string }
  const setCookie = response.headers.get('set-cookie') ?? ''
  const name = csrfCookieName(secureOrigin)

  return {
    app,
    token: body.csrfToken,
    setCookie,
    cookieHeader: `${name}=${body.csrfToken}`,
  }
}

function mutate(
  app: ReturnType<typeof createApp>,
  headers: Record<string, string>,
  method = 'POST',
) {
  return app.request('/api/decks', {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: method === 'DELETE' ? undefined : JSON.stringify({ name: '英単語' }),
  })
}

describe('GET /api/security/csrf', () => {
  test('256bitのトークンを発行しCookieと本文へ入れる', async () => {
    const issued = await issueToken()

    // 256bitをbase64urlにすると43文字になる。
    expect(issued.token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(issued.setCookie).toContain(
      `${csrfCookieName(true)}=${issued.token}`,
    )
  })

  test('HTTPSでは__Host-接頭辞とSecureを使う', async () => {
    const issued = await issueToken(true)

    expect(csrfCookieName(true)).toBe('__Host-tango-csrf')
    expect(issued.setCookie).toContain('Secure')
    expect(issued.setCookie).toContain('Path=/')
    expect(issued.setCookie).toContain('SameSite=Lax')
  })

  test('読み取り用なのでHttpOnlyにしない', async () => {
    // 二重送信のため、クライアントがCookieを読んでヘッダへ載せる必要がある。
    const issued = await issueToken()

    expect(issued.setCookie).not.toContain('HttpOnly')
  })

  test('HTTPのローカル検証では__Host-を使わない', async () => {
    // __Host-はSecure必須で、httpでは保存されない。
    expect(csrfCookieName(false)).toBe('tango-csrf')

    const issued = await issueToken(false)
    expect(issued.setCookie).not.toContain('Secure')
  })

  test('呼ぶたびに違うトークンを出す', async () => {
    const first = await issueToken()
    const second = await issueToken()

    expect(first.token).not.toBe(second.token)
  })
})

describe('安全なメソッド', () => {
  test('GETはOriginもトークンも要求しない', async () => {
    const response = await createApp().request('/api/decks')

    expect(response.status).toBe(200)
  })
})

describe('Origin検査', () => {
  test('Originが無い変更要求を拒否する', async () => {
    const issued = await issueToken()
    const response = await mutate(issued.app, {
      cookie: issued.cookieHeader,
      'x-tango-csrf': issued.token,
    })

    expect(response.status).toBe(403)
  })

  test('別オリジンからの変更要求を拒否する', async () => {
    const issued = await issueToken()
    const response = await mutate(issued.app, {
      origin: 'https://evil.example.com',
      cookie: issued.cookieHeader,
      'x-tango-csrf': issued.token,
    })

    expect(response.status).toBe(403)
  })

  test('前方一致するだけの偽オリジンを拒否する', async () => {
    const issued = await issueToken()
    const response = await mutate(issued.app, {
      origin: `${APP_ORIGIN}.evil.example.com`,
      cookie: issued.cookieHeader,
      'x-tango-csrf': issued.token,
    })

    expect(response.status).toBe(403)
  })

  test('cross-siteのFetch Metadataを拒否する', async () => {
    const issued = await issueToken()
    const response = await mutate(issued.app, {
      origin: APP_ORIGIN,
      'sec-fetch-site': 'cross-site',
      cookie: issued.cookieHeader,
      'x-tango-csrf': issued.token,
    })

    expect(response.status).toBe(403)
  })

  test('same-originのFetch Metadataは通す', async () => {
    const issued = await issueToken()
    const response = await mutate(issued.app, {
      origin: APP_ORIGIN,
      'sec-fetch-site': 'same-origin',
      cookie: issued.cookieHeader,
      'x-tango-csrf': issued.token,
    })

    expect(response.status).toBe(200)
  })
})

describe('二重送信トークン', () => {
  test('Cookieとヘッダが一致すれば通す', async () => {
    const issued = await issueToken()
    const response = await mutate(issued.app, {
      origin: APP_ORIGIN,
      cookie: issued.cookieHeader,
      'x-tango-csrf': issued.token,
    })

    expect(response.status).toBe(200)
  })

  test('ヘッダが無ければ拒否する', async () => {
    const issued = await issueToken()
    const response = await mutate(issued.app, {
      origin: APP_ORIGIN,
      cookie: issued.cookieHeader,
    })

    expect(response.status).toBe(403)
  })

  test('Cookieが無ければ拒否する', async () => {
    const issued = await issueToken()
    const response = await mutate(issued.app, {
      origin: APP_ORIGIN,
      'x-tango-csrf': issued.token,
    })

    expect(response.status).toBe(403)
  })

  test('別々に発行したトークン同士を組み合わせても拒否する', async () => {
    const issued = await issueToken()
    const other = await issueToken()
    const response = await mutate(issued.app, {
      origin: APP_ORIGIN,
      cookie: issued.cookieHeader,
      'x-tango-csrf': other.token,
    })

    expect(response.status).toBe(403)
  })

  test('長さの違うトークンでも例外にせず拒否する', async () => {
    const issued = await issueToken()
    const response = await mutate(issued.app, {
      origin: APP_ORIGIN,
      cookie: issued.cookieHeader,
      'x-tango-csrf': 'short',
    })

    expect(response.status).toBe(403)
  })

  test('DELETEにも同じ検査を適用する', async () => {
    const issued = await issueToken()
    const response = await issued.app.request('/api/decks/abc', {
      method: 'DELETE',
      headers: { origin: APP_ORIGIN, cookie: issued.cookieHeader },
    })

    expect(response.status).toBe(403)
  })
})

describe('Better Authの除外', () => {
  test('委譲済みの認証経路は自前の検査を通さない', async () => {
    // Better Authは自身でorigin/CSRFを検証する。二重に課すと正規の
    // sign-inやcallbackが通らなくなる。
    const response = await createApp().request('/api/auth/sign-in/social', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'google' }),
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ delegated: true })
  })
})

describe('失敗の伝え方', () => {
  test('日本語の安定コードで返す', async () => {
    const issued = await issueToken()
    const response = await mutate(issued.app, { origin: APP_ORIGIN })
    const body = (await response.json()) as {
      error: { code: string; message: string }
    }

    expect(body.error.code).toBe('FORBIDDEN')
    expect(body.error.message).toMatch(/[ぁ-んァ-ン一-龥]/)
    expect(new AppError('FORBIDDEN').status).toBe(403)
  })
})
