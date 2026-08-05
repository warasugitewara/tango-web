/**
 * Phase 1の識別フローをHTTP境界から通しで検証する。
 * 実DB (infra/test/compose.yml) を使い、Better AuthとTurnstileだけを差し替える。
 */

import { Temporal } from '@js-temporal/polyfill'
import {
  createPrincipalRepository,
  type PrincipalRepository,
  schema,
} from '@tango/db'
import {
  createTestDatabase,
  dumpIdentityText,
  resetIdentityTables,
  type TestDatabaseHandle,
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
  GUEST_SESSION_DAYS,
  GUEST_SESSION_MAX_AGE_SECONDS,
} from './guest-service'
import { createIdentityCompletionService } from './identity-completion-service'

const TEST_PEPPER = 'identity-flow-integration-pepper'

let handle: TestDatabaseHandle | undefined
let repository: PrincipalRepository
let app: ReturnType<typeof createApp>

let currentInstant: Temporal.Instant
let currentFormalSession: FormalSession | null

const codec = createGuestTokenCodec(TEST_PEPPER)

function database(): TestDatabaseHandle {
  if (handle === undefined) {
    throw new Error('テストDBが初期化されていません。')
  }
  return handle
}

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
  await database()
    .db.insert(schema.user)
    .values({
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
  repository = createPrincipalRepository(database().db)

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
  await handle?.close()
})

beforeEach(async () => {
  await resetIdentityTables(database())
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
    expect(await completed.json()).toEqual({
      actor: {
        kind: 'user',
        principalId: guestRecord?.principalId,
        userId: 'user-flow-promote',
      },
      outcome: 'promoted',
    })
    expect(completed.headers.get('set-cookie')).toContain('Max-Age=0')

    // 成功時にゲストsessionが失効したあとでも、同じ入力tokenの再送は
    // 同じsource hashになるため、同じ結果へ収束する。
    const replayed = await completeIdentity(rawToken, mergeKey)
    expect(replayed.status).toBe(200)
    expect(await replayed.json()).toMatchObject({ outcome: 'existing' })

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
    expect(await created.json()).toMatchObject({ outcome: 'created' })
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
    expect(await merged.json()).toEqual({
      actor: {
        kind: 'user',
        principalId: formal?.id,
        userId: 'user-flow-merge',
      },
      outcome: 'merged',
    })
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

    // 取り込み元のゲストprincipalは残らない。
    const remaining = await database()
      .db.select({ id: schema.principals.id })
      .from(schema.principals)
    expect(remaining.map((row) => row.id)).toEqual([formal?.id])
  })

  test('preserves a different guest cookie and session after merge key conflict', async () => {
    await insertUser('user-flow-source-conflict')
    currentFormalSession = {
      userId: 'user-flow-source-conflict',
      name: 'テスト太郎',
      image: null,
      providers: ['google'],
    }
    expect((await completeIdentity(null, uuidv7())).status).toBe(200)

    currentFormalSession = null
    const firstGuest = await startGuest()
    currentFormalSession = {
      userId: 'user-flow-source-conflict',
      name: 'テスト太郎',
      image: null,
      providers: ['google'],
    }
    const mergeKey = uuidv7()
    expect((await completeIdentity(firstGuest.rawToken, mergeKey)).status).toBe(
      200,
    )

    currentFormalSession = null
    const secondGuest = await startGuest()
    const secondGuestRecord = await repository.findActiveGuestByTokenHash(
      codec.hash(secondGuest.rawToken),
      new Date(currentInstant.epochMilliseconds),
    )
    expect(secondGuestRecord).not.toBeNull()

    currentFormalSession = {
      userId: 'user-flow-source-conflict',
      name: 'テスト太郎',
      image: null,
      providers: ['google'],
    }
    const conflicted = await completeIdentity(secondGuest.rawToken, mergeKey)

    expect(conflicted.status).toBe(409)
    expect(await conflicted.json()).toMatchObject({
      error: { code: 'CONFLICT' },
    })
    expect(conflicted.headers.get('set-cookie')).toBeNull()

    currentFormalSession = null
    const preservedSession = await app.request('/api/session', {
      headers: {
        cookie: `${GUEST_COOKIE_NAME}=${secondGuest.rawToken}`,
      },
    })
    expect(preservedSession.status).toBe(200)
    expect(await preservedSession.json()).toMatchObject({
      authenticated: true,
      kind: 'guest',
    })
    const preservedGuest = await repository.findActiveGuestByTokenHash(
      codec.hash(secondGuest.rawToken),
      new Date(currentInstant.epochMilliseconds),
    )
    expect(preservedGuest?.principalId).toBe(secondGuestRecord?.principalId)
  })

  test('rejects a merge key already recorded for another user', async () => {
    await insertUser('user-flow-owner')
    await insertUser('user-flow-other')

    currentFormalSession = {
      userId: 'user-flow-owner',
      name: 'テスト太郎',
      image: null,
      providers: ['google'],
    }
    const mergeKey = uuidv7()
    expect((await completeIdentity(null, mergeKey)).status).toBe(200)

    // 他人の冪等性キーを掴んでも、相手のprincipalへは到達できない。
    currentFormalSession = {
      userId: 'user-flow-other',
      name: 'テスト次郎',
      image: null,
      providers: ['github'],
    }
    const stolen = await completeIdentity(null, mergeKey)

    expect(stolen.status).toBe(409)
    expect(await stolen.json()).toMatchObject({ error: { code: 'CONFLICT' } })
    expect(await repository.findByUserId('user-flow-other')).toBeNull()
  })

  test('never replaces the session of an existing guest', async () => {
    const { rawToken } = await startGuest()
    const before = await repository.findActiveGuestByTokenHash(
      codec.hash(rawToken),
      new Date(currentInstant.epochMilliseconds),
    )
    expect(before).not.toBeNull()

    // 同じブラウザから再度開始しても、既存のゲストをそのまま返す。
    const again = await app.request('/api/guest/start', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: `${GUEST_COOKIE_NAME}=${rawToken}`,
      },
      body: JSON.stringify({ turnstileToken: 'valid-token' }),
    })

    expect(again.status).toBe(200)
    expect(again.headers.get('set-cookie')).toBeNull()

    const after = await repository.findActiveGuestByTokenHash(
      codec.hash(rawToken),
      new Date(currentInstant.epochMilliseconds),
    )
    expect(after?.principalId).toBe(before?.principalId)

    // 到達不能な孤児principalを作らない。
    const allPrincipals = await database()
      .db.select({ id: schema.principals.id })
      .from(schema.principals)
    expect(allPrincipals).toHaveLength(1)
  })

  test('keeps a daily guest reachable past the 90 day cookie lifetime', async () => {
    const { response: started, rawToken } = await startGuest()
    expect(started.headers.get('set-cookie')).toContain(
      `Max-Age=${GUEST_SESSION_MAX_AGE_SECONDS}`,
    )

    const createdAt = currentInstant

    // 80日後に再訪する。DB側の期限もCookieのMax-Ageも延長されるはず。
    currentInstant = createdAt.add({ hours: 24 * 80 })
    const revisit = await app.request('/api/session', {
      headers: { cookie: `${GUEST_COOKIE_NAME}=${rawToken}` },
    })

    expect(revisit.status).toBe(200)
    expect(revisit.headers.get('set-cookie')).toContain(
      `${GUEST_COOKIE_NAME}=${rawToken}`,
    )
    expect(revisit.headers.get('set-cookie')).toContain(
      `Max-Age=${GUEST_SESSION_MAX_AGE_SECONDS}`,
    )

    const extended = await repository.findActiveGuestByTokenHash(
      codec.hash(rawToken),
      new Date(currentInstant.epochMilliseconds),
    )
    expect(extended?.expiresAt.getTime()).toBe(
      currentInstant.add({ hours: 24 * GUEST_SESSION_DAYS }).epochMilliseconds,
    )

    // 作成から90日を超えても、延長が続いている限り到達できる。
    currentInstant = createdAt.add({ hours: 24 * 160 })
    const later = await app.request('/api/session', {
      headers: { cookie: `${GUEST_COOKIE_NAME}=${rawToken}` },
    })

    expect(later.status).toBe(200)
    expect(await later.json()).toMatchObject({
      authenticated: true,
      kind: 'guest',
    })
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

  test('never stores the raw guest token anywhere in the database, even after the source principal is deleted by a merge', async () => {
    await insertUser('user-flow-hash')
    currentFormalSession = {
      userId: 'user-flow-hash',
      name: 'テスト太郎',
      image: null,
      providers: ['google'],
    }

    // 先にゲストなしで正式principalを作っておく。
    expect((await completeIdentity(null, uuidv7())).status).toBe(200)
    const formal = await repository.findByUserId('user-flow-hash')

    // 別ブラウザで新しくゲストを開始し、merged経路を発生させる。
    currentFormalSession = null
    const { rawToken } = await startGuest()
    const guestRecord = await repository.findActiveGuestByTokenHash(
      codec.hash(rawToken),
      new Date(currentInstant.epochMilliseconds),
    )
    expect(guestRecord).not.toBeNull()
    expect(guestRecord?.principalId).not.toBe(formal?.id)

    currentFormalSession = {
      userId: 'user-flow-hash',
      name: 'テスト太郎',
      image: null,
      providers: ['google'],
    }
    const mergeKey = uuidv7()
    const merged = await completeIdentity(rawToken, mergeKey)

    expect(merged.status).toBe(200)
    expect(await merged.json()).toMatchObject({ outcome: 'merged' })

    // 取り込み元のゲストprincipalが実際に削除されたことを確認する。
    const remainingPrincipalIds = (
      await database()
        .db.select({ id: schema.principals.id })
        .from(schema.principals)
    ).map((row) => row.id)
    expect(remainingPrincipalIds).not.toContain(guestRecord?.principalId)

    const merges = await database()
      .db.select({
        mergeKey: schema.identityMerges.mergeKey,
        sourceGuestTokenHash: schema.identityMerges.sourceGuestTokenHash,
      })
      .from(schema.identityMerges)
    const merge = merges.find((candidate) => candidate.mergeKey === mergeKey)

    // source principalが削除された後もHMAC fingerprintは入力と完全一致する。
    expect(merge?.sourceGuestTokenHash).toBe(codec.hash(rawToken))
    expect(JSON.stringify(merge)).not.toContain(rawToken)

    const dump = await dumpIdentityText(database().db)

    // 保存されているのはHMACハッシュだけで、生トークンはどこにも残らない。
    expect(dump).toContain(codec.hash(rawToken))
    expect(dump).not.toContain(rawToken)
  })
})
