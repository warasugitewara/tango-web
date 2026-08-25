import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router'
import { apiClient, type CardRecord, type DeckSummary } from '../api/client'
import { CardMarkdown } from '../components/CardMarkdown'

/** カード一覧の1ページに出す枚数。APIのlimit上限100の範囲に収める。 */
const PAGE_SIZE = 50

/** 新規上限として受け付ける範囲。共有契約の `deckUpdateSchema` と揃える。 */
const NEW_CARD_LIMIT_MAX = 1_000

function parseNewCardLimit(value: string): number | null {
  if (!/^\d+$/.test(value.trim())) {
    return null
  }
  const parsed = Number(value)
  return parsed <= NEW_CARD_LIMIT_MAX ? parsed : null
}

/**
 * デッキ名・説明・新規上限をまとめて更新する。
 * 変更はPATCHで送るが、部分更新の差分計算は持たず3項目を常に送る。
 * 画面が持つ値がそのまま保存される形にして、押した結果を読み違えないようにする。
 */
function DeckSettingsForm(props: { deck: DeckSummary }) {
  const { deck } = props
  const queryClient = useQueryClient()
  const [name, setName] = useState(deck.name)
  const [description, setDescription] = useState(deck.description ?? '')
  const [newCardLimit, setNewCardLimit] = useState(String(deck.newCardLimit))
  const parsedLimit = parseNewCardLimit(newCardLimit)
  const update = useMutation({
    mutationFn: (input: {
      name: string
      description: string
      newCardLimit: number
    }) => apiClient.updateDeck(deck.id, input),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['decks'] })
    },
  })

  return (
    <section className="content-panel">
      <h2>デッキの設定</h2>
      <form
        className="deck-settings-form"
        onSubmit={(event) => {
          event.preventDefault()
          if (parsedLimit === null) {
            return
          }
          update.mutate({
            name: name.trim(),
            description,
            newCardLimit: parsedLimit,
          })
        }}
      >
        <label>
          デッキ名
          <input
            value={name}
            maxLength={100}
            onChange={(event) => {
              setName(event.target.value)
            }}
          />
        </label>
        <label>
          説明
          <textarea
            value={description}
            maxLength={1_000}
            onChange={(event) => {
              setDescription(event.target.value)
            }}
          />
        </label>
        <label>
          1日の新規上限
          <input
            type="number"
            inputMode="numeric"
            min={0}
            max={NEW_CARD_LIMIT_MAX}
            value={newCardLimit}
            onChange={(event) => {
              setNewCardLimit(event.target.value)
            }}
          />
        </label>
        <button
          type="submit"
          disabled={
            update.isPending || name.trim() === '' || parsedLimit === null
          }
        >
          設定を保存
        </button>
      </form>
      {parsedLimit === null ? (
        <p className="form-error">
          新規上限は0以上{NEW_CARD_LIMIT_MAX}以下の整数で入力してください。
        </p>
      ) : null}
      {update.isSuccess && !update.isPending ? (
        <p>設定を保存しました。</p>
      ) : null}
      {update.isError ? (
        <p className="form-error">{update.error.message}</p>
      ) : null}
    </section>
  )
}

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
  const [offset, setOffset] = useState(0)

  const cards = useQuery({
    queryKey: ['cards', resolvedDeckId, offset],
    queryFn: () =>
      apiClient.listCards(resolvedDeckId, { limit: PAGE_SIZE, offset }),
    enabled: deckId !== undefined,
  })
  const total = cards.data?.total ?? 0
  const shown = cards.data?.cards.length ?? 0

  // 削除や取り込みで総数が変わると、今の位置が範囲外になることがある。
  // その場合は最後のページへ寄せて、空の画面のまま止まらないようにする。
  useEffect(() => {
    if (cards.data !== undefined && offset > 0 && offset >= total) {
      setOffset(Math.max(0, Math.floor((total - 1) / PAGE_SIZE) * PAGE_SIZE))
    }
  }, [cards.data, offset, total])
  // デッキ単体の取得APIは持たない。一覧は利用者ごとに小さく、
  // 単語帳一覧と同じキャッシュを共有できるため、そこから引く。
  const decks = useQuery({
    queryKey: ['decks'],
    queryFn: () => apiClient.listDecks(),
    enabled: deckId !== undefined,
  })
  const deck = decks.data?.find((candidate) => candidate.id === resolvedDeckId)
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
          <h1>{deck === undefined ? 'カード' : deck.name}</h1>
        </div>
        <Link className="study-link" to={`/study?deckId=${deckId}`}>
          この単語帳を学習
        </Link>
      </header>

      {deck === undefined ? null : (
        <DeckSettingsForm deck={deck} key={deck.id} />
      )}

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
        {cards.data !== undefined && total === 0 ? (
          <p>カードはまだありません。</p>
        ) : null}
        {cards.data === undefined || total === 0 ? null : (
          <p className="card-range">
            {total}枚中 {offset + 1}〜{offset + shown}枚を表示
          </p>
        )}
        {cards.data?.cards.map((card, index) => (
          <article className="content-card" key={card.id}>
            <span className="card-number">
              {String(offset + index + 1).padStart(2, '0')}
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
        {total > PAGE_SIZE ? (
          <nav className="card-paging" aria-label="カード一覧のページ送り">
            <button
              type="button"
              disabled={offset === 0}
              onClick={() => {
                setOffset(Math.max(0, offset - PAGE_SIZE))
              }}
            >
              前の50件
            </button>
            <button
              type="button"
              disabled={offset + PAGE_SIZE >= total}
              onClick={() => {
                setOffset(offset + PAGE_SIZE)
              }}
            >
              次の50件
            </button>
          </nav>
        ) : null}
      </section>
    </main>
  )
}
