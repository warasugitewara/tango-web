import { useEffect, useRef } from 'react'

const SCRIPT_ID = 'tango-turnstile-script'

export function TurnstileWidget(props: {
  onToken(token: string | null): void
}) {
  const { onToken } = props
  const container = useRef<HTMLFieldSetElement>(null)

  useEffect(() => {
    const sitekey = import.meta.env.VITE_TURNSTILE_SITE_KEY
    const element = container.current
    if (typeof sitekey !== 'string' || sitekey === '' || element === null) {
      return
    }

    let widgetId: string | null = null
    const render = () => {
      if (window.turnstile === undefined || widgetId !== null) {
        return
      }
      widgetId = window.turnstile.render(element, {
        sitekey,
        callback: (token) => onToken(token),
        'expired-callback': () => onToken(null),
        'error-callback': () => onToken(null),
      })
    }

    let script = document.getElementById(SCRIPT_ID)
    if (script === null) {
      script = document.createElement('script')
      script.id = SCRIPT_ID
      script.setAttribute(
        'src',
        'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit',
      )
      script.setAttribute('async', '')
      script.setAttribute('defer', '')
      document.head.append(script)
    }
    script.addEventListener('load', render)
    render()

    return () => {
      script?.removeEventListener('load', render)
      if (widgetId !== null) {
        window.turnstile?.remove(widgetId)
      }
    }
  }, [onToken])

  return (
    <fieldset
      ref={container}
      className="turnstile-fieldset"
      aria-label="認証チャレンジ"
    />
  )
}
