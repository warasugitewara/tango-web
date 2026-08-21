import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Temporal } from '@js-temporal/polyfill'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { createApp } from '../app'

let spaRoot = ''

beforeAll(async () => {
  spaRoot = await mkdtemp(join(tmpdir(), 'tango-spa-static-'))
  await mkdir(join(spaRoot, 'assets'))
  await writeFile(
    join(spaRoot, 'index.html'),
    '<!doctype html><title>Tango SPA</title>',
  )
  await writeFile(join(spaRoot, 'assets', 'app.js'), 'window.tango = true')
})

afterAll(async () => {
  if (spaRoot.startsWith(tmpdir())) {
    await rm(spaRoot, { recursive: true, force: true })
  }
})

function createHarness() {
  return createApp({
    clock: {
      now: () => Temporal.Instant.from('2026-08-21T08:00:00Z'),
    },
    guestService: {
      async start() {
        throw new Error('このテストでは使用しません。')
      },
      async resolve() {
        throw new Error('このテストでは使用しません。')
      },
      async revoke() {
        // このテストでは使用しない。
      },
    },
    actorResolver: {
      async resolveFormal() {
        return null
      },
    },
    identityCompletionService: {
      async complete() {
        throw new Error('このテストでは使用しません。')
      },
    },
    authHandler: async () => new Response(null, { status: 204 }),
    cookieSecure: true,
    spaRoot,
  })
}

describe('SPA static delivery', () => {
  test('APIの未知パスはHTMLへフォールバックしない', async () => {
    const response = await createHarness().request('/api/unknown')

    expect(response.status).toBe(404)
    expect(response.headers.get('content-type')).toContain('application/json')
  })

  test('未知の画面パスはindex.htmlを返す', async () => {
    const response = await createHarness().request(
      '/decks/019fd000-0000-7000-8000-000000000000',
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/html')
    expect(await response.text()).toContain('Tango SPA')
  })

  test('ビルド済み静的ファイルをそのまま返す', async () => {
    const response = await createHarness().request('/assets/app.js')

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('javascript')
    expect(await response.text()).toBe('window.tango = true')
  })
})
