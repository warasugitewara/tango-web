import { Temporal } from '@js-temporal/polyfill'
import { describe, expect, test } from 'vitest'
import { AppError } from '../errors/app-error'
import { formatJst, learningDayOf, parseJstInstant } from './learning-day'

describe('learningDayOf', () => {
  test.each([
    ['2026-08-01T03:59:59+09:00', '2026-07-31'],
    ['2026-08-01T04:00:00+09:00', '2026-08-01'],
    ['2027-01-01T03:59:59+09:00', '2026-12-31'],
  ])('%s は学習日 %s に属する', (input, expected) => {
    expect(learningDayOf(Temporal.Instant.from(input))).toBe(expected)
  })

  test('UTC入力でもAsia/Tokyoの04:00境界で判定する', () => {
    // 2026-08-01T18:59:59Z は 2026-08-02T03:59:59+09:00
    expect(learningDayOf(Temporal.Instant.from('2026-08-01T18:59:59Z'))).toBe(
      '2026-08-01',
    )
    expect(learningDayOf(Temporal.Instant.from('2026-08-01T19:00:00Z'))).toBe(
      '2026-08-02',
    )
  })
})

describe('formatJst', () => {
  test('明示的な+09:00オフセット付きで整形する', () => {
    expect(formatJst(Temporal.Instant.from('2026-08-01T03:30:00Z'))).toBe(
      '2026-08-01T12:30:00+09:00',
    )
  })
})

describe('parseJstInstant', () => {
  test('+09:00 を明示した文字列を受け付ける', () => {
    expect(parseJstInstant('2026-08-01T12:30:00+09:00').epochMilliseconds).toBe(
      Temporal.Instant.from('2026-08-01T03:30:00Z').epochMilliseconds,
    )
  })

  test.each([
    '2026-08-01T03:30:00Z',
    '2026-08-01T12:30:00',
    '2026-08-01T12:30:00+00:00',
    '2026-08-01T12:30:00+0900',
  ])('%s は+09:00の明示が無いため拒否する', (value) => {
    expect(() => parseJstInstant(value)).toThrow(AppError)
  })

  test('拒否理由はVALIDATION_FAILEDで返す', () => {
    try {
      parseJstInstant('2026-08-01T03:30:00Z')
      expect.unreachable('例外が発生しませんでした')
    } catch (error) {
      expect(error).toBeInstanceOf(AppError)
      expect((error as AppError).code).toBe('VALIDATION_FAILED')
    }
  })
})
