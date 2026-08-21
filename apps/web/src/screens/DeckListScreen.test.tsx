import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { DeckListScreen } from './DeckListScreen'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function renderScreen(session: unknown, decks: unknown[] = []) {
  let currentDecks = [...decks]
  const deletedPaths: string[] = []
  const fetchStub = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const path = new URL(
      typeof input === 'string' ? input : input.toString(),
      'https://tango.test',
    ).pathname
    if (init?.method === 'DELETE' && path.startsWith('/api/decks/')) {
      deletedPaths.push(path)
      const deletedId = path.slice('/api/decks/'.length)
      currentDecks = currentDecks.filter(
        (deck) =>
          typeof deck !== 'object' ||
          deck === null ||
          !('id' in deck) ||
          deck.id !== deletedId,
      )
      return new Response(null, { status: 204 })
    }
    const body = path === '/api/session' ? session : { decks: currentDecks }
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

  return { deletedPaths }
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

  test('確認後にデモデッキを削除して一覧から消す', async () => {
    const demoId = '019fd000-0000-7000-8000-000000000020'
    const { deletedPaths } = renderScreen(
      {
        authenticated: true,
        kind: 'guest',
        expiresAt: '2026-11-19T12:00:00+09:00',
        warning: 'Cookieを削除すると復元できません。',
      },
      [
        {
          id: demoId,
          name: 'デモ',
          description: 'ローマ字とひらがなの練習用です。',
          newCardLimit: 20,
          cardCount: 46,
        },
      ],
    )
    vi.stubGlobal('confirm', () => true)

    expect(await screen.findByText('デモ')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'デモを削除' }))

    expect(
      await screen.findByText('最初の単語帳を作ってください。'),
    ).toBeTruthy()
    expect(screen.queryByText('デモ')).toBeNull()
    expect(deletedPaths).toEqual([`/api/decks/${demoId}`])
  })

  test('削除確認を取り消した場合はデッキを残す', async () => {
    const demoId = '019fd000-0000-7000-8000-000000000021'
    const { deletedPaths } = renderScreen(
      {
        authenticated: true,
        kind: 'guest',
        expiresAt: '2026-11-19T12:00:00+09:00',
        warning: 'Cookieを削除すると復元できません。',
      },
      [
        {
          id: demoId,
          name: 'デモ',
          description: 'ローマ字とひらがなの練習用です。',
          newCardLimit: 20,
          cardCount: 46,
        },
      ],
    )
    const confirm = vi.fn(() => false)
    vi.stubGlobal('confirm', confirm)

    fireEvent.click(await screen.findByRole('button', { name: 'デモを削除' }))

    expect(confirm).toHaveBeenCalledOnce()
    expect(screen.getByText('デモ')).toBeTruthy()
    expect(deletedPaths).toHaveLength(0)
  })
})
