import { Temporal } from '@js-temporal/polyfill'
import { createDatabase } from '@tango/db'
import { type ApiErrorEnvelope, AppError } from '@tango/shared'
import { v7 as uuidv7 } from 'uuid'
import { describe, expect, test } from 'vitest'
import { createApp } from '../../app'
import type { ActorResolver, FormalSession } from './actor-resolver'
import { createAuth, createBetterAuthOptions } from './better-auth'
import { GUEST_COOKIE_NAME, type GuestService } from './guest-service'
import type { IdentityCompletionService } from './identity-completion-service'

const NOW = Temporal.Instant.from('2026-08-01T01:00:00Z')
const APP_ORIGIN = 'https://tango.warasugi.com'
const VALID_RAW_TOKEN = 'valid-raw-token'
const STALE_RAW_TOKEN = 'stale-raw-token'

const FORMAL_SESSION: FormalSession = {
  userId: 'user-1',
  name: 'テスト太郎',
  image: null,
  providers: ['google'],
}

/** 接続はしない。オプション生成にDrizzleインスタンスが必要なだけ。 */
function createOptions() {
  const handle = createDatabase(
    'postgres://options-only@127.0.0.1:5432/unused',
    { max: 1 },
  )
  return createBetterAuthOptions({
    db: handle.db,
    appOrigin: APP_ORIGIN,
    secret: 'x'.repeat(32),
    google: { clientId: 'google-id', clientSecret: 'google-secret' },
    github: { clientId: 'github-id', clientSecret: 'github-secret' },
    useSecureCookies: true,
  })
}

type AppHarness = {
  app: ReturnType<typeof createApp>
  authRequests: string[]
  completions: Array<{ userId: string; guestRawToken: string | null }>
}

function createHarness(
  options: {
    formalSession?: FormalSession | null
    completionError?: AppError
  } = {},
): AppHarness {
  const formalSession = options.formalSession ?? null
  const authRequests: string[] = []
  const completions: AppHarness['completions'] = []

  const guestService: GuestService = {
    async start() {
      throw new Error('このテストでは使用しない。')
    },
    async resolve(rawToken) {
      if (rawToken !== VALID_RAW_TOKEN) {
        throw new AppError('UNAUTHENTICATED')
      }
      return {
        actor: {
          kind: 'guest',
          principalId: 'principal-guest',
          guestSessionId: 'session-1',
        },
        expiresAt: NOW.add({ hours: 24 }),
      }
    },
    async revoke() {
      // 何もしない
    },
  }

  const actorResolver: ActorResolver = {
    async resolveFormal() {
      return formalSession === null
        ? null
        : { session: formalSession, actor: null }
    },
  }

  const identityCompletionService: IdentityCompletionService = {
    async complete(input) {
      completions.push({
        userId: input.userId,
        guestRawToken: input.guestRawToken,
      })
      if (options.completionError !== undefined) {
        throw options.completionError
      }
      return {
        actor: {
          kind: 'user',
          principalId: 'principal-formal',
          userId: input.userId,
        },
        outcome: 'created',
      }
    },
  }

  const app = createApp({
    clock: { now: () => NOW },
    guestService,
    actorResolver,
    identityCompletionService,
    authHandler: async (request) => {
      authRequests.push(new URL(request.url).pathname)
      return new Response('{"ok":true}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    },
    cookieSecure: true,
  })

  return { app, authRequests, completions }
}

describe('Better Auth configuration', () => {
  const options = createOptions()

  test('serves only the validated origin under /api/auth', () => {
    expect(options.baseURL).toBe(APP_ORIGIN)
    expect(options.basePath).toBe('/api/auth')
    expect(options.trustedOrigins).toEqual([APP_ORIGIN])
  })

  test('disables email and password sign-in', () => {
    expect(options.emailAndPassword?.enabled).toBe(false)
  })

  test('offers exactly the Google and GitHub providers', () => {
    expect(Object.keys(options.socialProviders ?? {}).sort()).toEqual([
      'github',
      'google',
    ])
  })

  test('protects stored OAuth material', () => {
    expect(options.account?.encryptOAuthTokens).toBe(true)
    expect(options.account?.storeStateStrategy).toBe('database')
  })

  test('requires explicit account linking', () => {
    expect(options.account?.accountLinking).toMatchObject({
      enabled: true,
      disableImplicitLinking: true,
      allowDifferentEmails: true,
      allowUnlinkingAll: false,
    })
  })

  test('keeps CSRF and origin checks enabled with hardened cookies', () => {
    expect(options.advanced?.disableCSRFCheck).toBe(false)
    expect(options.advanced?.disableOriginCheck).toBe(false)
    expect(options.advanced?.useSecureCookies).toBe(true)
    expect(options.advanced?.defaultCookieAttributes).toMatchObject({
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/',
    })
    // サブドメイン間でセッションを共有しない。
    expect(options.advanced?.defaultCookieAttributes).not.toHaveProperty(
      'domain',
    )
    expect(Object.keys(options.advanced ?? {})).not.toContain(
      'crossSubDomainCookies',
    )
  })

  test('requires a fresh session for sensitive operations', () => {
    expect(options.session?.freshAge).toBe(600)
    expect(options.session?.expiresIn).toBe(60 * 60 * 24 * 30)
  })

  test('keeps user deletion disabled until Phase 4 adds its guard', () => {
    expect(options.user?.deleteUser?.enabled).toBe(false)
  })

  test('loads no anonymous or beta guest plugin', () => {
    expect(options.plugins ?? []).toEqual([])
  })

  test('sends no telemetry', () => {
    expect(options.telemetry?.enabled).toBe(false)
  })

  test('rejects email and password sign-up at runtime', async () => {
    const handle = createDatabase(
      'postgres://runtime-check@127.0.0.1:5432/unused',
      { max: 1 },
    )
    const auth = createAuth({
      db: handle.db,
      appOrigin: APP_ORIGIN,
      // 低エントロピー警告を避けるための検証専用ダミー。
      secret: 'k3Jd82nfPqRsTuVwXyZ01234567890ab',
      google: { clientId: 'google-id', clientSecret: 'google-secret' },
      github: { clientId: 'github-id', clientSecret: 'github-secret' },
      useSecureCookies: true,
    })

    // 無効化されているためDBに触れる前に拒否される。
    const response = await auth.handler(
      new Request(`${APP_ORIGIN}/api/auth/sign-up/email`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: APP_ORIGIN,
        },
        body: JSON.stringify({
          email: 'nobody@example.com',
          password: 'password1234',
          name: 'テスト太郎',
        }),
      }),
    )

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      code: 'EMAIL_PASSWORD_SIGN_UP_DISABLED',
    })

    await handle.close()
  })
})

describe('/api/auth/*', () => {
  test('delegates every method to the Better Auth handler', async () => {
    const harness = createHarness()

    const get = await harness.app.request('/api/auth/get-session')
    const post = await harness.app.request('/api/auth/sign-out', {
      method: 'POST',
    })

    expect(get.status).toBe(200)
    expect(post.status).toBe(200)
    expect(harness.authRequests).toEqual([
      '/api/auth/get-session',
      '/api/auth/sign-out',
    ])
  })

  test('is reachable while a stale guest cookie is still present', async () => {
    const harness = createHarness()

    const response = await harness.app.request('/api/auth/sign-in/social', {
      method: 'POST',
      headers: { cookie: `${GUEST_COOKIE_NAME}=${STALE_RAW_TOKEN}` },
    })

    expect(response.status).toBe(200)
    expect(harness.authRequests).toEqual(['/api/auth/sign-in/social'])
  })
})

describe('POST /api/identity/complete', () => {
  test('requires a Better Auth session', async () => {
    const harness = createHarness()

    const response = await harness.app.request('/api/identity/complete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mergeKey: uuidv7() }),
    })

    expect(response.status).toBe(401)
    expect(harness.completions).toHaveLength(0)
  })

  test('rejects a merge key that is not a UUID', async () => {
    const harness = createHarness({ formalSession: FORMAL_SESSION })

    const response = await harness.app.request('/api/identity/complete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mergeKey: 'not-a-uuid' }),
    })

    expect(response.status).toBe(400)
    expect(harness.completions).toHaveLength(0)
  })

  test('adopts the guest cookie and clears it after success', async () => {
    const harness = createHarness({ formalSession: FORMAL_SESSION })

    const response = await harness.app.request('/api/identity/complete', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: `${GUEST_COOKIE_NAME}=${VALID_RAW_TOKEN}`,
      },
      body: JSON.stringify({ mergeKey: uuidv7() }),
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ outcome: 'created' })
    expect(harness.completions).toEqual([
      { userId: 'user-1', guestRawToken: VALID_RAW_TOKEN },
    ])

    const cookie = response.headers.get('set-cookie')
    expect(cookie).toContain(`${GUEST_COOKIE_NAME}=`)
    expect(cookie).toContain('Max-Age=0')
  })

  test('keeps the guest cookie when completion fails', async () => {
    const harness = createHarness({
      formalSession: FORMAL_SESSION,
      completionError: new AppError('CONFLICT'),
    })

    const response = await harness.app.request('/api/identity/complete', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: `${GUEST_COOKIE_NAME}=${VALID_RAW_TOKEN}`,
      },
      body: JSON.stringify({ mergeKey: uuidv7() }),
    })

    expect(response.status).toBe(409)
    expect(response.headers.get('set-cookie')).toBeNull()
  })

  test('maps an implicit-link rejection to the Japanese ACCOUNT_NOT_LINKED message', async () => {
    const harness = createHarness({
      formalSession: FORMAL_SESSION,
      completionError: new AppError('ACCOUNT_NOT_LINKED'),
    })

    const response = await harness.app.request('/api/identity/complete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mergeKey: uuidv7() }),
    })

    expect(response.status).toBe(409)

    const body = (await response.json()) as ApiErrorEnvelope
    expect(body.error.code).toBe('ACCOUNT_NOT_LINKED')
    expect(body.error.message).toContain('連携されていません')
  })
})
