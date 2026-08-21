import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useState } from 'react'
import { Link } from 'react-router'
import { apiClient } from '../api/client'
import { TurnstileWidget } from '../components/TurnstileWidget'

export function DeckListScreen() {
  const queryClient = useQueryClient()
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null)
  const [deckName, setDeckName] = useState('')
  const session = useQuery({
    queryKey: ['session'],
    queryFn: () => apiClient.session(),
  })
  const decks = useQuery({
    queryKey: ['decks'],
    queryFn: () => apiClient.listDecks(),
    enabled: session.data?.authenticated === true,
  })
  const startGuest = useMutation({
    mutationFn: (token: string) => apiClient.startGuest(token),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['session'] })
    },
  })
  const createDeck = useMutation({
    mutationFn: (name: string) => apiClient.createDeck({ name }),
    onSuccess: async () => {
      setDeckName('')
      await queryClient.invalidateQueries({ queryKey: ['decks'] })
    },
  })
  const receiveToken = useCallback((token: string | null) => {
    setTurnstileToken(token)
  }, [])

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

  return (
    <main className="shell">
      <header className="page-header">
        <div>
          <p className="eyebrow">TANGO / PRE-RELEASE</p>
          <h1>単語帳</h1>
        </div>
        <Link className="study-link" to="/study">
          すべて学習
        </Link>
      </header>

      {session.data.kind === 'guest' ? (
        <aside className="guest-warning">{session.data.warning}</aside>
      ) : null}

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
              <p>{deck.description ?? '説明はまだありません。'}</p>
            </div>
            <div className="deck-meta">
              <span>{deck.cardCount}枚</span>
              <span>新規 {deck.newCardLimit}枚/日</span>
            </div>
            <div className="deck-actions">
              <Link to={`/decks/${deck.id}`}>カードを見る</Link>
              <Link to={`/study?deckId=${deck.id}`}>学習する</Link>
            </div>
          </article>
        ))}
      </section>
    </main>
  )
}
