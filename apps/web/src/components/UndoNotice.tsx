/** 取り消せる操作をした直後に出す知らせ。 */
export type UndoableNotice = {
  message: string
  undo(): void
}

/**
 * 操作の結果を読み上げ、その場で戻す手段を添える。
 * 読み上げ領域は中身が空でも置いておく。後から差し込んだ領域は、
 * 支援技術によっては変化を拾わないため。
 */
export function UndoNoticeSlot(props: {
  notice: UndoableNotice | null
  undoing: boolean
  error: string | null
  onDismiss(): void
}) {
  const { notice, undoing, error, onDismiss } = props

  return (
    <div className="notice-slot" role="status">
      {notice === null ? null : (
        <div className="undo-notice">
          <span>{notice.message}</span>
          <button type="button" disabled={undoing} onClick={notice.undo}>
            元に戻す
          </button>
          <button
            type="button"
            className="notice-dismiss"
            aria-label="知らせを閉じる"
            onClick={onDismiss}
          >
            ×
          </button>
          {error === null ? null : <p className="form-error">{error}</p>}
        </div>
      )}
    </div>
  )
}
