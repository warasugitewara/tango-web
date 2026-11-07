import { apiClient } from '../api/client'
import { PROVIDERS } from '../auth/providers'
import { useExternalRedirect } from '../hooks/useExternalRedirect'

/**
 * Google / GitHub でのログインを始める。
 * Better Auth が張る署名済み state Cookie がブラウザに残らないと
 * コールバックで突き合わせに失敗するため、必ずブラウザから遷移させる。
 */
export function SignInButtons() {
  const redirect = useExternalRedirect()

  return (
    <>
      <div className="sign-in-buttons">
        {PROVIDERS.map((provider) => (
          <button
            key={provider.id}
            type="button"
            disabled={redirect.pending}
            onClick={() =>
              redirect.start(
                () => apiClient.signInUrl(provider.id),
                'ログインを開始できませんでした。',
              )
            }
          >
            {provider.label}でログイン
          </button>
        ))}
      </div>
      {redirect.error === null ? null : (
        <p className="form-error" role="alert">
          {redirect.error}
        </p>
      )}
    </>
  )
}
