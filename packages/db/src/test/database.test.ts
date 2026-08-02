import { describe, expect, test } from 'vitest'
import { assertTestDatabaseUrl } from './database'

/** 誤設定を検知するためのサンプル。パスワード部分が漏れないことも確認する。 */
const PRODUCTION_LIKE_URL =
  'postgres://tango:s3cret-production-password@db.example.com:5432/tango'

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
