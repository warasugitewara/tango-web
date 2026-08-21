import { createHash } from 'node:crypto'
import { v7 as uuidv7 } from 'uuid'
import type { Database } from '../client'
import { cards, decks } from '../schema/content'

export const DEMO_DECK_SEED_KEY = 'romaji-gojuon-v1'

const DEMO_DECK_NAME = 'デモ'
const DEMO_DECK_DESCRIPTION =
  'ローマ字とひらがなの練習用です。不要になったら削除できます。'

const DEMO_CARD_PAIRS = [
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
] as const

function hashDemoCard(front: string, back: string): string {
  const normalized = `${front.normalize('NFC')}\0${back.normalize('NFC')}`
  return createHash('sha256').update(normalized, 'utf8').digest('hex')
}

/**
 * principalごとにデモを一度だけ作る。
 * 論理削除済みの行も一意制約に残るため、削除後に復活しない。
 */
export async function ensureDemoDeck(
  db: Database,
  principalId: string,
  now: Date,
): Promise<void> {
  await db.transaction(async (tx) => {
    const deckId = uuidv7()
    const [created] = await tx
      .insert(decks)
      .values({
        id: deckId,
        principalId,
        name: DEMO_DECK_NAME,
        normalizedName: DEMO_DECK_NAME,
        description: DEMO_DECK_DESCRIPTION,
        seedKey: DEMO_DECK_SEED_KEY,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing()
      .returning({ id: decks.id })

    if (created === undefined) {
      return
    }

    await tx.insert(cards).values(
      DEMO_CARD_PAIRS.map(([front, back]) => ({
        id: uuidv7(),
        deckId,
        front,
        back,
        contentHash: hashDemoCard(front, back),
        createdAt: now,
        updatedAt: now,
      })),
    )
  })
}
