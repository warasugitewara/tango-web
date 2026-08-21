import type { PrincipalRepository } from '@tango/db'
import { createDatabase, createPrincipalRepository } from '@tango/db'
import { AppError, parseJstInstant, toSafeErrorName } from '@tango/shared'
import { v7 as uuidv7 } from 'uuid'
import { loadEnv, resolveDatabaseUrl } from '../env'
import { type Clock, createSystemClock } from '../features/auth/guest-service'

/** ログの相関に使うjob識別子。 */
const JOB_NAME = 'purge-expired-guests'

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

/** このCLIが受け付ける唯一のオプション。 */
const NOW_OPTION_PREFIX = '--now='

/**
 * `--now=<+09:00の日時>` を解釈する。test環境以外では受け付けない。
 * argvは閉じた集合として検査し、未知のオプション・typo・位置引数・
 * 重複・有効な`--now`との混在はすべて拒否する。黙って無視しない。
 */
export function resolveClock(appEnv: string, argv: readonly string[]): Clock {
  const [argument, ...rest] = argv

  if (argument === undefined) {
    return createSystemClock()
  }

  if (rest.length > 0) {
    throw new AppError('VALIDATION_FAILED', {
      publicMessage: '引数は --now=<日時> を1つだけ指定できます。',
    })
  }

  if (argument === '--now' || argument === NOW_OPTION_PREFIX) {
    throw new AppError('VALIDATION_FAILED', {
      publicMessage: '--now は --now=<日時> の形式で値を指定してください。',
    })
  }

  if (!argument.startsWith(NOW_OPTION_PREFIX)) {
    throw new AppError('VALIDATION_FAILED', {
      publicMessage: '認識できない引数です。--now=<日時> だけを指定できます。',
    })
  }

  if (appEnv !== 'test') {
    throw new AppError('VALIDATION_FAILED', {
      publicMessage: '--now はAPP_ENV=testでのみ指定できます。',
    })
  }

  const instant = parseJstInstant(argument.slice(NOW_OPTION_PREFIX.length))
  return { now: () => instant }
}

/** 失敗時に記録してよい項目だけを持つ。メッセージ・cause・stackは含めない。 */
export type PurgeFailureLog = {
  job: string
  level: 'error'
  errorId: string
  errorName: string
}

/**
 * 失敗ログを組み立てる。原因の特定はerrorIdで運用側の記録と突き合わせる。
 * 生のメッセージ・cause・stackはどの経路からも出さない。
 */
export function toPurgeFailureLog(error: unknown): PurgeFailureLog {
  return {
    job: JOB_NAME,
    level: 'error',
    errorId: uuidv7(),
    errorName: toSafeErrorName(error),
  }
}

async function main(): Promise<void> {
  const env = loadEnv(process.env)
  const clock = resolveClock(env.APP_ENV, process.argv.slice(2))
  const database = createDatabase(await resolveDatabaseUrl(env), { max: 1 })

  try {
    const summary = await purgeExpiredGuests({
      repository: createPrincipalRepository(database.db),
      clock,
    })

    console.log(JSON.stringify({ job: JOB_NAME, ...summary }))
  } finally {
    await database.close()
  }
}

// Webプロセスのタイマーからは起動しない。cron等から独立したプロセスとして実行する。
if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(JSON.stringify(toPurgeFailureLog(error)))
    process.exit(1)
  })
}
