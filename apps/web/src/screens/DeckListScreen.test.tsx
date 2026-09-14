import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { DeckListScreen } from './DeckListScreen'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

/** 進捗を見ないテストでは空の集計を返す。 */
const EMPTY_DASHBOARD = {
  learningDay: '2026-08-25',
  completedToday: 0,
  streakDays: 0,
  remaining: { review: 0, learning: 0, new: 0 },
  activity: [],
  nextDueAt: null,
}

function renderScreen(
  session: unknown,
  decks: unknown[] = [],
  deckQueues: unknown[] = [],
  dashboard: unknown = EMPTY_DASHBOARD,
) {
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
    // CSRFトークンの発行はクライアントが自動で行う。
    if (path === '/api/security/csrf') {
      return new Response(JSON.stringify({ csrfToken: 'test-token' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
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
    if (path === '/api/study/dashboard') {
      return new Response(JSON.stringify(dashboard), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    if (path === '/api/study/decks') {
      return new Response(
        JSON.stringify({ learningDay: '2026-08-25', decks: deckQueues }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
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

  test('ゲストでも単語帳の見出しを出す', async () => {
    // プレリリースでは「ログイン導線を一切出さない」ことを固定していたが、
    // 本番ではCookie喪失によるデータ消失を塞ぐため導線を出す方針へ変えた。
    // 導線そのものの検証は「ログイン導線」のテスト群が受け持つ。
    renderScreen({
      authenticated: true,
      kind: 'guest',
      expiresAt: '2026-11-19T12:00:00+09:00',
      warning: 'Cookieを削除すると復元できません。',
    })

    expect(await screen.findByRole('heading', { name: '単語帳' })).toBeTruthy()
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

  test('説明が空文字なら説明なしとして表示する', async () => {
    // 設定画面で説明を消すと空文字が保存される。nullと同じ扱いにする。
    renderScreen(
      {
        authenticated: true,
        kind: 'guest',
        expiresAt: '2026-11-19T12:00:00+09:00',
        warning: 'Cookieを削除すると復元できません。',
      },
      [
        {
          id: '019fd000-0000-7000-8000-000000000011',
          name: '英単語',
          description: '',
          newCardLimit: 20,
          cardCount: 3,
        },
      ],
    )

    expect(await screen.findByText('説明はまだありません。')).toBeTruthy()
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

describe('ログイン導線', () => {
  const guestSession = {
    authenticated: true,
    kind: 'guest',
    expiresAt: '2026-11-19T12:00:00+09:00',
    warning: 'ゲストの学習データはこのブラウザだけに紐づきます。',
  }

  const userSession = {
    authenticated: true,
    kind: 'user',
    user: { id: 'user-1', name: 'テスト太郎', image: null },
    providers: ['google'],
  }

  test('ゲストにはログインの導線を出す', async () => {
    renderScreen(guestSession)

    expect(await screen.findByRole('button', { name: /Google/ })).toBeDefined()
    expect(screen.getByRole('button', { name: /GitHub/ })).toBeDefined()
  })

  test('ゲストには失われる理由と対処を並べて示す', async () => {
    renderScreen(guestSession)

    // 警告だけを出して打つ手を示さない状態にしない。
    expect(
      await screen.findByText(/このブラウザだけに紐づきます/),
    ).toBeDefined()
    expect(screen.getByText(/引き継/)).toBeDefined()
  })

  test('正式ユーザーにはログイン導線を出さず名前を出す', async () => {
    renderScreen(userSession)

    // 連携の操作は出るが、ログインの導線は出ない。
    expect(await screen.findByText('テスト太郎')).toBeDefined()
    expect(
      screen.queryByRole('button', { name: 'Googleでログイン' }),
    ).toBeNull()
    expect(
      screen.queryByRole('button', { name: 'GitHubでログイン' }),
    ).toBeNull()
  })

  test('正式ユーザーにはログアウトを出す', async () => {
    renderScreen(userSession)

    expect(
      await screen.findByRole('button', { name: 'ログアウト' }),
    ).toBeDefined()
  })
})

describe('当日の残り枚数', () => {
  const guestSession = {
    authenticated: true,
    kind: 'guest',
    expiresAt: '2026-11-19T12:00:00+09:00',
    warning: 'Cookieを削除すると復元できません。',
  }

  const deckId = '019fd000-0000-7000-8000-000000000030'
  const deck = {
    id: deckId,
    name: '英単語',
    description: null,
    newCardLimit: 20,
    cardCount: 30,
  }

  test('復習と新規の残りをデッキごとに出す', async () => {
    renderScreen(
      guestSession,
      [deck],
      [
        {
          deckId,
          remainingReview: 4,
          remainingLearning: 1,
          remainingNew: 2,
        },
      ],
    )

    // 再学習は復習と同じ列に足して出す。学習画面の残り表示と桁を揃える。
    expect(await screen.findByText('今日 復習5・新規2')).toBeTruthy()
  })

  test('残りが無ければ今日は完了と出す', async () => {
    renderScreen(
      guestSession,
      [deck],
      [
        {
          deckId,
          remainingReview: 0,
          remainingLearning: 0,
          remainingNew: 0,
        },
      ],
    )

    expect(await screen.findByText('今日はここまで')).toBeTruthy()
  })

  test('残数を取得できていないデッキには枚数を出さない', async () => {
    renderScreen(guestSession, [deck], [])

    expect(await screen.findByText('英単語')).toBeTruthy()
    expect(screen.queryByText('今日はここまで')).toBeNull()
  })
})

describe('アカウント連携', () => {
  const googleOnly = {
    authenticated: true,
    kind: 'user',
    user: { id: 'user-1', name: 'テスト太郎', image: null },
    providers: ['google'],
  }

  const bothProviders = {
    ...googleOnly,
    providers: ['google', 'github'],
  }

  test('未連携のプロバイダにだけ連携ボタンを出す', async () => {
    renderScreen(googleOnly)

    expect(
      await screen.findByRole('button', { name: 'GitHubを連携' }),
    ).toBeDefined()
    expect(screen.queryByRole('button', { name: 'Googleを連携' })).toBeNull()
  })

  test('連携済みのプロバイダ名を並べて表示する', async () => {
    renderScreen(bothProviders)

    expect(await screen.findByText(/連携中: Google、GitHub/)).toBeDefined()
  })

  test('連携が1つだけなら解除を出さない', async () => {
    // 最後の1つを解除するとログイン手段を失う。押せないボタンは見せない。
    renderScreen(googleOnly)

    await screen.findByRole('button', { name: 'GitHubを連携' })
    expect(screen.queryByRole('button', { name: /解除/ })).toBeNull()
  })

  test('連携が2つあれば解除を出す', async () => {
    renderScreen(bothProviders)

    expect(
      await screen.findByRole('button', { name: 'Googleの連携を解除' }),
    ).toBeDefined()
    expect(
      screen.getByRole('button', { name: 'GitHubの連携を解除' }),
    ).toBeDefined()
  })

  test('ゲストには連携の操作を出さない', async () => {
    renderScreen({
      authenticated: true,
      kind: 'guest',
      expiresAt: '2026-11-19T12:00:00+09:00',
      warning: 'Cookieを削除すると復元できません。',
    })

    await screen.findByRole('heading', { name: '単語帳' })
    expect(screen.queryByRole('button', { name: /連携/ })).toBeNull()
  })

  describe('進捗', () => {
    const SESSION = {
      authenticated: true,
      kind: 'guest',
      warning: 'ゲストです。',
      expiresAt: '2026-08-22T12:00:00+09:00',
    }

    function dashboard(overrides: Record<string, unknown> = {}) {
      return {
        learningDay: '2026-08-21',
        completedToday: 5,
        streakDays: 3,
        remaining: { review: 4, learning: 1, new: 2 },
        activity: [
          { learningDay: '2026-08-15', reviews: 0 },
          { learningDay: '2026-08-16', reviews: 4 },
          { learningDay: '2026-08-17', reviews: 0 },
          { learningDay: '2026-08-18', reviews: 2 },
          { learningDay: '2026-08-19', reviews: 6 },
          { learningDay: '2026-08-20', reviews: 3 },
          { learningDay: '2026-08-21', reviews: 5 },
        ],
        nextDueAt: '2026-08-22T12:00:00+09:00',
        ...overrides,
      }
    }

    test('今日の完了枚数と連続学習日を出す', async () => {
      renderScreen(SESSION, [], [], dashboard())

      expect(await screen.findByText(/今日 5枚/)).toBeTruthy()
      expect(screen.getByText(/連続 3日/)).toBeTruthy()
    })

    test('残りは全デッキの合計で出す', async () => {
      renderScreen(SESSION, [], [], dashboard())

      expect(await screen.findByText(/残り 7枚/)).toBeTruthy()
    })

    test('直近7日の活動量を日付つきで出す', async () => {
      renderScreen(SESSION, [], [], dashboard())

      expect(await screen.findByLabelText('2026-08-19 6枚')).toBeTruthy()
      expect(screen.getByLabelText('2026-08-17 0枚')).toBeTruthy()
    })

    test('次回の期限を日時で伝える', async () => {
      renderScreen(SESSION, [], [], dashboard())

      expect(await screen.findByText(/2026-08-22 12:00/)).toBeTruthy()
    })

    test('次回の期限が無ければ予定が無いことを伝える', async () => {
      renderScreen(SESSION, [], [], dashboard({ nextDueAt: null }))

      expect(await screen.findByText(/次の予定はありません/)).toBeTruthy()
    })
  })
})
