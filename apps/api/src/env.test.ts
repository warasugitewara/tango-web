import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'
import {
  ENVIRONMENT_KEYS,
  isSecureCookieOrigin,
  loadEnv,
  PRODUCTION_APP_ORIGIN,
  resolveDatabaseUrl,
} from './env'

/** 検証だけを見るための最小構成。値はどれもテスト用のダミー。 */
function baseEnv(): Record<string, string> {
  return {
    APP_ENV: 'production',
    APP_ORIGIN: PRODUCTION_APP_ORIGIN,
    DATABASE_URL: 'postgres://tango:tango@127.0.0.1:5432/tango',
    GUEST_TOKEN_PEPPER_FILE: '/run/secrets/guest_token_pepper',
    TURNSTILE_SITE_KEY: 'turnstile-site-key',
    TURNSTILE_SECRET_FILE: '/run/secrets/turnstile_secret',
    BETTER_AUTH_SECRET_FILE: '/run/secrets/better_auth_secret',
    GOOGLE_CLIENT_ID: 'google-client-id',
    GOOGLE_CLIENT_SECRET_FILE: '/run/secrets/google_client_secret',
    GITHUB_CLIENT_ID: 'github-client-id',
    GITHUB_CLIENT_SECRET_FILE: '/run/secrets/github_client_secret',
  }
}

describe('loadEnv', () => {
  test('.env.example and the runtime schema declare the same keys', async () => {
    const example = await readFile(
      resolve(
        dirname(fileURLToPath(import.meta.url)),
        '..',
        '..',
        '..',
        '.env.example',
      ),
      'utf8',
    )
    const exampleKeys = example
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line !== '' && !line.startsWith('#'))
      .map((line) => line.slice(0, line.indexOf('=')))
      .sort()

    expect(exampleKeys).toEqual(ENVIRONMENT_KEYS)
  })

  test('accepts the production origin', () => {
    const env = loadEnv(baseEnv())

    expect(env.APP_ORIGIN).toBe(PRODUCTION_APP_ORIGIN)
    // 本番で起動できた時点でSecure Cookieは必ず有効になる。
    expect(isSecureCookieOrigin(env)).toBe(true)
  })

  test('rejects a production origin that is not https', () => {
    expect(() =>
      loadEnv({ ...baseEnv(), APP_ORIGIN: 'http://tango.warasugi.com' }),
    ).toThrow(/APP_ORIGIN/)
  })

  test('rejects a production origin pointing at another host', () => {
    expect(() =>
      loadEnv({ ...baseEnv(), APP_ORIGIN: 'https://tango.example.com' }),
    ).toThrow(/APP_ORIGIN/)
  })

  test('rejects a production origin that only shares a prefix', () => {
    // 部分一致で通ると別ホストへCookieを配ってしまう。
    expect(() =>
      loadEnv({
        ...baseEnv(),
        APP_ORIGIN: 'https://tango.warasugi.com.example.test',
      }),
    ).toThrow(/APP_ORIGIN/)
  })

  test('allows a local http origin outside production', () => {
    const env = loadEnv({
      ...baseEnv(),
      APP_ENV: 'development',
      APP_ORIGIN: 'http://localhost:3000',
    })

    expect(isSecureCookieOrigin(env)).toBe(false)
  })

  test.each([
    'postgres://tango:tango@127.0.0.1:5432/tango',
    'postgresql://tango:tango@127.0.0.1:5432/tango',
  ])('accepts the PostgreSQL connection URL %s', (databaseUrl) => {
    const env = loadEnv({ ...baseEnv(), DATABASE_URL: databaseUrl })

    expect(env.DATABASE_URL).toBe(databaseUrl)
  })

  test('accepts DATABASE_URL_FILE instead of putting the secret URL in env', () => {
    const source: Record<string, string | undefined> = baseEnv()
    delete source.DATABASE_URL
    source.DATABASE_URL_FILE = '/run/secrets/database_url'

    const env = loadEnv(source)

    expect(env.DATABASE_URL).toBeUndefined()
    expect(env.DATABASE_URL_FILE).toBe('/run/secrets/database_url')
  })

  test('rejects ambiguous database URL sources', () => {
    expect(() =>
      loadEnv({
        ...baseEnv(),
        DATABASE_URL_FILE: '/run/secrets/database_url',
      }),
    ).toThrow(/DATABASE_URL/)
  })

  test('reads and validates the database URL from a secret file', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'tango-database-url-'))
    const path = resolve(directory, 'database_url')
    const databaseUrl = 'postgresql://tango:dummy@tango-postgres:5432/tango'
    try {
      await writeFile(path, databaseUrl)
      const source: Record<string, string | undefined> = baseEnv()
      delete source.DATABASE_URL
      source.DATABASE_URL_FILE = path

      expect(await resolveDatabaseUrl(loadEnv(source))).toBe(databaseUrl)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('never leaks invalid database URL file contents', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'tango-database-url-'))
    const path = resolve(directory, 'database_url')
    const secretMarker = 'dummy-secret-database-marker'
    try {
      await writeFile(path, `https://tango:${secretMarker}@example.test/tango`)
      const source: Record<string, string | undefined> = baseEnv()
      delete source.DATABASE_URL
      source.DATABASE_URL_FILE = path

      await expect(resolveDatabaseUrl(loadEnv(source))).rejects.not.toThrow(
        secretMarker,
      )
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test.each([
    ['URLとして解釈できない値', 'postgres'],
    ['スキームのない値', '127.0.0.1:5432/tango'],
    ['空白だけの値', '   '],
    ['プロトコルの違うhttp', 'http://tango:s3cret@10.0.0.5:5432/tango'],
    ['プロトコルの違うhttps', 'https://tango:s3cret@10.0.0.5:5432/tango'],
    ['プロトコルの違うmysql', 'mysql://tango:s3cret@10.0.0.5:3306/tango'],
    ['接頭辞だけ一致するpostgresx', 'postgresx://tango:s3cret@10.0.0.5/tango'],
    // `postgres:` は非special schemeなので、URLとしては解釈できてしまう。
    // 接続先が定まらない形は起動前に落とす。
    ['ホストもDB名もない不透明形式', 'postgres:whatever'],
    ['ホストのない値', 'postgres://'],
    ['DB名のない値', 'postgres://127.0.0.1:5432'],
    ['DB名が空の値', 'postgres://127.0.0.1:5432/'],
  ] satisfies ReadonlyArray<readonly [string, string]>)(
    'rejects DATABASE_URL: %s',
    (_caseName, databaseUrl) => {
      expect(() =>
        loadEnv({ ...baseEnv(), DATABASE_URL: databaseUrl }),
      ).toThrow(/DATABASE_URL/)
    },
  )

  test('never leaks the DATABASE_URL value or its secret', () => {
    // 接続URLにはパスワードが載る。失敗時にキー名以外を出してはならない。
    const databaseUrl = 'http://tango:s3cret@10.0.0.5:5432/tango'

    try {
      loadEnv({ ...baseEnv(), DATABASE_URL: databaseUrl })
      expect.unreachable('プロトコルが違うので失敗するはず。')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      expect(message).toContain('DATABASE_URL')
      expect(message).not.toContain(databaseUrl)
      expect(message).not.toContain('s3cret')
      expect(message).not.toContain('10.0.0.5')
      expect(message).not.toContain('http://')
    }
  })

  test('reports only the failing keys and never the values', () => {
    const source = { ...baseEnv() }
    source.GUEST_TOKEN_PEPPER_FILE = ''
    source.DATABASE_URL = 'postgres://tango:s3cret@10.0.0.5:5432/tango'
    delete source.TURNSTILE_SECRET_FILE

    try {
      loadEnv(source)
      expect.unreachable('必須キーが欠けているので失敗するはず。')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      expect(message).toContain('GUEST_TOKEN_PEPPER_FILE')
      expect(message).toContain('TURNSTILE_SECRET_FILE')
      expect(message).not.toContain('s3cret')
      expect(message).not.toContain('/run/secrets/')
    }
  })
})
