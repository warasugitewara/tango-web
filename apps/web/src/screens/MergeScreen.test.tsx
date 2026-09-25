import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { MergeScreen } from './MergeScreen'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function preview() {
  return {
    current: {
      userId: 'user-current',
      name: 'GitHubの自分',
      providers: ['github'],
      decks: 2,
      cards: 15,
      reviews: 0,
      lastReviewedAt: null,
    },
    other: {
      userId: 'user-other',
      name: 'Googleの自分',
      providers: ['google'],
      decks: 8,
      cards: 312,
      reviews: 38,
      lastReviewedAt: '2026-09-25T12:00:00+09:00',
    },
  }
}

function renderScreen(options: { previewStatus?: number } = {}) {
  const confirmed: unknown[] = []

  vi.stubGlobal(
    'fetch',
    async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const path = new URL(
        typeof input === 'string' ? input : input.toString(),
        'https://tango.test',
      ).pathname

      if (path === '/api/security/csrf') {
        return new Response(JSON.stringify({ csrfToken: 'test-token' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }

      if (path === '/api/identity/merge/confirm') {
        confirmed.push(
          JSON.parse(typeof init?.body === 'string' ? init.body : '{}'),
        )
        return new Response(JSON.stringify({ signedOut: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }

      const status = options.previewStatus ?? 200
      if (status !== 200) {
        return new Response(
          JSON.stringify({
            error: {
              code: 'VALIDATION_FAILED',
              message:
                '統合の手続きが期限切れです。最初からやり直してください。',
            },
          }),
          { status, headers: { 'content-type': 'application/json' } },
        )
      }

      return new Response(JSON.stringify(preview()), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    },
  )

  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })

  render(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <MergeScreen />
      </QueryClientProvider>
    </MemoryRouter>,
  )

  return { confirmed }
}

describe('MergeScreen', () => {
  test('両方の規模を並べて出す', async () => {
    renderScreen()

    expect(await screen.findByText('GitHubの自分')).toBeTruthy()
    expect(screen.getByText('Googleの自分')).toBeTruthy()
    // 判断材料になる数字が出ていること。
    expect(screen.getByText('312')).toBeTruthy()
    expect(screen.getByText('38')).toBeTruthy()
  })

  test('どちらを選んでもデータが両方残ることを伝える', async () => {
    // 片方が消えると誤解させない。ここが一番不安になる場面。
    renderScreen()

    expect(
      await screen.findByText(/どちらを選んでも、両方の単語帳と学習履歴/),
    ).toBeTruthy()
  })

  test('いまのアカウントへまとめる', async () => {
    const { confirmed } = renderScreen()

    fireEvent.click(
      await screen.findByRole('button', { name: /GitHubの自分にまとめる/ }),
    )

    expect(await screen.findByText(/まとまりました/)).toBeTruthy()
    expect(confirmed).toEqual([{ keep: 'current' }])
  })

  test('相手のアカウントへまとめる', async () => {
    const { confirmed } = renderScreen()

    fireEvent.click(
      await screen.findByRole('button', { name: /Googleの自分にまとめる/ }),
    )

    expect(await screen.findByText(/まとまりました/)).toBeTruthy()
    expect(confirmed).toEqual([{ keep: 'other' }])
  })

  test('取り込まれた側でログインしていたら、入り直しが要ると伝える', async () => {
    renderScreen()

    fireEvent.click(
      await screen.findByRole('button', { name: /Googleの自分にまとめる/ }),
    )

    expect(await screen.findByText(/もう一度ログイン/)).toBeTruthy()
  })

  test('証明が切れていたら、やり直しを促す', async () => {
    renderScreen({ previewStatus: 400 })

    expect(await screen.findByText(/期限切れ/)).toBeTruthy()
  })
})
