import { PanelLeft, CirclePlus, Settings, Trash2, Clock } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { Conversation } from '@/types'

interface Props {
  items: Conversation[]
  activeId: string
  onSelect: (id: string) => void
  onNewChat: () => void
  onCollapse: () => void
  onOpenSettings: () => void
  onDelete: (c: Conversation) => void
}

export default function Sidebar({
  items,
  activeId,
  onSelect,
  onNewChat,
  onCollapse,
  onOpenSettings,
  onDelete
}: Props): React.JSX.Element {
  return (
    <aside className="flex h-full w-[256px] flex-none flex-col overflow-hidden rounded-[12px] border border-black/[0.05] bg-[#f8f8f7] shadow-[0_1px_2px_rgba(20,22,30,0.05),0_4px_14px_rgba(20,22,30,0.07)]">
      <div className="app-drag flex h-[44px] flex-none items-center pl-[84px]">
        <button
          onClick={onCollapse}
          title="收起侧栏  ⌘."
          className="app-no-drag grid size-8 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-black/[0.06] hover:text-foreground"
        >
          <PanelLeft className="size-[18px]" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-2.5 pb-2">
        <button
          onClick={onNewChat}
          className="flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-[15px] text-foreground transition-colors hover:bg-black/[0.05]"
        >
          <CirclePlus className="size-[18px] text-muted-foreground" />
          新建对话
        </button>

        <div className="mt-3 flex items-center gap-1.5 px-2.5 py-1.5 text-[13px] leading-none font-medium text-muted-foreground">
          <Clock className="size-3.5 shrink-0" />
          <span className="leading-none">最近</span>
        </div>
        {items.map((it) => {
          const active = it.id === activeId
          return (
            <div
              key={it.id}
              onClick={() => onSelect(it.id)}
              className={cn(
                'group mb-px flex h-9 w-full cursor-pointer items-center gap-1 rounded-lg pr-1 pl-2.5 text-[15px] transition-colors',
                active
                  ? 'bg-primary-soft font-medium text-primary-soft-foreground'
                  : 'text-foreground hover:bg-black/[0.05]'
              )}
            >
              <span className="flex-1 truncate">{it.title}</span>
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  onDelete(it)
                }}
                title="删除会话"
                className="grid size-6 flex-none place-items-center rounded-md text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:bg-black/[0.08] hover:text-foreground"
              >
                <Trash2 className="size-4" />
              </button>
            </div>
          )
        })}
      </div>

      <div className="flex-none border-t border-black/[0.06] p-2.5">
        <button
          onClick={onOpenSettings}
          className="flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-[15px] text-muted-foreground transition-colors hover:bg-black/[0.05]"
        >
          <Settings className="size-[18px] text-muted-foreground" />
          设置
        </button>
      </div>
    </aside>
  )
}
