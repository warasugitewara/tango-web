import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { transformBetterAuthPostgresSchema } from './auth-schema'

const CLI_PACKAGE = 'auth@1.6.25'
const CLI_ENTRYPOINT = 'packages/db/node_modules/auth/dist/index.mjs'
const CONFIG_PATH = 'apps/api/src/features/auth/better-auth.config.ts'
const CHECKED_IN_PATH = 'packages/db/src/schema/auth.generated.ts'

const repositoryRoot = resolve(import.meta.dir, '..', '..', '..')

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
  const rawOutput = join(temporaryDirectory, 'auth.raw.ts')

  try {
    const generation = Bun.spawn(
      [
        // authパッケージ自身のbin launcherと同じNode実行に揃える。
        // Bunで直接実行すると関数defaultの解析結果が変わり、生成物が不安定になる。
        'node',
        CLI_ENTRYPOINT,
        'generate',
        '--config',
        CONFIG_PATH,
        '--output',
        rawOutput,
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

    const generated = await readFile(rawOutput, 'utf8')
    const transformed = transformBetterAuthPostgresSchema(generated)
    await writeFile(
      resolve(repositoryRoot, CHECKED_IN_PATH),
      transformed,
      'utf8',
    )
    console.log(
      `${CHECKED_IN_PATH} を ${CLI_PACKAGE} からTIMESTAMPTZ変換付きで再生成しました。`,
    )
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true })
  }
}

await main()
