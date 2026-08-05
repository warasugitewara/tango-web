import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  expectTypeOf,
  test,
  vi,
} from 'vitest'
import type { Database, DatabaseHandle } from '../client'
import {
  assertTestDatabaseUrl,
  createTestDatabase,
  resetIdentityTables,
  type TestDatabaseHandle,
} from './database'

/** 誤設定を検知するためのサンプル。パスワード部分が漏れないことも確認する。 */
const PRODUCTION_LIKE_URL =
  'postgres://tango:s3cret-production-password@db.example.com:5432/tango'

const RESET_SAFETY_ERROR =
  'テストデータベースの安全性を確認できないため、リセットを中止しました。'

let handle: TestDatabaseHandle | undefined

function database(): TestDatabaseHandle {
  if (!handle) {
    throw new Error('テストデータベースが初期化されていません。')
  }

  return handle
}

async function expectResetSafetyError(operation: Promise<void>): Promise<void> {
  let caught: unknown
  try {
    await operation
  } catch (error) {
    caught = error
  }

  expect(caught).toBeInstanceOf(Error)
  if (!(caught instanceof Error)) {
    return
  }
  expect(caught.message).toBe(RESET_SAFETY_ERROR)
}

beforeAll(async () => {
  handle = await createTestDatabase()
})

afterEach(() => {
  vi.restoreAllMocks()
})

afterAll(async () => {
  await handle?.close()
})

describe('assertTestDatabaseUrl', () => {
  test('accepts loopback connections to a _test database', () => {
    expect(() =>
      assertTestDatabaseUrl(
        'postgres://tango_test:tango_test@127.0.0.1:55432/tango_test',
      ),
    ).not.toThrow()
    expect(() =>
      assertTestDatabaseUrl(
        'postgresql://user:pw@localhost:5432/anything_test',
      ),
    ).not.toThrow()
    expect(() =>
      assertTestDatabaseUrl('postgres://user:pw@[::1]:5432/tango_test'),
    ).not.toThrow()
  })

  test('rejects a host that is not loopback', () => {
    expect(() => assertTestDatabaseUrl(PRODUCTION_LIKE_URL)).toThrow(
      /ループバックではありません/,
    )
  })

  test('never leaks the connection URL or credentials in the error', () => {
    try {
      assertTestDatabaseUrl(PRODUCTION_LIKE_URL)
      expect.unreachable('ループバック以外は拒否されるべき。')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      expect(message).not.toContain('s3cret-production-password')
      expect(message).not.toContain(PRODUCTION_LIKE_URL)
      expect(message).toContain('db.example.com')
    }
  })

  test('rejects a database name without the _test suffix', () => {
    expect(() =>
      assertTestDatabaseUrl('postgres://user:pw@127.0.0.1:5432/tango'),
    ).toThrow(/_test/)
    expect(() =>
      assertTestDatabaseUrl('postgres://user:pw@127.0.0.1:5432/'),
    ).toThrow(/_test/)
  })

  test('rejects a non PostgreSQL URL', () => {
    expect(() =>
      assertTestDatabaseUrl('mysql://user:pw@127.0.0.1:3306/tango_test'),
    ).toThrow(/PostgreSQL/)
  })

  test('rejects a value that is not a URL', () => {
    expect(() => assertTestDatabaseUrl('tango_test')).toThrow(
      /URLとして解釈できません/,
    )
  })
})

describe('test database handle', () => {
  test('is nominally distinct from arbitrary database handles', () => {
    expectTypeOf<TestDatabaseHandle>().toExtend<DatabaseHandle>()
    expectTypeOf<DatabaseHandle>().not.toExtend<TestDatabaseHandle>()
    expectTypeOf<Database>().not.toExtend<TestDatabaseHandle>()
  })

  test('is frozen after creation', () => {
    expect(Object.isFrozen(database())).toBe(true)
  })

  test('rejects an arbitrary database handle before executing SQL', async () => {
    const executeSpy = vi.spyOn(database().db, 'execute')
    const foreignHandle: DatabaseHandle = {
      db: database().db,
      close: database().close,
    }

    await expectResetSafetyError(
      Reflect.apply(resetIdentityTables, undefined, [foreignHandle]),
    )
    expect(executeSpy).not.toHaveBeenCalled()
  })

  test('rejects a property copy of a registered handle before executing SQL', async () => {
    const executeSpy = vi.spyOn(database().db, 'execute')
    const copiedHandle = { ...database() }

    await expectResetSafetyError(
      Reflect.apply(resetIdentityTables, undefined, [copiedHandle]),
    )
    expect(executeSpy).not.toHaveBeenCalled()
  })

  test('rejects a current database mismatch before truncate', async () => {
    const mismatchedRows = Object.assign(
      [{ currentDatabase: 'production_like' }],
      {
        columns: [],
        count: 1,
        command: 'SELECT',
        statement: { name: '', string: '', types: [], columns: [] },
        state: { status: 'idle', pid: 0, secret: 0 },
      },
    )
    const executeSpy = vi
      .spyOn(database().db, 'execute')
      .mockResolvedValue(mismatchedRows)

    await expectResetSafetyError(resetIdentityTables(database()))
    expect(executeSpy).toHaveBeenCalledTimes(1)
  })

  test('resets a registered handle after verifying the current database', async () => {
    await expect(resetIdentityTables(database())).resolves.toBeUndefined()
  })
})
