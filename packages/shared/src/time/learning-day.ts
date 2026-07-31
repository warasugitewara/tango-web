import { Temporal } from '@js-temporal/polyfill'
import { AppError } from '../errors/app-error'

/** 業務時刻は利用者設定に依存せず常にこのタイムゾーンで扱う。 */
export const PRODUCT_TIME_ZONE = 'Asia/Tokyo' as const

/** 学習日が切り替わるJSTの時刻。 */
export const LEARNING_DAY_START_HOUR = 4 as const

const JST_OFFSET_SUFFIX = /\+09:00$/

/**
 * 瞬間が属する学習日(YYYY-MM-DD)を返す。
 * 04:00 JST 未満は前日の学習日に属する。
 */
export function learningDayOf(instant: Temporal.Instant): string {
  return instant
    .toZonedDateTimeISO(PRODUCT_TIME_ZONE)
    .subtract({ hours: LEARNING_DAY_START_HOUR })
    .toPlainDate()
    .toString()
}

/** 瞬間を +09:00 オフセットを明示したISO文字列へ整形する。 */
export function formatJst(instant: Temporal.Instant): string {
  return instant
    .toZonedDateTimeISO(PRODUCT_TIME_ZONE)
    .toString({ timeZoneName: 'never' })
}

/**
 * インポート/API境界で受け取る日時文字列を解釈する。
 * オフセットの解釈揺れを防ぐため、`+09:00` の明示が無い入力は拒否する。
 */
export function parseJstInstant(value: string): Temporal.Instant {
  if (!JST_OFFSET_SUFFIX.test(value)) {
    throw new AppError('VALIDATION_FAILED', {
      publicMessage:
        '日時は +09:00 のオフセットを明示した形式で指定してください。',
    })
  }

  try {
    return Temporal.Instant.from(value)
  } catch (cause) {
    throw new AppError('VALIDATION_FAILED', {
      publicMessage: '日時の形式が正しくありません。',
      cause,
    })
  }
}
