import { describe, expect, test } from 'vitest'
import { isSecureCookieOrigin, loadEnv, PRODUCTION_APP_ORIGIN } from './env'

/** 検証だけを見るための最小構成。値はどれもテスト用のダミー。 */
function baseEnv(): Record<string, string> {
  return {
    APP_ENV: 'production',
    APP_ORIGIN: PRODUCTION_APP_ORIGIN,
    DATABASE_URL: 'postgres://tango:tango@127.0.0.1:5432/tango',
    GUEST_TOKEN_PEPPER_FILE: '/run/secrets/guest_token_pepper',
    TURNSTILE_SECRET_FILE: '/run/secrets/turnstile_secret',
    BETTER_AUTH_SECRET_FILE: '/run/secrets/better_auth_secret',
    GOOGLE_CLIENT_ID: 'google-client-id',
    GOOGLE_CLIENT_SECRET_FILE: '/run/secrets/google_client_secret',
    GITHUB_CLIENT_ID: 'github-client-id',
    GITHUB_CLIENT_SECRET_FILE: '/run/secrets/github_client_secret',
  }
}

describe('loadEnv', () => {
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
