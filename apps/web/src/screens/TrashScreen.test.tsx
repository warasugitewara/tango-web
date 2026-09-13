import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { TrashScreen } from './TrashScreen'

const DECK_ID = '019fd000-0000-7000-8000-0000000000d1'
const CARD_ID = '019fd000-0000-7000-8000-0000000000c1'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function emptyTrash() {
  return { retentionDays: 30, decks: [], cards: [] }
}

function filledTrash() {
  return {
    retentionDays: 30,
    decks: [
      {
        id: DECK_ID,
        name: '英単語',
        cardCount: 3,
        trashedAt: '2026-09-01T12:00:00+09:00',
      },
    ],
    cards: [
      {
        id: CARD_ID,
        deckId: DECK_ID,
        deckName: '英単語',
        front: '表1',
        trashedAt: '2026-09-02T12:00:00+09:00',
      },
    ],
  }
}

function renderScreen(trash: unknown) {
  const restored: string[] = []
  let current = trash

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

      if (path.startsWith('/api/trash/') && init?.method === 'POST') {
        restored.push(path)
        current = emptyTrash()
        return new Response(null, { status: 204 })
      }

      return new Response(JSON.stringify(current), {
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
        <TrashScreen />
      </QueryClientProvider>
    </MemoryRouter>,
  )

  return { restored }
}

describe('TrashScreen', () => {
  test('削除済みのデッキとカードを出す', async () => {
    renderScreen(filledTrash())

    expect(await screen.findByText('英単語')).toBeTruthy()
    expect(screen.getByText('表1')).toBeTruthy()
  })

  test('保持期限を文章で伝える', async () => {
    // 「戻せる」だけでなく「いつまで戻せるか」を示す。
    renderScreen(filledTrash())

    expect(await screen.findByText(/30日/)).toBeTruthy()
  })

  test('削除日を表示する', async () => {
    renderScreen(filledTrash())

    expect(await screen.findByText(/2026-09-01/)).toBeTruthy()
  })

  test('デッキを復元する', async () => {
    const { restored } = renderScreen(filledTrash())

    fireEvent.click(await screen.findByRole('button', { name: '英単語を復元' }))

    expect(await screen.findByText(/ゴミ箱は空です/)).toBeTruthy()
    expect(restored).toContain(`/api/trash/decks/${DECK_ID}/restore`)
  })

  test('カードを復元する', async () => {
    const { restored } = renderScreen(filledTrash())

    fireEvent.click(await screen.findByRole('button', { name: '表1を復元' }))

    expect(await screen.findByText(/ゴミ箱は空です/)).toBeTruthy()
    expect(restored).toContain(`/api/trash/cards/${CARD_ID}/restore`)
  })

  test('空なら何も無いことを伝える', async () => {
    renderScreen(emptyTrash())

    expect(await screen.findByText(/ゴミ箱は空です/)).toBeTruthy()
  })
})
