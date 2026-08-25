import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
  vi,
} from 'vitest'
import { DeckDetailScreen } from './DeckDetailScreen'

const DECK_ID = '019fd000-0000-7000-8000-000000000010'
let styleElement: HTMLStyleElement

beforeAll(() => {
  styleElement = document.createElement('style')
  styleElement.textContent = readFileSync(
    resolve(process.cwd(), 'apps/web/src/styles.css'),
    'utf8',
  )
  document.head.append(styleElement)
})

afterAll(() => {
  styleElement.remove()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

type DeckFixture = {
  id: string
  name: string
  description: string | null
  newCardLimit: number
  cardCount: number
}

const DEFAULT_DECK: DeckFixture = {
  id: DECK_ID,
  name: '英単語',
  description: null,
  newCardLimit: 20,
  cardCount: 0,
}

function seedCards(total: number): Array<Record<string, unknown>> {
  return Array.from({ length: total }, (_unused, index) => ({
    id: `019fd000-0000-7000-8000-${String(index).padStart(12, '0')}`,
    deckId: DECK_ID,
    front: `表${index + 1}`,
    back: `裏${index + 1}`,
    contentHash: 'a'.repeat(64),
    createdAt: '2026-08-21T12:00:00+09:00',
    updatedAt: '2026-08-21T12:00:00+09:00',
  }))
}

function renderScreen(
  options: { deck?: DeckFixture | null; cardCount?: number } = {},
) {
  const cards: Array<Record<string, unknown>> = seedCards(
    options.cardCount ?? 0,
  )
  const deckPatches: Array<Record<string, unknown>> = []
  const cardListQueries: Array<{
    limit: string | null
    offset: string | null
  }> = []
  let deck: DeckFixture | null =
    options.deck === undefined ? DEFAULT_DECK : options.deck
  const fetchStub = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = new URL(
      typeof input === 'string' ? input : input.toString(),
      'https://tango.test',
    )
    const path = url.pathname
    // CSRFトークンの発行はクライアントが自動で行う。
    if (path === '/api/security/csrf') {
      return new Response(JSON.stringify({ csrfToken: 'test-token' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    if (path === '/api/decks') {
      return Response.json({ decks: deck === null ? [] : [deck] })
    }
    if (init?.method === 'PATCH' && path === `/api/decks/${DECK_ID}`) {
      const body: unknown = JSON.parse(
        typeof init.body === 'string' ? init.body : '{}',
      )
      if (typeof body === 'object' && body !== null && deck !== null) {
        deckPatches.push({ ...body })
        deck = { ...deck, ...body }
      }
      return Response.json({ deck })
    }
    if (init?.method === undefined && path.endsWith('/cards')) {
      const limit = url.searchParams.get('limit')
      const offset = url.searchParams.get('offset')
      cardListQueries.push({ limit, offset })
      const from = offset === null ? 0 : Number(offset)
      const size = limit === null ? 50 : Number(limit)
      return Response.json({
        cards: cards.slice(from, from + size),
        total: cards.length,
        limit: size,
        offset: from,
      })
    }
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
      return Response.json({ card: cards.at(-1) }, { status: 201 })
    }
    if (init?.method === 'DELETE') {
      cards.pop()
      return new Response(null, { status: 204 })
    }
    return Response.json({ cards, total: cards.length })
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

  return { deckPatches, cardListQueries }
}

describe('DeckDetailScreen', () => {
  test('学習リンクは濃色背景でも白文字で表示する', async () => {
    renderScreen()

    const studyLink = await screen.findByRole('link', {
      name: 'この単語帳を学習',
    })
    const style = window.getComputedStyle(studyLink)

    expect(style.backgroundColor).toBe('rgb(49, 92, 117)')
    expect(style.color).toBe('rgb(255, 255, 255)')
  })

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

describe('デッキの設定', () => {
  test('見出しにデッキ名を出す', async () => {
    renderScreen()

    expect(await screen.findByRole('heading', { name: '英単語' })).toBeTruthy()
  })

  test('名前・説明・新規上限をまとめて保存する', async () => {
    const { deckPatches } = renderScreen()

    fireEvent.change(await screen.findByLabelText('デッキ名'), {
      target: { value: '英単語 中級' },
    })
    fireEvent.change(screen.getByLabelText('説明'), {
      target: { value: '毎日すこしずつ。' },
    })
    fireEvent.change(screen.getByLabelText('1日の新規上限'), {
      target: { value: '5' },
    })
    fireEvent.click(screen.getByRole('button', { name: '設定を保存' }))

    expect(
      await screen.findByRole('heading', { name: '英単語 中級' }),
    ).toBeTruthy()
    expect(deckPatches).toEqual([
      {
        name: '英単語 中級',
        description: '毎日すこしずつ。',
        newCardLimit: 5,
      },
    ])
  })

  test('説明を空にすると説明なしとして送る', async () => {
    const { deckPatches } = renderScreen({
      deck: {
        id: DECK_ID,
        name: '英単語',
        description: '前の説明',
        newCardLimit: 20,
        cardCount: 0,
      },
    })

    fireEvent.change(await screen.findByLabelText('説明'), {
      target: { value: '' },
    })
    fireEvent.click(screen.getByRole('button', { name: '設定を保存' }))

    await screen.findByText('設定を保存しました。')
    expect(deckPatches).toEqual([
      { name: '英単語', description: '', newCardLimit: 20 },
    ])
  })

  test('名前が空のあいだは保存できない', async () => {
    renderScreen()

    fireEvent.change(await screen.findByLabelText('デッキ名'), {
      target: { value: '   ' },
    })

    const save = screen.getByRole('button', { name: '設定を保存' })
    expect(save.hasAttribute('disabled')).toBe(true)
  })
})

describe('カード一覧のページ送り', () => {
  test('総数と表示中の範囲を出す', async () => {
    renderScreen({ cardCount: 120 })

    expect(await screen.findByText('120枚中 1〜50枚を表示')).toBeTruthy()
  })

  test('次の50件で51枚目以降を取り出す', async () => {
    const { cardListQueries } = renderScreen({ cardCount: 120 })

    fireEvent.click(await screen.findByRole('button', { name: '次の50件' }))

    expect(await screen.findByText('120枚中 51〜100枚を表示')).toBeTruthy()
    // 編集フォームのtextareaにも同じ本文が入るため、複数一致を許す。
    expect((await screen.findAllByText('表51')).length).toBeGreaterThan(0)
    expect(cardListQueries.at(-1)).toEqual({ limit: '50', offset: '50' })
  })

  test('先頭では前の50件を押せない', async () => {
    renderScreen({ cardCount: 120 })

    const previous = await screen.findByRole('button', { name: '前の50件' })
    expect(previous.hasAttribute('disabled')).toBe(true)
  })

  test('50枚以下ならページ送りを出さない', async () => {
    renderScreen({ cardCount: 3 })

    expect((await screen.findAllByText('表1')).length).toBeGreaterThan(0)
    expect(screen.queryByRole('button', { name: '次の50件' })).toBeNull()
  })

  test('末尾では次の50件を押せない', async () => {
    renderScreen({ cardCount: 60 })

    fireEvent.click(await screen.findByRole('button', { name: '次の50件' }))

    expect(await screen.findByText('60枚中 51〜60枚を表示')).toBeTruthy()
    const next = screen.getByRole('button', { name: '次の50件' })
    expect(next.hasAttribute('disabled')).toBe(true)
  })
})
