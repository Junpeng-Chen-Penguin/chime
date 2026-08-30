// mermaid 渲染（016 八节，从侧板抽出共用）：动态加载 + 串行渲染队列（render 不可并发）。
// 主题与字体配置只此一份，侧板与对话流同一套

let mermaidP: Promise<(typeof import('mermaid'))['default']> | null = null
let mermaidSeq = 0
let mermaidQueue: Promise<unknown> = Promise.resolve()

export function renderMermaid(code: string): Promise<string> {
  if (!mermaidP) {
    mermaidP = import('mermaid').then((m) => {
      m.default.initialize({ startOnLoad: false, theme: 'neutral', fontFamily: 'inherit' })
      return m.default
    })
  }
  const job = mermaidQueue.then(async () => {
    const mm = await mermaidP!
    // 先验语法再渲染（cherry-studio 同款）：parse 失败直接抛出，不进 render
    await mm.parse(code)
    const { svg } = await mm.render(`chime-mmd-${++mermaidSeq}`, code)
    return svg
  })
  mermaidQueue = job.catch(() => undefined)
  return job
}

// 复制图片（016 Case 10 功能点 5）：SVG 画进 canvas，先铺白底（透明底在深色背景看不清），
// 转 PNG 写剪贴板。纯渲染层，不走主进程
export async function copySvgAsPng(svg: string): Promise<void> {
  const img = new Image()
  const blobUrl = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }))
  try {
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve()
      img.onerror = () => reject(new Error('svg load failed'))
      img.src = blobUrl
    })
    const scale = 2 // 清晰度：2 倍导出
    const canvas = document.createElement('canvas')
    canvas.width = img.naturalWidth * scale
    canvas.height = img.naturalHeight * scale
    const ctx = canvas.getContext('2d')!
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.scale(scale, scale)
    ctx.drawImage(img, 0, 0)
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/png'))
    if (!blob) throw new Error('toBlob failed')
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
  } finally {
    URL.revokeObjectURL(blobUrl)
  }
}
