import { useMutation, useQuery } from '@tanstack/react-query'
import { Link } from 'react-router'
import { apiClient, type MergeCandidateView } from '../api/client'

const PROVIDER_LABELS: Record<string, string> = {
  google: 'Google',
  github: 'GitHub',
}

function providerLabel(providers: readonly string[]): string {
  return providers
    .map((provider) => PROVIDER_LABELS[provider] ?? provider)
    .join('・')
}

function dateLabel(lastReviewedAt: string | null): string {
  return lastReviewedAt === null ? '—' : lastReviewedAt.slice(0, 10)
}

function Column(props: { candidate: MergeCandidateView; heading: string }) {
  const { candidate, heading } = props

  return (
    <div className="merge-column">
      <p className="merge-role">{heading}</p>
      <h2>{candidate.name}</h2>
      <p>{providerLabel(candidate.providers)}でログイン</p>
      <dl className="merge-figures">
        <div>
          <dt>単語帳</dt>
          <dd>{candidate.decks}</dd>
        </div>
        <div>
          <dt>カード</dt>
          <dd>{candidate.cards}</dd>
        </div>
        <div>
          <dt>学習回数</dt>
          <dd>{candidate.reviews}</dd>
        </div>
        <div>
          <dt>最終学習</dt>
          <dd>{dateLabel(candidate.lastReviewedAt)}</dd>
        </div>
      </dl>
    </div>
  )
}

export function MergeScreen() {
  const preview = useQuery({
    queryKey: ['merge-preview'],
    queryFn: () => apiClient.mergePreview(),
  })

  const confirm = useMutation({
    mutationFn: (keep: 'current' | 'other') => apiClient.confirmMerge(keep),
  })

  if (confirm.isSuccess) {
    return (
      <main className="shell">
        <h1>まとまりました</h1>
        {confirm.data ? (
          <p>
            取り込まれた側でログインしていたため、もう一度ログインしてください。
            どちらのログイン方法でも同じデータに入れます。
          </p>
        ) : (
          <p>
            単語帳と学習履歴は1つになりました。どちらのログイン方法でも入れます。
          </p>
        )}
        <Link className="study-link" to="/">
          単語帳へ
        </Link>
      </main>
    )
  }

  if (preview.isPending) {
    return <main className="shell">読み込み中…</main>
  }

  if (preview.isError) {
    return (
      <main className="shell">
        <h1>統合できませんでした</h1>
        <p className="error-panel">{preview.error.message}</p>
        <Link className="study-link" to="/">
          単語帳へ戻る
        </Link>
      </main>
    )
  }

  const { current, other } = preview.data

  return (
    <main className="shell">
      <header className="page-header">
        <div>
          <h1>アカウントをまとめる</h1>
        </div>
      </header>

      <p>
        このログイン方法は別のアカウントで使われています。
        <strong>どちらを選んでも、両方の単語帳と学習履歴は残ります。</strong>
        違うのは、残る名前とログイン方法をどちらに寄せるかだけです。
      </p>

      <div className="merge-grid">
        <Column candidate={current} heading="いまログイン中" />
        <Column candidate={other} heading="統合を始めたアカウント" />
      </div>

      {confirm.isError ? (
        <p className="form-error" role="alert">
          {confirm.error.message}
        </p>
      ) : null}

      <div className="inline-form">
        <button
          type="button"
          disabled={confirm.isPending}
          onClick={() => confirm.mutate('current')}
        >
          {current.name}にまとめる
        </button>
        <button
          type="button"
          disabled={confirm.isPending}
          onClick={() => confirm.mutate('other')}
        >
          {other.name}にまとめる
        </button>
        <Link to="/">やめる</Link>
      </div>
    </main>
  )
}
