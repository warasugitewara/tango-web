import { zValidator } from '@hono/zod-validator'
import { Temporal } from '@js-temporal/polyfill'
import type { CardRecord, ContentRepository } from '@tango/db'
import {
  AppError,
  cardContentSchema,
  deckCreateSchema,
  deckUpdateSchema,
  formatJst,
  importRequestSchema,
} from '@tango/shared'
import { Hono } from 'hono'
import { z } from 'zod'
import {
  type AppEnv,
  requireServiceContext,
} from '../../middleware/request-context'
import { parseImportPayload } from './import-parser'

const idParamsSchema = z.object({ deckId: z.uuidv7() }).strict()
const cardIdParamsSchema = z.object({ cardId: z.uuidv7() }).strict()
const cardListQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(50),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .strict()

type ValidationResult =
  | { success: true }
  | { success: false; error: Parameters<typeof z.flattenError>[0] }

function validationFailure(result: ValidationResult) {
  if (!result.success) {
    throw new AppError('VALIDATION_FAILED', {
      fieldErrors: z.flattenError(result.error).fieldErrors,
    })
  }
}

function toDate(instant: Temporal.Instant): Date {
  return new Date(instant.epochMilliseconds)
}

function toCardView(card: CardRecord) {
  return {
    ...card,
    createdAt: formatJst(
      Temporal.Instant.fromEpochMilliseconds(card.createdAt.getTime()),
    ),
    updatedAt: formatJst(
      Temporal.Instant.fromEpochMilliseconds(card.updatedAt.getTime()),
    ),
  }
}

export function createContentRoutes(options: {
  repository: ContentRepository
}) {
  const { repository } = options

  return new Hono<AppEnv>()
    .get('/decks', async (context) => {
      const { actor, now } = requireServiceContext(context)
      await repository.ensureDemoDeck(actor.principalId, toDate(now))
      const decks = await repository.listDecks(actor.principalId)
      return context.json({ decks })
    })
    .post(
      '/decks',
      zValidator('json', deckCreateSchema, validationFailure),
      async (context) => {
        const serviceContext = requireServiceContext(context)
        const input = context.req.valid('json')
        const deck = await repository.createDeck(
          serviceContext.actor.principalId,
          {
            name: input.name,
            ...(input.description === undefined
              ? {}
              : { description: input.description }),
            ...(input.newCardLimit === undefined
              ? {}
              : { newCardLimit: input.newCardLimit }),
          },
          toDate(serviceContext.now),
        )
        return context.json({ deck }, 201)
      },
    )
    .patch(
      '/decks/:deckId',
      zValidator('param', idParamsSchema, validationFailure),
      zValidator('json', deckUpdateSchema, validationFailure),
      async (context) => {
        const serviceContext = requireServiceContext(context)
        const input = context.req.valid('json')
        const deck = await repository.updateDeck(
          serviceContext.actor.principalId,
          context.req.valid('param').deckId,
          {
            ...(input.name === undefined ? {} : { name: input.name }),
            ...(input.description === undefined
              ? {}
              : { description: input.description }),
            ...(input.newCardLimit === undefined
              ? {}
              : { newCardLimit: input.newCardLimit }),
          },
          toDate(serviceContext.now),
        )
        if (deck === null) {
          throw new AppError('NOT_FOUND')
        }
        return context.json({ deck })
      },
    )
    .delete(
      '/decks/:deckId',
      zValidator('param', idParamsSchema, validationFailure),
      async (context) => {
        const serviceContext = requireServiceContext(context)
        const deleted = await repository.trashDeck(
          serviceContext.actor.principalId,
          context.req.valid('param').deckId,
          toDate(serviceContext.now),
        )
        if (!deleted) {
          throw new AppError('NOT_FOUND')
        }
        return context.body(null, 204)
      },
    )
    .get(
      '/decks/:deckId/cards',
      zValidator('param', idParamsSchema, validationFailure),
      zValidator('query', cardListQuerySchema, validationFailure),
      async (context) => {
        const { actor } = requireServiceContext(context)
        const query = context.req.valid('query')
        const cards = await repository.listCards(
          actor.principalId,
          context.req.valid('param').deckId,
          query.limit,
          query.offset,
        )
        return context.json({ cards: cards.map(toCardView) })
      },
    )
    .post(
      '/decks/:deckId/cards',
      zValidator('param', idParamsSchema, validationFailure),
      zValidator('json', cardContentSchema, validationFailure),
      async (context) => {
        const serviceContext = requireServiceContext(context)
        const card = await repository.createCard(
          serviceContext.actor.principalId,
          context.req.valid('param').deckId,
          context.req.valid('json'),
          toDate(serviceContext.now),
        )
        if (card === null) {
          throw new AppError('NOT_FOUND')
        }
        return context.json({ card: toCardView(card) }, 201)
      },
    )
    .post(
      '/decks/:deckId/import',
      zValidator('param', idParamsSchema, validationFailure),
      zValidator('json', importRequestSchema, validationFailure),
      async (context) => {
        const serviceContext = requireServiceContext(context)
        const cards = parseImportPayload(context.req.valid('json'))
        const created = await repository.createCards(
          serviceContext.actor.principalId,
          context.req.valid('param').deckId,
          cards,
          toDate(serviceContext.now),
        )
        if (created === 0) {
          throw new AppError('NOT_FOUND')
        }
        return context.json({ created }, 201)
      },
    )
    .patch(
      '/cards/:cardId',
      zValidator('param', cardIdParamsSchema, validationFailure),
      zValidator('json', cardContentSchema, validationFailure),
      async (context) => {
        const serviceContext = requireServiceContext(context)
        const card = await repository.updateCard(
          serviceContext.actor.principalId,
          context.req.valid('param').cardId,
          context.req.valid('json'),
          toDate(serviceContext.now),
        )
        if (card === null) {
          throw new AppError('NOT_FOUND')
        }
        return context.json({ card: toCardView(card) })
      },
    )
    .delete(
      '/cards/:cardId',
      zValidator('param', cardIdParamsSchema, validationFailure),
      async (context) => {
        const serviceContext = requireServiceContext(context)
        const deleted = await repository.trashCard(
          serviceContext.actor.principalId,
          context.req.valid('param').cardId,
          toDate(serviceContext.now),
        )
        if (!deleted) {
          throw new AppError('NOT_FOUND')
        }
        return context.body(null, 204)
      },
    )
}
