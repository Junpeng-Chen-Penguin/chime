import { PanelLeft, CirclePlus, Settings, Trash2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { Conversation } from '@/types'

interface Props {
  items: Conversation[]
  activeId: string
  fullscreen: boolean
  settingsActive: boolean // 设置占用主区域时，选中态从会话列表移到设置按钮
  onSelect: (id: string) => void
  onNewChat: () => void
  onCollapse: () => void
  onOpenSettings: () => void
  onDelete: (c: Conversation) => void
}

export default function Sidebar({
  items,
  activeId,
  fullscreen,
  settingsActive,
  onSelect,
  onNewChat,
  onCollapse,
  onOpenSettings,
  onDelete
}: Props): React.JSX.Element {
  return (
    <aside className="flex h-full w-[256px] flex-none flex-col overflow-hidden rounded-[12px] border border-border bg-[#f8f8f7] shadow-[0_1px_2px_rgba(20,22,30,0.04),0_2px_8px_rgba(20,22,30,0.05)]">
      {/* 收起按钮左侧为红绿灯留空；全屏时红绿灯隐藏，回到常规内边距 */}
      <div className={cn('app-drag flex h-[44px] flex-none items-center', fullscreen ? 'pl-3' : 'pl-[70px]')}>
        <button
          onClick={onCollapse}
          title="收起侧栏  ⌘."
          className="app-no-drag grid size-8 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-black/5 hover:text-foreground"
        >
          <PanelLeft className="size-[18px]" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-2.5 pb-2">
        <button
          onClick={onNewChat}
          className="flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-[14px] text-foreground transition-colors hover:bg-black/5"
        >
          <CirclePlus className="size-[18px] text-muted-foreground" />
          新建对话
        </button>

        {/* 纯文字小标题（参照 Claude Recents / WorkBuddy 任务），不带 icon，与下方无 icon 列表对齐 */}
        <div className="mt-4 mb-0.5 px-2.5 text-[12px] font-medium text-muted-foreground">最近</div>
        {/* 016 Case 3 验收补：空列表给一句，不留空白 */}
        {items.length === 0 && (
          <div className="px-2.5 py-2 text-[13px] text-muted-foreground">还没有会话</div>
        )}
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
                  : 'text-foreground hover:bg-black/5'
              )}
            >
              <span className="flex-1 truncate">{it.title}</span>
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  onDelete(it)
                }}
                title="删除会话"
                className="grid size-6 flex-none place-items-center rounded-md text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:bg-black/5 hover:text-foreground"
              >
                <Trash2 className="size-4" />
              </button>
            </div>
          )
        })}
      </div>

      <div className="flex-none border-t border-border p-2.5">
        <button
          onClick={onOpenSettings}
          className={cn(
            'flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-[14px] transition-colors',
            settingsActive
              ? 'bg-primary-soft font-medium text-primary-soft-foreground'
              : 'text-muted-foreground hover:bg-black/5'
          )}
        >
          <Settings className="size-[18px] text-muted-foreground" />
          设置
        </button>
      </div>
    </aside>
  )
}
