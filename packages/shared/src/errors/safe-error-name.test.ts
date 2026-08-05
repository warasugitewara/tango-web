import { describe, expect, test } from 'vitest'
import { toSafeErrorName } from './safe-error-name'

/** ログへ出てはならない値。実際の障害で例外メッセージに混ざり得るものを並べる。 */
const SECRET_MESSAGE = 'postgres://tango:s3cret@10.0.0.5:5432/tango'

describe('toSafeErrorName', () => {
  test('通常のErrorはクラス名を返す', () => {
    expect(toSafeErrorName(new Error('失敗'))).toBe('Error')
    expect(toSafeErrorName(new TypeError('失敗'))).toBe('TypeError')
  })

  test('nameに自由文が入っている場合はErrorへフォールバックする', () => {
    const error = new Error('失敗')
    error.name = `Error: ${SECRET_MESSAGE}`

    expect(toSafeErrorName(error)).toBe('Error')
  })

  test('64文字を超える名前は切り詰める', () => {
    const error = new Error('失敗')
    error.name = 'A'.repeat(100)

    const result = toSafeErrorName(error)

    expect(result).toBe('A'.repeat(64))
    expect(result).toHaveLength(64)
  })

  test.each([
    ['文字列', SECRET_MESSAGE, 'string'],
    ['数値', 42, 'number'],
    ['null', null, 'object'],
    ['undefined', undefined, 'undefined'],
    ['プレーンなオブジェクト', { url: SECRET_MESSAGE }, 'object'],
  ] satisfies ReadonlyArray<readonly [string, unknown, string]>)(
    'Errorでない値(%s)はtypeofを返す',
    (_caseName, thrown, expected) => {
      expect(toSafeErrorName(thrown)).toBe(expected)
    },
  )

  test('例外メッセージ・stackは戻り値へ一切現れない', () => {
    const cause = new Error(`token=${SECRET_MESSAGE}`)
    const error = new Error(`接続に失敗しました\nurl=${SECRET_MESSAGE}`, {
      cause,
    })

    const result = toSafeErrorName(error)

    expect(result).toBe('Error')
    expect(result).not.toContain('s3cret')
    expect(result).not.toContain('接続に失敗しました')
    expect(result).not.toContain('at ')
  })
})
