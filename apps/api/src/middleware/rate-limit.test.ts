import type { RateLimitRepository } from '@tango/db'
import { Hono } from 'hono'
import { describe, expect, test } from 'vitest'
import { errorHandler } from './error-handler'
import { GUEST_START_BUCKET, rateLimit } from './rate-limit'
import type { AppEnv } from './request-context'

const NOW = new Date('2026-09-09T03:00:00Z')

/** 記録内容を覚えておくだけの、その場限りのリポジトリ。 */
function createRepository() {
  const rows: Array<{ bucket: string; fingerprint: string; at: Date }> = []

  const repository: RateLimitRepository = {
    async countSince(bucket, fingerprint, since) {
      return rows.filter(
        (row) =>
          row.bucket === bucket &&
          row.fingerprint === fingerprint &&
          row.at.getTime() >= since.getTime(),
      ).length
    },
    async record(bucket, fingerprint, at) {
      rows.push({ bucket, fingerprint, at })
    },
    async purgeBefore() {
      return 0
    },
  }

  return { repository, rows }
}

function createApp(repository: RateLimitRepository) {
  return new Hono<AppEnv>()
    .onError(errorHandler())
    .use(
      '/api/guest/start',
      rateLimit({
        repository,
        bucket: GUEST_START_BUCKET,
        limit: 10,
        windowMs: 10 * 60 * 1000,
        fingerprintPepper: 'test-pepper',
        now: () => NOW,
      }),
    )
    .post('/api/guest/start', (context) => context.json({ ok: true }))
    .post('/api/decks', (context) => context.json({ ok: true }))
}

function post(
  app: ReturnType<typeof createApp>,
  ip: string | null,
  path = '/api/guest/start',
) {
  return app.request(path, {
    method: 'POST',
    headers: ip === null ? {} : { 'cf-connecting-ip': ip },
  })
}

describe('rateLimit', () => {
  test('上限までは通す', async () => {
    const { repository } = createRepository()
    const app = createApp(repository)

    for (let attempt = 0; attempt < 10; attempt += 1) {
      expect((await post(app, '203.0.113.7')).status).toBe(200)
    }
  })

  test('上限を超えたら429で拒否する', async () => {
    const { repository } = createRepository()
    const app = createApp(repository)

    for (let attempt = 0; attempt < 10; attempt += 1) {
      await post(app, '203.0.113.7')
    }

    const blocked = await post(app, '203.0.113.7')
    expect(blocked.status).toBe(429)

    const body = (await blocked.json()) as {
      error: { code: string; message: string }
    }
    expect(body.error.code).toBe('RATE_LIMITED')
    expect(body.error.message).toMatch(/[ぁ-んァ-ン一-龥]/)
  })

  test('別のIPは互いに影響しない', async () => {
    const { repository } = createRepository()
    const app = createApp(repository)

    for (let attempt = 0; attempt < 10; attempt += 1) {
      await post(app, '203.0.113.7')
    }

    expect((await post(app, '198.51.100.9')).status).toBe(200)
  })

  test('拒否したときは記録を増やさない', async () => {
    // 拒否のたびに数えると、窓が永久に空かなくなる。
    const { repository, rows } = createRepository()
    const app = createApp(repository)

    for (let attempt = 0; attempt < 12; attempt += 1) {
      await post(app, '203.0.113.7')
    }

    expect(rows).toHaveLength(10)
  })

  test('対象外の経路は素通しする', async () => {
    const { repository, rows } = createRepository()
    const app = createApp(repository)

    expect((await post(app, '203.0.113.7', '/api/decks')).status).toBe(200)
    expect(rows).toHaveLength(0)
  })

  test('生のIPではなくHMACを記録する', async () => {
    const { repository, rows } = createRepository()
    const app = createApp(repository)

    await post(app, '203.0.113.7')

    expect(rows[0]?.fingerprint).toMatch(/^[0-9a-f]{64}$/)
    expect(JSON.stringify(rows)).not.toContain('203.0.113.7')
  })

  test('IPが分からない要求もまとめて数える', async () => {
    // ヘッダが無い場合に無制限へ倒すと、そこが抜け道になる。
    const { repository, rows } = createRepository()
    const app = createApp(repository)

    for (let attempt = 0; attempt < 10; attempt += 1) {
      await post(app, null)
    }

    expect((await post(app, null)).status).toBe(429)
    expect(rows).toHaveLength(10)
  })
})
