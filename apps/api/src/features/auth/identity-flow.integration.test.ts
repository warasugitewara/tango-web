/**
 * Phase 1の識別フローをHTTP境界から通しで検証する。
 * 実DB (infra/test/compose.yml) を使い、Better AuthとTurnstileだけを差し替える。
 */

import { Temporal } from '@js-temporal/polyfill'
import {
  createPrincipalRepository,
  type DatabaseHandle,
  type PrincipalRepository,
  schema,
} from '@tango/db'
import {
  createTestDatabase,
  dumpIdentityText,
  resetIdentityTables,
} from '@tango/db/test'
import { v7 as uuidv7 } from 'uuid'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { createApp } from '../../app'
import type { FormalSession } from './actor-resolver'
import { createActorResolver } from './actor-resolver'
import {
  createGuestService,
  createGuestTokenCodec,
  GUEST_COOKIE_NAME,
} from './guest-service'
import { createIdentityCompletionService } from './identity-completion-service'

const TEST_PEPPER = 'identity-flow-integration-pepper'

let handle: DatabaseHandle
let repository: PrincipalRepository
let app: ReturnType<typeof createApp>

let currentInstant: Temporal.Instant
let currentFormalSession: FormalSession | null

const codec = createGuestTokenCodec(TEST_PEPPER)

/** Set-Cookieヘッダからゲストトークンの生値を取り出す。 */
function readGuestCookie(response: Response): string | null {
  const header = response.headers.get('set-cookie')
  if (header === null) {
    return null
  }
  const match = header.match(new RegExp(`${GUEST_COOKIE_NAME}=([^;]*)`))
  return match?.[1] ?? null
}

async function insertUser(userId: string): Promise<void> {
  await handle.db.insert(schema.user).values({
    id: userId,
    name: 'テスト太郎',
    email: `${userId}@example.com`,
    emailVerified: true,
  })
}

async function startGuest(): Promise<{ response: Response; rawToken: string }> {
  const response = await app.request('/api/guest/start', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ turnstileToken: 'valid-token' }),
  })
  const rawToken = readGuestCookie(response)

  if (rawToken === null || rawToken === '') {
    throw new Error('ゲストCookieが発行されませんでした。')
  }

  return { response, rawToken }
}

async function completeIdentity(
  guestRawToken: string | null,
  mergeKey: string,
): Promise<Response> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  }

  if (guestRawToken !== null) {
    headers.cookie = `${GUEST_COOKIE_NAME}=${guestRawToken}`
  }

  return app.request('/api/identity/complete', {
    method: 'POST',
    headers,
    body: JSON.stringify({ mergeKey }),
  })
}

beforeAll(async () => {
  handle = await createTestDatabase()
  repository = createPrincipalRepository(handle.db)

  const clock = { now: () => currentInstant }

  app = createApp({
    clock,
    guestService: createGuestService({
      repository,
      clock,
      turnstile: { verify: async () => true },
      tokenCodec: codec,
    }),
    actorResolver: createActorResolver({
      repository,
      formalSessionReader: { read: async () => currentFormalSession },
    }),
    identityCompletionService: createIdentityCompletionService({
      repository,
      tokenCodec: codec,
    }),
    authHandler: async () => new Response(null, { status: 204 }),
    cookieSecure: true,
  })
})

afterAll(async () => {
  await handle.close()
})

beforeEach(async () => {
  await resetIdentityTables(handle.db)
  currentInstant = Temporal.Instant.from('2026-08-01T01:00:00Z')
  currentFormalSession = null
})

describe('identity flow', () => {
  test('promotes a guest into a formal principal and stays idempotent', async () => {
    const { response: started, rawToken } = await startGuest()
    expect(started.status).toBe(200)

    // ゲストとして解決できる。
    const guestSession = await app.request('/api/session', {
      headers: { cookie: `${GUEST_COOKIE_NAME}=${rawToken}` },
    })
    expect(await guestSession.json()).toMatchObject({
      authenticated: true,
      kind: 'guest',
    })

    const guestRecord = await repository.findActiveGuestByTokenHash(
      codec.hash(rawToken),
      new Date(currentInstant.epochMilliseconds),
    )
    expect(guestRecord).not.toBeNull()

    // Better Authのログインが完了した状態にする。
    await insertUser('user-flow-promote')
    currentFormalSession = {
      userId: 'user-flow-promote',
      name: 'テスト太郎',
      image: null,
      providers: ['google'],
    }

    const mergeKey = uuidv7()
    const completed = await completeIdentity(rawToken, mergeKey)

    expect(completed.status).toBe(200)
    expect(await completed.json()).toEqual({ outcome: 'promoted' })
    expect(completed.headers.get('set-cookie')).toContain('Max-Age=0')

    // 同じmergeKeyの再送は同じ結果に収束する。
    const replayed = await completeIdentity(null, mergeKey)
    expect(replayed.status).toBe(200)
    expect(await replayed.json()).toEqual({ outcome: 'existing' })

    const principal = await repository.findByUserId('user-flow-promote')
    expect(principal?.id).toBe(guestRecord?.principalId)
    expect(principal?.kind).toBe('user')

    // 正式セッションではユーザービューを返す。
    const userSession = await app.request('/api/session')
    expect(await userSession.json()).toMatchObject({
      authenticated: true,
      kind: 'user',
      user: { id: 'user-flow-promote' },
      providers: ['google'],
    })
  })

  test('merges a later guest into the existing formal principal', async () => {
    await insertUser('user-flow-merge')
    currentFormalSession = {
      userId: 'user-flow-merge',
      name: 'テスト太郎',
      image: null,
      providers: ['github'],
    }

    const created = await completeIdentity(null, uuidv7())
    expect(await created.json()).toEqual({ outcome: 'created' })
    const formal = await repository.findByUserId('user-flow-merge')

    // 別ブラウザでゲストを開始した状況を作る。
    currentFormalSession = null
    const { rawToken } = await startGuest()
    const guestRecord = await repository.findActiveGuestByTokenHash(
      codec.hash(rawToken),
      new Date(currentInstant.epochMilliseconds),
    )
    expect(guestRecord?.principalId).not.toBe(formal?.id)

    currentFormalSession = {
      userId: 'user-flow-merge',
      name: 'テスト太郎',
      image: null,
      providers: ['github'],
    }
    const merged = await completeIdentity(rawToken, uuidv7())

    expect(merged.status).toBe(200)
    expect(await merged.json()).toEqual({ outcome: 'merged' })
    expect(merged.headers.get('set-cookie')).toContain('Max-Age=0')

    // 取り込まれたゲストセッションは失効し、ログアウト後もCookieを再利用できない。
    currentFormalSession = null
    const reused = await app.request('/api/session', {
      headers: { cookie: `${GUEST_COOKIE_NAME}=${rawToken}` },
    })
    expect(reused.status).toBe(401)

    // principalは既存の正式principalのまま変わらない。
    const after = await repository.findByUserId('user-flow-merge')
    expect(after?.id).toBe(formal?.id)
  })

  test('rejects identity completion without a Better Auth session', async () => {
    const { rawToken } = await startGuest()

    const response = await completeIdentity(rawToken, uuidv7())

    expect(response.status).toBe(401)

    // 失敗時にゲストCookieは消さない。
    expect(response.headers.get('set-cookie')).toBeNull()
    await expect(
      repository.findActiveGuestByTokenHash(
        codec.hash(rawToken),
        new Date(currentInstant.epochMilliseconds),
      ),
    ).resolves.not.toBeNull()
  })

  test('never stores the raw guest token anywhere in the database', async () => {
    const { rawToken } = await startGuest()

    await insertUser('user-flow-hash')
    currentFormalSession = {
      userId: 'user-flow-hash',
      name: 'テスト太郎',
      image: null,
      providers: ['google'],
    }
    await completeIdentity(rawToken, uuidv7())

    const dump = await dumpIdentityText(handle.db)

    // 保存されているのはHMACハッシュだけで、生トークンはどこにも残らない。
    expect(dump).toContain(codec.hash(rawToken))
    expect(dump).not.toContain(rawToken)
  })
})
