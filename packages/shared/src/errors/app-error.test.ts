import { describe, expect, test } from 'vitest'
import { AppError, toApiErrorEnvelope } from './app-error'

describe('AppError', () => {
  test.each([
    ['VALIDATION_FAILED', 400],
    ['UNAUTHENTICATED', 401],
    ['IDENTITY_SETUP_REQUIRED', 409],
    ['ACCOUNT_NOT_LINKED', 409],
    ['FORBIDDEN', 403],
    ['NOT_FOUND', 404],
    ['CONFLICT', 409],
    ['STUDY_STATE_CONFLICT', 409],
    ['RATE_LIMITED', 429],
    ['INTERNAL_ERROR', 500],
  ] as const)('%s は HTTP %d を返す', (code, status) => {
    expect(new AppError(code).status).toBe(status)
  })

  test('既定の公開メッセージは日本語である', () => {
    expect(new AppError('NOT_FOUND').publicMessage).toBe(
      '対象が見つかりませんでした。',
    )
  })

  test('学習状態の競合は読み直しを促す日本語を返す', () => {
    // 通常のCONFLICTと文言を分け、利用者が次に取る行動を明確にする。
    expect(new AppError('STUDY_STATE_CONFLICT').publicMessage).toBe(
      '学習状態が更新されています。最新の状態を読み込み直してください。',
    )
  })

  test('内部causeは保持するが公開メッセージには含めない', () => {
    const cause = new Error('postgres://tango:secret@127.0.0.1:5432/tango')
    const error = new AppError('INTERNAL_ERROR', { cause })

    expect(error.cause).toBe(cause)
    expect(error.publicMessage).not.toContain('secret')
  })
})

describe('toApiErrorEnvelope', () => {
  test('公開情報だけを含め、causeとstackは含めない', () => {
    const cause = new Error('postgres://tango:secret@127.0.0.1:5432/tango')
    const error = new AppError('VALIDATION_FAILED', {
      publicMessage: '入力内容を確認してください。',
      fieldErrors: { front: ['表面は必須です。'] },
      cause,
    })

    const envelope = toApiErrorEnvelope(error, 'req-1')

    expect(envelope).toEqual({
      error: {
        code: 'VALIDATION_FAILED',
        message: '入力内容を確認してください。',
        fieldErrors: { front: ['表面は必須です。'] },
        requestId: 'req-1',
      },
    })

    const serialized = JSON.stringify(envelope)
    expect(serialized).not.toContain('secret')
    expect(serialized).not.toContain('stack')
  })

  test('fieldErrorsが無い場合はキー自体を出力しない', () => {
    const envelope = toApiErrorEnvelope(new AppError('FORBIDDEN'), 'req-2')

    expect(Object.keys(envelope.error)).toEqual([
      'code',
      'message',
      'requestId',
    ])
  })

  test('未知の例外はINTERNAL_ERRORへ写像し原因を漏らさない', () => {
    const envelope = toApiErrorEnvelope(
      new Error('ECONNREFUSED 10.0.0.5:5432'),
      'req-3',
    )

    expect(envelope.error.code).toBe('INTERNAL_ERROR')
    expect(envelope.error.message).toBe(
      'サーバー内部でエラーが発生しました。時間をおいて再度お試しください。',
    )
    expect(JSON.stringify(envelope)).not.toContain('10.0.0.5')
  })

  test('requestIdは常に含める', () => {
    expect(toApiErrorEnvelope('文字列例外', 'req-4').error.requestId).toBe(
      'req-4',
    )
  })
})
