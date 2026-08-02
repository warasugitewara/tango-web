import { AppError } from '@tango/shared'
import type { MiddlewareHandler } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import type { AppEnv } from './request-context'

/**
 * 受け付けるリクエストボディの上限。
 * Phase 1のAPIはどれも数百バイトで足りるため、余裕を見ても64KiBで十分。
 */
export const MAX_REQUEST_BODY_BYTES = 64 * 1024

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
export function jsonBodyGuard(): MiddlewareHandler<AppEnv> {
  const limit = bodyLimit({
    maxSize: MAX_REQUEST_BODY_BYTES,
    onError: () => {
      throw new AppError('VALIDATION_FAILED', {
        publicMessage: `リクエストの内容が大きすぎます。${MAX_REQUEST_BODY_BYTES / 1024}KB以下にしてください。`,
      })
    },
  })

  return async (context, next) => {
    if (!BODY_METHODS.has(context.req.method)) {
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

    return limit(context, next)
  }
}
