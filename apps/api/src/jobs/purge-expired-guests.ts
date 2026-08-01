import { Temporal } from '@js-temporal/polyfill'
import type { PrincipalRepository } from '@tango/db'
import { createDatabase, createPrincipalRepository } from '@tango/db'
import { loadEnv } from '../env'
import { type Clock, createSystemClock } from '../features/auth/guest-service'

/** 1回のDELETEで扱う上限。長いロックを避けるため小さく保つ。 */
const BATCH_SIZE = 500

/** 有限回で必ず終わらせる。到達した場合は次回の実行で続きを処理する。 */
const MAX_BATCHES = 200

export type PurgeSummary = {
  deletedPrincipals: number
  batches: number
  /** 上限に達して未処理が残っている可能性がある場合に true。 */
  truncated: boolean
}

export type PurgeDependencies = {
  repository: PrincipalRepository
  clock: Clock
}

/**
 * 期限切れゲストを有限ループで削除する。
 * 正式ユーザーが紐づいたprincipalはリポジトリ側の条件で除外される。
 */
export async function purgeExpiredGuests(
  dependencies: PurgeDependencies,
): Promise<PurgeSummary> {
  const now = new Date(dependencies.clock.now().epochMilliseconds)
  let deletedPrincipals = 0
  let batches = 0

  for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
    const result = await dependencies.repository.purgeExpiredGuests({
      now,
      limit: BATCH_SIZE,
    })

    batches += 1
    deletedPrincipals += result.deletedPrincipals

    if (result.deletedPrincipals < BATCH_SIZE) {
      return { deletedPrincipals, batches, truncated: false }
    }
  }

  return { deletedPrincipals, batches, truncated: true }
}

/** `--now=<RFC3339>` を解釈する。test環境以外では受け付けない。 */
export function resolveClock(appEnv: string, argv: readonly string[]): Clock {
  const override = argv
    .find((argument) => argument.startsWith('--now='))
    ?.slice('--now='.length)

  if (override === undefined) {
    return createSystemClock()
  }

  if (appEnv !== 'test') {
    throw new Error('--now はAPP_ENV=testでのみ指定できます。')
  }

  const instant = Temporal.Instant.from(override)
  return { now: () => instant }
}

async function main(): Promise<void> {
  const env = loadEnv(process.env)
  const clock = resolveClock(env.APP_ENV, process.argv.slice(2))
  const database = createDatabase(env.DATABASE_URL, { max: 1 })

  try {
    const summary = await purgeExpiredGuests({
      repository: createPrincipalRepository(database.db),
      clock,
    })

    console.log(JSON.stringify({ job: 'purge-expired-guests', ...summary }))
  } finally {
    await database.close()
  }
}

// Webプロセスのタイマーからは起動しない。cron等から独立したプロセスとして実行する。
if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(
      JSON.stringify({
        job: 'purge-expired-guests',
        level: 'error',
        message: error instanceof Error ? error.message : 'unknown error',
      }),
    )
    process.exit(1)
  })
}
