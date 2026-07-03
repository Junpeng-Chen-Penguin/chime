import { useEffect } from 'react'
import { Button } from '@/components/ui/button'

interface Props {
  open: boolean
  title: string
  body: string
  confirmText: string
  onConfirm: () => void
  onCancel: () => void
}

export default function ConfirmDialog({
  open,
  title,
  body,
  confirmText,
  onConfirm,
  onCancel
}: Props): React.JSX.Element | null {
  useEffect(() => {
    if (!open) return
    const h = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onCancel()
      if (e.key === 'Enter') onConfirm()
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [open, onCancel, onConfirm])

  if (!open) return null

  return (
    <div
      onClick={onCancel}
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-6"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-[380px] rounded-2xl bg-background p-5 shadow-2xl"
      >
        <div className="mb-2 text-[15.5px] font-semibold">{title}</div>
        <div className="mb-5 text-[13.5px] leading-[1.6] text-muted-foreground">{body}</div>
        <div className="flex justify-end gap-2.5">
          <Button variant="outline" onClick={onCancel} className="h-9">
            取消
          </Button>
          <Button variant="destructive" onClick={onConfirm} className="h-9">
            {confirmText}
          </Button>
        </div>
      </div>
    </div>
  )
}
