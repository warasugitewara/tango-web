/**
 * Better Auth生成スキーマのドリフト検査。
 *
 * ピン留めしたCLIで一時パスへ再生成し、コミット済みの
 * `packages/db/src/schema/auth.generated.ts` と1バイトでも異なれば失敗する。
 * 生成は設定の読み込みだけで完結しDBへは接続しないため、CIでも追加サービスは不要。
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const CLI_PACKAGE = 'auth@1.6.25'
const CONFIG_PATH = 'apps/api/src/features/auth/better-auth.config.ts'
const CHECKED_IN_PATH = 'packages/db/src/schema/auth.generated.ts'

const repositoryRoot = resolve(import.meta.dir, '..', '..', '..')

// 設定はダミー値で完結するため環境変数の注入は不要。呼び出し元の環境をそのまま渡す。
function buildEnv(): Record<string, string> {
  const env: Record<string, string> = {}

  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env[key] = value
    }
  }

  return env
}

async function main(): Promise<void> {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'tango-auth-schema-'))
  const temporaryOutput = join(temporaryDirectory, 'auth.generated.ts')

  try {
    const generation = Bun.spawn(
      [
        'bunx',
        CLI_PACKAGE,
        'generate',
        '--config',
        CONFIG_PATH,
        '--output',
        temporaryOutput,
        '--yes',
      ],
      {
        cwd: repositoryRoot,
        env: buildEnv(),
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )

    const exitCode = await generation.exited

    if (exitCode !== 0) {
      const stderr = await new Response(generation.stderr).text()
      throw new Error(
        `Better Authスキーマの再生成に失敗しました (exit ${exitCode})\n${stderr}`,
      )
    }

    const [regenerated, checkedIn] = await Promise.all([
      readFile(temporaryOutput, 'utf8'),
      readFile(resolve(repositoryRoot, CHECKED_IN_PATH), 'utf8'),
    ])

    if (regenerated !== checkedIn) {
      throw new Error(
        `${CHECKED_IN_PATH} が ${CLI_PACKAGE} の生成結果と一致しません。` +
          '生成物を手で編集せず、再生成してコミットしてください。',
      )
    }

    console.log(`${CHECKED_IN_PATH} は ${CLI_PACKAGE} の生成結果と一致します。`)
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true })
  }
}

await main()
