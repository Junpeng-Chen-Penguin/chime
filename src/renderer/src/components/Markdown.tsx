import React, { type ReactNode } from 'react'

// 引用角标：连续的 [n][m]… 作为一组处理——映射到显示编号后去重（多个片段同文即同号，
// 避免出现 [1][1]），每组渲染去重后的角标；无有效映射的原样保留
function cite(text: string, keyBase: string, citeMap?: Map<number, number>): ReactNode[] {
  if (!citeMap?.size) return [<span key={keyBase}>{text}</span>]
  return text.split(/((?:\[\d+\])+)/g).flatMap((p, i) => {
    if (/^(?:\[\d+\])+$/.test(p)) {
      const ns = [...p.matchAll(/\[(\d+)\]/g)].map((m) => +m[1])
      const disps = [...new Set(ns.map((n) => citeMap.get(n)).filter((d): d is number => !!d))]
      if (disps.length > 0) {
        return disps.map((d, j) => (
          <sup
            key={`${keyBase}-c${i}-${j}`}
            className="mx-0.5 inline-grid h-[15px] min-w-[15px] translate-y-[-1px] place-items-center rounded bg-primary-soft px-0.5 text-[10.5px] font-medium text-primary"
          >
            {d}
          </sup>
        ))
      }
    }
    return <span key={`${keyBase}-${i}`}>{p}</span>
  })
}

function inline(text: string, keyBase: string, citeMap?: Map<number, number>): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*)/g).flatMap((p, i) => {
    if (p.startsWith('**') && p.endsWith('**')) {
      return (
        <strong key={`${keyBase}-${i}`} className="font-semibold">
          {cite(p.slice(2, -2), `${keyBase}-b${i}`, citeMap)}
        </strong>
      )
    }
    return cite(p, `${keyBase}-${i}`, citeMap)
  })
}

// 轻量 Markdown：标题 / 无序列表 / 段落 / 行内加粗 / 引用角标，足够覆盖模型常见输出
export function Markdown({
  text,
  streaming,
  citeMap
}: {
  text: string
  streaming?: boolean
  citeMap?: Map<number, number>
}): React.JSX.Element {
  const lines = text.split('\n')
  const blocks: ReactNode[] = []
  let list: string[] = []

  const flushList = (key: string): void => {
    if (!list.length) return
    const items = list
    blocks.push(
      <ul key={key} className="my-2 flex flex-col gap-1.5">
        {items.map((it, i) => (
          <li key={i} className="flex gap-2.5 leading-[1.78]">
            <span className="mt-[0.66em] size-[5px] flex-none rounded-full bg-foreground/45" />
            <span>{inline(it, `${key}-${i}`, citeMap)}</span>
          </li>
        ))}
      </ul>
    )
    list = []
  }

  lines.forEach((raw, i) => {
    const line = raw.trimEnd()
    const heading = line.match(/^(#{1,4})\s+(.*)$/)
    const bullet = line.match(/^\s*[-*]\s+(.*)$/)
    if (heading) {
      flushList(`l${i}`)
      blocks.push(
        <div key={i} className="mt-5 mb-2 text-[16px] font-semibold first:mt-0">
          {inline(heading[2], `h${i}`, citeMap)}
        </div>
      )
    } else if (bullet) {
      list.push(bullet[1])
    } else if (line.trim() === '') {
      flushList(`l${i}`)
    } else {
      flushList(`l${i}`)
      blocks.push(
        <p key={i} className="mb-3 leading-[1.78] last:mb-0">
          {inline(line, `p${i}`, citeMap)}
        </p>
      )
    }
  })
  flushList('lend')

  if (streaming) {
    const cursor = (
      <span
        key="cursor"
        className="ml-0.5 inline-block h-[0.95em] w-[2px] translate-y-[1px] rounded-full bg-primary align-baseline motion-safe:animate-pulse"
      />
    )
    const last = blocks[blocks.length - 1]
    if (React.isValidElement(last) && last.type === 'p') {
      const el = last as React.ReactElement<{ children?: ReactNode }>
      blocks[blocks.length - 1] = React.cloneElement(el, {}, [el.props.children, cursor])
    } else {
      blocks.push(
        <p key="cursor-p" className="leading-[1.78]">
          {cursor}
        </p>
      )
    }
  }

  return <>{blocks}</>
}
