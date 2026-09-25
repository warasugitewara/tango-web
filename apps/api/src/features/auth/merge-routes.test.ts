import { Temporal } from '@js-temporal/polyfill'
import type { MergeCandidate, MergeUsersInput } from '@tango/db'
import { describe, expect, test } from 'vitest'
import { createApp } from '../../app'
import { mutationHeaders } from '../../test/request-headers'
import type { ActorResolver } from './actor-resolver'
import type { GuestService } from './guest-service'
import { createMergeIntentCodec } from './merge-intent'

const NOW = Temporal.Instant.from('2026-09-26T03:00:00Z')
const SECRET = 'merge-route-test-secret'
const MERGE_COOKIE = '__Host-tango-merge'
const CURRENT_USER = 'user-current'
const OTHER_USER = 'user-other'

const codec = createMergeIntentCodec(SECRET)

function candidate(userId: string, decks: number): MergeCandidate {
  return {
    principalId: `principal-${userId}`,
    userId,
    name: `${userId}の名前`,
    providers: userId === CURRENT_USER ? ['github'] : ['google'],
    decks,
    cards: decks * 10,
    reviews: decks,
    lastReviewedAt: new Date('2026-09-20T03:00:00Z'),
  }
}

function createHarness(
  options: { signedIn?: boolean; known?: readonly string[] } = {},
) {
  const signedIn = options.signedIn ?? true
  const known = options.known ?? [CURRENT_USER, OTHER_USER]
  const merges: MergeUsersInput[] = []

  const actorResolver: ActorResolver = {
    async resolveFormal() {
      if (!signedIn) {
        return null
      }
      return {
        session: {
          userId: CURRENT_USER,
          name: 'いまの人',
          image: null,
          providers: ['github'],
        },
        actor: null,
      }
    },
  }

  const guestService: GuestService = {
    async start() {
      throw new Error('このテストでは使用しない。')
    },
    async resolve() {
      throw new Error('このテストでは使用しない。')
    },
    async revoke() {
      // 何もしない。
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
    cookieSecure: true,
    appOrigin: 'https://tango.warasugi.com',
    principalRepository: {
      async summarizeMergeCandidate(userId) {
        return known.includes(userId)
          ? candidate(userId, userId === CURRENT_USER ? 2 : 5)
          : null
      },
      async mergeUsers(input) {
        merges.push(input)
        return {
          principal: {
            id: `principal-${input.targetUserId}`,
            kind: 'user' as const,
            userId: input.targetUserId,
            createdAt: new Date('2026-09-01T03:00:00Z'),
            updatedAt: new Date('2026-09-26T03:00:00Z'),
          },
          movedProviders: ['google'],
        }
      },
    },
    mergeIntentSecret: SECRET,
  })

  return { app, merges }
}

function intentCookie(userId = OTHER_USER, at = NOW): string {
  const token = codec.sign(
    { userId, mergeKey: '019fd000-0000-7000-8000-000000000001' },
    at,
  )
  return `${MERGE_COOKIE}=${token}`
}

describe('統合の開始', () => {
  test('ログインしていなければ401を返す', async () => {
    const { app } = createHarness({ signedIn: false })

    const response = await app.request('/api/identity/merge/start', {
      method: 'POST',
      headers: mutationHeaders([]),
    })

    expect(response.status).toBe(401)
  })

  test('証明のCookieを発行する', async () => {
    const { app } = createHarness()

    const response = await app.request('/api/identity/merge/start', {
      method: 'POST',
      headers: mutationHeaders([]),
    })

    expect(response.status).toBe(204)
    const cookie = response.headers.get('set-cookie') ?? ''
    expect(cookie).toContain(MERGE_COOKIE)
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('Secure')
    expect(cookie).toContain('SameSite=Lax')
  })
})

describe('統合の比較', () => {
  test('両方の規模を返す', async () => {
    const { app } = createHarness()

    const response = await app.request('/api/identity/merge/preview', {
      headers: { cookie: intentCookie() },
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      current: { userId: CURRENT_USER, decks: 2 },
      other: { userId: OTHER_USER, decks: 5 },
    })
  })

  test('証明が無ければ拒否する', async () => {
    const { app } = createHarness()

    const response = await app.request('/api/identity/merge/preview')

    expect(response.status).toBe(400)
  })

  test('期限切れの証明を拒否する', async () => {
    const { app } = createHarness()

    const response = await app.request('/api/identity/merge/preview', {
      headers: { cookie: intentCookie(OTHER_USER, NOW.subtract({ hours: 1 })) },
    })

    expect(response.status).toBe(400)
  })

  test('同じアカウント同士なら拒否する', async () => {
    // 自分自身との統合は成立しない。証明の使い回しも防ぐ。
    const { app } = createHarness()

    const response = await app.request('/api/identity/merge/preview', {
      headers: { cookie: intentCookie(CURRENT_USER) },
    })

    expect(response.status).toBe(400)
  })
})

describe('統合の確定', () => {
  test('いまのアカウントを残すと、証明側を取り込む', async () => {
    const { app, merges } = createHarness()

    const response = await app.request('/api/identity/merge/confirm', {
      method: 'POST',
      headers: mutationHeaders([intentCookie()], {
        'content-type': 'application/json',
      }),
      body: JSON.stringify({ keep: 'current' }),
    })

    expect(response.status).toBe(200)
    expect(merges).toHaveLength(1)
    expect(merges[0]?.targetUserId).toBe(CURRENT_USER)
    expect(merges[0]?.sourceUserId).toBe(OTHER_USER)
  })

  test('証明側を残すと、いまのアカウントを取り込む', async () => {
    const { app, merges } = createHarness()

    const response = await app.request('/api/identity/merge/confirm', {
      method: 'POST',
      headers: mutationHeaders([intentCookie()], {
        'content-type': 'application/json',
      }),
      body: JSON.stringify({ keep: 'other' }),
    })

    expect(response.status).toBe(200)
    expect(merges[0]?.targetUserId).toBe(OTHER_USER)
    expect(merges[0]?.sourceUserId).toBe(CURRENT_USER)
  })

  test('統合キーは証明に載せたものを使う', async () => {
    // 再送で新しい鍵を振ると、同じ統合が二重に走る。
    const { app, merges } = createHarness()

    await app.request('/api/identity/merge/confirm', {
      method: 'POST',
      headers: mutationHeaders([intentCookie()], {
        'content-type': 'application/json',
      }),
      body: JSON.stringify({ keep: 'current' }),
    })

    expect(merges[0]?.mergeKey).toBe('019fd000-0000-7000-8000-000000000001')
  })

  test('確定したら証明のCookieを捨てる', async () => {
    const { app } = createHarness()

    const response = await app.request('/api/identity/merge/confirm', {
      method: 'POST',
      headers: mutationHeaders([intentCookie()], {
        'content-type': 'application/json',
      }),
      body: JSON.stringify({ keep: 'current' }),
    })

    expect(response.headers.get('set-cookie') ?? '').toContain(
      `${MERGE_COOKIE}=;`,
    )
  })

  test('ログインしていなければ401を返す', async () => {
    const { app } = createHarness({ signedIn: false })

    const response = await app.request('/api/identity/merge/confirm', {
      method: 'POST',
      headers: mutationHeaders([intentCookie()], {
        'content-type': 'application/json',
      }),
      body: JSON.stringify({ keep: 'current' }),
    })

    expect(response.status).toBe(401)
  })
})
