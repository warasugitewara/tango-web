import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router'
import { apiClient, type SessionView } from '../api/client'
import { forgetSignedInData, queryKeys } from '../api/query-keys'
import { PROVIDERS, type ProviderId, providerLabels } from '../auth/providers'
import { useExternalRedirect } from '../hooks/useExternalRedirect'

type UserSession = Extract<SessionView, { kind: 'user' }>

/**
 * 正式アカウントの欄。
 * 連携・統合・解除・削除はめったに使わないため折りたたみ、
 * 「学習する」より目立たせない。ログアウトだけは常に見える場所に置く。
 */
export function AccountPanel(props: { account: UserSession }) {
  const { account } = props
  const queryClient = useQueryClient()
  const redirect = useExternalRedirect()
  const unlinked = PROVIDERS.filter(
    (provider) => !account.providers.includes(provider.id),
  )
  const linked = PROVIDERS.filter((provider) =>
    account.providers.includes(provider.id),
  )

  const unlink = useMutation({
    mutationFn: (provider: ProviderId) => apiClient.unlinkAccount(provider),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.session })
    },
  })
  const signOut = useMutation({
    mutationFn: () => apiClient.signOut(),
    onSuccess: () => {
      forgetSignedInData(queryClient)
    },
  })

  /** 連携を開始する。サインインと同じくブラウザから遷移させる。 */
  const startLink = (provider: ProviderId) => {
    redirect.start(
      () => apiClient.linkSocialUrl(provider),
      '連携を開始できませんでした。',
    )
  }

  /**
   * 別アカウントとの統合を始める。
   * 連携ではなく通常のログインを通す。連携は「未使用のプロバイダ」しか
   * 受け付けないため、既に別アカウントで使われている場合に進めないため。
   */
  const startMerge = (provider: ProviderId) => {
    redirect.start(async () => {
      await apiClient.startMerge()
      return apiClient.signInUrl(provider, '/auth/merge')
    }, '統合を開始できませんでした。')
  }

  const failure =
    redirect.error ??
    (unlink.isError ? unlink.error.message : null) ??
    (signOut.isError ? signOut.error.message : null)

  return (
    <aside className="account-bar">
      <p className="account-who">
        {account.user.name}
        <span>連携中: {providerLabels(account.providers)}</span>
      </p>
      <div className="account-actions">
        <button
          type="button"
          disabled={signOut.isPending}
          onClick={() => signOut.mutate()}
        >
          ログアウト
        </button>
      </div>

      <details className="account-manage">
        <summary>アカウントの管理</summary>
        <div className="account-actions">
          {unlinked.map((provider) => (
            <button
              key={provider.id}
              type="button"
              disabled={redirect.pending}
              onClick={() => startLink(provider.id)}
            >
              {provider.label}を連携
            </button>
          ))}
          {unlinked.map((provider) => (
            <button
              key={`merge-${provider.id}`}
              type="button"
              disabled={redirect.pending}
              onClick={() => startMerge(provider.id)}
            >
              {provider.label}の別アカウントとまとめる
            </button>
          ))}
          {/* 最後の1つを解除するとログイン手段を失うため、複数あるときだけ出す。 */}
          {account.providers.length < 2
            ? null
            : linked.map((provider) => (
                <button
                  key={provider.id}
                  type="button"
                  disabled={unlink.isPending}
                  onClick={() => unlink.mutate(provider.id)}
                >
                  {provider.label}の連携を解除
                </button>
              ))}
          <Link className="account-delete-link" to="/account/delete">
            アカウントを削除
          </Link>
        </div>
        {account.providers.length < 2 ? (
          // ボタンを黙って隠すと「壊れている」ように見える。理由を書く。
          <p className="account-note">
            ログイン方法が1つだけのため、連携は解除できません。
            もう1つ連携すると解除できるようになります。
          </p>
        ) : null}
      </details>
      {failure === null ? null : (
        <p className="form-error" role="alert">
          {failure}
        </p>
      )}
    </aside>
  )
}
