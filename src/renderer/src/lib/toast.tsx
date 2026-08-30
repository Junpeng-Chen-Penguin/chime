// Toast 统一入口（016 Case 1）：文案格式在这一处拼装，各组件传参不拼句子。
// 成功「已 + 动作 + 对象名」，失败「无法 + 动作 + 对象名：原因」；对象名加书名号，
// 没有名字的对象只写动作。
// 卡片完全自绘（验收修订）：错误浅红底、成功浅绿底（白底看不出报错场景）；
// 关闭按钮在右侧（sonner 自带的钉死在左上，不合使用习惯）。时长、排队、悬停暂停仍由 sonner 管

import { toast as sonner } from 'sonner'
import { AlertCircle, Check, X } from 'lucide-react'

function show(kind: 'success' | 'error', text: string): void {
  const error = kind === 'error'
  sonner.custom(
    (id) => (
      <div
        className={
          'flex min-w-[288px] max-w-[400px] items-center gap-2.5 rounded-xl border px-4 py-3 text-[13px] text-foreground shadow-lg [-webkit-app-region:no-drag] ' +
          (error ? 'border-red-200/70 bg-red-50' : 'border-emerald-200/70 bg-emerald-50')
        }
      >
        {error ? (
          <AlertCircle className="size-4 flex-none text-destructive" />
        ) : (
          <Check className="size-4 flex-none text-emerald-600" />
        )}
        <span className="min-w-0 flex-1 [display:-webkit-box] overflow-hidden [-webkit-box-orient:vertical] [-webkit-line-clamp:2]">
          {text}
        </span>
        <button
          onClick={() => sonner.dismiss(id)}
          className="grid size-5 flex-none place-items-center rounded-md text-muted-foreground transition-colors hover:bg-black/5 hover:text-foreground"
        >
          <X className="size-3.5" />
        </button>
      </div>
    ),
    { duration: error ? 8000 : 4000 }
  )
}

const name = (target?: string): string => (target ? `「${target}」` : '')

export function toastSuccess(action: string, target?: string): void {
  show('success', `已${action}${name(target)}`)
}

export function toastError(action: string, target?: string, reason?: string): void {
  const head = `无法${action}${name(target)}`
  show('error', reason ? `${head}：${reason}` : head)
}

// 兜底通道（Case 1 功能点 7）：没人接的异步失败，文案剥掉 Electron 的包装前缀
export function toastRawError(message: string): void {
  const clean = message.replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '')
  show('error', clean || '操作失败')
}
