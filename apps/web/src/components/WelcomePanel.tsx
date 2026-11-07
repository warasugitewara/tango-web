import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useCallback, useState } from 'react'
import { apiClient } from '../api/client'
import { queryKeys } from '../api/query-keys'
import { SignInButtons } from './SignInButtons'
import { TurnstileWidget } from './TurnstileWidget'

/** 未ログインの最初の画面。ゲストで始めるか、既存のアカウントで入る。 */
export function WelcomePanel() {
  const queryClient = useQueryClient()
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null)
  const receiveToken = useCallback((token: string | null) => {
    setTurnstileToken(token)
  }, [])
  const startGuest = useMutation({
    mutationFn: (token: string) => apiClient.startGuest(token),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.session })
    },
  })

  return (
    <main className="welcome-shell">
      <section className="welcome-card">
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
          {startGuest.isPending ? '準備しています…' : 'はじめる'}
        </button>
        {startGuest.isError ? (
          <p className="form-error" role="alert">
            {startGuest.error.message}
          </p>
        ) : null}

        {/* 別のブラウザや端末から戻ってきた人が、ゲストを作らずに入れる。 */}
        <div className="welcome-sign-in">
          <p>アカウントをお持ちの方</p>
          <SignInButtons />
        </div>
      </section>
    </main>
  )
}
