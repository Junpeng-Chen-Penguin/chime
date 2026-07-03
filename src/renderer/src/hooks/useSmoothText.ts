import { useEffect, useRef, useState } from 'react'

// 流式文本平滑：API 的 token 是一阵一阵到的，直接追加会顿挫。
// 按 requestAnimationFrame 逐帧出字，每帧出字量随积压自适应（积压多快出、少则慢出），
// 始终留一点缓冲垫住突发。
// ponytail: Cherry(useSmoothStream) 是带速率测量与失速检测的完整抖动缓冲，
// 这里是它的简化版；若长回答仍见顿挫再升级
export function useSmoothText(target: string, streaming: boolean): string {
  const [shown, setShown] = useState(streaming ? '' : target)
  const targetRef = useRef(target)
  const lenRef = useRef(streaming ? 0 : target.length)
  targetRef.current = target

  useEffect(() => {
    if (!streaming) {
      // 完成/历史消息：直接同步全文
      lenRef.current = target.length
      setShown(target)
    }
  }, [streaming, target])

  useEffect(() => {
    if (!streaming) return undefined
    let raf = 0
    const tick = (): void => {
      const t = targetRef.current
      if (t.length < lenRef.current) lenRef.current = t.length // 重试等场景的回退
      const backlog = t.length - lenRef.current
      if (backlog > 0) {
        const step = Math.max(1, Math.ceil(backlog / 15))
        lenRef.current = Math.min(t.length, lenRef.current + step)
        setShown(t.slice(0, lenRef.current))
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [streaming])

  return shown
}
