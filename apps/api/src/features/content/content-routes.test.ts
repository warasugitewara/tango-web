import { Temporal } from '@js-temporal/polyfill'
import type { ContentRepository } from '@tango/db'
import { AppError } from '@tango/shared'
import { v7 as uuidv7 } from 'uuid'
import { describe, expect, test } from 'vitest'
import { createApp } from '../../app'
import type { ActorResolver } from '../auth/actor-resolver'
import { GUEST_COOKIE_NAME, type GuestService } from '../auth/guest-service'

const NOW = Temporal.Instant.from('2026-08-21T03:00:00Z')
const RAW_TOKEN = 'content-route-token'

function createRepository(): ContentRepository {
  return {
    async listDecks() {
      return []
    },
    async createDeck(_principalId, input) {
      return {
        id: uuidv7(),
        name: input.name,
        description: input.description ?? null,
        newCardLimit: input.newCardLimit ?? 20,
        cardCount: 0,
      }
    },
    async updateDeck() {
      return null
    },
    async trashDeck() {
      return false
    },
    async listCards() {
      return []
    },
    async createCard(_principalId, deckId, input, now) {
      return {
        id: uuidv7(),
        deckId,
        front: input.front,
        back: input.back,
        contentHash: 'a'.repeat(64),
        createdAt: now,
        updatedAt: now,
      }
    },
    async updateCard() {
      return null
    },
    async trashCard() {
      return false
    },
    async createCards() {
      return 0
    },
  }
}

function createHarness(repository: ContentRepository = createRepository()) {
  const guestService: GuestService = {
    async start() {
      throw new Error('このテストでは使用しない。')
    },
    async resolve(rawToken) {
      if (rawToken !== RAW_TOKEN) {
        throw new AppError('UNAUTHENTICATED')
      }
      return {
        actor: {
          kind: 'guest',
          principalId: 'principal-content',
          guestSessionId: 'guest-session-content',
        },
        expiresAt: NOW.add({ hours: 24 }),
        refreshed: false,
      }
    },
    async revoke() {
      // 何もしない。
    },
  }
  const actorResolver: ActorResolver = {
    async resolveFormal() {
      return null
    },
  }

  return createApp({
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
    contentRepository: repository,
  })
}

function guestHeaders(): Record<string, string> {
  return { cookie: `${GUEST_COOKIE_NAME}=${RAW_TOKEN}` }
}

describe('content routes', () => {
  test('actorが無ければ401を返す', async () => {
    const response = await createHarness().request('/api/decks')

    expect(response.status).toBe(401)
    expect(await response.json()).toMatchObject({
      error: { code: 'UNAUTHENTICATED' },
    })
  })

  test('他人または存在しないデッキの更新は404を返す', async () => {
    const response = await createHarness().request(`/api/decks/${uuidv7()}`, {
      method: 'PATCH',
      headers: {
        ...guestHeaders(),
        'content-type': 'application/json',
      },
      body: JSON.stringify({ name: '乗っ取り' }),
    })

    expect(response.status).toBe(404)
    expect(await response.json()).toMatchObject({
      error: { code: 'NOT_FOUND' },
    })
  })

  test('20000文字を超える本文は400を返す', async () => {
    const response = await createHarness().request(
      `/api/decks/${uuidv7()}/cards`,
      {
        method: 'POST',
        headers: {
          ...guestHeaders(),
          'content-type': 'application/json',
        },
        body: JSON.stringify({ front: 'あ'.repeat(20_001), back: '裏' }),
      },
    )

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      error: { code: 'VALIDATION_FAILED' },
    })
  })

  test('カード作成日時をJSTオフセット付きで返す', async () => {
    const response = await createHarness().request(
      `/api/decks/${uuidv7()}/cards`,
      {
        method: 'POST',
        headers: {
          ...guestHeaders(),
          'content-type': 'application/json',
        },
        body: JSON.stringify({ front: '表', back: '裏' }),
      },
    )

    expect(response.status).toBe(201)
    expect(await response.json()).toMatchObject({
      card: {
        front: '表',
        back: '裏',
        createdAt: '2026-08-21T12:00:00+09:00',
        updatedAt: '2026-08-21T12:00:00+09:00',
      },
    })
  })

  test('妥当なJSONを全件まとめて取り込む', async () => {
    const imported: Array<readonly { front: string; back: string }[]> = []
    const repository: ContentRepository = {
      ...createRepository(),
      async createCards(_principalId, _deckId, inputs) {
        imported.push(inputs)
        return inputs.length
      },
    }
    const response = await createHarness(repository).request(
      `/api/decks/${uuidv7()}/import`,
      {
        method: 'POST',
        headers: {
          ...guestHeaders(),
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          format: 'json',
          payload: JSON.stringify({
            schema: 'tango.content',
            version: 1,
            cards: [
              { front: '表1', back: '裏1' },
              { front: '表2', back: '裏2' },
            ],
          }),
        }),
      },
    )

    expect(response.status).toBe(201)
    expect(await response.json()).toEqual({ created: 2 })
    expect(imported).toEqual([
      [
        { front: '表1', back: '裏1' },
        { front: '表2', back: '裏2' },
      ],
    ])
  })

  test('不正な取り込みはリポジトリを呼ばず全体を拒否する', async () => {
    let createCalls = 0
    const repository: ContentRepository = {
      ...createRepository(),
      async createCards() {
        createCalls += 1
        return 0
      },
    }
    const response = await createHarness(repository).request(
      `/api/decks/${uuidv7()}/import`,
      {
        method: 'POST',
        headers: {
          ...guestHeaders(),
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          format: 'json',
          payload: JSON.stringify({
            schema: 'tango.content',
            version: 1,
            cards: [{ front: '', back: '裏' }],
          }),
        }),
      },
    )

    expect(response.status).toBe(400)
    expect(createCalls).toBe(0)
  })
})
