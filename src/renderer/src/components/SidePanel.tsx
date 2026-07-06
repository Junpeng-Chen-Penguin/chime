import { useEffect, useMemo, useRef, useState } from 'react'
import { X, FileX2, Loader2, BookX } from 'lucide-react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { cn } from '@/lib/utils'
import { chunkMarkdown } from '../../../shared/chunker'
import type { SourceRef } from '../../../preload/index.d'

// 侧板：通用容器 + 本版唯一内容「来源文档阅读」。
// 容器管标题栏 / 关闭 / 动效；内容自行渲染（能力与入口分离，见 PRD 架构预留）
export interface DocPanelData {
  file: string // 仓库内相对路径
  content: string | null // 磁盘当前内容；异常时为 null
  sources: SourceRef[] // 本条消息中该文档被引用的片段（含原文快照）
  error?: 'missing' | 'no-kb' | 'busy' // 异常态：侧板内空态展示（导航到达目的地，由目的地呈现状态）
}

// ── Mermaid：动态加载 + 串行渲染队列（render 不可并发） ──
let mermaidP: Promise<typeof import('mermaid')['default']> | null = null
let mermaidSeq = 0
let mermaidQueue: Promise<unknown> = Promise.resolve()

function renderMermaid(code: string): Promise<string> {
  if (!mermaidP) {
    mermaidP = import('mermaid').then((m) => {
      m.default.initialize({ startOnLoad: false, theme: 'neutral', fontFamily: 'inherit' })
      return m.default
    })
  }
  const job = mermaidQueue.then(async () => {
    const mm = await mermaidP!
    const { svg } = await mm.render(`chime-mmd-${++mermaidSeq}`, code)
    return svg
  })
  mermaidQueue = job.catch(() => undefined)
  return job
}

function MermaidBlock({ code, onSettled }: { code: string; onSettled: () => void }): React.JSX.Element {
  const [svg, setSvg] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let alive = true
    renderMermaid(code).then(
      (s) => {
        if (alive) setSvg(s)
        onSettled()
      },
      () => {
        if (alive) setFailed(true)
        onSettled()
      }
    )
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code])
  if (failed) {
    // 语法错误降级：显示原代码，不白屏
    return (
      <pre className="my-3 overflow-x-auto rounded-lg bg-muted p-3 text-[13px]">
        <code>{code}</code>
      </pre>
    )
  }
  if (!svg) return <div className="my-3 text-[12px] text-muted-foreground">图表渲染中…</div>
  return <div className="my-3 flex justify-center overflow-x-auto" dangerouslySetInnerHTML={{ __html: svg }} />
}

interface Props {
  doc: DocPanelData
  onClose: () => void
}

export default function SidePanel({ doc, onClose }: Props): React.JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null)
  const anchorRef = useRef<HTMLElement | null>(null)
  const anchorTakenRef = useRef(false)
  anchorTakenRef.current = false // 每次渲染重新认领首个高亮块

  // 高亮区间：对当前内容重新切块，与消息自带的片段原文快照精确匹配
  // （与入库共用同一切块器 = 同一套规范化；多处相同内容以入库行号为锚取最近）
  const ranges = useMemo(() => {
    if (!doc.content) return []
    const withContent = doc.sources.filter((s) => s.content)
    if (withContent.length === 0) return []
    const fresh = chunkMarkdown(doc.content)
    const out: { start: number; end: number }[] = []
    for (const s of withContent) {
      const matches = fresh.filter((f) => f.content === s.content)
      if (matches.length === 0) continue
      const best = matches.reduce((a, b) =>
        Math.abs(a.startLine - s.startLine) <= Math.abs(b.startLine - s.startLine) ? a : b
      )
      out.push({ start: best.startLine, end: best.endLine })
    }
    return out.sort((a, b) => a.start - b.start)
  }, [doc])

  // 定位滚动：首屏一次；mermaid / 图片异步加载改变高度后二次校正
  const settle = (): void => {
    if (anchorRef.current) anchorRef.current.scrollIntoView({ block: 'start', behavior: 'auto' })
  }
  useEffect(() => {
    const t1 = setTimeout(settle, 50)
    const t2 = setTimeout(settle, 700)
    return () => {
      clearTimeout(t1)
      clearTimeout(t2)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc])

  // 块级元素统一包装：按源码行区间判定高亮；嵌套重复上色由 CSS 后代选择器抵消
  const block = (Tag: string) =>
    function Block(props: Record<string, unknown>): React.JSX.Element {
      const node = props.node as { position?: { start: { line: number }; end: { line: number } } } | undefined
      const pos = node?.position
      const hit = !!pos && ranges.some((r) => pos.start.line <= r.end && pos.end.line >= r.start)
      const { node: _n, ...rest } = props
      const ref = (el: HTMLElement | null): void => {
        if (el && hit && !anchorTakenRef.current) {
          anchorTakenRef.current = true
          anchorRef.current = el
        }
      }
      const T = Tag as 'div'
      return <T ref={ref} className={cn(hit && 'doc-hl')} {...(rest as object)} />
    }

  const name = doc.file.split('/').pop()!.replace(/\.md$/, '')

  return (
    <div className="animate-in slide-in-from-right-4 flex h-full flex-1 flex-col overflow-hidden rounded-[12px] border border-black/[0.09] bg-white shadow-[0_1px_2px_rgba(0,0,0,0.03),0_2px_8px_rgba(0,0,0,0.05)] duration-300 min-w-[380px]">
      <header className="flex h-[44px] flex-none items-center gap-2.5 border-b border-border px-4">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[14px] leading-tight font-semibold">{name}</div>
          <div className="truncate text-[11px] text-muted-foreground">{doc.file}</div>
        </div>
        <button
          onClick={onClose}
          title="关闭"
          className="grid size-8 flex-none place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <X className="size-[18px]" />
        </button>
      </header>

      {doc.error ? (
        <PanelEmpty error={doc.error} />
      ) : (
      <div ref={scrollRef} className="doc-md flex-1 overflow-y-auto px-6 py-5">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            p: block('p'),
            h1: block('h1'),
            h2: block('h2'),
            h3: block('h3'),
            h4: block('h4'),
            h5: block('h5'),
            h6: block('h6'),
            ul: block('ul'),
            ol: block('ol'),
            table: block('table'),
            blockquote: block('blockquote'),
            hr: block('hr'),
            pre: (props) => {
              // 拦截 mermaid 围栏块 → 渲染为图；其余照常
              const node = props.node as unknown as {
                position?: { start: { line: number }; end: { line: number } }
                children?: { tagName?: string; properties?: { className?: string[] }; children?: { value?: string }[] }[]
              }
              const codeNode = node?.children?.[0]
              const lang = codeNode?.properties?.className?.find((c) => c.startsWith('language-'))
              const codeText = codeNode?.children?.[0]?.value ?? ''
              const pos = node?.position
              const hit = !!pos && ranges.some((r) => pos.start.line <= r.end && pos.end.line >= r.start)
              const ref = (el: HTMLElement | null): void => {
                if (el && hit && !anchorTakenRef.current) {
                  anchorTakenRef.current = true
                  anchorRef.current = el
                }
              }
              if (lang === 'language-mermaid') {
                return (
                  <div ref={ref} className={cn(hit && 'doc-hl')}>
                    <MermaidBlock code={codeText} onSettled={settle} />
                  </div>
                )
              }
              const { node: _n, ...rest } = props
              return <pre ref={ref as never} className={cn(hit && 'doc-hl')} {...(rest as object)} />
            },
            img: (props) => {
              const src = String(props.src ?? '')
              const isAbs = /^(https?:|data:|file:|chime-doc:)/.test(src)
              const url = isAbs
                ? src
                : `chime-doc://img/?doc=${encodeURIComponent(doc.file)}&src=${encodeURIComponent(src)}`
              return <img src={url} alt={String(props.alt ?? '')} loading="lazy" onLoad={settle} />
            },
            a: (props) => (
              // 只读视图：外链交系统浏览器，内链不跳转
              <a
                {...props}
                onClick={(e) => {
                  e.preventDefault()
                  const href = String(props.href ?? '')
                  if (/^https?:/.test(href)) window.open(href)
                }}
              />
            )
          } as Components}
        >
          {doc.content ?? ''}
        </ReactMarkdown>
      </div>
      )}
    </div>
  )
}

const EMPTY_COPY: Record<NonNullable<DocPanelData['error']>, { title: string; desc: string }> = {
  missing: {
    title: '文档已不存在',
    desc: '该文档已从知识库来源中删除或移动。同步知识库后，来源清单将与最新内容对齐。'
  },
  'no-kb': { title: '知识库已移除', desc: '重新添加知识库后即可查看来源文档。' },
  busy: { title: '知识库更新中', desc: '请稍候片刻，更新完成后再试。' }
}

function PanelEmpty({ error }: { error: NonNullable<DocPanelData['error']> }): React.JSX.Element {
  const { title, desc } = EMPTY_COPY[error]
  const Icon = error === 'busy' ? Loader2 : error === 'no-kb' ? BookX : FileX2
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-10 text-center">
      <div className="grid size-12 place-items-center rounded-2xl bg-muted">
        <Icon className={error === 'busy' ? 'size-5 animate-spin text-muted-foreground' : 'size-5 text-muted-foreground'} />
      </div>
      <div className="text-[14px] font-semibold">{title}</div>
      <div className="max-w-[300px] text-[12px] leading-[1.7] text-muted-foreground">{desc}</div>
    </div>
  )
}
