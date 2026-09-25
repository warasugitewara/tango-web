import { createHmac, timingSafeEqual } from 'node:crypto'
import type { Temporal } from '@js-temporal/polyfill'

/**
 * 統合の証明が有効な時間。OAuthを1往復する間だけ持てばよい。
 * 長く持たせるほど、放置された証明を後から拾われる余地が増える。
 */
const INTENT_LIFETIME_MS = 10 * 60 * 1000

/**
 * 「この人は統合の開始時点で userId のアカウントを操作できた」という証明。
 * 統合キーを一緒に載せることで、再送しても同じ統合として扱える。
 */
export type MergeIntent = {
  userId: string
  mergeKey: string
}

type IntentPayload = MergeIntent & { expiresAt: number }

export type MergeIntentCodec = {
  sign(intent: MergeIntent, now: Temporal.Instant): string
  verify(token: string, now: Temporal.Instant): MergeIntent | null
}

function isIntentPayload(value: unknown): value is IntentPayload {
  if (typeof value !== 'object' || value === null) {
    return false
  }

  const record: Record<string, unknown> = { ...value }

  return (
    typeof record.userId === 'string' &&
    typeof record.mergeKey === 'string' &&
    typeof record.expiresAt === 'number' &&
    Number.isFinite(record.expiresAt)
  )
}

export function createMergeIntentCodec(secret: string): MergeIntentCodec {
  if (secret === '') {
    throw new Error('統合の証明に使う鍵が空です。')
  }

  const signatureOf = (payload: string): string =>
    createHmac('sha256', secret).update(payload).digest('base64url')

  return {
    sign(intent, now) {
      const payload = Buffer.from(
        JSON.stringify({
          userId: intent.userId,
          mergeKey: intent.mergeKey,
          expiresAt: now.epochMilliseconds + INTENT_LIFETIME_MS,
        }),
      ).toString('base64url')

      return `${payload}.${signatureOf(payload)}`
    },

    verify(token, now) {
      const parts = token.split('.')
      const [payload, provided] = parts
      if (
        parts.length !== 2 ||
        payload === undefined ||
        provided === undefined
      ) {
        return null
      }

      const providedBytes = Buffer.from(provided)
      const expectedBytes = Buffer.from(signatureOf(payload))
      // 長さが違うと timingSafeEqual が例外を投げるため、先に弾く。
      if (providedBytes.length !== expectedBytes.length) {
        return null
      }
      if (!timingSafeEqual(providedBytes, expectedBytes)) {
        return null
      }

      let parsed: unknown
      try {
        parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
      } catch {
        return null
      }

      if (!isIntentPayload(parsed)) {
        return null
      }
      if (parsed.expiresAt <= now.epochMilliseconds) {
        return null
      }

      return { userId: parsed.userId, mergeKey: parsed.mergeKey }
    },
  }
}
