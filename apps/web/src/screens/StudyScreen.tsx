import type { PublicRating } from '@tango/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { ApiClientError, apiClient } from '../api/client'
import { CardMarkdown } from '../components/CardMarkdown'

const RATINGS: ReadonlyArray<{ rating: PublicRating; label: string }> = [
  { rating: 1, label: 'もう一度' },
  { rating: 2, label: '難しい' },
  { rating: 3, label: '普通' },
  { rating: 4, label: 'かんたん' },
]

export function StudyScreen() {
  const [searchParams] = useSearchParams()
  const deckId = searchParams.get('deckId')
  const queryClient = useQueryClient()
  const [revealed, setRevealed] = useState(false)
  const pendingIdempotencyKey = useRef<string | null>(null)
  const queryKey = ['study-session', deckId ?? 'all']
  const session = useQuery({
    queryKey,
    queryFn: () =>
      apiClient.createStudySession(
        deckId === null
          ? { mode: 'all' }
          : { mode: 'selected', deckIds: [deckId] },
      ),
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
  })
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
      const idempotencyKey =
        pendingIdempotencyKey.current ?? crypto.randomUUID()
      pendingIdempotencyKey.current = idempotencyKey
      await apiClient.submitReview({
        sessionId: current.sessionId,
        cardId: current.card.id,
        rating,
        expectedScheduleVersion: current.schedule.scheduleVersion,
        idempotencyKey,
      })
      return apiClient.getStudySession(current.sessionId)
    },
    onSuccess: (next) => {
      pendingIdempotencyKey.current = null
      setRevealed(false)
      queryClient.setQueryData(queryKey, next)
    },
    onError: async (error) => {
      if (
        error instanceof ApiClientError &&
        error.code === 'STUDY_STATE_CONFLICT' &&
        session.data !== undefined
      ) {
        pendingIdempotencyKey.current = null
        const refreshed = await apiClient.getStudySession(
          session.data.sessionId,
        )
        setRevealed(false)
        queryClient.setQueryData(queryKey, refreshed)
      }
    },
  })

  if (session.isPending) {
    return (
      <main className="study-shell">
        <p>学習を準備しています…</p>
      </main>
    )
  }
  if (session.isError) {
    return (
      <main className="study-shell">
        <p className="error-panel" role="alert">
          {session.error.message}
        </p>
        <Link to="/">単語帳へ戻る</Link>
      </main>
    )
  }

  const view = session.data
  const totalRemaining =
    view.remainingReview + view.remainingLearning + view.remainingNew
  if (view.card === null || view.intervalPreviews === null) {
    return (
      <main className="study-shell study-complete">
        <p className="eyebrow">TODAY COMPLETE</p>
        <h1>今日の学習は完了です</h1>
        <Link className="study-link" to="/">
          単語帳へ戻る
        </Link>
      </main>
    )
  }

  return (
    <main className="study-shell">
      <header className="study-header">
        <Link to={deckId === null ? '/' : `/decks/${deckId}`}>← 終了</Link>
        <fieldset className="remaining-counts">
          <legend className="visually-hidden">残り枚数</legend>
          <span>復習 {view.remainingReview}</span>
          <span>学習中 {view.remainingLearning}</span>
          <span>新規 {view.remainingNew}</span>
          <strong>計 {totalRemaining}</strong>
        </fieldset>
      </header>

      <article className="study-card">
        <section className="study-face" aria-label="表">
          <span className="eyebrow">FRONT</span>
          <CardMarkdown text={view.card.front} />
        </section>
        {revealed ? (
          <section className="study-face study-back" aria-label="裏">
            <span className="eyebrow">BACK</span>
            <CardMarkdown text={view.card.back} />
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
              disabled={review.isPending}
              onClick={() => review.mutate(rating)}
            >
              <span>{label}</span>
              <strong>
                {view.intervalPreviews?.[rating].scheduledDays ?? 0}日後
              </strong>
            </button>
          ))}
        </fieldset>
      ) : (
        <button
          className="reveal-button"
          type="button"
          onClick={() => setRevealed(true)}
        >
          答えを見る
        </button>
      )}

      {review.isError &&
      !(
        review.error instanceof ApiClientError &&
        review.error.code === 'STUDY_STATE_CONFLICT'
      ) ? (
        <p className="form-error" role="alert">
          {review.error.message} 同じ評価をもう一度押して再送できます。
        </p>
      ) : null}
    </main>
  )
}
