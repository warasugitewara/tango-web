import {
  type ApiErrorEnvelope,
  AppError,
  formatJst,
  parseJstInstant,
} from '@tango/shared'
import { beforeEach, describe, expect, test } from 'vitest'
import { createApp } from '../../app'
import { MAX_REQUEST_BODY_BYTES } from '../../middleware/json-body-guard'
import type { ActorResolver, FormalSession } from './actor-resolver'
import {
  GUEST_COOKIE_NAME,
  GUEST_RISK_NOTICE,
  GUEST_SESSION_DAYS,
  type GuestService,
} from './guest-service'

const NOW = parseJstInstant('2026-08-01T10:00:00+09:00')
const GUEST_EXPIRES_AT = NOW.add({ hours: 24 * GUEST_SESSION_DAYS })
/** APIが返す期限はJSTのオフセットを明示した形式に固定する。 */
const GUEST_EXPIRES_AT_JST = formatJst(GUEST_EXPIRES_AT)
const VALID_RAW_TOKEN = 'valid-raw-token'
const STALE_RAW_TOKEN = 'stale-raw-token'

type Harness = {
  app: ReturnType<typeof createApp>
  startCalls: Array<{ turnstileToken: string; remoteIp: string | null }>
}

async function readErrorEnvelope(
  response: Response,
): Promise<ApiErrorEnvelope> {
  return (await response.json()) as ApiErrorEnvelope
}

function createHarness(options: {
  turnstileValid?: boolean
  formalSession?: FormalSession | null
  cookieSecure?: boolean
  /** ゲスト解決時にDB側の期限を延長できたことにするか。 */
  guestRefreshed?: boolean
}): Harness {
  const turnstileValid = options.turnstileValid ?? true
  const formalSession = options.formalSession ?? null
  const startCalls: Harness['startCalls'] = []

  const guestService: GuestService = {
    async start(input) {
      startCalls.push(input)
      if (!turnstileValid) {
        throw new AppError('VALIDATION_FAILED', {
          publicMessage: '認証チャレンジの確認に失敗しました。',
        })
      }
      return {
        rawToken: VALID_RAW_TOKEN,
        actor: {
          kind: 'guest',
          principalId: 'principal-1',
          guestSessionId: 'session-1',
        },
        expiresAt: GUEST_EXPIRES_AT,
        warning: GUEST_RISK_NOTICE,
      }
    },
    async resolve(rawToken) {
      if (rawToken !== VALID_RAW_TOKEN) {
        throw new AppError('UNAUTHENTICATED')
      }
      return {
        actor: {
          kind: 'guest',
          principalId: 'principal-1',
          guestSessionId: 'session-1',
        },
        expiresAt: GUEST_EXPIRES_AT,
        refreshed: options.guestRefreshed ?? false,
      }
    },
    async revoke() {
      // 何もしない
    },
  }

  const actorResolver: ActorResolver = {
    async resolveFormal() {
      if (formalSession === null) {
        return null
      }
      return {
        session: formalSession,
        actor: {
          kind: 'user',
          principalId: 'principal-9',
          userId: formalSession.userId,
        },
      }
    },
  }

  const app = createApp({
    clock: { now: () => NOW },
    guestService,
    actorResolver,
    identityCompletionService: {
      async complete() {
        throw new Error('このテストでは使用しない。')
      },
    },
    authHandler: async () => new Response(null, { status: 204 }),
    cookieSecure: options.cookieSecure ?? true,
  })

  return { app, startCalls }
}

describe('POST /api/guest/start', () => {
  let harness: Harness

  beforeEach(() => {
    harness = createHarness({})
  })

  test('sets a hardened guest cookie and returns the risk notice', async () => {
    const response = await harness.app.request('/api/guest/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ turnstileToken: 'valid-token' }),
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      authenticated: true,
      kind: 'guest',
      expiresAt: GUEST_EXPIRES_AT_JST,
      warning: GUEST_RISK_NOTICE,
    })
    // JSTのオフセットを明示しないと画面側で解釈が揺れる。
    expect(GUEST_EXPIRES_AT_JST).toMatch(/\+09:00$/)

    const cookie = response.headers.get('set-cookie')
    expect(cookie).toContain(`${GUEST_COOKIE_NAME}=`)
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('Secure')
    expect(cookie).toContain('SameSite=Lax')
    expect(cookie).toContain('Path=/')
    expect(cookie).toContain(`Max-Age=${24 * 60 * 60 * GUEST_SESSION_DAYS}`)
    // サブドメイン間で共有しない。
    expect(cookie).not.toContain('Domain')
  })

  test('omits Secure outside production so local http development works', async () => {
    const local = createHarness({ cookieSecure: false })
    const response = await local.app.request('/api/guest/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ turnstileToken: 'valid-token' }),
    })

    const cookie = response.headers.get('set-cookie')
    expect(cookie).toContain('HttpOnly')
    expect(cookie).not.toContain('Secure')
  })

  test('rejects a failed Turnstile challenge with the shared error envelope', async () => {
    const invalid = createHarness({ turnstileValid: false })
    const response = await invalid.app.request('/api/guest/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ turnstileToken: 'invalid-token' }),
    })

    expect(response.status).toBe(400)
    expect(response.headers.get('set-cookie')).toBeNull()

    const body = await readErrorEnvelope(response)
    expect(body).toMatchObject({
      error: {
        code: 'VALIDATION_FAILED',
        message: '認証チャレンジの確認に失敗しました。',
      },
    })
    expect(typeof body.error.requestId).toBe('string')
  })

  test('rejects a malformed body before calling Turnstile', async () => {
    const response = await harness.app.request('/api/guest/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ turnstileToken: 42 }),
    })

    expect(response.status).toBe(400)
    expect(harness.startCalls).toHaveLength(0)
  })

  test('keeps an existing guest session instead of issuing a new cookie', async () => {
    // 上書きすると旧principalの学習データへ到達する唯一の生トークンを失う。
    const response = await harness.app.request('/api/guest/start', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: `${GUEST_COOKIE_NAME}=${VALID_RAW_TOKEN}`,
      },
      body: JSON.stringify({ turnstileToken: 'valid-token' }),
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      authenticated: true,
      kind: 'guest',
      expiresAt: GUEST_EXPIRES_AT_JST,
      warning: GUEST_RISK_NOTICE,
    })
    // 新しいゲストを作らず、Cookieも書き換えない。
    expect(harness.startCalls).toHaveLength(0)
    expect(response.headers.get('set-cookie')).toBeNull()
  })

  test('refuses to replace a live formal session', async () => {
    const formal = createHarness({
      formalSession: {
        userId: 'user-1',
        name: 'テスト太郎',
        image: null,
        providers: ['google'],
      },
    })

    const response = await formal.app.request('/api/guest/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ turnstileToken: 'valid-token' }),
    })

    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({
      error: { code: 'CONFLICT' },
    })
    expect(formal.startCalls).toHaveLength(0)
  })
})

describe('GET /api/session', () => {
  test('reports an anonymous visitor', async () => {
    const { app } = createHarness({})
    const response = await app.request('/api/session')

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ authenticated: false })
  })

  test('reports an active guest with its expiry and warning', async () => {
    const { app } = createHarness({})
    const response = await app.request('/api/session', {
      headers: { cookie: `${GUEST_COOKIE_NAME}=${VALID_RAW_TOKEN}` },
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      authenticated: true,
      kind: 'guest',
      expiresAt: GUEST_EXPIRES_AT_JST,
      warning: GUEST_RISK_NOTICE,
    })
  })

  test('reports a formal user with linked providers', async () => {
    const { app } = createHarness({
      formalSession: {
        userId: 'user-1',
        name: 'テスト太郎',
        image: null,
        providers: ['google', 'github'],
      },
    })
    const response = await app.request('/api/session')

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      authenticated: true,
      kind: 'user',
      user: { id: 'user-1', name: 'テスト太郎', image: null },
      providers: ['google', 'github'],
    })
  })

  test('clears a revoked or expired guest cookie and reports UNAUTHENTICATED', async () => {
    const { app } = createHarness({})
    const response = await app.request('/api/session', {
      headers: { cookie: `${GUEST_COOKIE_NAME}=${STALE_RAW_TOKEN}` },
    })

    expect(response.status).toBe(401)
    expect(await response.json()).toMatchObject({
      error: { code: 'UNAUTHENTICATED' },
    })

    const cookie = response.headers.get('set-cookie')
    expect(cookie).toContain(`${GUEST_COOKIE_NAME}=`)
    expect(cookie).toContain('Max-Age=0')
  })

  test('reissues the guest cookie when the expiry was extended', async () => {
    // DB側だけ延長してCookieを据え置くと、作成から90日でブラウザが先にCookieを捨てる。
    const { app } = createHarness({ guestRefreshed: true })
    const response = await app.request('/api/session', {
      headers: { cookie: `${GUEST_COOKIE_NAME}=${VALID_RAW_TOKEN}` },
    })

    expect(response.status).toBe(200)

    const cookie = response.headers.get('set-cookie')
    expect(cookie).toContain(`${GUEST_COOKIE_NAME}=${VALID_RAW_TOKEN}`)
    expect(cookie).toContain(`Max-Age=${24 * 60 * 60 * GUEST_SESSION_DAYS}`)
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('Secure')
    expect(cookie).toContain('SameSite=Lax')
    expect(cookie).not.toContain('Domain')
  })

  test('leaves the guest cookie untouched when nothing was extended', async () => {
    const { app } = createHarness({})
    const response = await app.request('/api/session', {
      headers: { cookie: `${GUEST_COOKIE_NAME}=${VALID_RAW_TOKEN}` },
    })

    expect(response.status).toBe(200)
    expect(response.headers.get('set-cookie')).toBeNull()
  })

  test('prefers the formal session over a guest cookie', async () => {
    const { app } = createHarness({
      formalSession: {
        userId: 'user-1',
        name: 'テスト太郎',
        image: null,
        providers: ['github'],
      },
    })
    const response = await app.request('/api/session', {
      headers: { cookie: `${GUEST_COOKIE_NAME}=${VALID_RAW_TOKEN}` },
    })

    expect(await response.json()).toMatchObject({
      authenticated: true,
      kind: 'user',
    })
  })
})

describe('request body boundaries', () => {
  let harness: Harness

  beforeEach(() => {
    harness = createHarness({})
  })

  test('normalizes malformed JSON into VALIDATION_FAILED', async () => {
    const response = await harness.app.request('/api/guest/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"turnstileToken":',
    })

    expect(response.status).toBe(400)

    const body = await readErrorEnvelope(response)
    expect(body.error.code).toBe('VALIDATION_FAILED')
    expect(body.error.message).toContain('JSON形式')
    expect(harness.startCalls).toHaveLength(0)
  })

  test('normalizes an empty body into VALIDATION_FAILED', async () => {
    const response = await harness.app.request('/api/guest/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    })

    expect(response.status).toBe(400)
    expect((await readErrorEnvelope(response)).error.code).toBe(
      'VALIDATION_FAILED',
    )
    expect(harness.startCalls).toHaveLength(0)
  })

  test('rejects a body sent without a JSON content type', async () => {
    const response = await harness.app.request('/api/guest/start', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: JSON.stringify({ turnstileToken: 'valid-token' }),
    })

    expect(response.status).toBe(400)

    const body = await readErrorEnvelope(response)
    expect(body.error.code).toBe('VALIDATION_FAILED')
    expect(body.error.message).toContain('Content-Type')
    expect(harness.startCalls).toHaveLength(0)
  })

  test('accepts a JSON content type that carries a charset', async () => {
    const response = await harness.app.request('/api/guest/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ turnstileToken: 'valid-token' }),
    })

    expect(response.status).toBe(200)
    expect(harness.startCalls).toHaveLength(1)
  })

  test('rejects a body that exceeds the size limit', async () => {
    const oversized = JSON.stringify({
      turnstileToken: 'a'.repeat(MAX_REQUEST_BODY_BYTES),
    })

    const response = await harness.app.request('/api/guest/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: oversized,
    })

    expect(response.status).toBe(400)

    const body = await readErrorEnvelope(response)
    expect(body.error.code).toBe('VALIDATION_FAILED')
    expect(body.error.message).toContain('大きすぎます')
    expect(harness.startCalls).toHaveLength(0)
  })

  test('accepts a body that sits just under the size limit', async () => {
    // 上限ぎりぎりの本文を誤って弾かないことも確かめる。
    const filler = 'a'.repeat(
      MAX_REQUEST_BODY_BYTES - JSON.stringify({ turnstileToken: '' }).length,
    )

    const response = await harness.app.request('/api/guest/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ turnstileToken: filler }),
    })

    expect(response.status).toBe(200)
    expect(harness.startCalls).toHaveLength(1)
  })
})

describe('request context and error handling', () => {
  test('echoes the caller request id into the error envelope', async () => {
    const { app } = createHarness({})
    const response = await app.request('/api/session', {
      headers: {
        cookie: `${GUEST_COOKIE_NAME}=${STALE_RAW_TOKEN}`,
        'x-request-id': '01919b1e-0000-7000-8000-000000000000',
      },
    })

    const body = await readErrorEnvelope(response)
    expect(body.error.requestId).toBe('01919b1e-0000-7000-8000-000000000000')
  })

  test('generates a request id when the caller supplies an invalid one', async () => {
    const { app } = createHarness({})
    const response = await app.request('/api/session', {
      headers: {
        cookie: `${GUEST_COOKIE_NAME}=${STALE_RAW_TOKEN}`,
        'x-request-id': 'not-a-uuid',
      },
    })

    const body = await readErrorEnvelope(response)
    expect(body.error.requestId).not.toBe('not-a-uuid')
    expect(body.error.requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    )
  })

  test('keeps the guest cookie when resolution fails for an unknown reason', async () => {
    // DB障害などの一時的な失敗でCookieを消してしまうと、
    // 唯一の生トークンを失いゲストの学習データへ到達できなくなる。
    const unstable: GuestService = {
      async start() {
        throw new Error('このテストでは使用しない。')
      },
      async resolve() {
        throw new Error('データベースへ接続できません')
      },
      async revoke() {
        // 何もしない
      },
    }

    const app = createApp({
      clock: { now: () => NOW },
      guestService: unstable,
      actorResolver: {
        async resolveFormal() {
          return null
        },
      },
      identityCompletionService: {
        async complete() {
          throw new Error('このテストでは使用しない。')
        },
      },
      authHandler: async () => new Response(null, { status: 204 }),
      cookieSecure: true,
    })

    const response = await app.request('/api/session', {
      headers: { cookie: `${GUEST_COOKIE_NAME}=${VALID_RAW_TOKEN}` },
    })

    expect(response.status).toBe(500)
    expect(await response.json()).toMatchObject({
      error: { code: 'INTERNAL_ERROR' },
    })
    // Cookieは残したままにする。
    expect(response.headers.get('set-cookie')).toBeNull()
  })

  test('maps an unexpected failure to INTERNAL_ERROR without leaking details', async () => {
    const failing: GuestService = {
      async start() {
        throw new Error(
          '接続文字列 postgres://secret@10.0.0.5/db が壊れています',
        )
      },
      async resolve() {
        throw new AppError('UNAUTHENTICATED')
      },
      async revoke() {
        // 何もしない
      },
    }

    const app = createApp({
      clock: { now: () => NOW },
      guestService: failing,
      actorResolver: {
        async resolveFormal() {
          return null
        },
      },
      identityCompletionService: {
        async complete() {
          throw new Error('このテストでは使用しない。')
        },
      },
      authHandler: async () => new Response(null, { status: 204 }),
      cookieSecure: true,
    })

    const response = await app.request('/api/guest/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ turnstileToken: 'valid-token' }),
    })

    expect(response.status).toBe(500)

    const raw = await response.text()
    expect(raw).toContain('INTERNAL_ERROR')
    expect(raw).not.toContain('secret')
    expect(raw).not.toContain('10.0.0.5')
    expect(raw).not.toContain('postgres://')
  })
})
