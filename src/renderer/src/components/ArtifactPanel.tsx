import type { ArtifactView } from '../../../preload/index.d'

// 制品表格内容（侧板容器的一种内容，容器见 SidePanel）。
// 滚动容器不留顶部内边距——吸顶表头贴住容器顶，行数据不会从表头上方穿出。
// rows 已在主进程按渲染上限截断，totalRows 为完整行数（超出时提示）。
export function ArtifactContent({ artifact }: { artifact: ArtifactView }): React.JSX.Element {
  return (
    <div className="flex-1 overflow-auto">
      <table className="w-full border-collapse text-[13px]">
        <thead>
          <tr>
            {artifact.columns.map((c, i) => (
              <th
                key={c.key}
                className={
                  'sticky top-0 z-10 border-b border-border bg-white px-3 py-2 text-left font-medium whitespace-nowrap' +
                  (i === 0 ? ' pl-6' : '') +
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
              {artifact.columns.map((c, j) => (
                <td
                  key={c.key}
                  className={
                    'border-b border-border/60 px-3 py-1.5 align-top' +
                    (j === 0 ? ' pl-6' : '') +
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
          仅显示前 {artifact.rows.length.toLocaleString()} 行（共 {artifact.totalRows.toLocaleString()} 行，数据完整保存）
        </div>
      )}
    </div>
  )
}
