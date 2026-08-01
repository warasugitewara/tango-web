import { AppError, toApiErrorEnvelope } from '@tango/shared'
import type { Context, ErrorHandler } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import type { AppEnv } from './request-context'

/**
 * 例外を共通エンベロープへ写像する。
 * 内部診断はサーバログにのみ残し、Cookieやリクエストボディは決して記録しない。
 */
export function errorHandler(): ErrorHandler<AppEnv> {
  return (error, context: Context<AppEnv>) => {
    const requestId = context.get('requestId') ?? ''
    const envelope = toApiErrorEnvelope(error, requestId)
    const status =
      error instanceof AppError
        ? error.status
        : /* 想定外の例外はすべて500へ倒す */ 500

    console.error(
      JSON.stringify({
        level: 'error',
        requestId,
        code: envelope.error.code,
        method: context.req.method,
        path: context.req.path,
        stack: error instanceof Error ? error.stack : undefined,
      }),
    )

    return context.json(envelope, status as ContentfulStatusCode)
  }
}
