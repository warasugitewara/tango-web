import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { StudyScreen } from './StudyScreen'

const SESSION_ID = '019fd000-0000-7000-8000-000000000100'
const DECK_ID = '019fd000-0000-7000-8000-000000000010'
const CARD_1 = '019fd000-0000-7000-8000-000000000101'
const CARD_2 = '019fd000-0000-7000-8000-000000000102'
const IDEMPOTENCY_KEY = '550e8400-e29b-41d4-a716-446655440000'
const SECOND_IDEMPOTENCY_KEY = '550e8400-e29b-41d4-a716-446655440001'

function studyView(card: { id: string; front: string; back: string }) {
  return {
    sessionId: SESSION_ID,
    learningDay: '2026-08-21',
    card: { ...card, deckId: DECK_ID },
    schedule: { scheduleVersion: 1 },
    intervalPreviews: {
      1: { dueAt: '2026-08-21T17:20:00+09:00', scheduledDays: 0 },
      2: { dueAt: '2026-08-22T17:20:00+09:00', scheduledDays: 1 },
      3: { dueAt: '2026-08-25T17:20:00+09:00', scheduledDays: 4 },
      4: { dueAt: '2026-08-28T17:20:00+09:00', scheduledDays: 7 },
    },
    remainingReview: 2,
    remainingLearning: 1,
    remainingNew: 3,
  }
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function renderScreen(fetchStub: typeof fetch) {
  vi.stubGlobal('fetch', fetchStub)
  let uuidCount = 0
  vi.stubGlobal('crypto', {
    randomUUID: () => {
      uuidCount += 1
      return uuidCount === 1 ? IDEMPOTENCY_KEY : SECOND_IDEMPOTENCY_KEY
    },
  })
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  })
  render(
    <MemoryRouter initialEntries={[`/study?deckId=${DECK_ID}`]}>
      <QueryClientProvider client={client}>
        <StudyScreen />
      </QueryClientProvider>
    </MemoryRouter>,
  )
}

function routeOf(input: RequestInfo | URL) {
  return new URL(
    typeof input === 'string' ? input : input.toString(),
    'https://tango.test',
  ).pathname
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('StudyScreen', () => {
  test('答えを見るまで裏を表示せず、評価に次回間隔を表示する', async () => {
    const initial = studyView({ id: CARD_1, front: '表1', back: '裏1' })
    renderScreen(async () => jsonResponse(initial, 201))

    expect(await screen.findByText('表1')).toBeTruthy()
    expect(screen.queryByText('裏1')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '答えを見る' }))

    expect(await screen.findByText('裏1')).toBeTruthy()
    expect(screen.getByRole('button', { name: /かんたん.*7日後/ })).toBeTruthy()
  })

  test('サーバーの応答前に次のカードへ進まない', async () => {
    const initial = studyView({ id: CARD_1, front: '表1', back: '裏1' })
    const next = studyView({ id: CARD_2, front: '表2', back: '裏2' })
    let resolveReview: ((response: Response) => void) | undefined
    const pendingReview = new Promise<Response>((resolve) => {
      resolveReview = resolve
    })
    renderScreen(async (input, init) => {
      const route = routeOf(input)
      if (route === '/api/study/reviews' && init?.method === 'POST') {
        return pendingReview
      }
      if (route === `/api/study/sessions/${SESSION_ID}`) {
        return jsonResponse(next)
      }
      return jsonResponse(initial, 201)
    })

    await screen.findByText('表1')
    fireEvent.click(screen.getByRole('button', { name: '答えを見る' }))
    fireEvent.click(screen.getByRole('button', { name: /普通/ }))

    expect(screen.getByText('表1')).toBeTruthy()
    expect(screen.queryByText('表2')).toBeNull()
    resolveReview?.(jsonResponse({ schedule: {} }))
    expect(await screen.findByText('表2')).toBeTruthy()
  })

  test('状態競合を受けたら同じセッションを再取得する', async () => {
    const initial = studyView({ id: CARD_1, front: '表1', back: '裏1' })
    const refreshed = studyView({ id: CARD_2, front: '更新後', back: '裏2' })
    let getCount = 0
    renderScreen(async (input, init) => {
      const route = routeOf(input)
      if (route === '/api/study/reviews' && init?.method === 'POST') {
        return jsonResponse(
          {
            error: {
              code: 'STUDY_STATE_CONFLICT',
              message: '学習状態が更新されています。',
            },
          },
          409,
        )
      }
      if (route === `/api/study/sessions/${SESSION_ID}`) {
        getCount += 1
        return jsonResponse(refreshed)
      }
      return jsonResponse(initial, 201)
    })

    await screen.findByText('表1')
    fireEvent.click(screen.getByRole('button', { name: '答えを見る' }))
    fireEvent.click(screen.getByRole('button', { name: /難しい/ }))

    expect(await screen.findByText('更新後')).toBeTruthy()
    expect(getCount).toBe(1)
  })

  test('通信失敗後の再送では同じ冪等キーを使う', async () => {
    const initial = studyView({ id: CARD_1, front: '表1', back: '裏1' })
    const bodies: unknown[] = []
    let reviewCount = 0
    renderScreen(async (input, init) => {
      const route = routeOf(input)
      if (route === '/api/study/reviews' && init?.method === 'POST') {
        reviewCount += 1
        bodies.push(
          JSON.parse(typeof init.body === 'string' ? init.body : '{}'),
        )
        if (reviewCount === 1) {
          return jsonResponse({}, 503)
        }
        return jsonResponse({ schedule: {} })
      }
      if (route === `/api/study/sessions/${SESSION_ID}`) {
        return jsonResponse({
          ...initial,
          card: null,
          schedule: null,
          intervalPreviews: null,
        })
      }
      return jsonResponse(initial, 201)
    })

    await screen.findByText('表1')
    fireEvent.click(screen.getByRole('button', { name: '答えを見る' }))
    fireEvent.click(screen.getByRole('button', { name: /もう一度/ }))
    expect(await screen.findByRole('alert')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /もう一度/ }))

    await waitFor(() => expect(reviewCount).toBe(2))
    expect(bodies).toEqual([
      expect.objectContaining({ idempotencyKey: IDEMPOTENCY_KEY }),
      expect.objectContaining({ idempotencyKey: IDEMPOTENCY_KEY }),
    ])
  })
})
