/** `2026-08-22T12:00:00+09:00` を `2026-08-22 12:00` にする。 */
export function toDateTimeLabel(isoWithOffset: string): string {
  return isoWithOffset.slice(0, 16).replace('T', ' ')
}

/** 日付だけを見せる。時刻まで出しても判断の役に立たない場面で使う。 */
export function toDateLabel(isoWithOffset: string): string {
  return isoWithOffset.slice(0, 10)
}

/** 小数1桁へ丸め、`.0` は落とす。`1.5` はそのまま、`2.0` は `2` にする。 */
function oneDecimal(value: number): string {
  return String(Math.round(value * 10) / 10)
}

const MINUTE_MS = 60_000

/**
 * 評価ボタンに添える「次はいつ出るか」。
 *
 * 学習中のカードは `scheduledDays` が 0 のまま数分後に戻ってくる。
 * 日数だけを出すと「もう一度」が軒並み「0日後」になり、
 * 押すと何が起きるかが読めない。1日未満は期限との差から分・時間で出す。
 */
export function intervalLabel(
  preview: { dueAt: string; scheduledDays: number },
  nowMs: number = Date.now(),
): string {
  const days = preview.scheduledDays
  if (days >= 365) {
    return `${oneDecimal(days / 365)}年後`
  }
  if (days >= 30) {
    return `${oneDecimal(days / 30)}か月後`
  }
  if (days >= 1) {
    return `${days}日後`
  }

  const dueMs = Date.parse(preview.dueAt)
  if (Number.isNaN(dueMs)) {
    return '今日中'
  }
  const minutes = Math.round((dueMs - nowMs) / MINUTE_MS)
  if (minutes < 1) {
    return '1分以内'
  }
  if (minutes < 60) {
    return `${minutes}分後`
  }
  return `${Math.round(minutes / 60)}時間後`
}
