import { useState } from 'react'
import { createPortal } from 'react-dom'
import type { ArtifactView } from '../../../preload/index.d'

// 制品表格内容（侧板容器的一种内容，容器见 SidePanel）。
// 滚动容器不留顶部内边距——吸顶表头贴住容器顶，行数据不会从表头上方穿出。
// rows 已在主进程按渲染上限截断，totalRows 为完整行数（超出时提示）。
//
// 行勾选与右键菜单（013 Case 2 模块二）：勾选状态与未发出的 chip 是同一份数据的两个视图——
// 打开侧板时按该制品未发出的引用初始化勾选（chip 还挂着就恢复勾选，发出后 chip 清空、
// 侧板回初始态）；「加进对话」把勾选写回 chip（同制品替换，一个制品最多一个 chip）。
// 右键菜单只在有勾选行时出现，只作用于已勾选的行（不把光标下那行自动算进去）；
// 超过 200 行时菜单内提示改用导出，不执行。
// 菜单用 portal 挂到 body：侧板容器带入场动画与 overflow，fixed 定位在里面会被裁剪
const REF_ROWS_MAX = 200

export function ArtifactContent({
  artifact,
  referencedRows,
  onAddToChat
}: {
  artifact: ArtifactView
  referencedRows?: number[] // 该制品未发出的引用行（挂载时恢复勾选）
  onAddToChat?: (rowIndexes: number[]) => void
}): React.JSX.Element {
  const [sel, setSel] = useState<Set<number>>(() => new Set(referencedRows ?? []))
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const canPick = !!onAddToChat
  const allPicked = artifact.rows.length > 0 && sel.size === artifact.rows.length

  const toggle = (i: number): void =>
    setSel((s) => {
      const n = new Set(s)
      if (n.has(i)) n.delete(i)
      else n.add(i)
      return n
    })

  return (
    <div
      className="flex-1 overflow-auto"
      onContextMenu={(e) => {
        if (!canPick || sel.size === 0) return
        e.preventDefault()
        setMenu({ x: e.clientX, y: e.clientY })
      }}
    >
      <table className="w-full border-collapse text-[13px]">
        <thead>
          <tr>
            {canPick && (
              <th className="sticky top-0 z-10 w-9 border-b border-border bg-background py-2 pr-1 pl-5 select-none">
                <input
                  type="checkbox"
                  className="block accent-primary"
                  checked={allPicked}
                  onChange={() =>
                    setSel(allPicked ? new Set() : new Set(artifact.rows.map((_, i) => i)))
                  }
                />
              </th>
            )}
            {artifact.columns.map((c, i) => (
              <th
                key={c.key}
                className={
                  'sticky top-0 z-10 border-b border-border bg-background px-3 py-2 text-left font-medium whitespace-nowrap' +
                  (i === 0 && !canPick ? ' pl-6' : '') +
                  (i === artifact.columns.length - 1 ? ' pr-6' : '')
                }
              >
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {artifact.rows.map((row, i) => (
            <tr key={i} className={i % 2 === 1 ? 'bg-muted/50' : undefined}>
              {canPick && (
                <td className="w-9 border-b border-border py-1.5 pr-1 pl-5 align-top select-none">
                  <input
                    type="checkbox"
                    className="block accent-primary"
                    checked={sel.has(i)}
                    onChange={() => toggle(i)}
                  />
                </td>
              )}
              {artifact.columns.map((c, j) => (
                <td
                  key={c.key}
                  className={
                    'border-b border-border px-3 py-1.5 align-top' +
                    (j === 0 && !canPick ? ' pl-6' : '') +
                    (j === artifact.columns.length - 1 ? ' pr-6' : '')
                  }
                >
                  {row[c.key] === undefined || row[c.key] === null ? '' : String(row[c.key])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {artifact.totalRows > artifact.rows.length && (
        <div className="py-3 text-center text-[12px] text-muted-foreground">
          仅显示前 {artifact.rows.length.toLocaleString()} 行（共{' '}
          {artifact.totalRows.toLocaleString()} 行）——完整数据可从右上角导出 CSV
        </div>
      )}
      {menu &&
        createPortal(
          <div
            className="fixed inset-0 z-50"
            onMouseDown={() => setMenu(null)}
            onContextMenu={(e) => {
              e.preventDefault()
              setMenu(null)
            }}
          >
            <div
              className="absolute min-w-[160px] rounded-xl border border-border bg-popover p-1.5 shadow-lg"
              style={{ left: menu.x, top: menu.y }}
              onMouseDown={(e) => e.stopPropagation()}
            >
              {sel.size > REF_ROWS_MAX ? (
                <div className="max-w-[220px] px-2.5 py-1.5 text-[12px] leading-[1.6] text-muted-foreground">
                  已选 {sel.size} 行，超过 {REF_ROWS_MAX} 行上限。要用完整数据，请从右上角导出 CSV。
                </div>
              ) : (
                <button
                  className="w-full rounded-md px-2.5 py-1.5 text-left text-[13px] hover:bg-muted"
                  onClick={() => {
                    onAddToChat?.([...sel].sort((a, b) => a - b))
                    setMenu(null)
                  }}
                >
                  加进对话
                </button>
              )}
            </div>
          </div>,
          document.body
        )}
    </div>
  )
}
