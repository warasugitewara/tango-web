import { ACCOUNT_DELETE_CONFIRMATION } from '@tango/shared'
import { useMutation, useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { Link } from 'react-router'
import { apiClient } from '../api/client'

export function AccountDeleteScreen() {
  const [confirmation, setConfirmation] = useState('')

  const summary = useQuery({
    queryKey: ['account-summary'],
    queryFn: () => apiClient.accountSummary(),
  })

  const remove = useMutation({
    mutationFn: () => apiClient.deleteAccount(ACCOUNT_DELETE_CONFIRMATION),
  })

  if (remove.isSuccess) {
    return (
      <main className="shell">
        <h1>削除しました</h1>
        <p>
          アカウントと学習データを消しました。ご利用ありがとうございました。
        </p>
        <Link className="study-link" to="/">
          最初の画面へ
        </Link>
      </main>
    )
  }

  if (summary.isPending) {
    return <main className="shell">読み込み中…</main>
  }

  if (summary.isError) {
    return (
      <main className="shell">
        <p className="error-panel">{summary.error.message}</p>
        <Link className="study-link" to="/">
          単語帳へ戻る
        </Link>
      </main>
    )
  }

  const matched = confirmation === ACCOUNT_DELETE_CONFIRMATION

  return (
    <main className="shell">
      <header className="page-header">
        <div>
          <h1>アカウントを削除</h1>
        </div>
      </header>

      <p>
        以下がすべて消えます。<strong>取り消せません。</strong>
      </p>

      <dl className="merge-figures">
        <div>
          <dt>単語帳</dt>
          <dd>{summary.data.decks}</dd>
        </div>
        <div>
          <dt>カード</dt>
          <dd>{summary.data.cards}</dd>
        </div>
        <div>
          <dt>学習履歴</dt>
          <dd>{summary.data.reviews}</dd>
        </div>
      </dl>

      <p>
        残しておきたい単語帳があれば、先に
        <Link to="/">各単語帳の画面から書き出して</Link>
        ください。
      </p>

      <form
        className="delete-form"
        onSubmit={(event) => {
          event.preventDefault()
          if (matched) {
            remove.mutate()
          }
        }}
      >
        <label>
          確認のため「{ACCOUNT_DELETE_CONFIRMATION}」と入力してください
          <input
            value={confirmation}
            onChange={(event) => setConfirmation(event.target.value)}
            autoComplete="off"
          />
        </label>
        <button
          className="danger-button"
          type="submit"
          disabled={!matched || remove.isPending}
        >
          完全に削除する
        </button>
      </form>

      {remove.isError ? (
        <p className="form-error" role="alert">
          {remove.error.message}
        </p>
      ) : null}

      <Link to="/">やめる</Link>
    </main>
  )
}
