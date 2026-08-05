/** ログに載せる例外クラス名の最大長。 */
const MAX_ERROR_NAME_LENGTH = 64

/**
 * 例外の種類だけを取り出す。メッセージは決して読まない。
 * 例外メッセージにはSQL文・接続URL・token・カード内容が入り得るため、
 * 分類に使える名前だけを、記号を含まない形に限って取り出す。
 */
export function toSafeErrorName(error: unknown): string {
  if (!(error instanceof Error)) {
    return typeof error
  }

  return /^[\w$.]+$/.test(error.name)
    ? error.name.slice(0, MAX_ERROR_NAME_LENGTH)
    : 'Error'
}
