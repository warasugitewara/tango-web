import { z } from 'zod'

/**
 * 退会の確認に打たせる文言。
 * 消せるのは自分のアカウントだけなので、表示名を打たせても誤削除は防げない。
 * 目的は「手が滑って押せない」ことなので、固定の文言で足りる。
 */
export const ACCOUNT_DELETE_CONFIRMATION = '削除します' as const

export const accountDeleteSchema = z
  .object({ confirm: z.literal(ACCOUNT_DELETE_CONFIRMATION) })
  .strict()

export type AccountDeleteInput = z.infer<typeof accountDeleteSchema>
