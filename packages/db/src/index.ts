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
  createPrincipalRepository,
  type GuestSessionRecord,
  type IdentityCompletionOutcome,
  type IdentityCompletionResult,
  IdentityMergeKeyConflictError,
  type PrincipalRecord,
  type PrincipalRepository,
  type PurgeExpiredGuestsResult,
} from './repositories/principal-repository'
export * as schema from './schema'
export type { IdentityMergeStatus, PrincipalKind } from './schema/principals'
