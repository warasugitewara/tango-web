/** 画面に出すエラー文。サーバの日本語メッセージを優先し、無ければ代わりの文を出す。 */
export function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message !== ''
    ? error.message
    : fallback
}
