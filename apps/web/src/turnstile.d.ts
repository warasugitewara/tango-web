type TurnstileOptions = {
  sitekey: string
  callback(token: string): void
  'expired-callback'(): void
  'error-callback'(): void
}

interface Window {
  turnstile?: {
    render(container: HTMLElement, options: TurnstileOptions): string
    remove(widgetId: string): void
  }
}
