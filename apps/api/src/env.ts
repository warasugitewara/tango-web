import { z } from 'zod'

const environmentSchema = z.object({
  APP_ENV: z.enum(['development', 'test', 'production']),
  APP_ORIGIN: z.url(),
  DATABASE_URL: z.string().min(1),
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
