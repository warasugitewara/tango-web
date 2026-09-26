/**
 * テスト環境の jsdom は CSS 変数（`var()`）を解決せず、透明として返す。
 * 画面の配色を検証するテストのために、`:root` のトークンを実際の値へ展開する。
 * 本番のスタイルには関与しない。
 */
export function resolveCssVariables(css: string): string {
  const tokens = new Map<string, string>()

  for (const block of css.matchAll(/:root\s*\{([^}]*)\}/g)) {
    const body = block[1] ?? ''
    for (const declaration of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
      const name = declaration[1]
      const value = declaration[2]
      if (name !== undefined && value !== undefined) {
        tokens.set(name, value.trim())
      }
    }
  }

  // トークンが別のトークンを参照していても展開しきる。循環は回数で打ち切る。
  let resolved = css
  for (let pass = 0; pass < 5; pass += 1) {
    const next = resolved.replace(
      /var\((--[\w-]+)\)/g,
      (whole, name: string) => tokens.get(name) ?? whole,
    )
    if (next === resolved) {
      break
    }
    resolved = next
  }

  return resolved
}

function parseRgb(value: string): readonly [number, number, number] {
  const match = /^rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(value)
  if (match === null) {
    throw new Error(`色として読めません: ${value}`)
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

function relativeLuminance(value: string): number {
  const channels = parseRgb(value).map((channel) => {
    const srgb = channel / 255
    return srgb <= 0.03928 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4
  })
  const [red = 0, green = 0, blue = 0] = channels
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue
}

/** WCAG 2.x のコントラスト比。本文は 4.5 以上が基準。 */
export function contrastRatio(foreground: string, background: string): number {
  const lighter = Math.max(
    relativeLuminance(foreground),
    relativeLuminance(background),
  )
  const darker = Math.min(
    relativeLuminance(foreground),
    relativeLuminance(background),
  )
  return (lighter + 0.05) / (darker + 0.05)
}
