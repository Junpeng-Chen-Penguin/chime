// 卡片挂起与排队：需授权的工具与「询问用户」的 execute 在这里 await 用户回应。
// 两类卡共用一条队列——同一轮一次只有一张活跃卡（队首），混合排队也成立；
// 渲染层从 items 推导卡与排队态，本模块只管队列与 Promise。
// 三级中断文案也在此定义（卡片与中断同源：都是「调用没有正常拿到结果」的收场文案）。

// 三级中断文案（PRD 统一工具格式章定稿）：级别的区别在于模型能否重试
export const INTERRUPT_NOT_STARTED = '这次调用未执行（用户停止了本轮）。需要时可重新发起。'
export const INTERRUPT_NOT_STARTED_EXIT = '这次调用未执行（等待授权时应用退出）。需要时可重新发起。'
export const INTERRUPT_LOCAL = '这次调用被中断，未完成，未产生任何变更。需要时可重试。'
export const interruptExternal = (reason: '用户停止' | '应用退出'): string =>
  `这次调用在执行中被打断（${reason}），指令可能已到达系统，是否生效未知。不要自行重试；先向用户说明，协助核实实际结果后再定下一步。`
export const AUTH_DENIED = '用户拒绝了这次调用'

// 提问卡的收场文案（PRD 提问卡章定稿）
export const ASK_INTERRUPTED = '用户中断了本次提问'
export const ASK_INTERRUPTED_EXIT = '这次提问未收到回应（应用退出）。需要时可重新发起。'

export type CardDecision = 'approved' | 'denied' | 'aborted'

// 提问卡出路（PRD 出路表）：作答 / 放弃整卡 / 中断（停止或主输入框发新消息，均为 aborted）
export type AskOutcome =
  | { kind: 'answers'; answers: { question: string; answer: string | null }[] }
  | { kind: 'declined' }
  | { kind: 'aborted' }

export interface AskQuestion {
  question: string
  options: { label: string }[]
  multiSelect?: boolean
}

interface PendingCard {
  toolCallId: string
  kind: 'auth' | 'ask'
  resolve: (outcome: never) => void
}

// 评估代答（Case 7 正式机制）：注入后弹卡即按用例预设回应，不经 UI。
// 优先级：注入的代答器 > 环境变量快速钩子 > UI 队列
let responder:
  | ((kind: 'auth' | 'ask', toolCallId: string, questions?: AskQuestion[]) => CardDecision | AskOutcome | null)
  | null = null
export function setCardResponder(r: typeof responder): void {
  responder = r
}

// 每轮一个队列实例；streamId → 实例，供 IPC 路由用户回应
const queues = new Map<string, CardQueue>()

export class CardQueue {
  private pending: PendingCard[] = []

  constructor(
    private streamId: string,
    signal: AbortSignal,
    // 回应产生时回调（含 aborted）：orchestrator 据此更新 item 状态、落库并推 item-update
    private onAuth: (toolCallId: string, d: CardDecision) => void,
    private onAsk: (toolCallId: string, o: AskOutcome) => void
  ) {
    queues.set(streamId, this)
    signal.addEventListener('abort', () => this.abortAll())
  }

  // 授权卡：工具 execute 内 await；用户回应（或停止）后 resolve
  request(toolCallId: string, signal: AbortSignal): Promise<CardDecision> {
    return new Promise((resolve) => {
      if (signal.aborted) return resolve('aborted')
      // 评估代答（按用例预设）
      const r = responder?.('auth', toolCallId)
      if (r) {
        this.onAuth(toolCallId, r as CardDecision)
        return resolve(r as CardDecision)
      }
      // 无界面自测钩子：快速手测用（正式代答走 setCardResponder）
      const auto = process.env.CHIME_CARD_AUTO
      if (auto === 'approve' || auto === 'deny') {
        const d: CardDecision = auto === 'approve' ? 'approved' : 'denied'
        this.onAuth(toolCallId, d)
        return resolve(d)
      }
      this.pending.push({ toolCallId, kind: 'auth', resolve: resolve as (o: never) => void })
    })
  }

  // 提问卡：同一条队列排队；questions 供代答用
  requestAsk(toolCallId: string, questions: AskQuestion[], signal: AbortSignal): Promise<AskOutcome> {
    return new Promise((resolve) => {
      if (signal.aborted) return resolve({ kind: 'aborted' })
      // 评估代答（按用例预设）
      const r = responder?.('ask', toolCallId, questions)
      if (r) {
        this.onAsk(toolCallId, r as AskOutcome)
        return resolve(r as AskOutcome)
      }
      // 无界面自测钩子：answer = 每题选第一项，decline = 放弃整卡
      const auto = process.env.CHIME_ASK_AUTO
      if (auto === 'answer' || auto === 'decline') {
        const o: AskOutcome =
          auto === 'answer'
            ? { kind: 'answers', answers: questions.map((q) => ({ question: q.question, answer: q.options[0]?.label ?? null })) }
            : { kind: 'declined' }
        this.onAsk(toolCallId, o)
        return resolve(o)
      }
      this.pending.push({ toolCallId, kind: 'ask', resolve: resolve as (o: never) => void })
    })
  }

  respond(toolCallId: string, decision: 'approved' | 'denied'): void {
    // 只认队首：一次只有一张活跃卡，防过期/重复点击
    const head = this.pending[0]
    if (head?.toolCallId !== toolCallId || head.kind !== 'auth') return
    this.pending.shift()
    this.onAuth(toolCallId, decision)
    ;(head.resolve as (d: CardDecision) => void)(decision)
  }

  respondAsk(toolCallId: string, outcome: Exclude<AskOutcome, { kind: 'aborted' }>): void {
    const head = this.pending[0]
    if (head?.toolCallId !== toolCallId || head.kind !== 'ask') return
    this.pending.shift()
    this.onAsk(toolCallId, outcome)
    ;(head.resolve as (o: AskOutcome) => void)(outcome)
  }

  private abortAll(): void {
    const all = this.pending
    this.pending = []
    for (const p of all) {
      if (p.kind === 'auth') {
        this.onAuth(p.toolCallId, 'aborted')
        ;(p.resolve as (d: CardDecision) => void)('aborted')
      } else {
        this.onAsk(p.toolCallId, { kind: 'aborted' })
        ;(p.resolve as (o: AskOutcome) => void)({ kind: 'aborted' })
      }
    }
  }

  dispose(): void {
    queues.delete(this.streamId)
  }
}

export function respondCard(streamId: string, toolCallId: string, decision: 'approved' | 'denied'): void {
  queues.get(streamId)?.respond(toolCallId, decision)
}

export function respondAskCard(
  streamId: string,
  toolCallId: string,
  outcome: Exclude<AskOutcome, { kind: 'aborted' }>
): void {
  queues.get(streamId)?.respondAsk(toolCallId, outcome)
}
