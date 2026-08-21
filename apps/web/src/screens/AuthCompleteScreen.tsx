import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { apiClient } from '../api/client'

/**
 * 冪等性キーの保管場所。
 * 通信断で画面を開き直したときに新しい鍵を作ると、
 * 二重統合や誤った競合を招く。同じタブの再試行では同じ鍵を使う。
 */
export const MERGE_KEY_STORAGE_KEY = 'tango.identity.mergeKey'

/** 時系列で並ぶUUIDv7。APIが冪等性キーとして要求する形式。 */
function createMergeKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  const milliseconds = BigInt(Date.now())

  for (let index = 0; index < 6; index += 1) {
    bytes[index] = Number((milliseconds >> BigInt(8 * (5 - index))) & 0xffn)
  }

  const versioned = bytes[6]
  const variant = bytes[8]

  if (versioned === undefined || variant === undefined) {
    throw new Error('乱数を取得できませんでした。')
  }

  bytes[6] = (versioned & 0x0f) | 0x70
  bytes[8] = (variant & 0x3f) | 0x80

  const hex = [...bytes]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')

  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-')
}

/** 保持済みの鍵があれば使い、無ければ作って保持する。 */
function resolveMergeKey(): string {
  const stored = sessionStorage.getItem(MERGE_KEY_STORAGE_KEY)

  if (stored !== null && stored !== '') {
    return stored
  }

  const created = createMergeKey()
  sessionStorage.setItem(MERGE_KEY_STORAGE_KEY, created)
  return created
}

export function AuthCompleteScreen() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [failure, setFailure] = useState<string | null>(null)
  // React 18以降のStrict Modeは効果を2回実行する。二重送信を避ける。
  const started = useRef(false)

  useEffect(() => {
    if (started.current) {
      return
    }
    started.current = true

    const complete = async () => {
      try {
        await apiClient.completeIdentity(resolveMergeKey())
        sessionStorage.removeItem(MERGE_KEY_STORAGE_KEY)
        await queryClient.invalidateQueries({ queryKey: ['session'] })
        await navigate('/', { replace: true })
      } catch (error) {
        // 失敗しても鍵は残す。同じ鍵で再試行すれば二重に統合されない。
        setFailure(
          error instanceof Error
            ? error.message
            : 'ログインを完了できませんでした。',
        )
      }
    }

    void complete()
  }, [navigate, queryClient])

  if (failure === null) {
    return (
      <main className="shell">
        <p>ログインを完了しています…</p>
      </main>
    )
  }

  return (
    <main className="shell error-panel">
      <h1>ログインを完了できませんでした</h1>
      <p>{failure}</p>
      <p>
        <Link to="/">デッキ一覧へ戻る</Link>
      </p>
    </main>
  )
}
