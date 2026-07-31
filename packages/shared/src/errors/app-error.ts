/**
 * アプリケーション全体で安定させるエラーコード。
 * Phase 2以降で追加・削除する場合は実装計画のライフサイクル定義に従う。
 */
export type AppErrorCode =
  | 'VALIDATION_FAILED'
  | 'UNAUTHENTICATED'
  | 'IDENTITY_SETUP_REQUIRED'
  | 'ACCOUNT_NOT_LINKED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'RATE_LIMITED'
  | 'INTERNAL_ERROR'

export type FieldErrors = Record<string, string[]>

type AppErrorDefault = {
  status: number
  message: string
}

const APP_ERROR_DEFAULTS: Readonly<Record<AppErrorCode, AppErrorDefault>> = {
  VALIDATION_FAILED: {
    status: 400,
    message: '入力内容に誤りがあります。内容を確認してください。',
  },
  UNAUTHENTICATED: {
    status: 401,
    message:
      'ログイン状態を確認できませんでした。もう一度ログインしてください。',
  },
  IDENTITY_SETUP_REQUIRED: {
    status: 409,
    message: 'アカウントの初期設定が完了していません。設定を完了してください。',
  },
  ACCOUNT_NOT_LINKED: {
    status: 409,
    message:
      'このログイン方法は連携されていません。既存のログイン方法でログインしてから連携してください。',
  },
  FORBIDDEN: {
    status: 403,
    message: 'この操作を行う権限がありません。',
  },
  NOT_FOUND: {
    status: 404,
    message: '対象が見つかりませんでした。',
  },
  CONFLICT: {
    status: 409,
    message:
      '他の変更と競合しました。最新の状態を読み込んでからやり直してください。',
  },
  RATE_LIMITED: {
    status: 429,
    message: 'リクエストが多すぎます。しばらく待ってから再度お試しください。',
  },
  INTERNAL_ERROR: {
    status: 500,
    message:
      'サーバー内部でエラーが発生しました。時間をおいて再度お試しください。',
  },
}

export type AppErrorOptions = {
  /** 利用者に見せてよい日本語メッセージ。省略時はコード既定の文言を使う。 */
  publicMessage?: string
  fieldErrors?: FieldErrors
  /** 内部診断用の原因。JSONには決して含めない。 */
  cause?: unknown
}

/**
 * HTTPステータスと公開メッセージを持つ安定したアプリケーションエラー。
 * `cause` は内部にのみ保持し、APIレスポンスには出さない。
 */
export class AppError extends Error {
  readonly code: AppErrorCode
  readonly status: number
  readonly publicMessage: string
  readonly fieldErrors: FieldErrors | undefined

  constructor(code: AppErrorCode, options: AppErrorOptions = {}) {
    const fallback = APP_ERROR_DEFAULTS[code]
    const publicMessage = options.publicMessage ?? fallback.message

    super(publicMessage, { cause: options.cause })

    this.name = 'AppError'
    this.code = code
    this.status = fallback.status
    this.publicMessage = publicMessage
    this.fieldErrors = options.fieldErrors
  }
}

/** クライアントへ返す共通エラーエンベロープ。 */
export type ApiErrorEnvelope = {
  error: {
    code: AppErrorCode
    message: string
    fieldErrors?: FieldErrors
    requestId: string
  }
}

/**
 * 任意の例外を公開安全なエンベロープへ変換する。
 * `AppError` 以外は原因を伏せて INTERNAL_ERROR に写像する。
 */
export function toApiErrorEnvelope(
  error: unknown,
  requestId: string,
): ApiErrorEnvelope {
  const appError =
    error instanceof AppError
      ? error
      : new AppError('INTERNAL_ERROR', { cause: error })

  if (appError.fieldErrors === undefined) {
    return {
      error: {
        code: appError.code,
        message: appError.publicMessage,
        requestId,
      },
    }
  }

  return {
    error: {
      code: appError.code,
      message: appError.publicMessage,
      fieldErrors: appError.fieldErrors,
      requestId,
    },
  }
}
