import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import * as schema from '../schema'
import type { TestDatabaseHandle } from '../test/database'
import { createTestDatabase, resetIdentityTables } from '../test/database'
import type { RateLimitRepository } from './rate-limit-repository'
import { createRateLimitRepository } from './rate-limit-repository'

const BUCKET = 'guest-start'
const FINGERPRINT = 'a'.repeat(64)
const OTHER_FINGERPRINT = 'b'.repeat(64)
const NOW = new Date('2026-09-09T03:00:00Z')
const WINDOW_MS = 10 * 60 * 1000

describe('RateLimitRepository', () => {
  let handle: TestDatabaseHandle
  let repository: RateLimitRepository

  beforeAll(async () => {
    handle = await createTestDatabase()
    repository = createRateLimitRepository(handle.db)
  })

  afterAll(async () => {
    if (handle !== undefined) {
      await handle.close()
    }
  })

  beforeEach(async () => {
    await resetIdentityTables(handle)
  })

  function since(now: Date): Date {
    return new Date(now.getTime() - WINDOW_MS)
  }

  test('記録した回数を数える', async () => {
    await repository.record(BUCKET, FINGERPRINT, NOW)
    await repository.record(BUCKET, FINGERPRINT, NOW)

    expect(await repository.countSince(BUCKET, FINGERPRINT, since(NOW))).toBe(2)
  })

  test('別の指紋の回数は混ざらない', async () => {
    await repository.record(BUCKET, FINGERPRINT, NOW)
    await repository.record(BUCKET, OTHER_FINGERPRINT, NOW)

    expect(await repository.countSince(BUCKET, FINGERPRINT, since(NOW))).toBe(1)
  })

  test('別のバケットの回数は混ざらない', async () => {
    await repository.record(BUCKET, FINGERPRINT, NOW)
    await repository.record('import', FINGERPRINT, NOW)

    expect(await repository.countSince(BUCKET, FINGERPRINT, since(NOW))).toBe(1)
  })

  test('窓の外の記録は数えない', async () => {
    const old = new Date(NOW.getTime() - WINDOW_MS - 1000)
    await repository.record(BUCKET, FINGERPRINT, old)
    await repository.record(BUCKET, FINGERPRINT, NOW)

    expect(await repository.countSince(BUCKET, FINGERPRINT, since(NOW))).toBe(1)
  })

  test('窓の境界ちょうどは数える', async () => {
    const edge = new Date(NOW.getTime() - WINDOW_MS)
    await repository.record(BUCKET, FINGERPRINT, edge)

    expect(await repository.countSince(BUCKET, FINGERPRINT, since(NOW))).toBe(1)
  })

  test('古い記録をまとめて消せる', async () => {
    const old = new Date(NOW.getTime() - WINDOW_MS - 1000)
    await repository.record(BUCKET, FINGERPRINT, old)
    await repository.record(BUCKET, FINGERPRINT, NOW)

    expect(await repository.purgeBefore(since(NOW))).toBe(1)

    const rows = await handle.db.select().from(schema.rateLimitHits)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.occurredAt.getTime()).toBe(NOW.getTime())
  })

  test('生のIPではなく指紋だけを保持する', async () => {
    // 記録に載せてよいのはHMACだけ。IPそのものは残さない。
    await repository.record(BUCKET, FINGERPRINT, NOW)

    const rows = await handle.db.select().from(schema.rateLimitHits)
    expect(rows[0]?.fingerprint).toBe(FINGERPRINT)
    expect(JSON.stringify(rows)).not.toContain('192.168')
  })
})
