// 卡片挂起与排队：需授权的工具 execute 在这里 await 用户决定。
// 同一轮一次只有一张活跃卡（队首）；渲染层从 items 推导卡与排队态，本模块只管队列与 Promise。
// 三级中断文案也在此定义（卡片与中断同源：都是「调用没有正常拿到结果」的收场文案）。

// 三级中断文案（PRD 统一工具格式章定稿）：级别的区别在于模型能否重试
export const INTERRUPT_NOT_STARTED = '这次调用未执行（用户停止了本轮）。需要时可重新发起。'
export const INTERRUPT_NOT_STARTED_EXIT = '这次调用未执行（等待授权时应用退出）。需要时可重新发起。'
export const INTERRUPT_LOCAL = '这次调用被中断，未完成，未产生任何变更。需要时可重试。'
export const interruptExternal = (reason: '用户停止' | '应用退出'): string =>
  `这次调用在执行中被打断（${reason}），指令可能已到达系统，是否生效未知。不要自行重试；先向用户说明，协助核实实际结果后再定下一步。`
export const AUTH_DENIED = '用户拒绝了这次调用'

export type CardDecision = 'approved' | 'denied' | 'aborted'

interface PendingCard {
  toolCallId: string
  resolve: (d: CardDecision) => void
}

// 每轮一个队列实例；streamId → 实例，供 IPC 路由用户回应
const queues = new Map<string, CardQueue>()

export class CardQueue {
  private pending: PendingCard[] = []

  constructor(
    private streamId: string,
    signal: AbortSignal,
    // 决定产生时回调（含 aborted）：orchestrator 据此更新 item.auth 并推 item-update
    private onDecision: (toolCallId: string, d: CardDecision) => void
  ) {
    queues.set(streamId, this)
    signal.addEventListener('abort', () => this.abortAll())
  }

  // 工具 execute 内 await；用户回应（或停止）后 resolve
  request(toolCallId: string, signal: AbortSignal): Promise<CardDecision> {
    return new Promise((resolve) => {
      if (signal.aborted) return resolve('aborted')
      // 无界面自测钩子：三去向不经 UI 直接给决定（正式卡片代答随评估收口模块）
      const auto = process.env.CHIME_CARD_AUTO
      if (auto === 'approve' || auto === 'deny') {
        const d: CardDecision = auto === 'approve' ? 'approved' : 'denied'
        this.onDecision(toolCallId, d)
        return resolve(d)
      }
      this.pending.push({ toolCallId, resolve })
    })
  }

  respond(toolCallId: string, decision: 'approved' | 'denied'): void {
    // 只认队首：一次只有一张活跃卡，防过期/重复点击
    if (this.pending[0]?.toolCallId !== toolCallId) return
    const head = this.pending.shift()!
    this.onDecision(toolCallId, decision)
    head.resolve(decision)
  }

  private abortAll(): void {
    const all = this.pending
    this.pending = []
    for (const p of all) {
      this.onDecision(p.toolCallId, 'aborted')
      p.resolve('aborted')
    }
  }

  dispose(): void {
    queues.delete(this.streamId)
  }
}

export function respondCard(streamId: string, toolCallId: string, decision: 'approved' | 'denied'): void {
  queues.get(streamId)?.respond(toolCallId, decision)
}
