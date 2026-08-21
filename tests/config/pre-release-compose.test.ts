import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'

const compose = readFileSync(
  new URL('../../infra/pre-release/compose.yml', import.meta.url),
  'utf8',
)
const envExample = readFileSync(
  new URL('../../infra/pre-release/.env.example', import.meta.url),
  'utf8',
)

describe('pre-release compose contract', () => {
  test('publishes the app only on the LXC loopback interface', () => {
    expect(compose).toContain("- '127.0.0.1:3000:3000'")
    expect(compose).not.toContain("expose:\n      - '3000'")
  })

  test('pins the non-root app identity used to own file secrets', () => {
    expect(compose).toContain("user: '1000:1000'")
  })

  test('leaves the Cloudflare Tunnel under host systemd management', () => {
    expect(compose).not.toMatch(/^ {2}cloudflared:/m)
    expect(compose).not.toContain('cloudflare_tunnel_token')
    expect(envExample).not.toContain('CLOUDFLARE_TUNNEL_TOKEN_FILE')
  })
})
