import { AppError, toApiErrorEnvelope, toSafeErrorName } from '@tango/shared'
import type { Context, ErrorHandler } from 'hono'
import { HTTPException } from 'hono/http-exception'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { v7 as uuidv7 } from 'uuid'
import type { AppEnv } from './request-context'

/** cause連鎖をたどる深さの上限。連鎖が循環していても必ず止まる。 */
const MAX_CAUSE_DEPTH = 5

/** ログに載せる呼び出し位置の最大数。 */
const MAX_STACK_FRAMES = 10

/**
 * V8形式の呼び出し位置に一致させる。
 * `at ...:行:桁` の形だけを受け入れ、例外メッセージの行を弾く。
 */
const STACK_FRAME_PATTERN = /^at\s.*:\d+:\d+\)?$/

/** cause連鎖を種類名だけの配列にする。メッセージは取り出さない。 */
function toSafeCauseNames(error: unknown): string[] {
  const names: string[] = []
  let current: unknown = error instanceof Error ? error.cause : undefined

  for (
    let depth = 0;
    depth < MAX_CAUSE_DEPTH && current !== undefined && current !== null;
    depth += 1
  ) {
    names.push(toSafeErrorName(current))
    current = current instanceof Error ? current.cause : undefined
  }

  return names
}

/**
 * スタックから呼び出し位置だけを取り出す。
 * スタックの先頭には `名前: メッセージ` がそのまま入るため、
 * メッセージの行数分を必ず読み飛ばしてから収集する。
 * 加えて呼び出し位置の形をしていない行に当たった時点で打ち切り、
 * 複数行メッセージが紛れ込む余地をなくす。
 */
function toSafeStackFrames(error: unknown): string[] {
  if (!(error instanceof Error) || typeof error.stack !== 'string') {
    return []
  }

  const messageLineCount = error.message.split('\n').length
  const frames: string[] = []

  for (const line of error.stack.split('\n').slice(messageLineCount)) {
    const trimmed = line.trim()

    if (trimmed === '') {
      continue
    }

    if (!STACK_FRAME_PATTERN.test(trimmed)) {
      break
    }

    frames.push(trimmed)

    if (frames.length >= MAX_STACK_FRAMES) {
      break
    }
  }

  return frames
}

/**
 * Honoが投げるHTTPExceptionのうち、送信内容の不備によるものを揃える。
 * `hono/validator` は壊れたJSONをHTTPException(400)にするため、
 * そのままでは想定外の例外として500へ倒れ、利用者に原因が伝わらない。
 * 元の例外はcauseとして内部に残し、公開する文言は日本語の定型にする。
 */
function normalizeError(error: unknown): unknown {
  if (!(error instanceof HTTPException) || error.status !== 400) {
    return error
  }

  return new AppError('VALIDATION_FAILED', {
    publicMessage:
      'リクエストの本文を解釈できませんでした。JSON形式で送信してください。',
    cause: error,
  })
}

/**
 * 例外を共通エンベロープへ写像する。
 * サーバログには分類・内部エラーID・サニタイズ済みの呼び出し位置だけを残す。
 * 例外メッセージ、Cookie、リクエストボディ、接続URL、カード内容は
 * どの経路からもログへ出さない。
 */
export function errorHandler(): ErrorHandler<AppEnv> {
  return (rawError, context: Context<AppEnv>) => {
    const error = normalizeError(rawError)
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
        // 同じリクエスト内で複数回失敗しても個別に追える内部識別子。
        errorId: uuidv7(),
        code: envelope.error.code,
        status,
        method: context.req.method,
        path: context.req.path,
        errorName: toSafeErrorName(error),
        causes: toSafeCauseNames(error),
        frames: toSafeStackFrames(error),
      }),
    )

    return context.json(envelope, status as ContentfulStatusCode)
  }
}
