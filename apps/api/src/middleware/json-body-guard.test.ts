import { Hono } from 'hono'
import { describe, expect, test } from 'vitest'
import { errorHandler } from './error-handler'
import {
  GENERIC_BODY_LIMIT_BYTES,
  IMPORT_BODY_LIMIT_BYTES,
  jsonBodyGuard,
} from './json-body-guard'
import type { AppEnv } from './request-context'

function createApp() {
  return new Hono<AppEnv>()
    .onError(errorHandler())
    .use('/api/*', jsonBodyGuard())
    .post('/api/decks', (context) => context.json({ ok: true }))
    .post('/api/decks/:deckId/import', (context) => context.json({ ok: true }))
}

/** 指定バイト数のJSONボディを作る。 */
function bodyOfSize(bytes: number): string {
  const envelope = '{"payload":""}'
  return `{"payload":"${'a'.repeat(bytes - envelope.length)}"}`
}

async function post(path: string, body: string) {
  return createApp().request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  })
}

describe('ボディ上限', () => {
  test('取り込み以外は1MiBを超えると拒否する', async () => {
    const response = await post(
      '/api/decks',
      bodyOfSize(GENERIC_BODY_LIMIT_BYTES + 1),
    )

    expect(response.status).toBe(400)
  })

  test('取り込み以外でも1MiB以内なら通す', async () => {
    const response = await post(
      '/api/decks',
      bodyOfSize(GENERIC_BODY_LIMIT_BYTES - 1),
    )

    expect(response.status).toBe(200)
  })

  test('取り込みは1MiBを超えても通す', async () => {
    // 契約は payload 1,000,000 文字まで許す。多バイト文字なら
    // 1MiBを容易に超えるため、取り込みだけ上限を引き上げる。
    const response = await post(
      '/api/decks/019fd000-0000-7000-8000-000000000001/import',
      bodyOfSize(GENERIC_BODY_LIMIT_BYTES + 1),
    )

    expect(response.status).toBe(200)
  })

  test('取り込みでも10MiBを超えれば拒否する', async () => {
    const response = await post(
      '/api/decks/019fd000-0000-7000-8000-000000000001/import',
      bodyOfSize(IMPORT_BODY_LIMIT_BYTES + 1),
    )

    expect(response.status).toBe(400)
  })

  test('拒否の文言に上限を示す', async () => {
    const response = await post(
      '/api/decks',
      bodyOfSize(GENERIC_BODY_LIMIT_BYTES + 1),
    )
    const body = (await response.json()) as {
      error: { code: string; message: string }
    }

    expect(body.error.code).toBe('VALIDATION_FAILED')
    expect(body.error.message).toContain('大きすぎます')
  })
})
