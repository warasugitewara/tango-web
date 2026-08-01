import { z } from 'zod'
import type { TurnstileVerifier } from './guest-service'

const TURNSTILE_VERIFY_URL =
  'https://challenges.cloudflare.com/turnstile/v0/siteverify'

const VERIFY_TIMEOUT_MS = 5_000

const verifyResponseSchema = z.object({
  success: z.boolean(),
})

export type TurnstileClientOptions = {
  /** Cloudflareが発行するシークレット。ファイル経由で読み込んだ値を渡す。 */
  secret: string
  /** テストや疎通確認で差し替えるためのfetch実装。 */
  fetchImplementation?: typeof fetch
}

/**
 * Cloudflare Turnstileのサーバ側検証。
 * 検証に失敗した場合も理由は外部へ返さず、真偽値だけを返す。
 */
export function createTurnstileVerifier(
  options: TurnstileClientOptions,
): TurnstileVerifier {
  const doFetch = options.fetchImplementation ?? fetch

  return {
    async verify({ token, remoteIp }) {
      if (token === '') {
        return false
      }

      const form = new FormData()
      form.set('secret', options.secret)
      form.set('response', token)
      if (remoteIp !== null) {
        form.set('remoteip', remoteIp)
      }

      try {
        const response = await doFetch(TURNSTILE_VERIFY_URL, {
          method: 'POST',
          body: form,
          signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
        })

        if (!response.ok) {
          return false
        }

        const parsed = verifyResponseSchema.safeParse(await response.json())
        return parsed.success && parsed.data.success
      } catch {
        // ネットワーク障害やタイムアウトは検証失敗として扱う。詳細は外へ出さない。
        return false
      }
    },
  }
}
