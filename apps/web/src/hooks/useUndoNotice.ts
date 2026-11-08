import { useMutation } from '@tanstack/react-query'
import { useState } from 'react'
import type { UndoableNotice } from '../components/UndoNotice'

type PendingUndo = {
  message: string
  restore(): Promise<void>
}

/**
 * 「ゴミ箱へ移しました［元に戻す］」の状態を持つ。
 * 出せるのは直前の1件だけ。次の操作をしたら前の知らせは差し替える。
 */
export function useUndoNotice() {
  const [pending, setPending] = useState<PendingUndo | null>(null)
  const restore = useMutation({
    mutationFn: (target: PendingUndo) => target.restore(),
    onSuccess: () => {
      setPending(null)
    },
  })

  const notice: UndoableNotice | null =
    pending === null
      ? null
      : { message: pending.message, undo: () => restore.mutate(pending) }

  return {
    notice,
    undoing: restore.isPending,
    error: restore.isError ? restore.error.message : null,
    show(message: string, restoreFn: () => Promise<void>) {
      restore.reset()
      setPending({ message, restore: restoreFn })
    },
    dismiss() {
      restore.reset()
      setPending(null)
    },
  }
}
