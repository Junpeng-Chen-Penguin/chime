// 主区域空态（016 Case 3）：图标、标题、说明三段居中，尺寸取自侧板阅读视图的空态。
// 空的是页面里一块区域（上方还有分区名、新建按钮）加虚线框；整块面板都空不加框。
// 文案照 Chime-文案规范：标题「还没有 + 对象名」，说明写配好之后能做什么

import type { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'

export default function EmptyState({
  icon: Icon,
  title,
  desc,
  framed = false
}: {
  icon: LucideIcon
  title: string
  desc: string
  framed?: boolean
}): React.JSX.Element {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-3 px-10 py-10 text-center',
        framed && 'rounded-xl border border-dashed border-border'
      )}
    >
      <div className="grid size-12 place-items-center rounded-2xl bg-muted">
        <Icon className="size-[18px] text-muted-foreground" />
      </div>
      <div className="text-[14px] font-semibold">{title}</div>
      <div className="max-w-[300px] text-[12px] leading-[1.7] text-muted-foreground">{desc}</div>
    </div>
  )
}
