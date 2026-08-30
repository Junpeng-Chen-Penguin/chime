import { useEffect, useMemo, useState, isValidElement, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Check, Code, Copy, Image as ImageIcon } from 'lucide-react'
import { renderMermaid, copySvgAsPng } from '@/lib/mermaid'

// 对话流的 Markdown：走 react-markdown + remark-gfm，表格 / 有序列表 / 分隔线 / 代码全支持
// （与侧板文档共用引擎，样式各自：.chat-md 为对话流正文尺度）。引用标记在上游已剥离。
// 外链交系统浏览器打开，内链不跳转。
// 016 Case 10：语言标注 mermaid 的代码块渲染成图（拦 pre 不拦 code——图表块包在 pre 里；
// components 表 useMemo 稳定，避免整树卸载重建导致图表反复重画，侧板 013 踩过）

// 从 pre 的 children（code 元素）取语言与源码
function codeOf(children: ReactNode): { lang: string; text: string } | null {
  if (!isValidElement(children)) return null
  const props = children.props as { className?: string; children?: ReactNode }
  const lang = /language-(\S+)/.exec(props.className ?? '')?.[1] ?? ''
  const text = typeof props.children === 'string' ? props.children : ''
  return { lang: lang.toLowerCase(), text }
}

// 图表块（Case 10）：默认出图；流式期间每 300 毫秒试渲染，失败先显示源码；
// 流结束仍失败才出说明。工具按钮悬停淡入：复制（按当前状态）+ 看源码 / 看图
function MermaidBlock({ code, streaming }: { code: string; streaming: boolean }): React.JSX.Element {
  const [svg, setSvg] = useState<string | null>(null)
  const [failedAt, setFailedAt] = useState<string | null>(null) // 渲染失败时的源码快照
  const [showSrc, setShowSrc] = useState(false)
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    let alive = true
    const t = setTimeout(() => {
      renderMermaid(code).then(
        (s) => {
          if (!alive) return
          setSvg(s)
          setFailedAt(null)
        },
        () => alive && setFailedAt(code)
      )
    }, 300)
    return () => {
      alive = false
      clearTimeout(t)
    }
  }, [code])
  const finalFail = !svg && failedAt === code && !streaming
  const showingChart = !!svg && !showSrc && !finalFail
  const copy = (): void => {
    void (showingChart && svg ? copySvgAsPng(svg) : navigator.clipboard.writeText(code)).then(
      () => {
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      }
    )
  }
  return (
    <div className="group relative my-2 rounded-lg bg-muted p-3">
      <div className="absolute top-2 right-2 z-10 flex gap-1 opacity-0 transition-opacity duration-200 group-hover:opacity-100">
        <button
          onClick={copy}
          title={showingChart ? '复制图片' : '复制源码'}
          className="grid size-7 place-items-center rounded-md bg-background/80 text-muted-foreground hover:text-foreground"
        >
          {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
        </button>
        {!finalFail && svg && (
          <button
            onClick={() => setShowSrc((v) => !v)}
            title={showingChart ? '看源码' : '看图'}
            className="grid size-7 place-items-center rounded-md bg-background/80 text-muted-foreground hover:text-foreground"
          >
            {showingChart ? <Code className="size-4" /> : <ImageIcon className="size-4" />}
          </button>
        )}
      </div>
      {showingChart ? (
        // 图超宽横向滚动，不缩放；高度不限（Case 10 功能点 6）
        <div className="overflow-x-auto" dangerouslySetInnerHTML={{ __html: svg! }} />
      ) : (
        <pre className="overflow-x-auto text-[13px] leading-[1.6] whitespace-pre">{code}</pre>
      )}
      {finalFail && <div className="mt-2 text-[13px] text-muted-foreground">这段图表画不出来</div>}
    </div>
  )
}

export function Markdown({
  text,
  streaming = false
}: {
  text: string
  streaming?: boolean
}): React.JSX.Element {
  const components = useMemo(
    () => ({
      a: (props: { href?: string; children?: ReactNode }) => (
        <a
          {...props}
          onClick={(e) => {
            e.preventDefault()
            const href = String(props.href ?? '')
            if (/^https?:/.test(href)) window.open(href)
          }}
        />
      ),
      pre: (props: { children?: ReactNode }) => {
        const c = codeOf(props.children)
        if (c && c.lang === 'mermaid') return <MermaidBlock code={c.text} streaming={streaming} />
        return <pre>{props.children}</pre>
      }
    }),
    [streaming]
  )
  return (
    <div className="chat-md">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  )
}
