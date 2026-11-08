import type { PublicRating } from '@tango/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { ApiClientError, apiClient, type StudySessionView } from '../api/client'
import { invalidateStudyProgress, queryKeys } from '../api/query-keys'
import { CardMarkdown } from '../components/CardMarkdown'
import { intervalLabel } from '../lib/format'
import { isInteractiveTarget } from '../lib/keyboard'

const RATINGS: ReadonlyArray<{ rating: PublicRating; label: string }> = [
  { rating: 1, label: 'もう一度' },
  { rating: 2, label: '難しい' },
  { rating: 3, label: '普通' },
  { rating: 4, label: 'かんたん' },
]

/** 共有契約 `reviewSubmitSchema` の上限。席を外したまま放置した分は丸める。 */
const MAX_RESPONSE_DURATION_MS = 3_600_000

/** 数字キーと評価の対応。仕様のキーボード操作（`1`〜`4`）に合わせる。 */
const RATING_BY_KEY: Readonly<Record<string, PublicRating>> = {
  '1': 1,
  '2': 2,
  '3': 3,
  '4': 4,
}

/**
 * 送信中・送信に失敗した評価。再送では鍵と測定値をそのまま使う。
 * サーバは鍵が一致すると評価の値を比べずに記録済みの結果を返すため、
 * 鍵は「このカードにこの評価」という1回の送信に結び付ける。
 */
type PendingReview = {
  cardId: string
  rating: PublicRating
  idempotencyKey: string
  responseDurationMs: number
}

function ratingLabel(rating: PublicRating): string {
  return RATINGS.find((candidate) => candidate.rating === rating)?.label ?? ''
}

export function StudyScreen() {
  const [searchParams] = useSearchParams()
  const deckId = searchParams.get('deckId')
  const queryClient = useQueryClient()
  const [revealed, setRevealed] = useState(false)
  const pendingReview = useRef<PendingReview | null>(null)
  // 送信に失敗した評価。届いたかどうか分からないあいだは、ほかの評価を選ばせない。
  // 届いていた場合、別の評価を送っても（同じ鍵なら記録済みとして、別の鍵なら
  // 版の競合として）黙って捨てられ、押した評価と記録が食い違うため。
  const [unconfirmed, setUnconfirmed] = useState<{
    cardId: string
    rating: PublicRating
  } | null>(null)
  // 取り消せるのは直前の1手だけ。評価してからボタンを出す。
  const [canUndo, setCanUndo] = useState(false)
  const pendingUndoKey = useRef<string | null>(null)
  // この画面に入ってから評価した枚数。取り消した分は差し引く。
  const [reviewedCount, setReviewedCount] = useState(0)
  const cardShownAt = useRef(performance.now())
  const cardRegion = useRef<HTMLElement>(null)
  const queryKey = queryKeys.studySession(deckId)
  const session = useQuery({
    queryKey,
    queryFn: () =>
      apiClient.createStudySession(
        deckId === null
          ? { mode: 'all' }
          : { mode: 'selected', deckIds: [deckId] },
      ),
    retry: false,
    // 画面を開いているあいだは作り直さない（作り直すと別セッションになる）。
    staleTime: Number.POSITIVE_INFINITY,
    // 画面を離れたら捨てる。残すと、戻ってきたときに新しいセッションを
    // 作らず、カードを足したあとでも古い「完了です」をそのまま出してしまう。
    gcTime: 0,
  })
  const currentCardId = session.data?.card?.id ?? null
  // 学習中のカードが1枚だけ残ると、同じカードが続けて出る。
  // カードIDだけを見ていると切り替わりを取りこぼすため、表示の更新時刻も見る。
  const shownAt = session.dataUpdatedAt

  // 新しいカードが出た時点から応答時間を測る。
  // フォーカスが行き場を失っていれば、カードへ移して読み上げさせる。
  // biome-ignore lint/correctness/useExhaustiveDependencies: shownAt は再実行の合図として使う
  useEffect(() => {
    if (currentCardId === null) {
      return
    }
    cardShownAt.current = performance.now()
    if (
      document.activeElement === null ||
      document.activeElement === document.body
    ) {
      cardRegion.current?.focus()
    }
  }, [currentCardId, shownAt])

  const showView = (next: StudySessionView) => {
    setRevealed(false)
    queryClient.setQueryData(queryKey, next)
  }

  const review = useMutation({
    mutationFn: async (rating: PublicRating) => {
      const current = session.data
      if (
        current?.card === null ||
        current?.card === undefined ||
        current.schedule === null
      ) {
        throw new Error('評価するカードがありません。')
      }
      // 同じカードへの再送なら最初の鍵と測定値を使う。届いていた場合は
      // サーバが記録済みの結果を返し、二重に評価されない。
      // 別のカードへ移っていたら（取り消しなど）、古い鍵は捨てる。
      const previous = pendingReview.current
      const retrying = previous !== null && previous.cardId === current.card.id
      if (retrying && previous.rating !== rating) {
        throw new Error(
          `「${ratingLabel(previous.rating)}」の再送が済むまで、ほかの評価は選べません。`,
        )
      }
      const attempt: PendingReview = retrying
        ? previous
        : {
            cardId: current.card.id,
            rating,
            idempotencyKey: crypto.randomUUID(),
            responseDurationMs: Math.min(
              MAX_RESPONSE_DURATION_MS,
              Math.max(0, Math.round(performance.now() - cardShownAt.current)),
            ),
          }
      pendingReview.current = attempt
      await apiClient.submitReview({
        sessionId: current.sessionId,
        cardId: current.card.id,
        rating,
        expectedScheduleVersion: current.schedule.scheduleVersion,
        idempotencyKey: attempt.idempotencyKey,
        responseDurationMs: attempt.responseDurationMs,
      })
      return apiClient.getStudySession(current.sessionId)
    },
    onSuccess: (next) => {
      pendingReview.current = null
      setUnconfirmed(null)
      setCanUndo(true)
      setReviewedCount((count) => count + 1)
      showView(next)
      // 一覧の残数と進捗は、戻ったときに取り直させる。
      void invalidateStudyProgress(queryClient)
    },
    onError: async (error) => {
      if (
        error instanceof ApiClientError &&
        error.code === 'STUDY_STATE_CONFLICT' &&
        session.data !== undefined
      ) {
        pendingReview.current = null
        setUnconfirmed(null)
        try {
          showView(await apiClient.getStudySession(session.data.sessionId))
        } catch {
          // 取り直しにも失敗したら、今のカードを残す。押し直せば再送できる。
        }
        return
      }
      const failed = pendingReview.current
      if (failed !== null) {
        setUnconfirmed({ cardId: failed.cardId, rating: failed.rating })
      }
    },
  })

  const undo = useMutation({
    mutationFn: async () => {
      const current = session.data
      if (current === undefined) {
        throw new Error('取り消せる評価がありません。')
      }
      // 通信断で押し直しても二重に戻さないよう、同じ鍵を使い回す。
      const idempotencyKey = pendingUndoKey.current ?? crypto.randomUUID()
      pendingUndoKey.current = idempotencyKey
      return apiClient.undoLastReview({
        sessionId: current.sessionId,
        idempotencyKey,
      })
    },
    onSuccess: (next) => {
      pendingUndoKey.current = null
      setCanUndo(false)
      setReviewedCount((count) => Math.max(0, count - 1))
      showView(next)
      void invalidateStudyProgress(queryClient)
    },
  })

  const view = session.data
  const card = view?.card ?? null
  const busy = review.isPending || undo.isPending
  // 届いたか分からない評価があれば、その評価だけを押せるようにする。
  const lockedRating =
    unconfirmed !== null && card !== null && unconfirmed.cardId === card.id
      ? unconfirmed.rating
      : null

  // 仕様のキーボード操作: Space で答え、1〜4 で評価。取り消しは Ctrl / ⌘ + Z。
  // 最新の状態を読むため、描画ごとに付け替える。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.repeat || event.altKey || isInteractiveTarget(event.target)) {
        return
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
        if (canUndo && !busy) {
          event.preventDefault()
          undo.mutate()
        }
        return
      }
      if (event.ctrlKey || event.metaKey || card === null || busy) {
        return
      }
      if (!revealed && (event.key === ' ' || event.key === 'Enter')) {
        // Space の既定動作（ページ送り）を止める。
        event.preventDefault()
        setRevealed(true)
        return
      }
      const rating = RATING_BY_KEY[event.key]
      if (
        revealed &&
        rating !== undefined &&
        (lockedRating === null || lockedRating === rating)
      ) {
        event.preventDefault()
        review.mutate(rating)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  })

  const exitTo = deckId === null ? '/' : `/decks/${deckId}`

  if (session.isPending) {
    return (
      <main className="study-shell">
        <title>学習 | Tango</title>
        <p>学習を準備しています…</p>
      </main>
    )
  }
  if (session.isError || view === undefined) {
    return (
      <main className="study-shell">
        <title>学習 | Tango</title>
        <p className="error-panel" role="alert">
          {session.error?.message ?? '学習を始められませんでした。'}
        </p>
        <p className="inline-links">
          <button type="button" onClick={() => void session.refetch()}>
            もう一度試す
          </button>
          <Link to={exitTo}>戻る</Link>
        </p>
      </main>
    )
  }

  const totalRemaining =
    view.remainingReview + view.remainingLearning + view.remainingNew
  const previews = view.intervalPreviews
  if (card === null || previews === null) {
    return (
      <main className="study-shell study-complete">
        <title>学習 | Tango</title>
        {reviewedCount > 0 ? (
          <>
            <h1>今日の学習は完了です</h1>
            <p>この回で{reviewedCount}枚を学習しました。</p>
          </>
        ) : (
          <>
            <h1>いま学習するカードはありません</h1>
            <p>期限が来たカードが無いか、今日の新規の上限に達しています。</p>
          </>
        )}
        <p className="inline-links">
          {canUndo ? (
            <button
              type="button"
              className="quiet-button"
              disabled={undo.isPending}
              onClick={() => undo.mutate()}
            >
              最後の評価を取り消す
            </button>
          ) : null}
          {deckId === null ? null : (
            <Link to={`/decks/${deckId}`}>カードを追加する</Link>
          )}
          <Link className="study-link" to="/">
            単語帳へ戻る
          </Link>
        </p>
        {undo.isError ? (
          <p className="form-error" role="alert">
            {undo.error.message}
          </p>
        ) : null}
      </main>
    )
  }

  return (
    <main className="study-shell">
      <title>{`学習（残り${totalRemaining}枚） | Tango`}</title>
      <header className="study-header">
        <Link to={exitTo}>← 終了</Link>
        <fieldset className="remaining-counts">
          <legend className="visually-hidden">残り枚数</legend>
          <span>復習 {view.remainingReview}</span>
          <span>学習中 {view.remainingLearning}</span>
          <span>新規 {view.remainingNew}</span>
          <strong>計 {totalRemaining}</strong>
          {reviewedCount === 0 ? null : <span>済 {reviewedCount}</span>}
        </fieldset>
      </header>

      <article
        className="study-card"
        ref={cardRegion}
        tabIndex={-1}
        aria-label="学習カード"
      >
        <section className="study-face" aria-label="表">
          <span className="face-label">表</span>
          <CardMarkdown text={card.front} />
        </section>
        {revealed ? (
          <section className="study-face study-back" aria-label="裏">
            <span className="face-label">裏</span>
            <CardMarkdown text={card.back} />
          </section>
        ) : null}
      </article>

      {revealed ? (
        <fieldset className="rating-grid">
          <legend className="visually-hidden">評価</legend>
          {RATINGS.map(({ rating, label }) => (
            <button
              type="button"
              key={rating}
              disabled={
                busy || (lockedRating !== null && lockedRating !== rating)
              }
              aria-keyshortcuts={String(rating)}
              onClick={() => review.mutate(rating)}
            >
              <span>{label}</span>
              <strong>{intervalLabel(previews[rating])}</strong>
              <span className="key-hint" aria-hidden="true">
                {rating}
              </span>
            </button>
          ))}
        </fieldset>
      ) : (
        <button
          className="reveal-button"
          type="button"
          aria-keyshortcuts="Space"
          onClick={() => setRevealed(true)}
        >
          答えを見る
          <span className="key-hint" aria-hidden="true">
            Space
          </span>
        </button>
      )}

      {canUndo ? (
        <button
          className="undo-button"
          type="button"
          disabled={busy}
          aria-keyshortcuts="Control+Z Meta+Z"
          onClick={() => undo.mutate()}
        >
          取り消す
        </button>
      ) : null}

      {undo.isError ? (
        <p className="form-error" role="alert">
          {undo.error.message}
        </p>
      ) : null}

      {review.isError &&
      !(
        review.error instanceof ApiClientError &&
        review.error.code === 'STUDY_STATE_CONFLICT'
      ) ? (
        <p className="form-error" role="alert">
          {review.error.message}
          {lockedRating === null
            ? null
            : ` 「${ratingLabel(lockedRating)}」をもう一度押して再送してください。届いていた場合に記録と食い違わないよう、再送が済むまでほかの評価は選べません。`}
        </p>
      ) : null}
    </main>
  )
}
