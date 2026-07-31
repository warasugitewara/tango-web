import { createApp } from './app'
import { loadEnv } from './env'

const env = loadEnv(Bun.env)
const app = createApp({})

const server = Bun.serve({ fetch: app.fetch })

console.log(
  `Tango APIを起動しました: ${server.url.href} (許可オリジン: ${env.APP_ORIGIN})`,
)
