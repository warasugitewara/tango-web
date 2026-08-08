import { describe, expect, test, vi } from 'vitest'
import { createTurnstileVerifier } from './turnstile-client'

/** 検証専用のダミー。実在のシークレットではない。 */
const SECRET = 'turnstile-test-secret'

const VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify'

/**
 * 応答を固定したfetch実装を作る。呼び出し引数も記録する。
 * `preconnect` はfetchの型を満たすためだけに持たせる。
 */
function createFetchStub(respond: () => Response) {
  const mock = vi.fn(
    async (..._args: Parameters<typeof fetch>): Promise<Response> => respond(),
  )

  return Object.assign(mock, { preconnect: () => {} })
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/** FormDataとして送られたbodyだけを取り出す。 */
function formDataOf(init: RequestInit | undefined): FormData {
  const body = init?.body

  if (!(body instanceof FormData)) {
    throw new Error('bodyがFormDataではありません。')
  }

  return body
}

describe('createTurnstileVerifier', () => {
  test('success: true の応答だけを成功として扱う', async () => {
    const verifier = createTurnstileVerifier({
      secret: SECRET,
      fetchImplementation: createFetchStub(() =>
        jsonResponse({ success: true }),
      ),
    })

    await expect(
      verifier.verify({ token: 'token', remoteIp: null }),
    ).resolves.toBe(true)
  })

  test.each([
    ['success: false の応答', () => jsonResponse({ success: false })],
    ['HTTPステータスが失敗の応答', () => jsonResponse({ success: true }, 500)],
    ['スキーマに合わない応答', () => jsonResponse({ ok: 'yes' })],
    [
      '壊れたJSONの応答',
      () =>
        new Response('not json', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    ],
  ] satisfies ReadonlyArray<readonly [string, () => Response]>)(
    '%sは失敗として扱う',
    async (_caseName, respond) => {
      const verifier = createTurnstileVerifier({
        secret: SECRET,
        fetchImplementation: createFetchStub(respond),
      })

      await expect(
        verifier.verify({ token: 'token', remoteIp: null }),
      ).resolves.toBe(false)
    },
  )

  test('通信が例外で終わっても失敗として扱い、例外を外へ出さない', async () => {
    const verifier = createTurnstileVerifier({
      secret: SECRET,
      fetchImplementation: createFetchStub(() => {
        // 例外メッセージにシークレットが載っていても外へ漏れてはならない。
        throw new Error(`ネットワーク障害 ${SECRET}`)
      }),
    })

    await expect(
      verifier.verify({ token: 'token', remoteIp: null }),
    ).resolves.toBe(false)
  })

  test('空のトークンではネットワークへ出ない', async () => {
    const fetchImplementation = createFetchStub(() =>
      jsonResponse({ success: true }),
    )
    const verifier = createTurnstileVerifier({
      secret: SECRET,
      fetchImplementation,
    })

    await expect(verifier.verify({ token: '', remoteIp: null })).resolves.toBe(
      false,
    )
    expect(fetchImplementation).not.toHaveBeenCalled()
  })

  test('secretとresponseを送り、remoteIpはある時だけ添える', async () => {
    const fetchImplementation = createFetchStub(() =>
      jsonResponse({ success: true }),
    )
    const verifier = createTurnstileVerifier({
      secret: SECRET,
      fetchImplementation,
    })

    await verifier.verify({ token: 'token-1', remoteIp: null })
    await verifier.verify({ token: 'token-2', remoteIp: '203.0.113.7' })

    const calls = fetchImplementation.mock.calls
    expect(calls).toHaveLength(2)

    for (const [url] of calls) {
      expect(url).toBe(VERIFY_URL)
    }

    const withoutIp = formDataOf(calls[0]?.[1])
    const withIp = formDataOf(calls[1]?.[1])

    expect(withoutIp.get('secret')).toBe(SECRET)
    expect(withoutIp.get('response')).toBe('token-1')
    expect(withoutIp.get('remoteip')).toBeNull()

    expect(withIp.get('response')).toBe('token-2')
    expect(withIp.get('remoteip')).toBe('203.0.113.7')
  })

  test('判定結果は真偽値だけで、シークレットも失敗理由も含まない', async () => {
    const verifier = createTurnstileVerifier({
      secret: SECRET,
      fetchImplementation: createFetchStub(() =>
        jsonResponse({
          success: false,
          'error-codes': ['invalid-input-secret'],
          secret: SECRET,
        }),
      ),
    })

    const result = await verifier.verify({ token: 'token', remoteIp: null })

    expect(result).toBe(false)
    expect(JSON.stringify(result)).not.toContain(SECRET)
    expect(JSON.stringify(result)).not.toContain('invalid-input-secret')
  })
})
