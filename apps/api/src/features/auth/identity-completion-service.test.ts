import { Temporal } from '@js-temporal/polyfill'
import {
  createPrincipalRepository,
  type DatabaseHandle,
  type PrincipalRepository,
  schema,
} from '@tango/db'
import { createTestDatabase, resetIdentityTables } from '@tango/db/test'
import { v7 as uuidv7 } from 'uuid'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { createGuestService, createGuestTokenCodec } from './guest-service'
import {
  createIdentityCompletionService,
  type IdentityCompletionService,
} from './identity-completion-service'

const TEST_PEPPER = 'identity-completion-test-pepper'
const NOW = Temporal.Instant.from('2026-08-01T01:00:00Z')

let handle: DatabaseHandle
let repository: PrincipalRepository
let service: IdentityCompletionService

const codec = createGuestTokenCodec(TEST_PEPPER)

/** Better Authが作成する user 行だけを用意する。OAuthの往復はここでは扱わない。 */
async function insertUser(userId: string): Promise<void> {
  await handle.db.insert(schema.user).values({
    id: userId,
    name: 'テスト太郎',
    email: `${userId}@example.com`,
    emailVerified: true,
  })
}

async function startGuest(): Promise<string> {
  const guestService = createGuestService({
    repository,
    clock: { now: () => NOW },
    turnstile: { verify: async () => true },
    tokenCodec: codec,
  })
  const started = await guestService.start({
    turnstileToken: 'valid',
    remoteIp: null,
  })
  return started.rawToken
}

beforeAll(async () => {
  handle = await createTestDatabase()
  repository = createPrincipalRepository(handle.db)
  service = createIdentityCompletionService({ repository, tokenCodec: codec })
})

afterAll(async () => {
  await handle.close()
})

beforeEach(async () => {
  await resetIdentityTables(handle.db)
})

describe('IdentityCompletionService', () => {
  test('creates a principal for a new user without a guest cookie', async () => {
    await insertUser('user-created')

    const result = await service.complete({
      userId: 'user-created',
      guestRawToken: null,
      mergeKey: uuidv7(),
      now: NOW,
    })

    expect(result.outcome).toBe('created')
    expect(result.actor).toMatchObject({ kind: 'user', userId: 'user-created' })
  })

  test('promotes the guest principal when the user has none yet', async () => {
    await insertUser('user-promoted')
    const rawToken = await startGuest()
    const guest = await repository.findActiveGuestByTokenHash(
      codec.hash(rawToken),
      new Date(NOW.epochMilliseconds),
    )

    const result = await service.complete({
      userId: 'user-promoted',
      guestRawToken: rawToken,
      mergeKey: uuidv7(),
      now: NOW,
    })

    expect(result.outcome).toBe('promoted')
    expect(result.actor.principalId).toBe(guest?.principalId)
  })

  test('merges a guest principal into an existing formal principal', async () => {
    await insertUser('user-merged')
    await service.complete({
      userId: 'user-merged',
      guestRawToken: null,
      mergeKey: uuidv7(),
      now: NOW,
    })

    const rawToken = await startGuest()
    const result = await service.complete({
      userId: 'user-merged',
      guestRawToken: rawToken,
      mergeKey: uuidv7(),
      now: NOW,
    })

    expect(result.outcome).toBe('merged')

    // 取り込んだゲストセッションは無効化され、再利用できない。
    await expect(
      repository.findActiveGuestByTokenHash(
        codec.hash(rawToken),
        new Date(NOW.epochMilliseconds),
      ),
    ).resolves.toBeNull()
  })

  test('returns the same principal when the callback is replayed', async () => {
    await insertUser('user-replayed')
    const mergeKey = uuidv7()

    const first = await service.complete({
      userId: 'user-replayed',
      guestRawToken: null,
      mergeKey,
      now: NOW,
    })
    const second = await service.complete({
      userId: 'user-replayed',
      guestRawToken: null,
      mergeKey,
      now: NOW,
    })

    expect(second.outcome).toBe('existing')
    expect(second.actor.principalId).toBe(first.actor.principalId)
  })

  test('ignores an expired guest cookie instead of failing the sign-in', async () => {
    await insertUser('user-expired-guest')
    const rawToken = await startGuest()
    const expiredNow = NOW.add({ hours: 24 * 400 })

    const result = await service.complete({
      userId: 'user-expired-guest',
      guestRawToken: rawToken,
      mergeKey: uuidv7(),
      now: expiredNow,
    })

    // 期限切れゲストは取り込まれず、正式principalだけが新規作成される。
    expect(result.outcome).toBe('created')
  })

  test('never passes the raw guest cookie to the repository', async () => {
    await insertUser('user-hash-only')
    const rawToken = await startGuest()
    const seen: Array<string | null> = []

    const spying = createIdentityCompletionService({
      repository: {
        ...repository,
        async completeIdentity(input) {
          seen.push(input.guestTokenHash)
          return repository.completeIdentity(input)
        },
      },
      tokenCodec: codec,
    })

    await spying.complete({
      userId: 'user-hash-only',
      guestRawToken: rawToken,
      mergeKey: uuidv7(),
      now: NOW,
    })

    expect(seen).toEqual([codec.hash(rawToken)])
    expect(seen[0]).not.toBe(rawToken)
  })
})
