/** 画面に出すログイン手段。表示名はプロバイダの正式表記に合わせる。 */
export const PROVIDERS = [
  { id: 'google', label: 'Google' },
  { id: 'github', label: 'GitHub' },
] as const

export type ProviderId = (typeof PROVIDERS)[number]['id']

/** 未知のプロバイダはIDのまま出す。黙って消すと連携数が合わなく見える。 */
export function providerLabel(provider: string): string {
  return PROVIDERS.find((known) => known.id === provider)?.label ?? provider
}

/**
 * 連携中のプロバイダを読める名前で並べる。
 * 並びはサーバの返す順ではなく画面の定義順に揃え、未知のものは後ろへ置く。
 */
export function providerLabels(
  providers: readonly string[],
  separator = '、',
): string {
  const known = PROVIDERS.filter((provider) =>
    providers.includes(provider.id),
  ).map((provider) => provider.label)
  const unknown = providers.filter(
    (provider) => !PROVIDERS.some((known) => known.id === provider),
  )
  return [...known, ...unknown].join(separator)
}
