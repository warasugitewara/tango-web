import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { DeckDetailScreen } from './DeckDetailScreen'

const DECK_ID = '019fd000-0000-7000-8000-000000000010'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function renderScreen() {
  const cards: Array<Record<string, unknown>> = []
  const fetchStub = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const path = new URL(
      typeof input === 'string' ? input : input.toString(),
      'https://tango.test',
    ).pathname
    if (init?.method === 'POST' && path.endsWith('/cards')) {
      const body: unknown = JSON.parse(
        typeof init.body === 'string' ? init.body : '{}',
      )
      if (typeof body === 'object' && body !== null) {
        cards.push({
          id: '019fd000-0000-7000-8000-000000000011',
          deckId: DECK_ID,
          ...body,
          contentHash: 'a'.repeat(64),
          createdAt: '2026-08-21T12:00:00+09:00',
          updatedAt: '2026-08-21T12:00:00+09:00',
        })
      }
      return Response.json({ card: cards[0] }, { status: 201 })
    }
    if (init?.method === 'DELETE') {
      return new Response(null, { status: 204 })
    }
    return Response.json({ cards })
  }
  vi.stubGlobal('fetch', fetchStub)

  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  render(
    <MemoryRouter initialEntries={[`/decks/${DECK_ID}`]}>
      <QueryClientProvider client={client}>
        <Routes>
          <Route path="/decks/:deckId" element={<DeckDetailScreen />} />
        </Routes>
      </QueryClientProvider>
    </MemoryRouter>,
  )
}

describe('DeckDetailScreen', () => {
  test('カード作成後に一覧を更新する', async () => {
    renderScreen()

    fireEvent.change(await screen.findByLabelText('表'), {
      target: { value: '表1' },
    })
    fireEvent.change(screen.getByLabelText('裏'), {
      target: { value: '裏1' },
    })
    fireEvent.click(screen.getByRole('button', { name: '追加' }))

    expect(await screen.findByText('表1')).toBeTruthy()
    expect(screen.getAllByText('裏1').length).toBeGreaterThan(0)
  })

  test('削除は戻せない旨を確認してから実行する', async () => {
    renderScreen()
    fireEvent.change(await screen.findByLabelText('表'), {
      target: { value: '表1' },
    })
    fireEvent.change(screen.getByLabelText('裏'), {
      target: { value: '裏1' },
    })
    fireEvent.click(screen.getByRole('button', { name: '追加' }))
    await screen.findByText('表1')

    const messages: string[] = []
    vi.stubGlobal('confirm', (message: string) => {
      messages.push(message)
      return false
    })
    fireEvent.click(screen.getByRole('button', { name: '削除' }))

    expect(messages).toHaveLength(1)
    expect(messages[0]).toContain('戻せません')
  })
})
