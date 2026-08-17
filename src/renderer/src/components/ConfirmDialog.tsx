import { useEffect } from 'react'
import { Button } from '@/components/ui/button'

interface Props {
  open: boolean
  title: string
  body: string
  confirmText: string
  cancelText?: string // 缺省「取消」
  confirmVariant?: 'default' | 'destructive' // 缺省 destructive（既有调用方全是删除类确认）
  alertOnly?: boolean // 仅告知：只有确认键（如「已在授权范围内」），Esc 与确认同效
  onConfirm: () => void
  onCancel: () => void
}

export default function ConfirmDialog({
  open,
  title,
  body,
  confirmText,
  cancelText,
  confirmVariant,
  alertOnly,
  onConfirm,
  onCancel
}: Props): React.JSX.Element | null {
  useEffect(() => {
    if (!open) return
    const h = (e: KeyboardEvent): void => {
      // 输入法合成中的 Enter 是确认候选词，不该触发确认
      if (e.isComposing || e.keyCode === 229) return
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
        <div className="mb-2 text-[15px] font-semibold">{title}</div>
        <div className="mb-5 text-[13px] leading-[1.6] text-muted-foreground">{body}</div>
        <div className="flex justify-end gap-2.5">
          {!alertOnly && (
            <Button variant="outline" onClick={onCancel} className="h-9">
              {cancelText ?? '取消'}
            </Button>
          )}
          <Button variant={confirmVariant ?? 'destructive'} onClick={onConfirm} className="h-9">
            {confirmText}
          </Button>
        </div>
      </div>
    </div>
  )
}
