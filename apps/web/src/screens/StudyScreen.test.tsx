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
    renderScreen(async (input) =>
      routeOf(input) === '/api/security/csrf'
        ? jsonResponse({ csrfToken: 'test-token' })
        : jsonResponse(initial, 201),
    )

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
      // CSRFトークンの発行はクライアントが自動で行う。
      if (route === '/api/security/csrf') {
        return jsonResponse({ csrfToken: 'test-token' })
      }
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
      // CSRFトークンの発行はクライアントが自動で行う。
      if (route === '/api/security/csrf') {
        return jsonResponse({ csrfToken: 'test-token' })
      }
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
      // CSRFトークンの発行はクライアントが自動で行う。
      if (route === '/api/security/csrf') {
        return jsonResponse({ csrfToken: 'test-token' })
      }
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

describe('直前の評価の取り消し', () => {
  const first = { id: CARD_1, front: '表1', back: '裏1' }
  const second = { id: CARD_2, front: '表2', back: '裏2' }

  /** 1枚目を評価して2枚目へ進んだ状態を作る。 */
  async function reviewOnce(
    undoResponse: () => Response = () => jsonResponse(studyView(first)),
  ) {
    const undoCalls: string[] = []

    renderScreen(async (input, init) => {
      const route = routeOf(input)
      if (route === '/api/security/csrf') {
        return jsonResponse({ csrfToken: 'test-token' })
      }
      if (route === '/api/study/reviews/undo' && init?.method === 'POST') {
        undoCalls.push(typeof init.body === 'string' ? init.body : '')
        return undoResponse()
      }
      if (route === '/api/study/reviews' && init?.method === 'POST') {
        return jsonResponse({ schedule: { scheduleVersion: 2 } })
      }
      if (route === `/api/study/sessions/${SESSION_ID}`) {
        return jsonResponse(studyView(second))
      }
      return jsonResponse(studyView(first), 201)
    })

    await screen.findByText('表1')
    fireEvent.click(screen.getByRole('button', { name: '答えを見る' }))
    fireEvent.click(screen.getByRole('button', { name: /普通/ }))
    await screen.findByText('表2')

    return { undoCalls }
  }

  test('評価する前は取り消しを出さない', async () => {
    renderScreen(async (input) =>
      routeOf(input) === '/api/security/csrf'
        ? jsonResponse({ csrfToken: 'test-token' })
        : jsonResponse(studyView(first), 201),
    )

    await screen.findByText('表1')
    expect(screen.queryByRole('button', { name: '取り消す' })).toBeNull()
  })

  test('評価したあとに取り消しを出す', async () => {
    await reviewOnce()

    expect(screen.getByRole('button', { name: '取り消す' })).toBeTruthy()
  })

  test('取り消すと直前のカードへ戻る', async () => {
    const { undoCalls } = await reviewOnce()

    fireEvent.click(screen.getByRole('button', { name: '取り消す' }))

    expect(await screen.findByText('表1')).toBeTruthy()
    expect(undoCalls).toHaveLength(1)
    expect(undoCalls[0]).toContain(SESSION_ID)
  })

  test('取り消したあとは続けて取り消せない', async () => {
    // 戻せるのは直前の1手だけ。
    await reviewOnce()

    fireEvent.click(screen.getByRole('button', { name: '取り消す' }))
    await screen.findByText('表1')

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: '取り消す' })).toBeNull()
    })
  })

  test('取り消せない場合は日本語のメッセージを出す', async () => {
    await reviewOnce(() =>
      jsonResponse(
        {
          error: {
            code: 'UNDO_UNAVAILABLE',
            message: '取り消せる評価がありません。',
          },
        },
        409,
      ),
    )

    fireEvent.click(screen.getByRole('button', { name: '取り消す' }))

    expect(await screen.findByText(/取り消せる評価がありません/)).toBeTruthy()
  })
})

describe('キーボード操作', () => {
  const first = { id: CARD_1, front: '表1', back: '裏1' }
  const second = { id: CARD_2, front: '表2', back: '裏2' }

  function renderStudy() {
    const reviewBodies: Array<Record<string, unknown>> = []
    renderScreen(async (input, init) => {
      const route = routeOf(input)
      if (route === '/api/security/csrf') {
        return jsonResponse({ csrfToken: 'test-token' })
      }
      if (route === '/api/study/reviews' && init?.method === 'POST') {
        reviewBodies.push(
          JSON.parse(typeof init.body === 'string' ? init.body : '{}'),
        )
        return jsonResponse({ schedule: { scheduleVersion: 2 } })
      }
      if (route === `/api/study/sessions/${SESSION_ID}`) {
        return jsonResponse(studyView(second))
      }
      return jsonResponse(studyView(first), 201)
    })
    return { reviewBodies }
  }

  test('Spaceで答えを出し、数字キーで評価する', async () => {
    const { reviewBodies } = renderStudy()

    await screen.findByText('表1')
    fireEvent.keyDown(window, { key: ' ' })
    expect(await screen.findByText('裏1')).toBeTruthy()

    fireEvent.keyDown(window, { key: '4' })

    expect(await screen.findByText('表2')).toBeTruthy()
    expect(reviewBodies).toEqual([expect.objectContaining({ rating: 4 })])
  })

  test('答えを出す前の数字キーでは評価しない', async () => {
    const { reviewBodies } = renderStudy()

    await screen.findByText('表1')
    fireEvent.keyDown(window, { key: '3' })

    expect(screen.queryByText('裏1')).toBeNull()
    expect(reviewBodies).toHaveLength(0)
  })

  test('ボタンにフォーカスがあるときのSpaceは横取りしない', async () => {
    // ボタン上の Space は「そのボタンを押す」。二重に反応させない。
    renderStudy()

    await screen.findByText('表1')
    const exit = screen.getByRole('link', { name: '← 終了' })
    fireEvent.keyDown(exit, { key: ' ' })

    expect(screen.queryByText('裏1')).toBeNull()
  })

  test('評価に応答時間を添えて送る', async () => {
    const { reviewBodies } = renderStudy()

    await screen.findByText('表1')
    fireEvent.click(screen.getByRole('button', { name: '答えを見る' }))
    fireEvent.click(screen.getByRole('button', { name: /普通/ }))

    await screen.findByText('表2')
    const duration = reviewBodies[0]?.responseDurationMs
    expect(typeof duration).toBe('number')
    expect(duration).toBeGreaterThanOrEqual(0)
  })

  test('ボタンに対応するキーを示す', async () => {
    renderStudy()

    await screen.findByText('表1')
    fireEvent.click(screen.getByRole('button', { name: '答えを見る' }))

    const easy = await screen.findByRole('button', { name: /かんたん/ })
    expect(easy.getAttribute('aria-keyshortcuts')).toBe('4')
  })
})

describe('学習の終わりと再開', () => {
  test('学習できるカードが無ければ、その旨とデッキへの導線を出す', async () => {
    const empty = {
      ...studyView({ id: CARD_1, front: '表1', back: '裏1' }),
      card: null,
      schedule: null,
      intervalPreviews: null,
    }
    renderScreen(async (input) =>
      routeOf(input) === '/api/security/csrf'
        ? jsonResponse({ csrfToken: 'test-token' })
        : jsonResponse(empty, 201),
    )

    expect(
      await screen.findByRole('heading', {
        name: 'いま学習するカードはありません',
      }),
    ).toBeTruthy()
    expect(
      screen
        .getByRole('link', { name: 'カードを追加する' })
        .getAttribute('href'),
    ).toBe(`/decks/${DECK_ID}`)
  })

  test('学習し終えたら、この回の枚数を出す', async () => {
    const first = studyView({ id: CARD_1, front: '表1', back: '裏1' })
    renderScreen(async (input, init) => {
      const route = routeOf(input)
      if (route === '/api/security/csrf') {
        return jsonResponse({ csrfToken: 'test-token' })
      }
      if (route === '/api/study/reviews' && init?.method === 'POST') {
        return jsonResponse({ schedule: { scheduleVersion: 2 } })
      }
      if (route === `/api/study/sessions/${SESSION_ID}`) {
        return jsonResponse({
          ...first,
          card: null,
          schedule: null,
          intervalPreviews: null,
        })
      }
      return jsonResponse(first, 201)
    })

    await screen.findByText('表1')
    fireEvent.click(screen.getByRole('button', { name: '答えを見る' }))
    fireEvent.click(screen.getByRole('button', { name: /普通/ }))

    expect(
      await screen.findByRole('heading', { name: '今日の学習は完了です' }),
    ).toBeTruthy()
    expect(screen.getByText('この回で1枚を学習しました。')).toBeTruthy()
  })

  test('画面を離れて戻ったら、学習セッションを作り直す', async () => {
    // 古いセッションを使い回すと、カードを足しても「完了です」のまま残る。
    let created = 0
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      if (routeOf(input) === '/api/security/csrf') {
        return jsonResponse({ csrfToken: 'test-token' })
      }
      created += 1
      return jsonResponse(
        studyView({ id: CARD_1, front: `表${created}`, back: '裏' }),
        201,
      )
    })
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    const ui = (
      <MemoryRouter initialEntries={['/study']}>
        <QueryClientProvider client={client}>
          <StudyScreen />
        </QueryClientProvider>
      </MemoryRouter>
    )

    const firstVisit = render(ui)
    await screen.findByText('表1')
    firstVisit.unmount()
    // 捨てる処理はタイマーで走る。次の描画の前に一巡させる。
    await new Promise((resolve) => setTimeout(resolve, 0))

    render(ui)
    expect(await screen.findByText('表2')).toBeTruthy()
    expect(created).toBe(2)
  })
})

test('同じカードが続けて出たら、応答時間を出し直した時点から測る', async () => {
  const same = studyView({ id: CARD_1, front: '表1', back: '裏1' })
  const durations: number[] = []
  let now = 1_000
  vi.spyOn(performance, 'now').mockImplementation(() => now)
  renderScreen(async (input, init) => {
    const route = routeOf(input)
    if (route === '/api/security/csrf') {
      return jsonResponse({ csrfToken: 'test-token' })
    }
    if (route === '/api/study/reviews' && init?.method === 'POST') {
      const body = JSON.parse(typeof init.body === 'string' ? init.body : '{}')
      durations.push(body.responseDurationMs)
      return jsonResponse({ schedule: {} })
    }
    if (route === `/api/study/sessions/${SESSION_ID}`) {
      return jsonResponse({
        ...same,
        schedule: { scheduleVersion: durations.length + 1 },
      })
    }
    return jsonResponse(same, 201)
  })

  await screen.findByText('表1')
  now = 6_000
  fireEvent.keyDown(window, { key: ' ' })
  fireEvent.keyDown(window, { key: '1' })
  await waitFor(() => expect(durations).toHaveLength(1))
  // 同じカードが再び出るまで待ってから、2回目の所要時間を作る。
  await screen.findByRole('button', { name: '取り消す' })
  now = 9_000
  fireEvent.keyDown(window, { key: ' ' })
  fireEvent.keyDown(window, { key: '1' })
  await waitFor(() => expect(durations).toHaveLength(2))

  expect(durations).toEqual([5_000, 3_000])
})
