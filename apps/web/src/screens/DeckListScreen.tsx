import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useState } from 'react'
import { Link } from 'react-router'
import { apiClient } from '../api/client'
import { TurnstileWidget } from '../components/TurnstileWidget'

/** 画面に出すログイン手段。表示名はプロバイダの正式表記に合わせる。 */
const PROVIDERS = [
  { id: 'google', label: 'Google' },
  { id: 'github', label: 'GitHub' },
] as const

type ProviderId = (typeof PROVIDERS)[number]['id']

/** 連携中のプロバイダを読める名前で並べる。 */
function linkedLabels(providers: readonly string[]): string {
  return PROVIDERS.filter((provider) => providers.includes(provider.id))
    .map((provider) => provider.label)
    .join('、')
}

function totalRemaining(remaining: {
  review: number
  learning: number
  new: number
}): number {
  return remaining.review + remaining.learning + remaining.new
}

/** 活動量の濃さ。枚数そのものは読み上げ用のラベルで伝える。 */
function activityLevel(reviews: number): number {
  if (reviews === 0) {
    return 0
  }
  if (reviews < 5) {
    return 1
  }
  return reviews < 10 ? 2 : 3
}

/** `2026-08-22T12:00:00+09:00` を `2026-08-22 12:00` にする。 */
function toDueLabel(nextDueAt: string): string {
  return nextDueAt.slice(0, 16).replace('T', ' ')
}

export function DeckListScreen() {
  const queryClient = useQueryClient()
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null)
  const [deckName, setDeckName] = useState('')
  const [signInError, setSignInError] = useState<string | null>(null)
  const [linkError, setLinkError] = useState<string | null>(null)
  const session = useQuery({
    queryKey: ['session'],
    queryFn: () => apiClient.session(),
  })
  const decks = useQuery({
    queryKey: ['decks'],
    queryFn: () => apiClient.listDecks(),
    enabled: session.data?.authenticated === true,
  })
  // 当日の残数は学習の進み方で変わるため、デッキ一覧とは別に取る。
  const deckQueues = useQuery({
    queryKey: ['deck-queues'],
    queryFn: () => apiClient.listDeckQueues(),
    enabled: session.data?.authenticated === true,
  })
  // 進捗は学習のたびに変わるため、デッキ一覧とは別に取る。
  const progress = useQuery({
    queryKey: ['dashboard'],
    queryFn: () => apiClient.dashboard(),
    enabled: session.data?.authenticated === true,
  })
  const startGuest = useMutation({
    mutationFn: (token: string) => apiClient.startGuest(token),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['session'] })
    },
  })
  const unlink = useMutation({
    mutationFn: (provider: ProviderId) => apiClient.unlinkAccount(provider),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['session'] })
    },
    onError: (error: unknown) => {
      setLinkError(
        error instanceof Error ? error.message : '連携を解除できませんでした。',
      )
    },
  })

  const signOut = useMutation({
    mutationFn: () => apiClient.signOut(),
    onSuccess: async () => {
      // セッションとデッキの両方が別人のものへ変わるため、まとめて捨てる。
      await queryClient.invalidateQueries({ queryKey: ['session'] })
      await queryClient.invalidateQueries({ queryKey: ['decks'] })
      await queryClient.invalidateQueries({ queryKey: ['deck-queues'] })
    },
  })

  const createDeck = useMutation({
    mutationFn: (name: string) => apiClient.createDeck({ name }),
    onSuccess: async () => {
      setDeckName('')
      await queryClient.invalidateQueries({ queryKey: ['decks'] })
    },
  })
  const deleteDeck = useMutation({
    mutationFn: (deckId: string) => apiClient.deleteDeck(deckId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['decks'] })
      await queryClient.invalidateQueries({ queryKey: ['deck-queues'] })
    },
  })
  const receiveToken = useCallback((token: string | null) => {
    setTurnstileToken(token)
  }, [])

  /**
   * サインインはブラウザから開始する。
   * Better Authが張る署名済みstate Cookieがブラウザに残らないと、
   * コールバックで突き合わせに失敗する。
   */
  const startSignIn = (provider: 'google' | 'github') => {
    setSignInError(null)
    apiClient
      .signInUrl(provider)
      .then((url) => {
        window.location.href = url
      })
      .catch((error: unknown) => {
        setSignInError(
          error instanceof Error
            ? error.message
            : 'ログインを開始できませんでした。',
        )
      })
  }

  /**
   * 当日あと何枚かを1行で示す。
   * 再学習は復習側へ足し、学習画面の残り表示と読み方を揃える。
   */
  const todayLabel = (deckId: string): string => {
    const queue = deckQueues.data?.find(
      (candidate) => candidate.deckId === deckId,
    )
    if (queue === undefined) {
      return ''
    }
    const review = queue.remainingReview + queue.remainingLearning
    if (review === 0 && queue.remainingNew === 0) {
      return '今日はここまで'
    }
    return `今日 復習${review}・新規${queue.remainingNew}`
  }

  /** 連携を開始する。サインインと同じくブラウザから遷移させる。 */
  /**
   * 別アカウントとの統合を始める。
   * 連携ではなく通常のログインを通す。連携は「未使用のプロバイダ」しか
   * 受け付けないため、既に別アカウントで使われている場合に進めないため。
   */
  const startMerge = (provider: ProviderId) => {
    setLinkError(null)
    apiClient
      .startMerge()
      .then(() => apiClient.signInUrl(provider, '/auth/merge'))
      .then((url) => {
        window.location.href = url
      })
      .catch((error: unknown) => {
        setLinkError(
          error instanceof Error
            ? error.message
            : '統合を開始できませんでした。',
        )
      })
  }

  const startLink = (provider: ProviderId) => {
    setLinkError(null)
    apiClient
      .linkSocialUrl(provider)
      .then((url) => {
        window.location.href = url
      })
      .catch((error: unknown) => {
        setLinkError(
          error instanceof Error
            ? error.message
            : '連携を開始できませんでした。',
        )
      })
  }

  if (session.isPending) {
    return <main className="shell">読み込み中…</main>
  }
  if (session.isError) {
    return <main className="shell error-panel">{session.error.message}</main>
  }

  if (session.data.authenticated === false) {
    return (
      <main className="welcome-shell">
        <section className="welcome-card">
          <p className="eyebrow">TANGO / PRE-RELEASE</p>
          <h1>覚えるものを、ここに束ねる。</h1>
          <p className="lead">
            単語や用語をカードにして、忘れる少し前にもう一度。
          </p>
          <TurnstileWidget onToken={receiveToken} />
          <button
            className="primary-button"
            type="button"
            disabled={turnstileToken === null || startGuest.isPending}
            onClick={() => {
              if (turnstileToken !== null) {
                startGuest.mutate(turnstileToken)
              }
            }}
          >
            はじめる
          </button>
          {startGuest.isError ? (
            <p className="form-error">{startGuest.error.message}</p>
          ) : null}
        </section>
      </main>
    )
  }

  // 型の絞り込みをコールバックまで持ち越すため、先に確定させる。
  const account = session.data.kind === 'user' ? session.data : null
  const guest = session.data.kind === 'guest' ? session.data : null

  return (
    <main className="shell">
      <header className="page-header">
        <div>
          <p className="eyebrow">TANGO / PRE-RELEASE</p>
          <h1>単語帳</h1>
        </div>
        <div className="header-links">
          <Link to="/trash">ゴミ箱</Link>
          <Link className="study-link" to="/study">
            すべて学習
          </Link>
        </div>
      </header>

      {progress.data === undefined ? null : (
        <section className="progress-panel" aria-label="学習の進み具合">
          <p className="progress-figures">
            <span>今日 {progress.data.completedToday}枚</span>
            <span>連続 {progress.data.streakDays}日</span>
            <span>残り {totalRemaining(progress.data.remaining)}枚</span>
          </p>
          <ul className="activity-row">
            {progress.data.activity.map((day) => (
              <li
                key={day.learningDay}
                className="activity-cell"
                aria-label={`${day.learningDay} ${day.reviews}枚`}
                data-level={activityLevel(day.reviews)}
              />
            ))}
          </ul>
          <p className="activity-note">
            {progress.data.nextDueAt === null
              ? '次の予定はありません。'
              : `次回 ${toDueLabel(progress.data.nextDueAt)}`}
          </p>
        </section>
      )}

      {guest === null ? null : (
        <aside className="guest-warning">
          <p>{guest.warning}</p>
          <p>ログインすると、別のブラウザや端末へ学習データを引き継げます。</p>
          <div className="inline-form">
            <button type="button" onClick={() => startSignIn('google')}>
              Googleでログイン
            </button>
            <button type="button" onClick={() => startSignIn('github')}>
              GitHubでログイン
            </button>
          </div>
          {signInError === null ? null : <p role="alert">{signInError}</p>}
        </aside>
      )}

      {account === null ? null : (
        <aside className="account-bar">
          <p>{account.user.name}</p>
          <p>連携中: {linkedLabels(account.providers)}</p>
          <div className="inline-form">
            {PROVIDERS.filter(
              (provider) => !account.providers.includes(provider.id),
            ).map((provider) => (
              <button
                key={provider.id}
                type="button"
                onClick={() => startLink(provider.id)}
              >
                {provider.label}を連携
              </button>
            ))}
            {PROVIDERS.filter(
              (provider) => !account.providers.includes(provider.id),
            ).map((provider) => (
              <button
                key={`merge-${provider.id}`}
                type="button"
                onClick={() => startMerge(provider.id)}
              >
                {provider.label}の別アカウントとまとめる
              </button>
            ))}
            {/* 最後の1つを解除するとログイン手段を失うため、複数あるときだけ出す。 */}
            {account.providers.length < 2
              ? null
              : PROVIDERS.filter((provider) =>
                  account.providers.includes(provider.id),
                ).map((provider) => (
                  <button
                    key={provider.id}
                    type="button"
                    onClick={() => unlink.mutate(provider.id)}
                  >
                    {provider.label}の連携を解除
                  </button>
                ))}
            <button type="button" onClick={() => signOut.mutate()}>
              ログアウト
            </button>
            <Link to="/account/delete">アカウントを削除</Link>
          </div>
          {account.providers.length < 2 ? (
            // ボタンを黙って隠すと「壊れている」ように見える。理由を書く。
            <p className="account-note">
              ログイン方法が1つだけのため、連携は解除できません。
              もう1つ連携すると解除できるようになります。
            </p>
          ) : null}
          {linkError === null ? null : <p role="alert">{linkError}</p>}
        </aside>
      )}

      <form
        className="deck-create"
        onSubmit={(event) => {
          event.preventDefault()
          const name = deckName.trim()
          if (name !== '') {
            createDeck.mutate(name)
          }
        }}
      >
        <label htmlFor="deck-name">新しい単語帳</label>
        <div className="inline-form">
          <input
            id="deck-name"
            value={deckName}
            maxLength={100}
            placeholder="例：英単語 中級"
            onChange={(event) => setDeckName(event.target.value)}
          />
          <button type="submit" disabled={createDeck.isPending}>
            デッキを作成
          </button>
        </div>
        {createDeck.isError ? (
          <p className="form-error">{createDeck.error.message}</p>
        ) : null}
      </form>

      <section className="deck-grid" aria-label="デッキ一覧">
        {decks.isPending ? <p>デッキを読み込み中…</p> : null}
        {decks.data?.length === 0 ? (
          <p className="empty-state">最初の単語帳を作ってください。</p>
        ) : null}
        {decks.data?.map((deck) => (
          <article className="deck-card" key={deck.id}>
            <div className="deck-tab" aria-hidden="true" />
            <div>
              <h2>{deck.name}</h2>
              <p>
                {deck.description === null || deck.description === ''
                  ? '説明はまだありません。'
                  : deck.description}
              </p>
            </div>
            <div className="deck-meta">
              <span>{deck.cardCount}枚</span>
              <span>新規 {deck.newCardLimit}枚/日</span>
              <span className="deck-today">{todayLabel(deck.id)}</span>
            </div>
            <div className="deck-actions">
              <Link to={`/decks/${deck.id}`}>カードを見る</Link>
              <Link to={`/study?deckId=${deck.id}`}>学習する</Link>
              <button
                aria-label={`${deck.name}を削除`}
                className="danger-button"
                type="button"
                disabled={deleteDeck.isPending}
                onClick={() => {
                  if (
                    window.confirm(
                      `「${deck.name}」を削除します。ゴミ箱から30日以内なら戻せます。`,
                    )
                  ) {
                    deleteDeck.mutate(deck.id)
                  }
                }}
              >
                削除
              </button>
            </div>
          </article>
        ))}
      </section>
    </main>
  )
}
