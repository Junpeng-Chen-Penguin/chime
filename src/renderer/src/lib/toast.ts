// Toast 统一入口（016 Case 1）：文案格式在这一处拼装，各组件传参不拼句子。
// 成功「已 + 动作 + 对象名」，失败「无法 + 动作 + 对象名：原因」；对象名加书名号，
// 没有名字的对象只写动作。样式与时长在 App.tsx 的 <Toaster /> 统一配置

import { toast } from 'sonner'

const name = (target?: string): string => (target ? `「${target}」` : '')

export function toastSuccess(action: string, target?: string): void {
  toast.success(`已${action}${name(target)}`)
}

export function toastError(action: string, target?: string, reason?: string): void {
  const head = `无法${action}${name(target)}`
  toast.error(reason ? `${head}：${reason}` : head, { duration: 8000 })
}

// 兜底通道（Case 1 功能点 7）：没人接的异步失败，文案剥掉 Electron 的包装前缀
export function toastRawError(message: string): void {
  const clean = message.replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '')
  toast.error(clean || '操作失败', { duration: 8000 })
}
