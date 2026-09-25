import { Temporal } from '@js-temporal/polyfill'
import { describe, expect, test } from 'vitest'
import { createApp } from '../../app'
import { mutationHeaders } from '../../test/request-headers'
import type { ActorResolver } from './actor-resolver'
import type { GuestService } from './guest-service'

const NOW = Temporal.Instant.from('2026-09-26T03:00:00Z')
const USER_ID = 'user-current'

function createHarness(options: { signedIn?: boolean } = {}) {
  const signedIn = options.signedIn ?? true
  const deleted: string[] = []

  const actorResolver: ActorResolver = {
    async resolveFormal() {
      if (!signedIn) {
        return null
      }
      return {
        session: {
          userId: USER_ID,
          name: 'いまの人',
          image: null,
          providers: ['google'],
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
        return {
          principalId: `principal-${userId}`,
          userId,
          name: 'いまの人',
          providers: ['google'],
          decks: 11,
          cards: 373,
          reviews: 38,
          lastReviewedAt: new Date('2026-09-25T03:00:00Z'),
        }
      },
      async mergeUsers() {
        throw new Error('このテストでは使用しない。')
      },
      async deleteUser(userId) {
        deleted.push(userId)
        return true
      },
    },
    mergeIntentSecret: 'account-route-test-secret',
  })

  return { app, deleted }
}

function deleteRequest(confirm: unknown) {
  return {
    method: 'POST',
    headers: mutationHeaders([], { 'content-type': 'application/json' }),
    body: JSON.stringify({ confirm }),
  }
}

describe('アカウントの規模', () => {
  test('ログインしていなければ401を返す', async () => {
    const { app } = createHarness({ signedIn: false })

    expect((await app.request('/api/account/summary')).status).toBe(401)
  })

  test('消える対象の件数を返す', async () => {
    const { app } = createHarness()

    const response = await app.request('/api/account/summary')

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      decks: 11,
      cards: 373,
      reviews: 38,
    })
  })
})

describe('アカウントの削除', () => {
  test('ログインしていなければ401を返す', async () => {
    const { app, deleted } = createHarness({ signedIn: false })

    const response = await app.request(
      '/api/account/delete',
      deleteRequest('削除します'),
    )

    expect(response.status).toBe(401)
    expect(deleted).toHaveLength(0)
  })

  test('確認の文言が違えば削除しない', async () => {
    // 画面の制御だけに頼らない。サーバでも文言を確かめる。
    const { app, deleted } = createHarness()

    const response = await app.request(
      '/api/account/delete',
      deleteRequest('けす'),
    )

    expect(response.status).toBe(400)
    expect(deleted).toHaveLength(0)
  })

  test('確認が空でも削除しない', async () => {
    const { app, deleted } = createHarness()

    const response = await app.request('/api/account/delete', deleteRequest(''))

    expect(response.status).toBe(400)
    expect(deleted).toHaveLength(0)
  })

  test('文言が一致すれば削除する', async () => {
    const { app, deleted } = createHarness()

    const response = await app.request(
      '/api/account/delete',
      deleteRequest('削除します'),
    )

    expect(response.status).toBe(204)
    expect(deleted).toEqual([USER_ID])
  })

  test('二重送信でトークンが無ければ拒否する', async () => {
    // 状態を変える要求なので、CSRFの守りが外れていないことを確かめる。
    const { app, deleted } = createHarness()

    const response = await app.request('/api/account/delete', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'https://tango.warasugi.com',
      },
      body: JSON.stringify({ confirm: '削除します' }),
    })

    expect(response.status).toBe(403)
    expect(deleted).toHaveLength(0)
  })
})
