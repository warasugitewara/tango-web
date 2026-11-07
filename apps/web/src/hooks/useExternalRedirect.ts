import { useCallback, useEffect, useState } from 'react'
import { errorMessage } from '../lib/errors'

/**
 * OAuth のようにブラウザごと別のページへ移る操作。
 * URLを取りに行くあいだは押せないようにし、失敗したら理由を返す。
 */
export function useExternalRedirect() {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // 移動先から「戻る」で帰ると、ページは押した直後の状態のまま復元される
  // （bfcache）。押せないまま固まらないよう、復元時に解除する。
  useEffect(() => {
    const restore = (event: PageTransitionEvent) => {
      if (event.persisted) {
        setPending(false)
      }
    }
    window.addEventListener('pageshow', restore)
    return () => window.removeEventListener('pageshow', restore)
  }, [])

  const start = useCallback(
    (resolveUrl: () => Promise<string>, fallbackMessage: string) => {
      setError(null)
      setPending(true)
      resolveUrl()
        .then((url) => {
          window.location.assign(url)
        })
        .catch((cause: unknown) => {
          setPending(false)
          setError(errorMessage(cause, fallbackMessage))
        })
    },
    [],
  )

  return { start, pending, error }
}
