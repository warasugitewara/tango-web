import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { apiClient, type DeckQueue, type DeckSummary } from '../api/client'
import { invalidateContent, queryKeys } from '../api/query-keys'
import { AccountPanel } from '../components/AccountPanel'
import { GuestNotice } from '../components/GuestNotice'
import { ProgressPanel } from '../components/ProgressPanel'
import { UndoNoticeSlot } from '../components/UndoNotice'
import { WelcomePanel } from '../components/WelcomePanel'
import { useUndoNotice } from '../hooks/useUndoNotice'

/**
 * 当日あと何枚かを1行で示す。
 * 再学習は復習側へ足し、学習画面の残り表示と読み方を揃える。
 */
function todayLabel(queue: DeckQueue | undefined): string {
  if (queue === undefined) {
    return ''
  }
  const review = queue.remainingReview + queue.remainingLearning
  if (review === 0 && queue.remainingNew === 0) {
    return '今日はここまで'
  }
  return `今日 復習${review}・新規${queue.remainingNew}`
}

function hasWorkToday(queue: DeckQueue | undefined): boolean {
  return (
    queue !== undefined &&
    queue.remainingReview + queue.remainingLearning + queue.remainingNew > 0
  )
}

function DeckCard(props: {
  deck: DeckSummary
  queue: DeckQueue | undefined
  deleting: boolean
  onDelete(): void
}) {
  const { deck, queue, deleting, onDelete } = props

  return (
    <article className="deck-card">
      <div className="deck-tab" aria-hidden="true" />
      <div>
        <h2>
          <Link className="deck-title-link" to={`/decks/${deck.id}`}>
            {deck.name}
          </Link>
        </h2>
        <p>
          {deck.description === null || deck.description === ''
            ? '説明はまだありません。'
            : deck.description}
        </p>
      </div>
      <div className="deck-meta">
        <span>{deck.cardCount}枚</span>
        <span>新規 {deck.newCardLimit}枚/日</span>
        <span className="deck-today">{todayLabel(queue)}</span>
      </div>
      <div className="deck-actions">
        {deck.cardCount === 0 ? (
          // 空のデッキは学習できない。次にやることを先に出す。
          <Link className="deck-primary-action" to={`/decks/${deck.id}`}>
            カードを追加
          </Link>
        ) : (
          <>
            <Link
              className={
                hasWorkToday(queue) ? 'deck-primary-action' : undefined
              }
              to={`/study?deckId=${deck.id}`}
            >
              学習する
            </Link>
            <Link to={`/decks/${deck.id}`}>カードを見る</Link>
          </>
        )}
        <button
          aria-label={`${deck.name}を削除`}
          className="danger-button"
          type="button"
          disabled={deleting}
          onClick={onDelete}
        >
          削除
        </button>
      </div>
    </article>
  )
}

function DeckCreateForm() {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const [deckName, setDeckName] = useState('')
  const createDeck = useMutation({
    mutationFn: (name: string) => apiClient.createDeck({ name }),
    onSuccess: async (deck) => {
      setDeckName('')
      await invalidateContent(queryClient)
      // 空のデッキでは何もできない。続けてカードを入れられる画面へ移る。
      await navigate(`/decks/${deck.id}`)
    },
  })

  return (
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
        <button
          type="submit"
          disabled={createDeck.isPending || deckName.trim() === ''}
        >
          デッキを作成
        </button>
      </div>
      {createDeck.isError ? (
        <p className="form-error" role="alert">
          {createDeck.error.message}
        </p>
      ) : null}
    </form>
  )
}

export function DeckListScreen() {
  const queryClient = useQueryClient()
  const undo = useUndoNotice()
  const session = useQuery({
    queryKey: queryKeys.session,
    queryFn: () => apiClient.session(),
  })
  const signedIn = session.data?.authenticated === true
  const decks = useQuery({
    queryKey: queryKeys.decks,
    queryFn: () => apiClient.listDecks(),
    enabled: signedIn,
  })
  // 当日の残数は学習の進み方で変わるため、デッキ一覧とは別に取る。
  const deckQueues = useQuery({
    queryKey: queryKeys.deckQueues,
    queryFn: () => apiClient.listDeckQueues(),
    enabled: signedIn,
  })
  // 進捗は学習のたびに変わるため、デッキ一覧とは別に取る。
  const progress = useQuery({
    queryKey: queryKeys.dashboard,
    queryFn: () => apiClient.dashboard(),
    enabled: signedIn,
  })
  const deleteDeck = useMutation({
    mutationFn: (deck: DeckSummary) => apiClient.deleteDeck(deck.id),
    onSuccess: async (_unused, deck) => {
      undo.show(`「${deck.name}」をゴミ箱へ移しました。`, async () => {
        await apiClient.restoreDeck(deck.id)
        await invalidateContent(queryClient)
      })
      await invalidateContent(queryClient)
    },
  })

  if (session.isPending) {
    return <main className="shell">読み込み中…</main>
  }
  if (session.isError) {
    return (
      <main className="shell">
        <title>単語帳 | Tango</title>
        <p className="error-panel" role="alert">
          {session.error.message}
        </p>
        <button type="button" onClick={() => void session.refetch()}>
          もう一度読み込む
        </button>
      </main>
    )
  }

  if (session.data.authenticated === false) {
    return (
      <>
        <title>Tango</title>
        <WelcomePanel />
      </>
    )
  }

  // 型の絞り込みをコールバックまで持ち越すため、先に確定させる。
  const account = session.data.kind === 'user' ? session.data : null
  const guest = session.data.kind === 'guest' ? session.data : null

  return (
    <main className="shell">
      <title>単語帳 | Tango</title>
      <header className="page-header">
        <div>
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
        <ProgressPanel progress={progress.data} />
      )}

      {guest === null ? null : <GuestNotice warning={guest.warning} />}
      {account === null ? null : <AccountPanel account={account} />}

      <DeckCreateForm />

      <UndoNoticeSlot
        notice={undo.notice}
        undoing={undo.undoing}
        error={undo.error}
        onDismiss={undo.dismiss}
      />
      {deleteDeck.isError ? (
        <p className="form-error" role="alert">
          {deleteDeck.error.message}
        </p>
      ) : null}

      <section className="deck-grid" aria-label="デッキ一覧">
        {decks.isPending ? <p>デッキを読み込み中…</p> : null}
        {decks.isError ? (
          <p className="error-panel" role="alert">
            {decks.error.message}
          </p>
        ) : null}
        {decks.data?.length === 0 ? (
          <p className="empty-state">最初の単語帳を作ってください。</p>
        ) : null}
        {decks.data?.map((deck) => (
          <DeckCard
            key={deck.id}
            deck={deck}
            queue={deckQueues.data?.find(
              (candidate) => candidate.deckId === deck.id,
            )}
            deleting={deleteDeck.isPending}
            onDelete={() => {
              if (
                window.confirm(
                  `「${deck.name}」を削除します。ゴミ箱から30日以内なら戻せます。`,
                )
              ) {
                deleteDeck.mutate(deck)
              }
            }}
          />
        ))}
      </section>
    </main>
  )
}
