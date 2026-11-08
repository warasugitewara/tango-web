import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Link } from 'react-router'
import { apiClient } from '../api/client'
import { invalidateContent, queryKeys } from '../api/query-keys'
import { toDateLabel } from '../lib/format'

/** 知らせに入れる見出し語。長い本文をそのまま入れると一文が読めなくなる。 */
function shorten(text: string, max = 30): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

export function TrashScreen() {
  const queryClient = useQueryClient()
  const [restored, setRestored] = useState<string | null>(null)
  const trash = useQuery({
    queryKey: queryKeys.trash,
    queryFn: () => apiClient.listTrash(),
  })

  /** 復元するとデッキ一覧・当日の残数・進捗も変わるため、まとめて捨てる。 */
  const restore = useMutation({
    mutationFn: async (target: {
      kind: 'deck' | 'card'
      id: string
      label: string
    }) => {
      if (target.kind === 'deck') {
        await apiClient.restoreDeck(target.id)
      } else {
        await apiClient.restoreCard(target.id)
      }
    },
    onSuccess: async (_unused, target) => {
      // 行が消えるだけだと、どこへ戻ったのかが分からない。
      setRestored(`「${target.label}」を元の単語帳へ戻しました。`)
      await invalidateContent(queryClient)
    },
  })

  if (trash.isPending) {
    return <main className="shell">読み込み中…</main>
  }

  if (trash.isError) {
    return (
      <main className="shell">
        <title>ゴミ箱 | Tango</title>
        <p className="error-panel" role="alert">
          {trash.error.message}
        </p>
        <Link to="/">単語帳へ戻る</Link>
      </main>
    )
  }

  const { retentionDays, decks, cards } = trash.data
  const isEmpty = decks.length === 0 && cards.length === 0

  return (
    <main className="shell">
      <title>ゴミ箱 | Tango</title>
      <header className="page-header">
        <div>
          <h1>ゴミ箱</h1>
        </div>
        <Link className="study-link" to="/">
          単語帳へ戻る
        </Link>
      </header>

      <p>削除から{retentionDays}日で完全に削除されます。</p>

      <div className="status-line" role="status">
        {restored === null ? null : <p className="notice">{restored}</p>}
      </div>
      {restore.isError ? (
        <p className="form-error" role="alert">
          {restore.error.message}
        </p>
      ) : null}

      {isEmpty ? <p className="empty-state">ゴミ箱は空です。</p> : null}

      {decks.length === 0 ? null : (
        <section className="trash-section">
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
                disabled={restore.isPending}
                onClick={() =>
                  restore.mutate({
                    kind: 'deck',
                    id: deck.id,
                    label: deck.name,
                  })
                }
              >
                復元
              </button>
            </article>
          ))}
        </section>
      )}

      {cards.length === 0 ? null : (
        <section className="trash-section">
          <h2>カード</h2>
          {cards.map((card) => (
            <article className="deck-card" key={card.id}>
              <div>
                <h3 className="trash-card-front">{card.front}</h3>
                <p>
                  {card.deckName} / 削除日 {toDateLabel(card.trashedAt)}
                </p>
              </div>
              <button
                aria-label={`${card.front}を復元`}
                type="button"
                disabled={restore.isPending}
                onClick={() =>
                  restore.mutate({
                    kind: 'card',
                    id: card.id,
                    label: shorten(card.front),
                  })
                }
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
