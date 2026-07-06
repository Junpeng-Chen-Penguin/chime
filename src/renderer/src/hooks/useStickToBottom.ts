import { useCallback, useLayoutEffect, useRef, useState } from 'react'

// 黏底滚动：流式内容增长时保持贴底；用户一旦上滑就松手、停在原处，滑回底部附近再恢复。
// 判定用户滚动的关键：区分「程序贴底」与「用户拖动」——程序每次贴底都记下目标位置，
// scroll 事件里若实际位置与该目标对不上，即用户所为。不再逐帧强制 scrollTop（那会把用户拽回）。
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
  const stick = useRef(true)
  const expectedTop = useRef(0) // 程序最近一次设置的 scrollTop，用于识别用户滚动
  const prevLen = useRef(0)
  const prevKey = useRef(resetKey)
  const [showJump, setShowJump] = useState(false)

  const pin = useCallback((): void => {
    const el = scrollRef.current
    if (!el) return
    const t = el.scrollHeight - el.clientHeight
    expectedTop.current = t
    el.scrollTop = t
  }, [])

  const onScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight
    // 实际位置偏离程序设定值 = 用户在滚：贴底附近才维持跟随，否则松手
    if (Math.abs(el.scrollTop - expectedTop.current) > 2) {
      stick.current = dist < 40
    }
    expectedTop.current = el.scrollTop
    setShowJump(dist > 120)
  }, [])

  const scrollToBottom = useCallback(() => {
    stick.current = true
    setShowJump(false)
    pin()
  }, [pin])

  // 内容变化（流式每帧新数组）时，若在跟随态就同步贴底——useLayoutEffect 与 DOM 同帧，无可见跳动
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    if (prevKey.current !== resetKey) {
      prevKey.current = resetKey
      prevLen.current = messages.length
      stick.current = true
      setShowJump(false)
      pin()
      return
    }
    if (messages.length > prevLen.current) stick.current = true // 新消息：恢复跟随
    prevLen.current = messages.length
    if (stick.current) pin()
  }, [messages, resetKey, pin])

  return { scrollRef, onScroll, showJump, scrollToBottom }
}
