/**
 * 入力欄やボタンにフォーカスがあるときは、画面全体のショートカットを奪わない。
 * ボタン上の Space は「そのボタンを押す」意味なので、二重に反応させない。
 */
export function isInteractiveTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false
  }
  if (target.isContentEditable) {
    return true
  }
  return (
    target.closest('input, textarea, select, button, a[href], summary') !== null
  )
}

/** Ctrl / ⌘ + Enter。複数行の入力欄から送信するときの慣習に合わせる。 */
export function isSubmitShortcut(event: {
  key: string
  ctrlKey: boolean
  metaKey: boolean
}): boolean {
  return event.key === 'Enter' && (event.ctrlKey || event.metaKey)
}
