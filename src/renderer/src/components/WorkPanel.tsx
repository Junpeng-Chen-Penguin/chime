// 工作面板首页（015 Case 1）：本会话的制品列表 + 工作空间清单。
// 容器是通用侧板（SidePanel），这里只管内容；点制品条目由 App 把侧板内容切到制品详情。
import { Folder, FolderPlus, Table2, TriangleAlert, X } from 'lucide-react'
import type { WsEntry } from '../../../preload/index.d'

export interface WorkArtifact {
  id: number
  title: string
  createdAt: number
}

export function WorkContent({
  artifacts,
  ws,
  frozen,
  onOpenArtifact,
  onAddWs,
  onRemoveWs
}: {
  artifacts: WorkArtifact[]
  ws: WsEntry[]
  frozen: boolean // 定格后才有「添加」入口（首条消息前经输入框下方的选择器增减）
  onOpenArtifact: (id: number) => void
  onAddWs: () => void
  onRemoveWs: (path: string) => void
}): React.JSX.Element {
  const empty = artifacts.length === 0 && ws.length === 0
  return (
    <div className="flex-1 overflow-y-auto px-4 py-3">
      {empty && (
        <div className="pt-8 text-center text-[13px] text-muted-foreground">
          本会话还没有制品和工作空间
        </div>
      )}

      {artifacts.length > 0 && (
        <div className="mb-5">
          <div className="mb-1.5 text-[12px] font-medium text-muted-foreground">制品</div>
          <div className="flex flex-col">
            {artifacts.map((a) => (
              <button
                key={a.id}
                onClick={() => onOpenArtifact(a.id)}
                className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-[13px] transition-colors hover:bg-muted"
              >
                <Table2 className="size-4 flex-none text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate">{a.title}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {(ws.length > 0 || frozen) && (
        <div>
          {/* 添加入口与标题同一行（验收意见 #6） */}
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-[12px] font-medium text-muted-foreground">工作空间</span>
            {frozen && (
              <button
                onClick={onAddWs}
                title="添加工作空间"
                className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[12px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                <FolderPlus className="size-3.5" />
                添加
              </button>
            )}
          </div>
          <div className="flex flex-col">
            {ws.map((e) => (
              <div
                key={e.path}
                title={e.path}
                className="group flex w-full items-center gap-2 rounded-lg px-2 py-2 text-[13px]"
              >
                {e.missing ? (
                  <TriangleAlert className="size-4 flex-none text-amber-600" />
                ) : (
                  <Folder className="size-4 flex-none text-muted-foreground" />
                )}
                <span className="min-w-0 flex-1 truncate">{e.name}</span>
                {e.missing && (
                  <>
                    <span className="flex-none text-[11px] text-amber-700">已失效</span>
                    {/* 只增不减的唯一例外：失效目录可移除（授权指向的东西没了） */}
                    <button
                      onClick={() => onRemoveWs(e.path)}
                      title="移除"
                      className="grid size-6 flex-none place-items-center rounded-md text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:bg-muted hover:text-foreground"
                    >
                      <X className="size-3.5" />
                    </button>
                  </>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
