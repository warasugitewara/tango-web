import {
  createContentRepository,
  createDatabase,
  createPrincipalRepository,
  createStudyRepository,
} from '@tango/db'
import { createApp } from './app'
import {
  isSecureCookieOrigin,
  loadEnv,
  readSecretFile,
  resolveDatabaseUrl,
} from './env'
import { createActorResolver } from './features/auth/actor-resolver'
import { createAuth } from './features/auth/better-auth'
import { createFormalSessionReader } from './features/auth/formal-session-reader'
import {
  createGuestService,
  createGuestTokenCodec,
  createSystemClock,
} from './features/auth/guest-service'
import { createIdentityCompletionService } from './features/auth/identity-completion-service'
import { createTurnstileVerifier } from './features/auth/turnstile-client'
import {
  createFsrsScheduler,
  DEFAULT_REQUEST_RETENTION,
} from './features/study/fsrs-adapter'

const env = loadEnv(Bun.env)

const [
  databaseUrl,
  guestTokenPepper,
  turnstileSecret,
  betterAuthSecret,
  googleClientSecret,
  githubClientSecret,
] = await Promise.all([
  resolveDatabaseUrl(env),
  readSecretFile(env.GUEST_TOKEN_PEPPER_FILE),
  readSecretFile(env.TURNSTILE_SECRET_FILE),
  readSecretFile(env.BETTER_AUTH_SECRET_FILE),
  readSecretFile(env.GOOGLE_CLIENT_SECRET_FILE),
  readSecretFile(env.GITHUB_CLIENT_SECRET_FILE),
])

const cookieSecure = isSecureCookieOrigin(env)

const database = createDatabase(databaseUrl)
const repository = createPrincipalRepository(database.db)
const clock = createSystemClock()
const tokenCodec = createGuestTokenCodec(guestTokenPepper)

const auth = createAuth({
  db: database.db,
  appOrigin: env.APP_ORIGIN,
  secret: betterAuthSecret,
  google: {
    clientId: env.GOOGLE_CLIENT_ID,
    clientSecret: googleClientSecret,
  },
  github: {
    clientId: env.GITHUB_CLIENT_ID,
    clientSecret: githubClientSecret,
  },
  useSecureCookies: cookieSecure,
})

const app = createApp({
  clock,
  guestService: createGuestService({
    repository,
    clock,
    turnstile: createTurnstileVerifier({ secret: turnstileSecret }),
    tokenCodec,
  }),
  actorResolver: createActorResolver({
    repository,
    formalSessionReader: createFormalSessionReader(auth),
  }),
  identityCompletionService: createIdentityCompletionService({
    repository,
    tokenCodec,
  }),
  authHandler: (request) => auth.handler(request),
  cookieSecure,
  contentRepository: createContentRepository(database.db),
  studyRepository: createStudyRepository(database.db),
  fsrsScheduler: createFsrsScheduler(DEFAULT_REQUEST_RETENTION),
  spaRoot: 'apps/web/dist',
})

const server = Bun.serve({ fetch: app.fetch })

console.log(
  `Tango APIを起動しました: ${server.url.href} (許可オリジン: ${env.APP_ORIGIN})`,
)
