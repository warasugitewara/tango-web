import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import {
  checkDatabaseReady,
  expectedTableNames,
  findMissingTables,
} from './health'
import type { TestDatabaseHandle } from './test/database'
import { createTestDatabase } from './test/database'

describe('expectedTableNames', () => {
  test('スキーマが必要とするテーブルを列挙する', () => {
    const names = expectedTableNames()

    expect(names).toContain('cards')
    expect(names).toContain('review_events')
    expect(names).toContain('principals')
  })

  test('重複なく返す', () => {
    const names = expectedTableNames()

    expect(new Set(names).size).toBe(names.length)
  })
})

describe('findMissingTables', () => {
  test('足りないテーブルだけを返す', () => {
    expect(findMissingTables(['cards', 'decks'], ['cards'])).toEqual(['decks'])
  })

  test('揃っていれば空を返す', () => {
    expect(findMissingTables(['cards'], ['cards', 'decks'])).toEqual([])
  })
})

describe('checkDatabaseReady', () => {
  let handle: TestDatabaseHandle

  beforeAll(async () => {
    handle = await createTestDatabase()
  })

  afterAll(async () => {
    if (handle !== undefined) {
      await handle.close()
    }
  })

  test('移行済みのデータベースでは受け入れ可能と答える', async () => {
    expect(await checkDatabaseReady(handle.db)).toBe(true)
  })

  test('接続できなければ受け入れ不可と答える', async () => {
    // 落ちているDBを ready と答えると、監視が停止を見逃す。
    const closed = await createTestDatabase()
    await closed.close()

    expect(await checkDatabaseReady(closed.db)).toBe(false)
  })
})
