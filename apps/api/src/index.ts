import { createDatabase, createPrincipalRepository } from '@tango/db'
import { createApp } from './app'
import { loadEnv, readSecretFile } from './env'
import { createActorResolver } from './features/auth/actor-resolver'
import {
  createGuestService,
  createGuestTokenCodec,
  createSystemClock,
} from './features/auth/guest-service'
import { createTurnstileVerifier } from './features/auth/turnstile-client'

const env = loadEnv(Bun.env)

const [guestTokenPepper, turnstileSecret] = await Promise.all([
  readSecretFile(env.GUEST_TOKEN_PEPPER_FILE),
  readSecretFile(env.TURNSTILE_SECRET_FILE),
])

const database = createDatabase(env.DATABASE_URL)
const repository = createPrincipalRepository(database.db)
const clock = createSystemClock()

const guestService = createGuestService({
  repository,
  clock,
  turnstile: createTurnstileVerifier({ secret: turnstileSecret }),
  tokenCodec: createGuestTokenCodec(guestTokenPepper),
})

// 正式セッションの読み取りはTask 5でBetter Authに接続する。
const actorResolver = createActorResolver({
  repository,
  formalSessionReader: { read: async () => null },
})

const app = createApp({
  clock,
  guestService,
  actorResolver,
  cookieSecure: new URL(env.APP_ORIGIN).protocol === 'https:',
})

const server = Bun.serve({ fetch: app.fetch })

console.log(
  `Tango APIを起動しました: ${server.url.href} (許可オリジン: ${env.APP_ORIGIN})`,
)
