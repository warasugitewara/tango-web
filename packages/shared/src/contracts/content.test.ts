import { describe, expect, test } from 'vitest'
import {
  cardContentSchema,
  deckCreateSchema,
  deckUpdateSchema,
  importRequestSchema,
} from './content'

describe('deckCreateSchema', () => {
  test('名前だけを与えても受け付ける', () => {
    expect(deckCreateSchema.parse({ name: '英単語' })).toEqual({
      name: '英単語',
    })
  })

  test('前後の空白を落とす', () => {
    expect(deckCreateSchema.parse({ name: '  英単語  ' }).name).toBe('英単語')
  })

  test('空の名前を拒否する', () => {
    expect(deckCreateSchema.safeParse({ name: '' }).success).toBe(false)
  })

  test('空白だけの名前を拒否する', () => {
    expect(deckCreateSchema.safeParse({ name: '   ' }).success).toBe(false)
  })

  test('100文字を超える名前を拒否する', () => {
    expect(deckCreateSchema.safeParse({ name: 'あ'.repeat(101) }).success).toBe(
      false,
    )
  })

  test('未知のキーを拒否する', () => {
    expect(
      deckCreateSchema.safeParse({ name: '英単語', owner: 'x' }).success,
    ).toBe(false)
  })

  test('新規カード上限に負の値を許さない', () => {
    expect(
      deckCreateSchema.safeParse({ name: '英単語', newCardLimit: -1 }).success,
    ).toBe(false)
  })
})

describe('deckUpdateSchema', () => {
  test('空のオブジェクトを受け付ける', () => {
    expect(deckUpdateSchema.parse({})).toEqual({})
  })

  test('未知のキーを拒否する', () => {
    expect(deckUpdateSchema.safeParse({ principalId: 'x' }).success).toBe(false)
  })
})

describe('cardContentSchema', () => {
  test('frontとbackを受け付ける', () => {
    expect(cardContentSchema.parse({ front: '表', back: '裏' }).front).toBe(
      '表',
    )
  })

  test('空のbackを拒否する', () => {
    expect(cardContentSchema.safeParse({ front: '表', back: '' }).success).toBe(
      false,
    )
  })

  test('20000文字ちょうどは受け付ける', () => {
    const atLimit = { front: 'あ'.repeat(20_000), back: '裏' }
    expect(cardContentSchema.safeParse(atLimit).success).toBe(true)
  })

  test('20000文字を超える本文を拒否する', () => {
    const tooLong = { front: 'あ'.repeat(20_001), back: '裏' }
    expect(cardContentSchema.safeParse(tooLong).success).toBe(false)
  })

  test.each([
    ['scriptタグ', '<script>alert(1)</script>'],
    ['imgタグ', '<img src=x onerror=alert(1)>'],
    ['閉じタグ', '</p>'],
    ['コメント', '<!-- comment -->'],
  ] satisfies ReadonlyArray<readonly [string, string]>)(
    '%sを含む本文を拒否する',
    (_caseName, front) => {
      expect(cardContentSchema.safeParse({ front, back: '裏' }).success).toBe(
        false,
      )
    },
  )

  test('不等号そのものは使える', () => {
    // 数式や比較を書けなくならないようにする。
    const mathLike = { front: '1 < 2 かつ 3 > 2', back: '正しい' }
    expect(cardContentSchema.safeParse(mathLike).success).toBe(true)
  })
})

describe('importRequestSchema', () => {
  test('jsonとcsvを受け付ける', () => {
    expect(
      importRequestSchema.parse({ format: 'json', payload: '{}' }).format,
    ).toBe('json')
    expect(
      importRequestSchema.parse({ format: 'csv', payload: 'a' }).format,
    ).toBe('csv')
  })

  test('未知の形式を拒否する', () => {
    expect(
      importRequestSchema.safeParse({ format: 'apkg', payload: 'a' }).success,
    ).toBe(false)
  })

  test('空の本文を拒否する', () => {
    expect(
      importRequestSchema.safeParse({ format: 'json', payload: '' }).success,
    ).toBe(false)
  })
})
