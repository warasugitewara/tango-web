import { createHmac } from 'node:crypto'
import type { RateLimitRepository } from '@tango/db'
import { AppError } from '@tango/shared'
import type { MiddlewareHandler } from 'hono'
import type { AppEnv } from './request-context'

/** ゲスト開始の制限枠。経路ごとに枠を分ける。 */
export const GUEST_START_BUCKET = 'guest-start'

/**
 * IPが分からない要求をまとめる指紋。
 * ヘッダが無ければ無制限、にするとそこが抜け道になる。
 */
const UNKNOWN_SOURCE = '(unknown)'

export type RateLimitOptions = {
  repository: RateLimitRepository
  bucket: string
  /** 窓の中で許す回数。これを超えた要求を拒否する。 */
  limit: number
  windowMs: number
  /**
   * 指紋を作るためのペッパー。
   * 生のIPを保存しないために使う。値そのものは記録へ出さない。
   */
  fingerprintPepper: string
  now: () => Date
}

/**
 * 送信元ごとの試行回数を窓で制限する。
 *
 * 記録に残すのはHMACだけで、IPそのものは保存しない。
 * 濫用対策の記録が個人の追跡記録に変わらないようにするため。
 */
export function rateLimit(
  options: RateLimitOptions,
): MiddlewareHandler<AppEnv> {
  const fingerprintOf = (source: string): string =>
    createHmac('sha256', options.fingerprintPepper).update(source).digest('hex')

  return async (context, next) => {
    const source = context.req.header('cf-connecting-ip') ?? UNKNOWN_SOURCE
    const fingerprint = fingerprintOf(source)
    const now = options.now()
    const since = new Date(now.getTime() - options.windowMs)

    const used = await options.repository.countSince(
      options.bucket,
      fingerprint,
      since,
    )

    if (used >= options.limit) {
      // 拒否のたびに数えると窓が永久に空かなくなる。記録は増やさない。
      throw new AppError('RATE_LIMITED')
    }

    await options.repository.record(options.bucket, fingerprint, now)

    return next()
  }
}
