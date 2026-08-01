import { readFile } from 'node:fs/promises'
import { z } from 'zod'

const environmentSchema = z.object({
  APP_ENV: z.enum(['development', 'test', 'production']),
  APP_ORIGIN: z.url(),
  DATABASE_URL: z.string().min(1),
  /** ゲストトークンのHMACペッパーを格納したファイルのパス。値自体は環境変数に置かない。 */
  GUEST_TOKEN_PEPPER_FILE: z.string().min(1),
  /** Cloudflare Turnstileのシークレットを格納したファイルのパス。 */
  TURNSTILE_SECRET_FILE: z.string().min(1),
})

export type Env = Readonly<z.infer<typeof environmentSchema>>

/**
 * 環境変数を検証して読み取り専用のEnvを返す。
 * 検証に失敗した場合はキー名だけを含むエラーを投げ、値は決して露出させない。
 */
export function loadEnv(source: Record<string, string | undefined>): Env {
  const result = environmentSchema.safeParse(source)

  if (!result.success) {
    const invalidKeys = [
      ...new Set(
        result.error.issues.map((issue) => String(issue.path[0] ?? '(root)')),
      ),
    ].sort()

    throw new Error(
      `環境変数の検証に失敗しました。次のキーを確認してください: ${invalidKeys.join(', ')}`,
    )
  }

  return Object.freeze(result.data)
}

/**
 * シークレットをファイルから読み取る。
 * 読み取りに失敗してもパスだけを報告し、内容は決してログへ出さない。
 */
export async function readSecretFile(path: string): Promise<string> {
  let contents: string

  try {
    contents = await readFile(path, 'utf8')
  } catch {
    throw new Error(`シークレットファイルを読み取れませんでした: ${path}`)
  }

  const secret = contents.trim()

  if (secret === '') {
    throw new Error(`シークレットファイルが空です: ${path}`)
  }

  return secret
}
