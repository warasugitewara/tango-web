import { v7 as uuidv7 } from 'uuid'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import * as schema from '../schema'
import type { TestDatabaseHandle } from '../test/database'
import { createTestDatabase, resetIdentityTables } from '../test/database'
import type { ContentRepository } from './content-repository'
import { createContentRepository } from './content-repository'

describe('ContentRepository', () => {
  let handle: TestDatabaseHandle
  let repository: ContentRepository
  const now = new Date('2026-08-21T03:00:00Z')

  beforeAll(async () => {
    handle = await createTestDatabase()
    repository = createContentRepository(handle.db)
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

  describe('デッキ', () => {
    test('デモデッキを五十音46枚で一度だけ作成する', async () => {
      const owner = await insertGuestPrincipal()
      const expectedPairs = [
        ['a', 'あ'],
        ['i', 'い'],
        ['u', 'う'],
        ['e', 'え'],
        ['o', 'お'],
        ['ka', 'か'],
        ['ki', 'き'],
        ['ku', 'く'],
        ['ke', 'け'],
        ['ko', 'こ'],
        ['sa', 'さ'],
        ['shi', 'し'],
        ['su', 'す'],
        ['se', 'せ'],
        ['so', 'そ'],
        ['ta', 'た'],
        ['chi', 'ち'],
        ['tsu', 'つ'],
        ['te', 'て'],
        ['to', 'と'],
        ['na', 'な'],
        ['ni', 'に'],
        ['nu', 'ぬ'],
        ['ne', 'ね'],
        ['no', 'の'],
        ['ha', 'は'],
        ['hi', 'ひ'],
        ['fu', 'ふ'],
        ['he', 'へ'],
        ['ho', 'ほ'],
        ['ma', 'ま'],
        ['mi', 'み'],
        ['mu', 'む'],
        ['me', 'め'],
        ['mo', 'も'],
        ['ya', 'や'],
        ['yu', 'ゆ'],
        ['yo', 'よ'],
        ['ra', 'ら'],
        ['ri', 'り'],
        ['ru', 'る'],
        ['re', 'れ'],
        ['ro', 'ろ'],
        ['wa', 'わ'],
        ['wo', 'を'],
        ['n', 'ん'],
      ]

      await repository.ensureDemoDeck(owner, now)
      await repository.ensureDemoDeck(owner, now)

      const [demo] = await repository.listDecks(owner)
      expect(demo).toMatchObject({
        name: 'デモ',
        cardCount: 46,
        newCardLimit: 20,
      })
      expect(demo?.description).toContain('ローマ字')
      expect(demo).toBeDefined()
      if (demo === undefined) {
        return
      }

      const demoCards = await repository.listCards(owner, demo.id, 100, 0)
      expect(demoCards.map(({ front, back }) => [front, back])).toEqual(
        expectedPairs,
      )
    })

    test('削除したデモデッキを再作成しない', async () => {
      const owner = await insertGuestPrincipal()
      await repository.ensureDemoDeck(owner, now)
      const [demo] = await repository.listDecks(owner)

      expect(demo).toBeDefined()
      if (demo === undefined) {
        return
      }
      expect(await repository.trashDeck(owner, demo.id, now)).toBe(true)

      await repository.ensureDemoDeck(owner, now)

      expect(await repository.listDecks(owner)).toHaveLength(0)
      expect(await handle.db.select().from(schema.decks)).toHaveLength(1)
      expect(await handle.db.select().from(schema.cards)).toHaveLength(46)
    })

    test('作成したデッキを一覧で返す', async () => {
      const owner = await insertGuestPrincipal()
      const deck = await repository.createDeck(owner, { name: '英単語' }, now)

      const decks = await repository.listDecks(owner)

      expect(decks).toHaveLength(1)
      expect(decks[0]?.id).toBe(deck.id)
      expect(decks[0]?.newCardLimit).toBe(20)
      expect(decks[0]?.cardCount).toBe(0)
    })

    test('他人のデッキは一覧に出ない', async () => {
      const owner = await insertGuestPrincipal()
      const other = await insertGuestPrincipal()
      await repository.createDeck(owner, { name: '英単語' }, now)

      expect(await repository.listDecks(other)).toHaveLength(0)
    })

    test('他人のデッキは更新も削除もできない', async () => {
      const owner = await insertGuestPrincipal()
      const other = await insertGuestPrincipal()
      const deck = await repository.createDeck(owner, { name: '英単語' }, now)

      expect(
        await repository.updateDeck(other, deck.id, { name: '乗っ取り' }, now),
      ).toBeNull()
      expect(await repository.trashDeck(other, deck.id, now)).toBe(false)

      const [stored] = await repository.listDecks(owner)
      expect(stored?.name).toBe('英単語')
    })

    test('論理削除したデッキは一覧から消えるが行は残る', async () => {
      const owner = await insertGuestPrincipal()
      const deck = await repository.createDeck(owner, { name: '英単語' }, now)

      expect(await repository.trashDeck(owner, deck.id, now)).toBe(true)
      expect(await repository.listDecks(owner)).toHaveLength(0)

      const rows = await handle.db.select().from(schema.decks)
      expect(rows).toHaveLength(1)
      expect(rows[0]?.trashedAt).not.toBeNull()
    })

    test('削除済みのデッキは二度目の削除で偽を返す', async () => {
      const owner = await insertGuestPrincipal()
      const deck = await repository.createDeck(owner, { name: '英単語' }, now)

      expect(await repository.trashDeck(owner, deck.id, now)).toBe(true)
      expect(await repository.trashDeck(owner, deck.id, now)).toBe(false)
    })

    test('名前の正規化キーを保存する', async () => {
      const owner = await insertGuestPrincipal()
      await repository.createDeck(owner, { name: '  English Words  ' }, now)

      const [row] = await handle.db.select().from(schema.decks)
      expect(row?.name).toBe('English Words')
      expect(row?.normalizedName).toBe('english words')
    })

    test('カード枚数は論理削除済みを数えない', async () => {
      const owner = await insertGuestPrincipal()
      const deck = await repository.createDeck(owner, { name: '英単語' }, now)
      const card = await repository.createCard(
        owner,
        deck.id,
        { front: '表', back: '裏' },
        now,
      )
      await repository.createCard(
        owner,
        deck.id,
        { front: '表2', back: '裏2' },
        now,
      )

      expect(card).not.toBeNull()
      if (card !== null) {
        await repository.trashCard(owner, card.id, now)
      }

      const [summary] = await repository.listDecks(owner)
      expect(summary?.cardCount).toBe(1)
    })
  })

  describe('カード', () => {
    test('他人のデッキへカードを作れない', async () => {
      const owner = await insertGuestPrincipal()
      const other = await insertGuestPrincipal()
      const deck = await repository.createDeck(owner, { name: '英単語' }, now)

      expect(
        await repository.createCard(
          other,
          deck.id,
          { front: '表', back: '裏' },
          now,
        ),
      ).toBeNull()
      expect(await handle.db.select().from(schema.cards)).toHaveLength(0)
    })

    test('削除済みデッキへカードを作れない', async () => {
      const owner = await insertGuestPrincipal()
      const deck = await repository.createDeck(owner, { name: '英単語' }, now)
      await repository.trashDeck(owner, deck.id, now)

      expect(
        await repository.createCard(
          owner,
          deck.id,
          { front: '表', back: '裏' },
          now,
        ),
      ).toBeNull()
    })

    test('他人のカードは更新も削除もできない', async () => {
      const owner = await insertGuestPrincipal()
      const other = await insertGuestPrincipal()
      const deck = await repository.createDeck(owner, { name: '英単語' }, now)
      const card = await repository.createCard(
        owner,
        deck.id,
        { front: '表', back: '裏' },
        now,
      )

      expect(card).not.toBeNull()
      if (card === null) {
        return
      }

      expect(
        await repository.updateCard(
          other,
          card.id,
          { front: 'x', back: 'y' },
          now,
        ),
      ).toBeNull()
      expect(await repository.trashCard(other, card.id, now)).toBe(false)

      const [stored] = await handle.db.select().from(schema.cards)
      expect(stored?.front).toBe('表')
      expect(stored?.trashedAt).toBeNull()
    })

    test('一覧は削除済みを除き作成順に返す', async () => {
      const owner = await insertGuestPrincipal()
      const deck = await repository.createDeck(owner, { name: '英単語' }, now)
      const first = await repository.createCard(
        owner,
        deck.id,
        { front: '1', back: 'a' },
        now,
      )
      await repository.createCard(
        owner,
        deck.id,
        { front: '2', back: 'b' },
        now,
      )
      await repository.createCard(
        owner,
        deck.id,
        { front: '3', back: 'c' },
        now,
      )

      expect(first).not.toBeNull()
      if (first !== null) {
        await repository.trashCard(owner, first.id, now)
      }

      const cards = await repository.listCards(owner, deck.id, 10, 0)
      expect(cards.map((card) => card.front)).toEqual(['2', '3'])
    })

    test('他人のデッキのカード一覧は空になる', async () => {
      const owner = await insertGuestPrincipal()
      const other = await insertGuestPrincipal()
      const deck = await repository.createDeck(owner, { name: '英単語' }, now)
      await repository.createCard(
        owner,
        deck.id,
        { front: '表', back: '裏' },
        now,
      )

      expect(await repository.listCards(other, deck.id, 10, 0)).toHaveLength(0)
    })

    test('内容が同じカードは同じcontent hashになる', async () => {
      const owner = await insertGuestPrincipal()
      const deck = await repository.createDeck(owner, { name: '英単語' }, now)

      const first = await repository.createCard(
        owner,
        deck.id,
        { front: '表', back: '裏' },
        now,
      )
      const second = await repository.createCard(
        owner,
        deck.id,
        { front: '表', back: '裏' },
        now,
      )

      expect(first?.contentHash).toBe(second?.contentHash)
      expect(first?.contentHash).toHaveLength(64)
    })

    test('一括作成は所有者を確認してから全件入れる', async () => {
      const owner = await insertGuestPrincipal()
      const other = await insertGuestPrincipal()
      const deck = await repository.createDeck(owner, { name: '英単語' }, now)

      const created = await repository.createCards(
        owner,
        deck.id,
        [
          { front: '1', back: 'a' },
          { front: '2', back: 'b' },
        ],
        now,
      )
      expect(created).toBe(2)

      const rejected = await repository.createCards(
        other,
        deck.id,
        [{ front: '3', back: 'c' }],
        now,
      )
      expect(rejected).toBe(0)
      expect(await handle.db.select().from(schema.cards)).toHaveLength(2)
    })

    test('一括作成で空配列を渡しても失敗しない', async () => {
      const owner = await insertGuestPrincipal()
      const deck = await repository.createDeck(owner, { name: '英単語' }, now)

      expect(await repository.createCards(owner, deck.id, [], now)).toBe(0)
    })
  })
})
