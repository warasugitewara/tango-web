import { AppError } from '@tango/shared'
import { describe, expect, test } from 'vitest'
import { resolveClock, toPurgeFailureLog } from './purge-expired-guests'

/** ログへ出てはならない値。実際の障害で例外メッセージに混ざり得るものを並べる。 */
const SECRET_CONNECTION_URL = 'postgres://tango:s3cret@10.0.0.5:5432/tango'
const SECRET_TOKEN = 'guest-token-abcdef0123456789'

function expectValidationError(argv: readonly string[]): void {
  try {
    resolveClock('test', argv)
    throw new Error('例外が発生しませんでした')
  } catch (error) {
    if (!(error instanceof AppError)) {
      throw error
    }
    expect(error.code).toBe('VALIDATION_FAILED')
  }
}

describe('resolveClock', () => {
  test('--nowが完全に未指定ならsystem clockを返す', () => {
    const before = Date.now()
    const resolved = resolveClock('test', []).now().epochMilliseconds
    const after = Date.now()

    expect(resolved).toBeGreaterThanOrEqual(before)
    expect(resolved).toBeLessThanOrEqual(after)
  })

  test('+09:00を明示した--nowをtest環境で受け付ける', () => {
    const clock = resolveClock('test', ['--now=2026-08-01T09:00:00+09:00'])

    expect(clock.now().toString()).toBe('2026-08-01T00:00:00Z')
  })

  test.each([
    '2026-08-01T00:00:00Z',
    '2026-08-01T09:00:00+00:00',
    '2026-08-01T09:00:00',
    '2026-08-01T25:00:00+09:00',
  ])('%sは明示的なJST instantではないため拒否する', (value) => {
    try {
      resolveClock('test', [`--now=${value}`])
      throw new Error('例外が発生しませんでした')
    } catch (error) {
      if (!(error instanceof AppError)) {
        throw error
      }
      expect(error.code).toBe('VALIDATION_FAILED')
    }
  })

  test.each([
    ['値なし', ['--now']],
    ['空値', ['--now=']],
    [
      '同じ値の重複',
      ['--now=2026-08-01T09:00:00+09:00', '--now=2026-08-01T09:00:00+09:00'],
    ],
    [
      '異なる値の重複',
      ['--now=2026-08-01T09:00:00+09:00', '--now=2026-08-02T09:00:00+09:00'],
    ],
  ] satisfies ReadonlyArray<readonly [string, readonly string[]]>)(
    '%sの--now指定を拒否する',
    (_caseName, argv) => {
      expectValidationError(argv)
    },
  )

  test.each([
    ['オプション名のtypo', ['--nwo=2026-08-01T09:00:00+09:00']],
    ['接頭辞だけ一致するオプション', ['--nowish=2026-08-01T09:00:00+09:00']],
    ['位置引数', ['unexpected']],
    ['未知のフラグ', ['--verbose']],
    ['-- 単体', ['--']],
    [
      '有効な--nowと未知引数の混在',
      ['--now=2026-08-01T09:00:00+09:00', 'unexpected'],
    ],
    [
      '未知引数が先行する有効な--now',
      ['--nwo=x', '--now=2026-08-01T09:00:00+09:00'],
    ],
  ] satisfies ReadonlyArray<readonly [string, readonly string[]]>)(
    '%sを拒否する',
    (_caseName, argv) => {
      expectValidationError(argv)
    },
  )

  test('--nowはtest環境以外ではVALIDATION_FAILEDで拒否する', () => {
    try {
      resolveClock('production', ['--now=2026-08-01T09:00:00+09:00'])
      throw new Error('例外が発生しませんでした')
    } catch (error) {
      if (!(error instanceof AppError)) {
        throw error
      }
      expect(error.code).toBe('VALIDATION_FAILED')
    }
  })
})

describe('toPurgeFailureLog', () => {
  test('接続URL・token・複数行stackを含むErrorでも安全な値だけを残す', () => {
    const cause = new Error(`token=${SECRET_TOKEN}`)
    const error = new Error(
      `接続に失敗しました\nurl=${SECRET_CONNECTION_URL}\ntoken=${SECRET_TOKEN}`,
      { cause },
    )

    const record = toPurgeFailureLog(error)
    const serialized = JSON.stringify(record)

    expect(record.job).toBe('purge-expired-guests')
    expect(record.level).toBe('error')
    expect(record.errorName).toBe('Error')
    // 内部追跡用のIDだけを出す。uuidv7の形であることまで確認する。
    expect(record.errorId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    )
    expect(Object.keys(record).sort()).toEqual([
      'errorId',
      'errorName',
      'job',
      'level',
    ])

    expect(serialized).not.toContain(SECRET_CONNECTION_URL)
    expect(serialized).not.toContain(SECRET_TOKEN)
    expect(serialized).not.toContain('s3cret')
    expect(serialized).not.toContain('接続に失敗しました')
    expect(serialized).not.toContain('at ')
  })

  test('呼び出しごとに異なるerrorIdを振る', () => {
    const first = toPurgeFailureLog(new Error('一つ目'))
    const second = toPurgeFailureLog(new Error('二つ目'))

    expect(first.errorId).not.toBe(second.errorId)
  })

  test.each([
    ['Error以外の値', SECRET_CONNECTION_URL, 'string'],
    ['undefined', undefined, 'undefined'],
    ['プレーンなオブジェクト', { url: SECRET_CONNECTION_URL }, 'object'],
  ] satisfies ReadonlyArray<readonly [string, unknown, string]>)(
    '%sは種類名だけをerrorNameにする',
    (_caseName, thrown, expected) => {
      const record = toPurgeFailureLog(thrown)

      expect(record.errorName).toBe(expected)
      expect(JSON.stringify(record)).not.toContain('s3cret')
    },
  )

  test('記号を含む例外クラス名はそのまま出さない', () => {
    const error = new Error('失敗')
    error.name = `Error: ${SECRET_CONNECTION_URL}`

    const record = toPurgeFailureLog(error)

    expect(record.errorName).toBe('Error')
    expect(JSON.stringify(record)).not.toContain('s3cret')
  })
})
