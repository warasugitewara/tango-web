import type { Temporal } from '@js-temporal/polyfill'

/**
 * リクエストの実行主体。ゲストも正式利用者も必ず `principalId` を持ち、
 * ドメインデータの所有者はこのIDで一意に決まる。
 */
export type Actor =
  | { kind: 'guest'; principalId: string; guestSessionId: string }
  | { kind: 'user'; principalId: string; userId: string }

/** サービス層へ渡す実行文脈。時刻はここから取得し、直接 now を読まない。 */
export type ServiceContext = {
  actor: Actor
  requestId: string
  now: Temporal.Instant
}
