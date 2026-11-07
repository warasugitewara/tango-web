import { describe, expect, test } from 'vitest'
import { intervalLabel, toDateLabel, toDateTimeLabel } from './format'

const NOW = Date.parse('2026-08-21T17:00:00+09:00')

describe('intervalLabel', () => {
  test('1日未満は期限との差を分で出す', () => {
    expect(
      intervalLabel(
        { dueAt: '2026-08-21T17:10:00+09:00', scheduledDays: 0 },
        NOW,
      ),
    ).toBe('10分後')
  })

  test('1時間以上1日未満は時間で出す', () => {
    expect(
      intervalLabel(
        { dueAt: '2026-08-21T20:00:00+09:00', scheduledDays: 0 },
        NOW,
      ),
    ).toBe('3時間後')
  })

  test('期限を過ぎていても負の値は出さない', () => {
    // 端末の時計がサーバより進んでいると差が負になる。
    expect(
      intervalLabel(
        { dueAt: '2026-08-21T16:59:00+09:00', scheduledDays: 0 },
        NOW,
      ),
    ).toBe('1分以内')
  })

  test('1日以上は日数で出す', () => {
    expect(
      intervalLabel(
        { dueAt: '2026-08-28T17:00:00+09:00', scheduledDays: 7 },
        NOW,
      ),
    ).toBe('7日後')
  })

  test('30日以上は月、365日以上は年で出す', () => {
    expect(intervalLabel({ dueAt: '', scheduledDays: 45 }, NOW)).toBe(
      '1.5か月後',
    )
    expect(intervalLabel({ dueAt: '', scheduledDays: 60 }, NOW)).toBe('2か月後')
    expect(intervalLabel({ dueAt: '', scheduledDays: 730 }, NOW)).toBe('2年後')
  })

  test('期限を読めなければ今日中と出す', () => {
    expect(intervalLabel({ dueAt: 'invalid', scheduledDays: 0 }, NOW)).toBe(
      '今日中',
    )
  })
})

test('日時と日付の表記', () => {
  expect(toDateTimeLabel('2026-08-22T12:00:00+09:00')).toBe('2026-08-22 12:00')
  expect(toDateLabel('2026-08-22T12:00:00+09:00')).toBe('2026-08-22')
})
