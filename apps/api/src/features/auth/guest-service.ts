import { createHmac } from 'node:crypto'
import { Temporal } from '@js-temporal/polyfill'
import type { PrincipalRepository } from '@tango/db'
import { type Actor, AppError, learningDayOf } from '@tango/shared'

/** 時刻の唯一の入口。サービス層は直接 now を読まない。 */
export interface Clock {
  now(): Temporal.Instant
}

export function createSystemClock(): Clock {
  return { now: () => Temporal.Now.instant() }
}

export interface TurnstileVerifier {
  verify(input: { token: string; remoteIp: string | null }): Promise<boolean>
}

export interface GuestTokenCodec {
  generate(): { rawToken: string; tokenHash: string }
  hash(rawToken: string): string
}

export const GUEST_COOKIE_NAME = 'tango_guest'

export const GUEST_SESSION_DAYS = 90

export const GUEST_SESSION_MAX_AGE_SECONDS = 24 * 60 * 60 * GUEST_SESSION_DAYS

export const GUEST_RISK_NOTICE =
  'ゲストの学習データはこのブラウザだけに紐づきます。' +
  'Cookieを削除すると復元できません。90日間アクセスがないと自動的に削除されます。' +
  'GoogleまたはGitHubでログインすると、いつでも引き継げます。'

/** 生トークンの長さ。32バイトをbase64urlで表現する。 */
const GUEST_TOKEN_BYTES = 32

export type GuestActor = Extract<Actor, { kind: 'guest' }>

export type GuestStartResult = {
  rawToken: string
  actor: GuestActor
  expiresAt: Temporal.Instant
  warning: string
}

export type GuestResolution = {
  actor: GuestActor
  expiresAt: Temporal.Instant
}

export interface GuestService {
  start(input: {
    turnstileToken: string
    remoteIp: string | null
  }): Promise<GuestStartResult>
  resolve(rawToken: string): Promise<GuestResolution>
  revoke(rawToken: string): Promise<void>
}

/**
 * ゲストトークンの生成とハッシュ化。
 * 生トークンはCookieにしか存在せず、保存されるのはHMAC-SHA-256の結果だけ。
 * ペッパーはDBとは別経路のシークレットから注入する。
 */
export function createGuestTokenCodec(pepper: string): GuestTokenCodec {
  if (pepper === '') {
    throw new Error('ゲストトークンのペッパーが空です。')
  }

  const hash = (rawToken: string): string =>
    createHmac('sha256', pepper).update(rawToken).digest('hex')

  return {
    hash,
    generate() {
      const bytes = new Uint8Array(GUEST_TOKEN_BYTES)
      crypto.getRandomValues(bytes)
      const rawToken = Buffer.from(bytes).toString('base64url')
      return { rawToken, tokenHash: hash(rawToken) }
    },
  }
}

export type GuestServiceDependencies = {
  repository: PrincipalRepository
  clock: Clock
  turnstile: TurnstileVerifier
  tokenCodec: GuestTokenCodec
}

function toDate(instant: Temporal.Instant): Date {
  return new Date(instant.epochMilliseconds)
}

function toInstant(value: Date): Temporal.Instant {
  return Temporal.Instant.fromEpochMilliseconds(value.getTime())
}

export function createGuestService(
  dependencies: GuestServiceDependencies,
): GuestService {
  const { repository, clock, turnstile, tokenCodec } = dependencies

  const expiryFrom = (now: Temporal.Instant): Temporal.Instant =>
    now.add({ hours: 24 * GUEST_SESSION_DAYS })

  return {
    async start({ turnstileToken, remoteIp }) {
      // 検証に成功するまでDBへは一切書き込まない。
      const verified = await turnstile.verify({
        token: turnstileToken,
        remoteIp,
      })

      if (!verified) {
        throw new AppError('VALIDATION_FAILED', {
          publicMessage:
            '認証チャレンジの確認に失敗しました。ページを再読み込みしてやり直してください。',
        })
      }

      const now = clock.now()
      const expiresAt = expiryFrom(now)
      const { rawToken, tokenHash } = tokenCodec.generate()

      const session = await repository.createGuest({
        tokenHash,
        now: toDate(now),
        expiresAt: toDate(expiresAt),
      })

      return {
        rawToken,
        actor: {
          kind: 'guest',
          principalId: session.principalId,
          guestSessionId: session.id,
        },
        expiresAt,
        warning: GUEST_RISK_NOTICE,
      }
    },

    async resolve(rawToken) {
      const now = clock.now()
      const session = await repository.findActiveGuestByTokenHash(
        tokenCodec.hash(rawToken),
        toDate(now),
      )

      if (session === null) {
        throw new AppError('UNAUTHENTICATED')
      }

      let expiresAt = toInstant(session.expiresAt)

      // 学習日 (04:00 JST 起点) ごとに一度だけ延長する。書き込み回数を抑える。
      if (learningDayOf(toInstant(session.lastSeenAt)) !== learningDayOf(now)) {
        expiresAt = expiryFrom(now)
        await repository.touchGuest({
          sessionId: session.id,
          now: toDate(now),
          expiresAt: toDate(expiresAt),
        })
      }

      return {
        actor: {
          kind: 'guest',
          principalId: session.principalId,
          guestSessionId: session.id,
        },
        expiresAt,
      }
    },

    async revoke(rawToken) {
      const now = clock.now()
      const session = await repository.findActiveGuestByTokenHash(
        tokenCodec.hash(rawToken),
        toDate(now),
      )

      if (session !== null) {
        await repository.revokeGuest(session.id, toDate(now))
      }
    },
  }
}
