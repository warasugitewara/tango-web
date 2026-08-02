import { AppError, parseJstInstant } from '@tango/shared'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createApp } from '../app'
import type { GuestService } from '../features/auth/guest-service'

const NOW = parseJstInstant('2026-08-01T10:00:00+09:00')

/** ログへ出てはならない値。実際の障害で例外メッセージに混ざり得るものを並べる。 */
const SECRET_CONNECTION_URL = 'postgres://tango:s3cret@10.0.0.5:5432/tango'
const SECRET_COOKIE_VALUE = 'super-secret-session-token'
const CARD_FRONT_TEXT = '暗記カードの表面テキスト'

type LogRecord = {
  level: string
  requestId: string
  errorId: string
  code: string
  status: number
  method: string
  path: string
  errorName: string
  causes: string[]
  frames: string[]
}

/** `start` だけが失敗するアプリを組み立てる。 */
function createAppThatFailsOnStart(failure: unknown) {
  const guestService: GuestService = {
    async start() {
      throw failure
    },
    async resolve() {
      throw new AppError('UNAUTHENTICATED')
    },
    async revoke() {
      // 何もしない
    },
  }

  return createApp({
    clock: { now: () => NOW },
    guestService,
    actorResolver: {
      async resolveFormal() {
        return null
      },
    },
    identityCompletionService: {
      async complete() {
        throw new Error('このテストでは使用しない。')
      },
    },
    authHandler: async () => new Response(null, { status: 204 }),
    cookieSecure: true,
  })
}

describe('errorHandler', () => {
  let logs: string[]

  beforeEach(() => {
    logs = []
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      logs.push(args.map((arg) => String(arg)).join(' '))
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  /** 記録された1件のログを読み出す。生文字列も返して部分一致で検査する。 */
  function readLog(): { raw: string; record: LogRecord } {
    expect(logs).toHaveLength(1)

    const raw = logs[0]
    if (raw === undefined) {
      throw new Error('ログが1件も記録されていない。')
    }

    return { raw, record: JSON.parse(raw) as LogRecord }
  }

  /** 汚染された例外を投げるリクエストを1本流す。 */
  async function requestWithFailure(failure: unknown): Promise<Response> {
    const app = createAppThatFailsOnStart(failure)

    return app.request('/api/guest/start', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: `better-auth.session_token=${SECRET_COOKIE_VALUE}`,
      },
      body: JSON.stringify({
        turnstileToken: 'valid-token',
        front: CARD_FRONT_TEXT,
      }),
    })
  }

  test('records classification and an internal error id instead of the raw stack', async () => {
    const response = await requestWithFailure(
      new Error('接続に失敗しました', {
        cause: new TypeError('内部原因'),
      }),
    )

    expect(response.status).toBe(500)

    const { record } = readLog()
    expect(record.level).toBe('error')
    expect(record.code).toBe('INTERNAL_ERROR')
    expect(record.status).toBe(500)
    expect(record.method).toBe('POST')
    expect(record.path).toBe('/api/guest/start')
    expect(record.errorName).toBe('Error')
    expect(record.causes).toEqual(['TypeError'])
    // 追跡できるよう内部エラーIDは必ず採番する。
    expect(record.errorId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    )
    // 呼び出し位置は診断のために残す。ただし位置情報の形のものだけ。
    expect(record.frames.length).toBeGreaterThan(0)
    for (const frame of record.frames) {
      expect(frame).toMatch(/^at\s.*:\d+:\d+\)?$/)
    }
  })

  test('never logs the exception message, cookies, request body or connection url', async () => {
    const response = await requestWithFailure(
      new Error(
        `接続文字列 ${SECRET_CONNECTION_URL} でカード ${CARD_FRONT_TEXT} の保存に失敗`,
        {
          cause: new Error('保存に失敗', { cause: SECRET_COOKIE_VALUE }),
        },
      ),
    )

    expect(response.status).toBe(500)

    const { raw, record } = readLog()
    // cause連鎖はErrorでない値も混ざるので、種類だけを記録する。
    expect(record.causes).toEqual(['Error', 'string'])
    expect(raw).not.toContain(SECRET_CONNECTION_URL)
    expect(raw).not.toContain('postgres://')
    expect(raw).not.toContain('s3cret')
    expect(raw).not.toContain('10.0.0.5')
    expect(raw).not.toContain(SECRET_COOKIE_VALUE)
    expect(raw).not.toContain('better-auth.session_token')
    // 日本語はJSON.stringifyでもそのまま出るので、生文字列で比較できる。
    expect(raw).not.toContain(CARD_FRONT_TEXT)
    expect(raw).not.toContain('接続文字列')
  })

  test('does not mistake a multi-line message for stack frames', async () => {
    // メッセージ自体が呼び出し位置の形をしていても取り込まない。
    const response = await requestWithFailure(
      new Error(`漏洩する秘密\n    at ${SECRET_CONNECTION_URL}:1:1`),
    )

    expect(response.status).toBe(500)

    const { raw, record } = readLog()
    expect(raw).not.toContain('漏洩する秘密')
    expect(raw).not.toContain(SECRET_CONNECTION_URL)
    for (const frame of record.frames) {
      expect(frame).not.toContain('10.0.0.5')
    }
  })

  test('keeps the stable code for an AppError and hides its cause', async () => {
    const response = await requestWithFailure(
      new AppError('RATE_LIMITED', {
        cause: new Error(`cookie=${SECRET_COOKIE_VALUE}`),
      }),
    )

    expect(response.status).toBe(429)

    const { raw, record } = readLog()
    expect(record.code).toBe('RATE_LIMITED')
    expect(record.status).toBe(429)
    expect(record.errorName).toBe('AppError')
    expect(record.causes).toEqual(['Error'])
    expect(raw).not.toContain(SECRET_COOKIE_VALUE)
  })

  test('falls back to a safe name when the error name carries free text', async () => {
    // nameは書き換えられるので、分類に使う前に形を検査する。
    const hostile = new Error('保存に失敗しました')
    hostile.name = `Error(${SECRET_CONNECTION_URL})`

    const response = await requestWithFailure(hostile)

    expect(response.status).toBe(500)

    const { raw, record } = readLog()
    expect(record.errorName).toBe('Error')
    expect(raw).not.toContain(SECRET_CONNECTION_URL)
  })
})
