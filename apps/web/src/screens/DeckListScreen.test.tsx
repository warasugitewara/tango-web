import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { DeckListScreen } from './DeckListScreen'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function renderScreen(session: unknown, decks: unknown[] = []) {
  const fetchStub = async (input: RequestInfo | URL): Promise<Response> => {
    const path = new URL(
      typeof input === 'string' ? input : input.toString(),
      'https://tango.test',
    ).pathname
    const body = path === '/api/session' ? session : { decks }
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  vi.stubGlobal('fetch', fetchStub)

  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  render(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <DeckListScreen />
      </QueryClientProvider>
    </MemoryRouter>,
  )
}

describe('DeckListScreen', () => {
  test('セッションが無ければ「はじめる」だけを出す', async () => {
    renderScreen({ authenticated: false })

    expect(await screen.findByRole('button', { name: 'はじめる' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'デッキを作成' })).toBeNull()
  })

  test('ログイン導線を一切出さない', async () => {
    renderScreen({
      authenticated: true,
      kind: 'guest',
      expiresAt: '2026-11-19T12:00:00+09:00',
      warning: 'Cookieを削除すると復元できません。',
    })

    expect(await screen.findByRole('heading', { name: '単語帳' })).toBeTruthy()
    expect(screen.queryByText(/Google/)).toBeNull()
    expect(screen.queryByText(/GitHub/)).toBeNull()
    expect(screen.queryByText(/ログイン/)).toBeNull()
  })

  test('Cookie削除でデータが戻せない旨を常時表示する', async () => {
    renderScreen({
      authenticated: true,
      kind: 'guest',
      expiresAt: '2026-11-19T12:00:00+09:00',
      warning: 'Cookieを削除すると復元できません。',
    })

    expect(await screen.findByText(/復元できません/)).toBeTruthy()
  })

  test('デッキをカード枚数とともに表示する', async () => {
    renderScreen(
      {
        authenticated: true,
        kind: 'guest',
        expiresAt: '2026-11-19T12:00:00+09:00',
        warning: 'Cookieを削除すると復元できません。',
      },
      [
        {
          id: '019fd000-0000-7000-8000-000000000010',
          name: '英単語',
          description: null,
          newCardLimit: 20,
          cardCount: 12,
        },
      ],
    )

    expect(await screen.findByText('英単語')).toBeTruthy()
    expect(screen.getByText('12枚')).toBeTruthy()
  })
})
