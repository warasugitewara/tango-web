import { AppError } from '@tango/shared'
import type { MiddlewareHandler } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import type { AppEnv } from './request-context'

/**
 * 取り込み以外のリクエストボディの上限。
 * カード1枚の本文は最大20,000文字で、余裕を見て1MiBとする。
 */
export const GENERIC_BODY_LIMIT_BYTES = 1024 * 1024

/**
 * 一括取り込みのボディ上限。
 * 契約は payload を1,000,000文字まで許す。日本語のような多バイト文字だと
 * 1文字3バイトになるため、1MiBでは契約上妥当な入力を弾いてしまう。
 */
export const IMPORT_BODY_LIMIT_BYTES = 10 * 1024 * 1024

/** 一括取り込みの経路。ここだけ上限を引き上げる。 */
const IMPORT_PATH_PATTERN = /^\/api\/decks\/[^/]+\/import$/

/** ボディを伴い得るメソッド。これ以外は素通しする。 */
const BODY_METHODS: ReadonlySet<string> = new Set(['POST', 'PUT', 'PATCH'])

/**
 * JSONとして受け付けるContent-Type。
 * `hono/validator` が `json` として扱う条件と同じ形にそろえてある。
 * ここを緩めると、検証器がボディを読まないまま空オブジェクトとして
 * 進んでしまい、原因の分からない検証エラーになる。
 */
const JSON_CONTENT_TYPE_PATTERN =
  /^application\/([a-z-.]+\+)?json(;\s*[a-zA-Z0-9-]+=([^;]+))*$/i

/**
 * ボディ付きリクエストの入口をそろえる。
 * Content-Type違反と過大なボディを、500ではなく
 * 日本語の `VALIDATION_FAILED` として返す。
 */
function createLimit(maxSize: number) {
  return bodyLimit({
    maxSize,
    onError: () => {
      throw new AppError('VALIDATION_FAILED', {
        publicMessage: `リクエストの内容が大きすぎます。${Math.floor(maxSize / (1024 * 1024))}MB以下にしてください。`,
      })
    },
  })
}

export function jsonBodyGuard(): MiddlewareHandler<AppEnv> {
  const genericLimit = createLimit(GENERIC_BODY_LIMIT_BYTES)
  const importLimit = createLimit(IMPORT_BODY_LIMIT_BYTES)

  return async (context, next) => {
    if (!BODY_METHODS.has(context.req.method)) {
      return next()
    }

    // 本文を伴わない操作にJSONのContent-Typeを要求しない。
    // 復元のような操作へ、意味のない空JSONを送らせないため。
    if (context.req.raw.body === null) {
      return next()
    }

    const contentType = context.req.header('Content-Type')

    if (
      contentType === undefined ||
      !JSON_CONTENT_TYPE_PATTERN.test(contentType)
    ) {
      throw new AppError('VALIDATION_FAILED', {
        publicMessage:
          'リクエストの形式が不正です。Content-Type に application/json を指定してください。',
      })
    }

    const limit = IMPORT_PATH_PATTERN.test(context.req.path)
      ? importLimit
      : genericLimit

    return limit(context, next)
  }
}
