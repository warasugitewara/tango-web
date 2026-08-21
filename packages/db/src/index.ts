export const DB_PACKAGE_NAME = '@tango/db' as const

export {
  type CreateDatabaseOptions,
  createDatabase,
  DATABASE_TIME_ZONE,
  type Database,
  type DatabaseHandle,
  type DatabaseSchema,
  type DatabaseTransaction,
} from './client'
export {
  type CardContent,
  type CardRecord,
  type ContentRepository,
  type CreateDeckInput,
  createContentRepository,
  type DeckSummary,
  hashCardContent,
  normalizeDeckName,
  type UpdateDeckInput,
} from './repositories/content-repository'
export {
  createPrincipalRepository,
  type GuestSessionRecord,
  type IdentityCompletionOutcome,
  type IdentityCompletionResult,
  IdentityMergeKeyConflictError,
  type PrincipalRecord,
  type PrincipalRepository,
  type PurgeExpiredGuestsResult,
} from './repositories/principal-repository'
export {
  type AppliedSchedule,
  CardNotFoundError,
  type CountInput,
  type CreateSessionInput,
  createStudyRepository,
  type QueuedCard,
  type QueueInput,
  type Rating,
  type RemainingCounts,
  type ReviewOutcome,
  type ScheduleRow,
  type ScheduleSeed,
  type StudyRepository,
  StudyStateConflictError,
  type SubmitReviewInput,
} from './repositories/study-repository'
export * as schema from './schema'
export type { IdentityMergeStatus, PrincipalKind } from './schema/principals'
