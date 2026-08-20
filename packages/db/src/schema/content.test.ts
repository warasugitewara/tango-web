import { v7 as uuidv7 } from 'uuid'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import type { TestDatabaseHandle } from '../test/database'
import { createTestDatabase, resetIdentityTables } from '../test/database'
import * as schema from './index'

describe('content schema', () => {
  let handle: TestDatabaseHandle

  beforeAll(async () => {
    handle = await createTestDatabase()
  })

  afterAll(async () => {
    if (handle !== undefined) {
      await handle.close()
    }
  })

  beforeEach(async () => {
    await resetIdentityTables(handle)
  })

  /** ゲストprincipalを1件作り、そのIDを返す。 */
  async function insertGuestPrincipal(): Promise<string> {
    const id = uuidv7()
    await handle.db.insert(schema.principals).values({ id, kind: 'guest' })
    return id
  }

  async function insertDeck(principalId: string): Promise<string> {
    const id = uuidv7()
    await handle.db.insert(schema.decks).values({
      id,
      principalId,
      name: '英単語',
      normalizedName: '英単語',
    })
    return id
  }

  test('デッキの新規カード上限は既定で20になる', async () => {
    const principalId = await insertGuestPrincipal()
    const deckId = await insertDeck(principalId)

    const [deck] = await handle.db.select().from(schema.decks)

    expect(deck?.id).toBe(deckId)
    expect(deck?.newCardLimit).toBe(20)
    expect(deck?.trashedAt).toBeNull()
  })

  test('新規カード上限に1000を超える値を入れられない', async () => {
    const principalId = await insertGuestPrincipal()

    await expect(
      handle.db.insert(schema.decks).values({
        id: uuidv7(),
        principalId,
        name: '英単語',
        normalizedName: '英単語',
        newCardLimit: 1_001,
      }),
    ).rejects.toThrow()
  })

  test('取り込み元IDが同じカードの重複を拒否する', async () => {
    const principalId = await insertGuestPrincipal()
    const deckId = await insertDeck(principalId)
    const card = {
      deckId,
      front: '表',
      back: '裏',
      contentHash: 'hash',
      sourceKey: 'ai',
      externalId: 'e-1',
    }

    await handle.db.insert(schema.cards).values({ id: uuidv7(), ...card })

    await expect(
      handle.db.insert(schema.cards).values({ id: uuidv7(), ...card }),
    ).rejects.toThrow()
  })

  test('取り込み元IDがなければ同じ内容を複数入れられる', async () => {
    const principalId = await insertGuestPrincipal()
    const deckId = await insertDeck(principalId)
    const card = { deckId, front: '表', back: '裏', contentHash: 'hash' }

    await handle.db.insert(schema.cards).values({ id: uuidv7(), ...card })
    await handle.db.insert(schema.cards).values({ id: uuidv7(), ...card })

    const rows = await handle.db.select().from(schema.cards)
    expect(rows).toHaveLength(2)
  })

  test('未知のカード状態を拒否する', async () => {
    const principalId = await insertGuestPrincipal()
    const deckId = await insertDeck(principalId)

    await expect(
      handle.db.execute(
        `insert into cards (id, deck_id, front, back, content_hash, status)
         values ('${uuidv7()}', '${deckId}', '表', '裏', 'hash', 'archived')`,
      ),
    ).rejects.toThrow()
  })

  test('principalを消すとデッキとカードも消える', async () => {
    const principalId = await insertGuestPrincipal()
    const deckId = await insertDeck(principalId)
    await handle.db.insert(schema.cards).values({
      id: uuidv7(),
      deckId,
      front: '表',
      back: '裏',
      contentHash: 'hash',
    })

    await handle.db.delete(schema.principals)

    expect(await handle.db.select().from(schema.decks)).toHaveLength(0)
    expect(await handle.db.select().from(schema.cards)).toHaveLength(0)
  })
})

describe('study schema', () => {
  let handle: TestDatabaseHandle

  beforeAll(async () => {
    handle = await createTestDatabase()
  })

  afterAll(async () => {
    if (handle !== undefined) {
      await handle.close()
    }
  })

  beforeEach(async () => {
    await resetIdentityTables(handle)
  })

  async function insertCard(): Promise<{
    principalId: string
    cardId: string
  }> {
    const principalId = uuidv7()
    await handle.db
      .insert(schema.principals)
      .values({ id: principalId, kind: 'guest' })

    const deckId = uuidv7()
    await handle.db.insert(schema.decks).values({
      id: deckId,
      principalId,
      name: '英単語',
      normalizedName: '英単語',
    })

    const cardId = uuidv7()
    await handle.db.insert(schema.cards).values({
      id: cardId,
      deckId,
      front: '表',
      back: '裏',
      contentHash: 'hash',
    })

    return { principalId, cardId }
  }

  function schedule(cardId: string) {
    return {
      cardId,
      dueAt: new Date(),
      stability: 1,
      difficulty: 5,
      schedulerVersion: 'ts-fsrs@5.4.1/fsrs-6',
      requestRetention: 0.9,
    }
  }

  test('希望保持率が範囲外なら拒否する', async () => {
    const { cardId } = await insertCard()

    await expect(
      handle.db
        .insert(schema.cardSchedules)
        .values({ ...schedule(cardId), requestRetention: 0.99 }),
    ).rejects.toThrow()
  })

  test('全デッキ学習で対象デッキを持てない', async () => {
    const { principalId } = await insertCard()

    await expect(
      handle.db.insert(schema.studySessions).values({
        id: uuidv7(),
        principalId,
        mode: 'all',
        deckIds: ['019fd000-0000-7000-8000-000000000001'],
        learningDay: '2026-08-21',
      }),
    ).rejects.toThrow()
  })

  test('同じprincipalで冪等キーを重複させられない', async () => {
    const { principalId, cardId } = await insertCard()
    await handle.db.insert(schema.cardSchedules).values(schedule(cardId))

    const sessionId = uuidv7()
    await handle.db.insert(schema.studySessions).values({
      id: sessionId,
      principalId,
      mode: 'all',
      learningDay: '2026-08-21',
    })

    const idempotencyKey = uuidv7()
    const event = {
      principalId,
      cardId,
      sessionId,
      rating: 3,
      beforeSnapshot: {},
      afterSnapshot: {},
      reviewedAt: new Date(),
      learningDay: '2026-08-21',
      idempotencyKey,
    }

    await handle.db
      .insert(schema.reviewEvents)
      .values({ id: uuidv7(), ...event })

    await expect(
      handle.db.insert(schema.reviewEvents).values({ id: uuidv7(), ...event }),
    ).rejects.toThrow()
  })

  test('範囲外の評価を拒否する', async () => {
    const { principalId, cardId } = await insertCard()
    await handle.db.insert(schema.cardSchedules).values(schedule(cardId))

    const sessionId = uuidv7()
    await handle.db.insert(schema.studySessions).values({
      id: sessionId,
      principalId,
      mode: 'all',
      learningDay: '2026-08-21',
    })

    await expect(
      handle.db.insert(schema.reviewEvents).values({
        id: uuidv7(),
        principalId,
        cardId,
        sessionId,
        rating: 5,
        beforeSnapshot: {},
        afterSnapshot: {},
        reviewedAt: new Date(),
        learningDay: '2026-08-21',
        idempotencyKey: uuidv7(),
      }),
    ).rejects.toThrow()
  })
})
