import React, { type ReactNode } from 'react'

function inline(text: string, keyBase: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*)/g).map((p, i) => {
    if (p.startsWith('**') && p.endsWith('**')) {
      return (
        <strong key={`${keyBase}-${i}`} className="font-semibold">
          {p.slice(2, -2)}
        </strong>
      )
    }
    return <span key={`${keyBase}-${i}`}>{p}</span>
  })
}

// 轻量 Markdown：标题 / 无序列表 / 段落 / 行内加粗，足够覆盖模型常见输出（引用标记在上游已剥离）
export function Markdown({
  text,
  streaming
}: {
  text: string
  streaming?: boolean
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
            <span>{inline(it, `${key}-${i}`)}</span>
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
          {inline(heading[2], `h${i}`)}
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
          {inline(line, `p${i}`)}
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
