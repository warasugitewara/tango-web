import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { AuthCompleteScreen, MERGE_KEY_STORAGE_KEY } from './AuthCompleteScreen'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  sessionStorage.clear()
})

type CompleteCall = { mergeKey: unknown }

/**
 * `/auth/complete` を描画し、`POST /api/identity/complete` の内容を記録する。
 * 成功時の遷移先は、遷移したことが分かる目印を置いて確認する。
 */
function renderScreen(respond: () => Response): { calls: CompleteCall[] } {
  const calls: CompleteCall[] = []

  vi.stubGlobal(
    'fetch',
    async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const path = new URL(
        typeof input === 'string' ? input : input.toString(),
        'https://tango.test',
      ).pathname

      if (path === '/api/identity/complete') {
        const body: unknown =
          typeof init?.body === 'string' ? JSON.parse(init.body) : null
        calls.push({
          mergeKey:
            typeof body === 'object' && body !== null && 'mergeKey' in body
              ? body.mergeKey
              : undefined,
        })
        return respond()
      }

      return new Response(JSON.stringify({ authenticated: false }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    },
  )

  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })

  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/auth/complete']}>
        <Routes>
          <Route path="/auth/complete" element={<AuthCompleteScreen />} />
          <Route path="/" element={<p>デッキ一覧</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )

  return { calls }
}

function okResponse(): Response {
  return new Response(
    JSON.stringify({
      actor: {
        kind: 'user',
        principalId: '019fd000-0000-7000-8000-000000000001',
        userId: 'user-1',
      },
      outcome: 'created',
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )
}

function conflictResponse(): Response {
  return new Response(
    JSON.stringify({
      error: {
        code: 'CONFLICT',
        message:
          'このログイン処理はすでに別のアカウントで完了しています。ログインからやり直してください。',
        requestId: '019fd000-0000-7000-8000-000000000009',
      },
    }),
    { status: 409, headers: { 'content-type': 'application/json' } },
  )
}

describe('AuthCompleteScreen', () => {
  test('成功したらデッキ一覧へ遷移する', async () => {
    renderScreen(okResponse)

    expect(await screen.findByText('デッキ一覧')).toBeDefined()
  })

  test('冪等性キーとしてUUIDv7を1件だけ送る', async () => {
    const { calls } = renderScreen(okResponse)

    await screen.findByText('デッキ一覧')

    expect(calls).toHaveLength(1)
    expect(calls[0]?.mergeKey).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    )
  })

  test('失敗したらAPIの日本語メッセージを表示し、遷移しない', async () => {
    renderScreen(conflictResponse)

    expect(
      await screen.findByText(/すでに別のアカウントで完了しています/),
    ).toBeDefined()
    expect(screen.queryByText('デッキ一覧')).toBeNull()
  })

  test('失敗しても戻る導線を出す', async () => {
    renderScreen(conflictResponse)

    await screen.findByText(/すでに別のアカウントで完了しています/)

    expect(screen.getByRole('link', { name: /戻る/ })).toBeDefined()
  })

  test('再読み込みでも同じ冪等性キーを使い回す', async () => {
    // 通信断で画面を開き直したとき新しい鍵を作ると、
    // 二重統合や誤った競合を招く。同じタブでは鍵を保持する。
    sessionStorage.setItem(
      MERGE_KEY_STORAGE_KEY,
      '019fd000-0000-7000-8000-0000000000aa',
    )

    const { calls } = renderScreen(okResponse)

    await screen.findByText('デッキ一覧')

    expect(calls[0]?.mergeKey).toBe('019fd000-0000-7000-8000-0000000000aa')
  })

  test('成功したら保持していた冪等性キーを捨てる', async () => {
    renderScreen(okResponse)

    await screen.findByText('デッキ一覧')

    expect(sessionStorage.getItem(MERGE_KEY_STORAGE_KEY)).toBeNull()
  })

  test('失敗したら冪等性キーを残して再試行に備える', async () => {
    renderScreen(conflictResponse)

    await screen.findByText(/すでに別のアカウントで完了しています/)

    expect(sessionStorage.getItem(MERGE_KEY_STORAGE_KEY)).not.toBeNull()
  })
})
