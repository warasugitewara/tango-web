import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Link, useParams } from 'react-router'
import { apiClient, type CardRecord } from '../api/client'
import { CardMarkdown } from '../components/CardMarkdown'

function EditCardForm(props: { card: CardRecord }) {
  const { card } = props
  const queryClient = useQueryClient()
  const [front, setFront] = useState(card.front)
  const [back, setBack] = useState(card.back)
  const update = useMutation({
    mutationFn: () => apiClient.updateCard(card.id, { front, back }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['cards', card.deckId] })
    },
  })

  return (
    <details className="card-edit">
      <summary>編集</summary>
      <form
        onSubmit={(event) => {
          event.preventDefault()
          update.mutate()
        }}
      >
        <label>
          表
          <textarea
            value={front}
            onChange={(event) => setFront(event.target.value)}
          />
        </label>
        <label>
          裏
          <textarea
            value={back}
            onChange={(event) => setBack(event.target.value)}
          />
        </label>
        <button type="submit" disabled={update.isPending}>
          変更を保存
        </button>
      </form>
    </details>
  )
}

export function DeckDetailScreen() {
  const { deckId } = useParams()
  const resolvedDeckId = deckId ?? ''
  const queryClient = useQueryClient()
  const [front, setFront] = useState('')
  const [back, setBack] = useState('')
  const [format, setFormat] = useState<'json' | 'csv'>('json')
  const [payload, setPayload] = useState('')
  const [importedCount, setImportedCount] = useState<number | null>(null)

  const cards = useQuery({
    queryKey: ['cards', resolvedDeckId],
    queryFn: () => apiClient.listCards(resolvedDeckId),
    enabled: deckId !== undefined,
  })
  const create = useMutation({
    mutationFn: () => apiClient.createCard(resolvedDeckId, { front, back }),
    onSuccess: async () => {
      setFront('')
      setBack('')
      await queryClient.invalidateQueries({
        queryKey: ['cards', resolvedDeckId],
      })
    },
  })
  const remove = useMutation({
    mutationFn: (cardId: string) => apiClient.deleteCard(cardId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: ['cards', resolvedDeckId],
      })
    },
  })
  const importCards = useMutation({
    mutationFn: () =>
      apiClient.importCards(resolvedDeckId, { format, payload }),
    onSuccess: async (created) => {
      setImportedCount(created)
      await queryClient.invalidateQueries({
        queryKey: ['cards', resolvedDeckId],
      })
    },
  })

  if (deckId === undefined) {
    throw new Error('デッキIDがありません。')
  }

  return (
    <main className="shell">
      <header className="detail-header">
        <div>
          <Link to="/">← 単語帳へ</Link>
          <h1>カード</h1>
        </div>
        <Link className="study-link" to={`/study?deckId=${deckId}`}>
          この単語帳を学習
        </Link>
      </header>

      <section className="content-panel">
        <h2>カードを追加</h2>
        <form
          className="card-form"
          onSubmit={(event) => {
            event.preventDefault()
            create.mutate()
          }}
        >
          <label>
            表
            <textarea
              value={front}
              maxLength={20_000}
              onChange={(event) => setFront(event.target.value)}
            />
          </label>
          <label>
            裏
            <textarea
              value={back}
              maxLength={20_000}
              onChange={(event) => setBack(event.target.value)}
            />
          </label>
          <button
            type="submit"
            disabled={create.isPending || front === '' || back === ''}
          >
            追加
          </button>
        </form>
        {create.isError ? (
          <p className="form-error">{create.error.message}</p>
        ) : null}
      </section>

      <section className="content-panel">
        <h2>JSON / CSVを取り込む</h2>
        <form
          className="import-form"
          onSubmit={(event) => {
            event.preventDefault()
            importCards.mutate()
          }}
        >
          <label>
            形式
            <select
              value={format}
              onChange={(event) =>
                setFormat(event.target.value === 'csv' ? 'csv' : 'json')
              }
            >
              <option value="json">JSON</option>
              <option value="csv">CSV</option>
            </select>
          </label>
          <label>
            取り込み内容
            <textarea
              value={payload}
              onChange={(event) => setPayload(event.target.value)}
            />
          </label>
          <button
            type="submit"
            disabled={payload === '' || importCards.isPending}
          >
            取り込む
          </button>
        </form>
        {importedCount === null ? null : (
          <p>{importedCount}枚を作成しました。</p>
        )}
        {importCards.isError ? (
          <p className="form-error">{importCards.error.message}</p>
        ) : null}
      </section>

      <section className="card-list" aria-label="カード一覧">
        {cards.isPending ? <p>カードを読み込み中…</p> : null}
        {cards.data?.length === 0 ? <p>カードはまだありません。</p> : null}
        {cards.data?.map((card, index) => (
          <article className="content-card" key={card.id}>
            <span className="card-number">
              {String(index + 1).padStart(2, '0')}
            </span>
            <div className="card-face">
              <span>表</span>
              <CardMarkdown text={card.front} />
            </div>
            <div className="card-face">
              <span>裏</span>
              <CardMarkdown text={card.back} />
            </div>
            <div className="card-controls">
              <EditCardForm card={card} />
              <button
                className="danger-button"
                type="button"
                onClick={() => {
                  if (
                    window.confirm('このカードを削除します。元に戻せません。')
                  ) {
                    remove.mutate(card.id)
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
