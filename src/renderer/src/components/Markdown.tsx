import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

// 对话流的 Markdown：走 react-markdown + remark-gfm，表格 / 有序列表 / 分隔线 / 代码全支持
// （与侧板文档共用引擎，样式各自：.chat-md 为对话流正文尺度）。引用标记在上游已剥离。
// 外链交系统浏览器打开，内链不跳转。
export function Markdown({ text }: { text: string; streaming?: boolean }): React.JSX.Element {
  return (
    <div className="chat-md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: (props) => (
            <a
              {...props}
              onClick={(e) => {
                e.preventDefault()
                const href = String(props.href ?? '')
                if (/^https?:/.test(href)) window.open(href)
              }}
            />
          )
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
}
