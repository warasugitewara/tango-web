import { Temporal } from '@js-temporal/polyfill'
import { schema } from '@tango/db'
import {
  createTestDatabase,
  resetIdentityTables,
  type TestDatabaseHandle,
} from '@tango/db/test'
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from 'vitest'
import { createApp } from '../../app'
import type { ActorResolver } from './actor-resolver'
import { type Auth, createAuth } from './better-auth'
import type { GuestService } from './guest-service'
import type { IdentityCompletionService } from './identity-completion-service'

const APP_ORIGIN = 'https://tango.warasugi.com'
const EXISTING_USER_ID = 'oauth-existing-user'
const SAME_EMAIL = 'oauth-same-email@example.test'
const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'
const DUMMY_BETTER_AUTH_SECRET =
  'DUMMY-BETTER-AUTH-SECRET-MARKER-x9Q4rT7uP2vK8mN5sL1c'
const DUMMY_GOOGLE_CLIENT_SECRET = 'DUMMY-GOOGLE-CLIENT-SECRET-MARKER'
const DUMMY_GITHUB_CLIENT_SECRET = 'DUMMY-GITHUB-CLIENT-SECRET-MARKER'
const DUMMY_OAUTH_TOKEN_SETS = [
  {
    accessToken: 'DUMMY-OAUTH-ACCESS-CREATE-MARKER',
    refreshToken: 'DUMMY-OAUTH-REFRESH-CREATE-MARKER',
    idToken: 'DUMMY-OAUTH-ID-CREATE-MARKER',
  },
  {
    accessToken: 'DUMMY-OAUTH-ACCESS-UPDATE-MARKER',
    refreshToken: 'DUMMY-OAUTH-REFRESH-UPDATE-MARKER',
    idToken: 'DUMMY-OAUTH-ID-UPDATE-MARKER',
  },
] as const

let databaseHandle: TestDatabaseHandle | null = null
let auth: Auth | null = null
let app: ReturnType<typeof createApp> | null = null

function requireDatabase(): TestDatabaseHandle {
  if (databaseHandle === null) {
    throw new Error('テストDBが初期化されていません。')
  }
  return databaseHandle
}

function requireAuth(): Auth {
  if (auth === null) {
    throw new Error('Better Authが初期化されていません。')
  }
  return auth
}

function requireApp(): ReturnType<typeof createApp> {
  if (app === null) {
    throw new Error('テストアプリが初期化されていません。')
  }
  return app
}

function requireHeader(response: Response, name: string): string {
  const value = response.headers.get(name)
  if (value === null) {
    throw new Error(`${name} ヘッダがありません。`)
  }
  return value
}

function createUnsignedGoogleIdToken(dummyIdTokenMarker: string): string {
  const encode = (value: Readonly<Record<string, unknown>>) =>
    Buffer.from(JSON.stringify(value)).toString('base64url')

  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode({
    aud: 'google-client-id',
    azp: 'google-client-id',
    email: SAME_EMAIL,
    email_verified: true,
    exp: 2_000_000_000,
    family_name: '既存',
    given_name: '利用者',
    iat: 1_900_000_000,
    iss: 'https://accounts.google.com',
    name: '既存 利用者',
    picture: 'https://example.test/avatar.png',
    sub: 'google-provider-user',
    dummy_token_marker: dummyIdTokenMarker,
  })}.test-signature`
}

type FetchImplementation = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>

function createExternalProviderFetch(): FetchImplementation {
  const originalFetch = globalThis.fetch
  let tokenExchangeCount = 0

  return async (input, init) => {
    const url = input instanceof Request ? input.url : String(input)

    if (url === GOOGLE_TOKEN_ENDPOINT) {
      const tokenSet = DUMMY_OAUTH_TOKEN_SETS[tokenExchangeCount]
      if (tokenSet === undefined) {
        throw new Error('dummy OAuth token setを使い切りました。')
      }
      tokenExchangeCount += 1
      return new Response(
        JSON.stringify({
          access_token: tokenSet.accessToken,
          expires_in: 3600,
          id_token: createUnsignedGoogleIdToken(tokenSet.idToken),
          refresh_token: tokenSet.refreshToken,
          scope: 'openid email profile',
          token_type: 'Bearer',
        }),
        { headers: { 'content-type': 'application/json' } },
      )
    }

    return originalFetch(input, init)
  }
}

async function insertExistingGithubUser(): Promise<void> {
  const db = requireDatabase().db
  const now = new Date('2026-08-01T01:00:00.000Z')

  await db.insert(schema.user).values({
    id: EXISTING_USER_ID,
    name: '既存 利用者',
    email: SAME_EMAIL,
    emailVerified: true,
    createdAt: now,
    updatedAt: now,
  })
  await db.insert(schema.account).values({
    id: 'existing-github-account',
    accountId: 'github-provider-user',
    providerId: 'github',
    userId: EXISTING_USER_ID,
    createdAt: now,
    updatedAt: now,
  })
}

beforeAll(async () => {
  databaseHandle = await createTestDatabase()
  auth = createAuth({
    db: databaseHandle.db,
    appOrigin: APP_ORIGIN,
    secret: DUMMY_BETTER_AUTH_SECRET,
    google: {
      clientId: 'google-client-id',
      clientSecret: DUMMY_GOOGLE_CLIENT_SECRET,
    },
    github: {
      clientId: 'github-client-id',
      clientSecret: DUMMY_GITHUB_CLIENT_SECRET,
    },
    useSecureCookies: true,
  })

  const guestService: GuestService = {
    async start() {
      throw new Error('このテストでは使用しません。')
    },
    async resolve() {
      throw new Error('このテストでは使用しません。')
    },
    async revoke() {
      throw new Error('このテストでは使用しません。')
    },
  }
  const actorResolver: ActorResolver = {
    async resolveFormal() {
      return null
    },
  }
  const identityCompletionService: IdentityCompletionService = {
    async complete() {
      throw new Error('このテストでは使用しません。')
    },
  }

  app = createApp({
    clock: {
      now: () => Temporal.Instant.from('2026-08-01T01:00:00Z'),
    },
    guestService,
    actorResolver,
    identityCompletionService,
    authHandler: (request) => requireAuth().handler(request),
    cookieSecure: true,
    appOrigin: 'https://tango.warasugi.com',
  })
})

afterAll(async () => {
  if (databaseHandle !== null) {
    await databaseHandle.close()
  }
})

afterEach(() => {
  vi.unstubAllGlobals()
})

beforeEach(async () => {
  await resetIdentityTables(requireDatabase())
  vi.stubGlobal('fetch', createExternalProviderFetch())
})

describe('OAuth callback persistence boundary', () => {
  test('creates a hardened session while encrypting access and refresh tokens and discarding the ID token', async () => {
    const completeSignIn = async (): Promise<Response> => {
      const started = await requireApp().request('/api/auth/sign-in/social', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: APP_ORIGIN,
        },
        body: JSON.stringify({
          provider: 'google',
          callbackURL: `${APP_ORIGIN}/auth/complete`,
        }),
      })

      expect(started.status).toBe(200)
      const authorizationUrl = new URL(requireHeader(started, 'location'))
      const state = authorizationUrl.searchParams.get('state')
      if (state === null) {
        throw new Error('OAuth stateが発行されませんでした。')
      }
      const stateCookie = requireHeader(started, 'set-cookie').split(';', 1)[0]
      if (stateCookie === undefined) {
        throw new Error('OAuth state Cookieを取り出せませんでした。')
      }

      return requireApp().request(
        `/api/auth/callback/google?code=dummy-provider-code-marker&state=${encodeURIComponent(state)}`,
        { headers: { cookie: stateCookie } },
      )
    }

    const callback = await completeSignIn()

    expect(callback.status).toBe(302)
    expect(new URL(requireHeader(callback, 'location')).pathname).toBe(
      '/auth/complete',
    )
    const sessionCookie = requireHeader(callback, 'set-cookie')
    expect(sessionCookie).toMatch(/__Secure-better-auth\.session_token=/)
    expect(sessionCookie).toMatch(/(?:^|;)\s*Secure(?:;|$)/i)
    expect(sessionCookie).toMatch(/(?:^|;)\s*HttpOnly(?:;|$)/i)
    expect(sessionCookie).toMatch(/(?:^|;)\s*SameSite=Lax(?:;|$)/i)
    expect(sessionCookie).toMatch(/(?:^|;)\s*Path=\/(?:;|$)/i)
    expect(sessionCookie).not.toMatch(/(?:^|;)\s*Domain=/i)

    const createdAccounts = await requireDatabase()
      .db.select({
        accessToken: schema.account.accessToken,
        refreshToken: schema.account.refreshToken,
        idToken: schema.account.idToken,
      })
      .from(schema.account)
    expect(createdAccounts).toHaveLength(1)
    expect(createdAccounts[0]).toMatchObject({ idToken: null })
    const createdAccessToken = createdAccounts[0]?.accessToken
    const createdRefreshToken = createdAccounts[0]?.refreshToken
    expect(createdAccessToken).toEqual(expect.any(String))
    expect(createdRefreshToken).toEqual(expect.any(String))
    if (
      typeof createdAccessToken !== 'string' ||
      typeof createdRefreshToken !== 'string'
    ) {
      throw new Error('create callbackの暗号化tokenが保存されていません。')
    }
    expect(createdAccessToken).not.toContain(
      DUMMY_OAUTH_TOKEN_SETS[0].accessToken,
    )
    expect(createdAccessToken).not.toContain(
      DUMMY_OAUTH_TOKEN_SETS[1].accessToken,
    )
    expect(createdRefreshToken).not.toContain(
      DUMMY_OAUTH_TOKEN_SETS[0].refreshToken,
    )
    expect(createdRefreshToken).not.toContain(
      DUMMY_OAUTH_TOKEN_SETS[1].refreshToken,
    )

    const repeatedCallback = await completeSignIn()
    expect(repeatedCallback.status).toBe(302)
    const updatedAccounts = await requireDatabase()
      .db.select({
        accessToken: schema.account.accessToken,
        refreshToken: schema.account.refreshToken,
        idToken: schema.account.idToken,
      })
      .from(schema.account)
    expect(updatedAccounts).toHaveLength(1)
    expect(updatedAccounts[0]).toMatchObject({ idToken: null })
    const updatedAccessToken = updatedAccounts[0]?.accessToken
    const updatedRefreshToken = updatedAccounts[0]?.refreshToken
    expect(updatedAccessToken).toEqual(expect.any(String))
    expect(updatedRefreshToken).toEqual(expect.any(String))
    if (
      typeof updatedAccessToken !== 'string' ||
      typeof updatedRefreshToken !== 'string'
    ) {
      throw new Error('update callbackの暗号化tokenが保存されていません。')
    }
    expect(updatedAccessToken).not.toBe(createdAccessToken)
    expect(updatedRefreshToken).not.toBe(createdRefreshToken)
    expect(updatedAccessToken).not.toContain(
      DUMMY_OAUTH_TOKEN_SETS[0].accessToken,
    )
    expect(updatedAccessToken).not.toContain(
      DUMMY_OAUTH_TOKEN_SETS[1].accessToken,
    )
    expect(updatedRefreshToken).not.toContain(
      DUMMY_OAUTH_TOKEN_SETS[0].refreshToken,
    )
    expect(updatedRefreshToken).not.toContain(
      DUMMY_OAUTH_TOKEN_SETS[1].refreshToken,
    )
  })
})

describe('OAuth callback error boundary', () => {
  test('maps a real same-email rejection to ACCOUNT_NOT_LINKED recovery guidance', async () => {
    await insertExistingGithubUser()

    const started = await requireApp().request('/api/auth/sign-in/social', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: APP_ORIGIN,
      },
      body: JSON.stringify({
        provider: 'google',
        callbackURL: `${APP_ORIGIN}/auth/complete`,
      }),
    })

    expect(started.status).toBe(200)
    const authorizationUrl = new URL(requireHeader(started, 'location'))
    const state = authorizationUrl.searchParams.get('state')
    if (state === null) {
      throw new Error('OAuth stateが発行されませんでした。')
    }
    const stateCookie = requireHeader(started, 'set-cookie').split(';', 1)[0]
    if (stateCookie === undefined) {
      throw new Error('OAuth state Cookieを取り出せませんでした。')
    }

    const callback = await requireApp().request(
      `/api/auth/callback/google?code=provider-code&state=${encodeURIComponent(state)}`,
      { headers: { cookie: stateCookie } },
    )

    expect(callback.status).toBe(302)
    const errorLocation = new URL(requireHeader(callback, 'location'))
    expect(errorLocation.pathname).toBe('/auth/error')
    expect(errorLocation.searchParams.get('error')).toBe('account_not_linked')

    const recoveryPage = await requireApp().request(
      `${errorLocation.pathname}${errorLocation.search}`,
    )
    expect(recoveryPage.status).toBe(409)
    const recoveryHtml = await recoveryPage.text()
    expect(recoveryHtml).toContain('ACCOUNT_NOT_LINKED')
    expect(recoveryHtml).toContain(
      '既存のログイン方法でログインしてから連携してください',
    )

    const accounts = await requireDatabase()
      .db.select({ providerId: schema.account.providerId })
      .from(schema.account)
    expect(accounts).toEqual([{ providerId: 'github' }])
  })
})
