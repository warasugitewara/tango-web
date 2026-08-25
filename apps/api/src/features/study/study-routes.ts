import { zValidator } from '@hono/zod-validator'
import {
  AppError,
  reviewSubmitSchema,
  studySessionCreateSchema,
} from '@tango/shared'
import { Hono } from 'hono'
import { z } from 'zod'
import {
  type AppEnv,
  requireServiceContext,
} from '../../middleware/request-context'
import type { StudyService } from './study-service'

const sessionParamsSchema = z.object({ sessionId: z.uuidv7() }).strict()

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

export function createStudyRoutes(options: { service: StudyService }) {
  const { service } = options

  return new Hono<AppEnv>()
    .get('/study/decks', async (context) => {
      const result = await service.listDeckQueues(
        requireServiceContext(context),
      )
      return context.json(result)
    })
    .post(
      '/study/sessions',
      zValidator('json', studySessionCreateSchema, validationFailure),
      async (context) => {
        const result = await service.createSession(
          requireServiceContext(context),
          context.req.valid('json'),
        )
        return context.json(result, 201)
      },
    )
    .get(
      '/study/sessions/:sessionId',
      zValidator('param', sessionParamsSchema, validationFailure),
      async (context) => {
        const result = await service.getSession(
          requireServiceContext(context),
          context.req.valid('param').sessionId,
        )
        return context.json(result)
      },
    )
    .post(
      '/study/reviews',
      zValidator('json', reviewSubmitSchema, validationFailure),
      async (context) => {
        const result = await service.submitReview(
          requireServiceContext(context),
          context.req.valid('json'),
        )
        return context.json(result)
      },
    )
}
