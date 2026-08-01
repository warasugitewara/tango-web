import type { Temporal } from '@js-temporal/polyfill'
import type {
  GuestSessionRecord,
  PrincipalRecord,
  PrincipalRepository,
} from '@tango/db'
import { AppError, parseJstInstant } from '@tango/shared'
import { beforeEach, describe, expect, test } from 'vitest'
import {
  createGuestService,
  createGuestTokenCodec,
  GUEST_RISK_NOTICE,
  GUEST_SESSION_DAYS,
  type GuestService,
} from './guest-service'

type FakeRepository = {
  repository: PrincipalRepository
  sessions: GuestSessionRecord[]
  writeCount: () => number
  touchCount: () => number
}

function createFakeRepository(): FakeRepository {
  const principals: PrincipalRecord[] = []
  const sessions: GuestSessionRecord[] = []
  let writes = 0
  let touches = 0

  const repository: PrincipalRepository = {
    async findByUserId(userId) {
      return principals.find((principal) => principal.userId === userId) ?? null
    },
    async findActiveGuestByTokenHash(tokenHash, now) {
      return (
        sessions.find(
          (session) =>
            session.tokenHash === tokenHash &&
            session.revokedAt === null &&
            session.expiresAt.getTime() > now.getTime(),
        ) ?? null
      )
    },
    async createGuest({ tokenHash, now, expiresAt }) {
      writes += 1
      const principal: PrincipalRecord = {
        id: `principal-${principals.length + 1}`,
        kind: 'guest',
        userId: null,
        createdAt: now,
        updatedAt: now,
      }
      principals.push(principal)

      const session: GuestSessionRecord = {
        id: `session-${sessions.length + 1}`,
        principalId: principal.id,
        tokenHash,
        lastSeenAt: now,
        expiresAt,
        revokedAt: null,
      }
      sessions.push(session)
      return session
    },
    async completeIdentity() {
      throw new Error('ゲストサービスのテストでは使用しない。')
    },
    async touchGuest({ sessionId, now, expiresAt }) {
      writes += 1
      touches += 1
      const session = sessions.find((candidate) => candidate.id === sessionId)
      if (session !== undefined) {
        session.lastSeenAt = now
        session.expiresAt = expiresAt
      }
    },
    async revokeGuest(sessionId, now) {
      writes += 1
      const session = sessions.find((candidate) => candidate.id === sessionId)
      if (session !== undefined) {
        session.revokedAt = now
      }
    },
    async purgeExpiredGuests() {
      throw new Error('ゲストサービスのテストでは使用しない。')
    },
  }

  return {
    repository,
    sessions,
    writeCount: () => writes,
    touchCount: () => touches,
  }
}

const TEST_PEPPER = 'test-guest-token-pepper'

describe('GuestService', () => {
  let fake: FakeRepository
  let currentInstant: Temporal.Instant
  let turnstileResult: boolean
  let turnstileCalls: Array<{ token: string; remoteIp: string | null }>
  let service: GuestService

  const codec = createGuestTokenCodec(TEST_PEPPER)

  beforeEach(() => {
    fake = createFakeRepository()
    currentInstant = parseJstInstant('2026-08-01T10:00:00+09:00')
    turnstileResult = true
    turnstileCalls = []

    service = createGuestService({
      repository: fake.repository,
      clock: { now: () => currentInstant },
      turnstile: {
        async verify(input) {
          turnstileCalls.push(input)
          return turnstileResult
        },
      },
      tokenCodec: codec,
    })
  })

  test('creates a guest with a 90 day expiry and returns the risk notice', async () => {
    const result = await service.start({
      turnstileToken: 'valid-token',
      remoteIp: '203.0.113.10',
    })

    expect(turnstileCalls).toEqual([
      { token: 'valid-token', remoteIp: '203.0.113.10' },
    ])
    expect(result.actor.kind).toBe('guest')
    expect(result.warning).toBe(GUEST_RISK_NOTICE)
    expect(
      result.expiresAt.since(currentInstant).total({ unit: 'day' }),
    ).toBeCloseTo(GUEST_SESSION_DAYS, 6)
    expect(fake.sessions).toHaveLength(1)
  })

  test('rejects an invalid Turnstile token without touching the database', async () => {
    turnstileResult = false

    await expect(
      service.start({ turnstileToken: 'invalid-token', remoteIp: null }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
    await expect(
      service.start({ turnstileToken: 'invalid-token', remoteIp: null }),
    ).rejects.toBeInstanceOf(AppError)

    expect(fake.writeCount()).toBe(0)
    expect(fake.sessions).toHaveLength(0)
  })

  test('stores only the HMAC derived hash, never the raw token', async () => {
    const result = await service.start({
      turnstileToken: 'valid-token',
      remoteIp: null,
    })
    const [session] = fake.sessions

    expect(session).toBeDefined()
    expect(session?.tokenHash).toBe(codec.hash(result.rawToken))
    expect(session?.tokenHash).not.toBe(result.rawToken)
    expect(session?.tokenHash).toMatch(/^[0-9a-f]{64}$/)
    // 生トークンは32バイトをbase64urlにしたもの。
    expect(result.rawToken).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })

  test('resolves an active guest cookie to a guest actor', async () => {
    const started = await service.start({
      turnstileToken: 'valid-token',
      remoteIp: null,
    })

    const resolution = await service.resolve(started.rawToken)

    expect(resolution.actor.kind).toBe('guest')
    expect(resolution.actor.principalId).toBe(started.actor.principalId)
    expect(resolution.actor.guestSessionId).toBe(started.actor.guestSessionId)
    expect(resolution.expiresAt.toString()).toBe(started.expiresAt.toString())
  })

  test('rejects a revoked cookie as unauthenticated', async () => {
    const started = await service.start({
      turnstileToken: 'valid-token',
      remoteIp: null,
    })
    await service.revoke(started.rawToken)

    await expect(service.resolve(started.rawToken)).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
    })
  })

  test('rejects an expired cookie as unauthenticated', async () => {
    const started = await service.start({
      turnstileToken: 'valid-token',
      remoteIp: null,
    })
    currentInstant = currentInstant.add({
      hours: 24 * (GUEST_SESSION_DAYS + 1),
    })

    await expect(service.resolve(started.rawToken)).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
    })
  })

  test('rejects an unknown cookie as unauthenticated', async () => {
    await expect(service.resolve('unknown-token')).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
    })
  })

  test('extends the session at most once per learning day', async () => {
    const started = await service.start({
      turnstileToken: 'valid-token',
      remoteIp: null,
    })
    const touchesAfterStart = fake.touchCount()

    // 同じ学習日 (04:00 JST 起点) の再訪では延長しない。
    currentInstant = parseJstInstant('2026-08-01T23:30:00+09:00')
    await service.resolve(started.rawToken)
    expect(fake.touchCount()).toBe(touchesAfterStart)

    // 04:00 JST を跨ぐと学習日が変わるので一度だけ延長する。
    currentInstant = parseJstInstant('2026-08-02T04:00:00+09:00')
    await service.resolve(started.rawToken)
    expect(fake.touchCount()).toBe(touchesAfterStart + 1)

    currentInstant = parseJstInstant('2026-08-02T09:00:00+09:00')
    await service.resolve(started.rawToken)
    expect(fake.touchCount()).toBe(touchesAfterStart + 1)

    // 延長後の期限は延長時点のサーバ時刻を起点にする。
    const [session] = fake.sessions
    const extendedFrom = parseJstInstant('2026-08-02T04:00:00+09:00')
    expect(session?.expiresAt.getTime()).toBe(
      extendedFrom.add({ hours: 24 * GUEST_SESSION_DAYS }).epochMilliseconds,
    )
  })
})
