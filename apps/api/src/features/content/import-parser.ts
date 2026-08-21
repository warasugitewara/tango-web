import {
  AppError,
  type CardContentInput,
  cardContentSchema,
  type ImportRequest,
} from '@tango/shared'
import { parse } from 'csv-parse/sync'
import { z } from 'zod'

const MAX_IMPORT_CARDS = 10_000

const contentEnvelopeSchema = z
  .object({
    schema: z.literal('tango.content'),
    version: z.literal(1),
    cards: z.array(cardContentSchema).min(1).max(MAX_IMPORT_CARDS),
  })
  .strict()

function invalidImport(cause?: unknown): AppError {
  return new AppError('VALIDATION_FAILED', {
    publicMessage:
      '取り込みデータを解釈できませんでした。形式と内容を確認してください。',
    ...(cause === undefined ? {} : { cause }),
  })
}

function parseJson(payload: string): readonly CardContentInput[] {
  let value: unknown
  try {
    value = JSON.parse(payload)
  } catch (error) {
    throw invalidImport(error)
  }

  const parsed = contentEnvelopeSchema.safeParse(value)
  if (!parsed.success) {
    throw invalidImport(parsed.error)
  }
  return parsed.data.cards
}

function parseCsv(payload: string): readonly CardContentInput[] {
  let rows: string[][]
  try {
    rows = parse(payload, {
      bom: true,
      skip_empty_lines: true,
    })
  } catch (error) {
    throw invalidImport(error)
  }

  const [header, ...dataRows] = rows
  if (
    header?.length !== 2 ||
    header[0] !== 'front' ||
    header[1] !== 'back' ||
    dataRows.length === 0 ||
    dataRows.length > MAX_IMPORT_CARDS
  ) {
    throw invalidImport()
  }

  const parsed = z.array(cardContentSchema).safeParse(
    dataRows.map((row) => ({
      front: row[0],
      back: row[1],
    })),
  )
  if (!parsed.success) {
    throw invalidImport(parsed.error)
  }
  return parsed.data
}

/** 全件を検証し、1件でも不正ならカードを返さない。 */
export function parseImportPayload(
  request: ImportRequest,
): readonly CardContentInput[] {
  return request.format === 'json'
    ? parseJson(request.payload)
    : parseCsv(request.payload)
}
