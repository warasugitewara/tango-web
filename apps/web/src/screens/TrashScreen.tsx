import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router'
import { apiClient } from '../api/client'

/** 削除日は日付だけ見せる。時刻まで出しても判断の役に立たない。 */
function toDateLabel(trashedAt: string): string {
  return trashedAt.slice(0, 10)
}

export function TrashScreen() {
  const queryClient = useQueryClient()
  const trash = useQuery({
    queryKey: ['trash'],
    queryFn: () => apiClient.listTrash(),
  })

  /** 復元するとデッキ一覧と当日の残数も変わるため、まとめて捨てる。 */
  const invalidateAll = async () => {
    await queryClient.invalidateQueries({ queryKey: ['trash'] })
    await queryClient.invalidateQueries({ queryKey: ['decks'] })
    await queryClient.invalidateQueries({ queryKey: ['deck-queues'] })
  }

  const restoreDeck = useMutation({
    mutationFn: (deckId: string) => apiClient.restoreDeck(deckId),
    onSuccess: invalidateAll,
  })

  const restoreCard = useMutation({
    mutationFn: (cardId: string) => apiClient.restoreCard(cardId),
    onSuccess: invalidateAll,
  })

  if (trash.isPending) {
    return <main className="shell">読み込み中…</main>
  }

  if (trash.isError) {
    return <main className="shell error-panel">{trash.error.message}</main>
  }

  const { retentionDays, decks, cards } = trash.data
  const isEmpty = decks.length === 0 && cards.length === 0

  return (
    <main className="shell">
      <header className="page-header">
        <div>
          <h1>ゴミ箱</h1>
        </div>
        <Link className="study-link" to="/">
          単語帳へ戻る
        </Link>
      </header>

      <p>削除から{retentionDays}日で完全に削除されます。</p>

      {restoreDeck.isError ? (
        <p className="form-error" role="alert">
          {restoreDeck.error.message}
        </p>
      ) : null}
      {restoreCard.isError ? (
        <p className="form-error" role="alert">
          {restoreCard.error.message}
        </p>
      ) : null}

      {isEmpty ? <p>ゴミ箱は空です。</p> : null}

      {decks.length === 0 ? null : (
        <section>
          <h2>単語帳</h2>
          {decks.map((deck) => (
            <article className="deck-card" key={deck.id}>
              <div>
                <h3>{deck.name}</h3>
                <p>
                  {deck.cardCount}枚 / 削除日 {toDateLabel(deck.trashedAt)}
                </p>
              </div>
              <button
                aria-label={`${deck.name}を復元`}
                type="button"
                disabled={restoreDeck.isPending}
                onClick={() => restoreDeck.mutate(deck.id)}
              >
                復元
              </button>
            </article>
          ))}
        </section>
      )}

      {cards.length === 0 ? null : (
        <section>
          <h2>カード</h2>
          {cards.map((card) => (
            <article className="deck-card" key={card.id}>
              <div>
                <h3>{card.front}</h3>
                <p>
                  {card.deckName} / 削除日 {toDateLabel(card.trashedAt)}
                </p>
              </div>
              <button
                aria-label={`${card.front}を復元`}
                type="button"
                disabled={restoreCard.isPending}
                onClick={() => restoreCard.mutate(card.id)}
              >
                復元
              </button>
            </article>
          ))}
        </section>
      )}
    </main>
  )
}
