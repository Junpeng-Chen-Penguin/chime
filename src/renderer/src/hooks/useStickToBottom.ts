import { useCallback, useLayoutEffect, useRef, useState } from 'react'

// 黏底滚动：流式内容增长时只在“用户已在底部”才跟随；上翻则停。
export function useStickToBottom(
  messages: unknown[],
  resetKey: string
): {
  scrollRef: React.RefObject<HTMLDivElement | null>
  onScroll: () => void
  showJump: boolean
  scrollToBottom: () => void
} {
  const scrollRef = useRef<HTMLDivElement>(null)
  const following = useRef(true)
  const prevLen = useRef(0)
  const prevKey = useRef(resetKey)
  const [showJump, setShowJump] = useState(false)

  const onScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight
    following.current = dist < 50
    setShowJump(dist > 120)
  }, [])

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    following.current = true
    setShowJump(false)
    el.scrollTop = el.scrollHeight
  }, [])

  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    // 切换会话：回到底、恢复跟随
    if (prevKey.current !== resetKey) {
      prevKey.current = resetKey
      prevLen.current = messages.length
      following.current = true
      setShowJump(false)
      el.scrollTop = el.scrollHeight
      return
    }
    const grew = messages.length > prevLen.current
    prevLen.current = messages.length
    if (grew) following.current = true // 新消息：强制跟随
    if (following.current) el.scrollTop = el.scrollHeight
  }, [messages, resetKey])

  // 跟随时逐帧对齐底部：流式出字（rAF 节奏）与滚动同帧同步，内容长高不再先跳后补
  useLayoutEffect(() => {
    let raf = 0
    const tick = (): void => {
      const el = scrollRef.current
      if (el && following.current) {
        const target = el.scrollHeight - el.clientHeight
        if (target - el.scrollTop > 1) el.scrollTop = target
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])

  return { scrollRef, onScroll, showJump, scrollToBottom }
}
