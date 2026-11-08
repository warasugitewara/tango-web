/**
 * ファイル名に使えない文字を置き換える。
 * Windows で禁止の記号と制御文字を `_` にし、空になったら代わりの名前を使う。
 */
export function toSafeFileName(name: string, fallback = 'deck'): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: 制御文字を取り除くための指定
  const replaced = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim()
  return replaced === '' ? fallback : replaced
}

/** 内容をJSONファイルとして利用者へ渡す。 */
export function downloadJson(filename: string, content: unknown): void {
  const blob = new Blob([JSON.stringify(content, null, 2)], {
    type: 'application/json',
  })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  // クリック直後に破棄すると、ブラウザによってはダウンロードが始まる前に
  // URLが無効になる。処理を一巡させてから破棄する。
  setTimeout(() => URL.revokeObjectURL(url), 0)
}
