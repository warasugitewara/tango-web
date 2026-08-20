import { z } from 'zod'

/** カード本文の上限。上位仕様が定める値。 */
const MAX_CARD_TEXT_LENGTH = 20_000

/**
 * HTMLタグとみなす形。
 * 描画側でも生HTMLを無効にするが、保存前にも受け付けない。
 * 不等号そのものは数式や比較で使うため、タグ名やコメントの形に限って弾く。
 */
const HTML_TAG_PATTERN = /<(?:[a-zA-Z][^>]*|\/[a-zA-Z][^>]*|!--[\s\S]*?--)>/

const cardTextSchema = z
  .string()
  .min(1)
  .max(MAX_CARD_TEXT_LENGTH)
  .refine((value) => !HTML_TAG_PATTERN.test(value), {
    message: 'HTMLタグは使用できません。',
  })

export const deckCreateSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    description: z.string().max(1_000).optional(),
    /** 1学習日あたりに出す新規カードの上限。0は新規を出さない。 */
    newCardLimit: z.number().int().min(0).max(1_000).optional(),
  })
  .strict()

export const deckUpdateSchema = deckCreateSchema.partial().strict()

export const cardContentSchema = z
  .object({ front: cardTextSchema, back: cardTextSchema })
  .strict()

export const importRequestSchema = z
  .object({
    format: z.enum(['json', 'csv']),
    payload: z.string().min(1).max(1_000_000),
  })
  .strict()

export type DeckCreateInput = z.infer<typeof deckCreateSchema>
export type DeckUpdateInput = z.infer<typeof deckUpdateSchema>
export type CardContentInput = z.infer<typeof cardContentSchema>
export type ImportRequest = z.infer<typeof importRequestSchema>
