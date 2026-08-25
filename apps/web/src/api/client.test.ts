import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

/**
 * トークンのキャッシュはモジュール内に持つ。
 * テスト間で持ち越さないよう、毎回読み直す。
 */
async function loadClient() {
  vi.resetModules()
  return (await import('./client')).apiClient
}

type Recorded = { path: string; method: string; headers: Headers }

beforeEach(() => {
  vi.resetModules()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

/**
 * 送信内容を記録するfetchを差し込む。
 * `/api/security/csrf` はトークンを返し、Cookieも自分で立てる。
 */
function stubFetch(options: { failFirstMutation?: boolean } = {}) {
  const calls: Recorded[] = []
  let issued = 0
  let mutations = 0

  vi.stubGlobal(
    'fetch',
    async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const path = new URL(
        typeof input === 'string' ? input : input.toString(),
        'https://tango.test',
      ).pathname
      calls.push({
        path,
        method: init?.method ?? 'GET',
        headers: new Headers(init?.headers),
      })

      if (path === '/api/security/csrf') {
        issued += 1
        // クライアントはCookieを読まず、応答本文のトークンを保持する。
        const token = `token-${issued}`
        return new Response(JSON.stringify({ csrfToken: token }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }

      if (init?.method !== undefined && init.method !== 'GET') {
        mutations += 1
        if (options.failFirstMutation === true && mutations === 1) {
          return new Response(
            JSON.stringify({
              error: {
                code: 'FORBIDDEN',
                message: 'この操作は許可されていません。',
              },
            }),
            { status: 403, headers: { 'content-type': 'application/json' } },
          )
        }
      }

      // 応答本文はクライアント側の解析を通す必要があるため、実在する形にする。
      return new Response(
        JSON.stringify({
          deck: {
            id: '019fd000-0000-7000-8000-000000000010',
            name: '英単語 中級',
            description: null,
            newCardLimit: 5,
            cardCount: 0,
          },
          decks: [],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    },
  )

  return { calls, issuedCount: () => issued }
}

describe('CSRFトークンの送信', () => {
  test('変更要求にX-Tango-CSRFを付ける', async () => {
    const stub = stubFetch()
    const apiClient = await loadClient()

    await apiClient.signOut()

    const mutation = stub.calls.find((call) => call.method === 'POST')
    expect(mutation?.headers.get('x-tango-csrf')).toBe('token-1')
  })

  test('読み取りだけの要求にはトークンを取りに行かない', async () => {
    const stub = stubFetch()
    const apiClient = await loadClient()

    await apiClient.listDecks()

    expect(stub.calls.map((call) => call.path)).not.toContain(
      '/api/security/csrf',
    )
  })

  test('2回目以降は同じトークンを使い回す', async () => {
    const stub = stubFetch()
    const apiClient = await loadClient()

    await apiClient.signOut()
    await apiClient.signOut()

    expect(stub.issuedCount()).toBe(1)
  })

  test('403を受けたらトークンを取り直して1度だけ再試行する', async () => {
    // Cookieの期限切れや別タブでの再発行で古くなることがある。
    const stub = stubFetch({ failFirstMutation: true })
    const apiClient = await loadClient()

    await apiClient.signOut()

    expect(stub.issuedCount()).toBe(2)
    const mutations = stub.calls.filter((call) => call.method === 'POST')
    expect(mutations).toHaveLength(2)
    expect(mutations[1]?.headers.get('x-tango-csrf')).toBe('token-2')
  })

  test('再試行しても失敗すればエラーを投げる', async () => {
    vi.stubGlobal(
      'fetch',
      async (input: RequestInfo | URL): Promise<Response> => {
        const path = new URL(
          typeof input === 'string' ? input : input.toString(),
          'https://tango.test',
        ).pathname

        if (path === '/api/security/csrf') {
          return new Response(JSON.stringify({ csrfToken: 'token' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        }

        return new Response(
          JSON.stringify({
            error: {
              code: 'FORBIDDEN',
              message: 'この操作は許可されていません。',
            },
          }),
          { status: 403, headers: { 'content-type': 'application/json' } },
        )
      },
    )

    const apiClient = await loadClient()
    await expect(apiClient.signOut()).rejects.toThrow(/許可されていません/)
  })
})

describe('デッキの更新', () => {
  test('PATCHで指定したデッキだけを更新する', async () => {
    const stub = stubFetch()
    const apiClient = await loadClient()

    await apiClient.updateDeck('019fd000-0000-7000-8000-000000000010', {
      name: '英単語 中級',
      newCardLimit: 5,
    })

    const mutation = stub.calls.find((call) => call.method === 'PATCH')
    expect(mutation?.path).toBe(
      '/api/decks/019fd000-0000-7000-8000-000000000010',
    )
    expect(mutation?.headers.get('x-tango-csrf')).toBe('token-1')
  })
})
