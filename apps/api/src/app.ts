import { Hono } from 'hono'

export type AppDependencies = Readonly<Record<never, never>>

export function createApp(_deps: AppDependencies) {
  return new Hono().get('/health/live', (context) =>
    context.json({ status: 'ok' as const }),
  )
}
