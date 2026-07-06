import { useCallback, useLayoutEffect, useRef, useState } from 'react'

// 黏底滚动：流式内容增长时只在“用户已在底部”才跟随；上翻则停。
export function useStickToBottom(
  messages: unknown[],
  resetKey: string
): {
  scrollRef: React.RefObject<HTMLDivElement | null>
  onScroll: () => void
  onWheel: (e: React.WheelEvent) => void
  showJump: boolean
  scrollToBottom: () => void
} {
  const scrollRef = useRef<HTMLDivElement>(null)
  const following = useRef(true)
  const lastTarget = useRef(0) // 程序最近一次定位到的底部位置，用于区分「用户上滑」与「程序贴底」
  const prevLen = useRef(0)
  const prevKey = useRef(resetKey)
  const [showJump, setShowJump] = useState(false)

  const onScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight
    // 用户向上滚一点就立即停跟随（低于程序定位点即视为用户动作）；滑回底部附近恢复跟随
    if (following.current && lastTarget.current - el.scrollTop > 1) {
      following.current = false
    } else if (!following.current && dist < 50) {
      following.current = true
    }
    setShowJump(dist > 120)
  }, [])

  // 滚轮向上 = 明确的用户意图，直接停跟随（覆盖拖动滚动条之外的主要路径）
  const onWheel = useCallback((e: React.WheelEvent) => {
    if (e.deltaY < 0) following.current = false
  }, [])

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    following.current = true
    setShowJump(false)
    lastTarget.current = el.scrollHeight - el.clientHeight
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
        lastTarget.current = target
        if (target - el.scrollTop > 1) el.scrollTop = target
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])

  return { scrollRef, onScroll, onWheel, showJump, scrollToBottom }
}
