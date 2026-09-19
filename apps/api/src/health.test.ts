import { Temporal } from '@js-temporal/polyfill'
import { describe, expect, test } from 'vitest'
import { createApp } from './app'
import type { ActorResolver } from './features/auth/actor-resolver'
import type { GuestService } from './features/auth/guest-service'

const NOW = Temporal.Instant.from('2026-09-19T03:00:00Z')

function createHarness(readiness?: () => Promise<boolean>) {
  const guestService: GuestService = {
    async start() {
      throw new Error('このテストでは使用しない。')
    },
    async resolve() {
      throw new Error('このテストでは使用しない。')
    },
    async revoke() {
      // 何もしない。
    },
  }
  const actorResolver: ActorResolver = {
    async resolveFormal() {
      return null
    },
  }

  return createApp({
    clock: { now: () => NOW },
    guestService,
    actorResolver,
    identityCompletionService: {
      async complete() {
        throw new Error('このテストでは使用しない。')
      },
    },
    authHandler: async () => new Response(null, { status: 204 }),
    cookieSecure: true,
    appOrigin: 'https://tango.warasugi.com',
    ...(readiness === undefined ? {} : { readiness }),
  })
}

describe('/health/live', () => {
  test('受け入れ可否に関わらず200を返す', async () => {
    // 死活はプロセスの生存だけを表す。DBの状態で落とさない。
    const response = await createHarness(async () => false).request(
      '/health/live',
    )

    expect(response.status).toBe(200)
  })
})

describe('/health/ready', () => {
  test('受け入れ可能なら200を返す', async () => {
    const response = await createHarness(async () => true).request(
      '/health/ready',
    )

    expect(response.status).toBe(200)
  })

  test('受け入れ不可なら503を返す', async () => {
    const response = await createHarness(async () => false).request(
      '/health/ready',
    )

    expect(response.status).toBe(503)
  })

  test('判定が例外を投げても503を返す', async () => {
    const response = await createHarness(async () => {
      throw new Error('接続できない')
    }).request('/health/ready')

    expect(response.status).toBe(503)
  })

  test('判定を渡していなければ503を返す', async () => {
    // 監視から見て「まだ受けられない」で正しい。404では停止と区別できない。
    const response = await createHarness().request('/health/ready')

    expect(response.status).toBe(503)
  })

  test('理由を応答へ出さない', async () => {
    // 接続先や構造が漏れる。監視には状態だけで足りる。
    const response = await createHarness(async () => {
      throw new Error('postgres://tango:secret@db:5432/tango へ接続できない')
    }).request('/health/ready')

    expect(await response.text()).not.toContain('postgres')
  })
})
