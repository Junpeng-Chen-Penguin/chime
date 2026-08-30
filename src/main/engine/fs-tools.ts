// 本地文件能力（015）。C1 落路径判定助手；C2 读文件 / 列目录与申请授权卡；C3 写入 / 编辑与写授权卡。
// 白名单语义：会话 ws_list（授权清单）∪ 技能库根目录；路径先 resolve 归一再判前缀，防「../」逃逸。
import {
  existsSync,
  statSync,
  readFileSync,
  readdirSync,
  openSync,
  readSync,
  closeSync,
  writeFileSync,
  mkdirSync
} from 'fs'
import { resolve, basename, dirname, isAbsolute, join, relative } from 'path'
import { app } from 'electron'
import { tool, jsonSchema } from 'ai'
import type { Tool } from 'ai'
import { getConversationWs, setConversationWs, touchWsRecent } from '../db'
import { INTERRUPT_NOT_STARTED, type CardQueue } from './cards'
import { guardSingle, READ_LINES_DEFAULT, type OverflowCtx } from './overflow'

// 目标路径已被清单中某目录覆盖（等于它，或是它的子路径）——「已在授权范围内」判定，
// Agent 编辑页 / 选择器 / 工作面板三个添加入口与 conv:wsAdd 复用；工具白名单校验同一份判定
export function coveredBy(target: string, list: string[]): boolean {
  const abs = resolve(target)
  return list.some((p) => {
    const root = resolve(p)
    return abs === root || abs.startsWith(root + '/')
  })
}

// 工作空间的展示名：取路径最后一段，不存名字快照
export function wsName(p: string): string {
  return basename(p) || p
}

// 技能库根目录：技能文件只参与白名单校验（自动放行），不进系统提示词清单（Case 2）
export function skillsRoot(): string {
  return join(app.getPath('userData'), 'skills')
}

// 「已读过」标记（Case 3 写前校验用）：会话级内存记录，磁盘变更即失效（比对 mtime/size）。
// 不落库——应用重启后为空，同一会话继续时写操作要求先重读，比持久化更严也更安全
const readMarks = new Map<string, Map<string, { mtime: number; size: number }>>()
function markRead(convId: string, abs: string): void {
  try {
    const st = statSync(abs)
    let m = readMarks.get(convId)
    if (!m) readMarks.set(convId, (m = new Map()))
    m.set(abs, { mtime: st.mtimeMs, size: st.size })
  } catch {
    // 标不上不影响读取本身（文件在读后瞬间被删的极端情况）
  }
}

// 「已读过」是否仍有效：读过且磁盘现值与标记一致（Case 3 三个关键定义之一）
function readFresh(convId: string, abs: string): boolean {
  const m = readMarks.get(convId)?.get(abs)
  if (!m) return false
  try {
    const st = statSync(abs)
    return st.mtimeMs === m.mtime && st.size === m.size
  } catch {
    return false
  }
}

// 写「总是允许」（Case 3）：会话级内存记录，挂在白名单目录上（含子目录命中），会话结束 / 应用重启即失效
const alwaysDirs = new Map<string, Set<string>>()
function alwaysHit(convId: string, abs: string): boolean {
  const s = alwaysDirs.get(convId)
  return !!s && coveredBy(abs, [...s])
}
function recordAlways(convId: string, abs: string): void {
  // 记挂到覆盖目标的那个白名单目录（每目录至多一条）；兜底记文件所在目录
  const dir = (getConversationWs(convId) ?? []).find((p) => coveredBy(abs, [p])) ?? dirname(abs)
  let s = alwaysDirs.get(convId)
  if (!s) alwaysDirs.set(convId, (s = new Set()))
  s.add(resolve(dir))
}

// 拒绝申请授权的收场文案（功能点 20）：照 AUTH_DENIED 的写法——报错 + 行为指令一体
export const WS_DENIED =
  '用户拒绝了这次访问申请，操作没有执行。不要重发同一个调用，也不要虚构文件内容；先在回复里明确告诉用户这件事没有做，需要时请用户从工作面板添加工作空间、或改用已授权工作空间内的路径，然后停下等用户指示。'

// 拒绝写授权的收场文案（Case 3 功能点 3）
export const WRITE_DENIED =
  '用户拒绝了这次写入，文件没有改动。不要重发同一个调用，也不要谎称已写入；先在回复里明确告诉用户这件事没有做，可以调整方案再征询，或请用户手动处理，然后停下等用户指示。'

// 文本判定：读头部 8KB 找 \0 字节，含则按二进制拒绝（git 同款启发式）
function isBinary(abs: string): boolean {
  const fd = openSync(abs, 'r')
  try {
    const buf = Buffer.alloc(8192)
    const n = readSync(fd, buf, 0, 8192, 0)
    return buf.subarray(0, n).includes(0)
  } finally {
    closeSync(fd)
  }
}

const LINE_CHAR_LIMIT = 2000 // 单行超长截断（字符）
const LIST_LIMIT = 100 // 列目录条数上限
const LIST_DEPTH_MAX = 5

const WRITE_TOOL_DESCRIPTION = `把完整内容写入工作空间内的文件：文件不存在即新建（父目录自动创建），已存在即整个覆盖。

- path 必须是绝对路径；可用的工作空间目录（绝对路径）在系统提示词的环境信息里
- 覆盖已有文件前必须先用 read_file 读过它（本会话内，且读后文件没被外部改过）
- 修改已有文件优先用 edit_file 定点替换，不要整文件重写`

const EDIT_TOOL_DESCRIPTION = `对工作空间内已有文件做定点替换：把 old_string 换成 new_string。

- path 必须是绝对路径；编辑前必须先用 read_file 读过该文件（本会话内，且读后文件没被外部改过）
- old_string 必须与文件原文精确一致（含缩进与换行；read_file 返回里的行号前缀不算内容），且在文件中唯一——不唯一时补足前后文，或传 replace_all 全部替换
- 新建文件用 write_file`

const READ_TOOL_DESCRIPTION = `读取工作空间内的文本文件，返回带行号的内容。

- path 必须是绝对路径；可用的工作空间目录（绝对路径）在系统提示词的环境信息里
- 默认从第 1 行读取最多 ${READ_LINES_DEFAULT} 行；未读完时结尾会提示剩余行数，用 offset 传起始行续读
- offset：起始行号（从 1 起）；limit：读取行数
- 只支持文本文件；要查看目录内容用 list_dir`

const LIST_TOOL_DESCRIPTION = `列出工作空间内某个目录的内容：目录在前、各按字母排序，目录名以 / 结尾，不含隐藏文件。

- path 必须是绝对路径；可用的工作空间目录（绝对路径）在系统提示词的环境信息里
- depth：递归层数（默认 1 只列一层，最多 ${LIST_DEPTH_MAX}）；超过 ${LIST_LIMIT} 条会截断并提示`

// 授权卡载荷（挂在 tool item 上随落库，渲染层不反查主进程内存）。
// ws-request = 申请授权卡（C2）；write = 写授权卡三按钮（C3）。
// 同一次调用可先后两张卡（白名单外的写：申请授权 → 写授权）= 同一 item 的 fsCard 随 item-update 切换
export interface FsCard {
  mode: 'ws-request' | 'write'
  dirs?: string[] // ws-request：申请的目录（绝对路径），渲染层取 basename 展示
  op: string // ws-request：触发申请的操作，如「读取 用例草稿.md」；write：'新建' | '覆盖' | '修改'
  path?: string // write：目标文件绝对路径
}

// 读文件 / 列目录（Case 2）。白名单外 → 拦截式申请授权卡（功能点 18）：
// 允许即把目录追加进会话授权清单（与手动添加同等地位）、被拦的调用继续执行；拒绝返回报错带行为指令。
// 重复触发照常弹卡，不做特化；授权不跨会话
export function makeFsTools(opts: {
  convId: string
  signal: AbortSignal
  cards: CardQueue
  overflow: OverflowCtx
  onFsCard: (toolCallId: string, card: FsCard) => void
}): Record<string, Tool> {
  const { convId, signal, cards, overflow, onFsCard } = opts

  // 白名单判定与申请授权（两工具共用）：通过返回 null，未通过返回该次调用的收场结果
  const ensureAccess = async (
    abs: string,
    reqDir: string,
    op: string,
    toolCallId: string,
    toolName: string
  ): Promise<{ denied: string } | { interrupted: string } | null> => {
    if (coveredBy(abs, [...(getConversationWs(convId) ?? []), skillsRoot()])) return null
    onFsCard(toolCallId, { mode: 'ws-request', dirs: [reqDir], op })
    const decision = await cards.request(toolCallId, signal, toolName)
    if (decision === 'denied') return { denied: WS_DENIED }
    if (decision === 'aborted') return { interrupted: INTERRUPT_NOT_STARTED }
    // 允许：目录进本会话授权清单（功能点 19，与手动添加同等地位），全局最近清单同步
    const cur = getConversationWs(convId) ?? []
    if (!coveredBy(reqDir, cur)) {
      setConversationWs(convId, [...cur, resolve(reqDir)])
      touchWsRecent([resolve(reqDir)])
    }
    return null
  }

  // 入参公共校验：缺 path / 相对路径（Case 2：相对路径报错并提示改用绝对路径）
  const badPath = (p: unknown): { error: string; userText?: string } | null => {
    if (typeof p !== 'string' || !p.trim())
      return { error: '缺少 path 参数：请带上目标的绝对路径重新调用', userText: '调用参数不完整' }
    if (!isAbsolute(p))
      return {
        error:
          '路径必须是绝对路径。可用的工作空间目录（绝对路径）在系统提示词的环境信息里，请拼出完整路径重新调用',
        userText: '调用参数不完整'
      }
    return null
  }

  const read_file = tool({
    description: READ_TOOL_DESCRIPTION,
    inputSchema: jsonSchema<{ path: string; offset?: number; limit?: number }>({
      type: 'object',
      properties: {
        path: { type: 'string', description: '要读取的文件的绝对路径' },
        offset: { type: 'number', description: '起始行号（从 1 起），续读时提供' },
        limit: { type: 'number', description: `读取行数，默认 ${READ_LINES_DEFAULT}` }
      },
      required: ['path']
    }),
    execute: async (args, { toolCallId }) => {
      const a = (args ?? {}) as { path?: string; offset?: number; limit?: number }
      const bad = badPath(a.path)
      if (bad) return bad
      const abs = resolve(a.path!)
      const gate = await ensureAccess(
        abs,
        dirname(abs),
        `读取 ${basename(abs)}`,
        toolCallId,
        'read_file'
      )
      if (gate) return gate
      if (!existsSync(abs))
        return { error: `文件不存在：${abs}。请重新列出所在目录核实路径，不要虚构文件内容`, userText: '文件不存在' }
      if (statSync(abs).isDirectory())
        return { error: '这是一个目录，不是文件。要查看目录内容请改用 list_dir', userText: '目标是文件夹' }
      if (isBinary(abs))
        return { error: '暂不支持读取此类型的文件（非文本内容），不要虚构文件内容', userText: '不支持的文件类型' }
      const text = readFileSync(abs, 'utf8')
      markRead(convId, abs)
      if (!text) return '文件为空'
      const all = text.split('\n')
      if (all[all.length - 1] === '') all.pop() // 末尾换行不算一行
      const start = Math.max(1, Math.floor(a.offset ?? 1))
      const count = Math.max(1, Math.floor(a.limit ?? READ_LINES_DEFAULT))
      const slice = all.slice(start - 1, start - 1 + count)
      if (!slice.length)
        return { error: `起始行超出范围：该文件共 ${all.length} 行，offset 传了 ${start}`, userText: '起始行超出范围' }
      const body = slice
        .map(
          (l, i) =>
            `${start + i}\t${l.length > LINE_CHAR_LIMIT ? l.slice(0, LINE_CHAR_LIMIT) + '…（本行超长截断）' : l}`
        )
        .join('\n')
      const rest = all.length - (start - 1 + slice.length)
      const out =
        rest > 0
          ? `${body}\n（还有 ${rest} 行未显示，用 offset=${start + slice.length} 续读）`
          : body
      return guardSingle(overflow, toolCallId, 'read_file', out)
    }
  })

  const list_dir = tool({
    description: LIST_TOOL_DESCRIPTION,
    inputSchema: jsonSchema<{ path: string; depth?: number }>({
      type: 'object',
      properties: {
        path: { type: 'string', description: '要列出的目录的绝对路径' },
        depth: { type: 'number', description: `递归层数，默认 1，最多 ${LIST_DEPTH_MAX}` }
      },
      required: ['path']
    }),
    execute: async (args, { toolCallId }) => {
      const a = (args ?? {}) as { path?: string; depth?: number }
      const bad = badPath(a.path)
      if (bad) return bad
      const abs = resolve(a.path!)
      const gate = await ensureAccess(abs, abs, `列出 ${basename(abs)}`, toolCallId, 'list_dir')
      if (gate) return gate
      if (!existsSync(abs))
        return {
          error: `目录不存在：${abs}。请核对系统提示词环境信息里的工作空间清单，或如实告知用户`,
          userText: '文件夹不存在'
        }
      if (!statSync(abs).isDirectory())
        return { error: '这是一个文件，不是目录。要查看内容请改用 read_file', userText: '目标是文件' }
      const depth = Math.min(LIST_DEPTH_MAX, Math.max(1, Math.floor(a.depth ?? 1)))
      const lines: string[] = []
      let total = 0
      const walk = (dir: string, left: number, indent: string): void => {
        let entries
        try {
          entries = readdirSync(dir, { withFileTypes: true })
        } catch {
          return // 无权限等：该层跳过
        }
        const visible = entries
          .filter((e) => !e.name.startsWith('.'))
          .sort((x, y) =>
            x.isDirectory() === y.isDirectory()
              ? x.name.localeCompare(y.name)
              : x.isDirectory()
                ? -1
                : 1
          )
        for (const e of visible) {
          total++
          if (lines.length < LIST_LIMIT)
            lines.push(`${indent}${e.name}${e.isDirectory() ? '/' : ''}`)
          if (e.isDirectory() && left > 1) walk(join(dir, e.name), left - 1, indent + '  ')
        }
      }
      walk(abs, depth, '')
      if (!total) return '目录为空'
      const out =
        total > lines.length
          ? `${lines.join('\n')}\n（还有 ${total - lines.length} 条未显示）`
          : lines.join('\n')
      return guardSingle(overflow, toolCallId, 'list_dir', out)
    }
  })

  // ── 写入 / 编辑（Case 3）────────────────────────────────
  // 返回里的相对路径：相对所属白名单目录（三个关键定义「工具返回与上下文」）
  const relPath = (abs: string): string => {
    const root = (getConversationWs(convId) ?? []).find((p) => coveredBy(abs, [p]))
    return root ? relative(resolve(root), abs) || basename(abs) : basename(abs)
  }
  const lineCount = (text: string): number => {
    if (!text) return 0
    const all = text.split('\n')
    if (all[all.length - 1] === '') all.pop()
    return all.length
  }
  // 写授权判定（图二后半）：总是允许命中即免卡；否则弹写授权卡，'always' 放行本次并记住目录。
  // 通过返回 null，未通过返回该次调用的收场结果
  const ensureWriteAuth = async (
    abs: string,
    op: '新建' | '覆盖' | '修改',
    toolCallId: string,
    toolName: string
  ): Promise<{ denied: string } | { interrupted: string } | null> => {
    if (alwaysHit(convId, abs)) return null
    onFsCard(toolCallId, { mode: 'write', op, path: abs })
    const decision = await cards.request(toolCallId, signal, toolName)
    if (decision === 'denied') return { denied: WRITE_DENIED }
    if (decision === 'aborted') return { interrupted: INTERRUPT_NOT_STARTED }
    if (decision === 'always') recordAlways(convId, abs)
    return null
  }
  // 技能目录只读（图二第二判）：白名单校验会放行技能目录，写操作在其后单独拦
  const skillReadonly = (abs: string): { error: string; userText?: string } | null =>
    coveredBy(abs, [skillsRoot()])
      ? { error: '技能目录只读，不能直接写入或修改。要改技能，请用户在设置里重新导入', userText: '技能目录只读' }
      : null

  const write_file = tool({
    description: WRITE_TOOL_DESCRIPTION,
    inputSchema: jsonSchema<{ path: string; content: string }>({
      type: 'object',
      properties: {
        path: { type: 'string', description: '要写入的文件的绝对路径' },
        content: { type: 'string', description: '写入的完整内容（已有文件会被整个覆盖）' }
      },
      required: ['path', 'content']
    }),
    execute: async (args, { toolCallId }) => {
      const a = (args ?? {}) as { path?: string; content?: string }
      const bad = badPath(a.path)
      if (bad) return bad
      if (typeof a.content !== 'string')
        return { error: '缺少 content 参数：请带上要写入的完整内容重新调用', userText: '调用参数不完整' }
      const abs = resolve(a.path!)
      const gate = await ensureAccess(
        abs,
        dirname(abs),
        `写入 ${basename(abs)}`,
        toolCallId,
        'write_file'
      )
      if (gate) return gate
      const ro = skillReadonly(abs)
      if (ro) return ro
      const exists = existsSync(abs)
      if (exists && statSync(abs).isDirectory())
        return { error: '这个路径是一个目录，不能作为文件写入', userText: '目标是文件夹' }
      // 覆盖前置：本会话读过且磁盘没再变过，防止用旧内容的记忆覆盖新文件
      if (exists && !readFresh(convId, abs))
        return {
          error:
            '目标文件已存在且你在本会话内还没读过它（或读后它被改动过）。先用 read_file 读取，再决定怎么改；修改已有文件优先用 edit_file'
        }
      const auth = await ensureWriteAuth(abs, exists ? '覆盖' : '新建', toolCallId, 'write_file')
      if (auth) return auth
      mkdirSync(dirname(abs), { recursive: true })
      writeFileSync(abs, a.content, 'utf8')
      markRead(convId, abs) // 落盘后刷新「已读过」：紧接的 edit_file 不被自己的写拦下
      return `${exists ? '已更新' : '已新建'} ${relPath(abs)}（${lineCount(a.content)} 行）`
    }
  })

  const edit_file = tool({
    description: EDIT_TOOL_DESCRIPTION,
    inputSchema: jsonSchema<{
      path: string
      old_string: string
      new_string: string
      replace_all?: boolean
    }>({
      type: 'object',
      properties: {
        path: { type: 'string', description: '要编辑的文件的绝对路径' },
        old_string: { type: 'string', description: '要替换的原文片段，须与文件内容精确一致且唯一' },
        new_string: { type: 'string', description: '替换后的新内容' },
        replace_all: {
          type: 'boolean',
          description: '原文片段出现多处时全部替换（默认只允许唯一匹配）'
        }
      },
      required: ['path', 'old_string', 'new_string']
    }),
    execute: async (args, { toolCallId }) => {
      const a = (args ?? {}) as {
        path?: string
        old_string?: string
        new_string?: string
        replace_all?: boolean
      }
      const bad = badPath(a.path)
      if (bad) return bad
      if (typeof a.old_string !== 'string' || typeof a.new_string !== 'string')
        return {
          error: '缺少 old_string / new_string 参数：请带上要替换的原文片段与新内容重新调用'
        }
      const abs = resolve(a.path!)
      const gate = await ensureAccess(
        abs,
        dirname(abs),
        `编辑 ${basename(abs)}`,
        toolCallId,
        'edit_file'
      )
      if (gate) return gate
      const ro = skillReadonly(abs)
      if (ro) return ro
      if (!existsSync(abs))
        return { error: `文件不存在：${abs}。新文件请用 write_file 写入，不要虚构编辑结果`, userText: '文件不存在' }
      if (statSync(abs).isDirectory()) return { error: '这个路径是一个目录，不是文件', userText: '目标是文件夹' }
      if (!readFresh(convId, abs))
        return {
          error:
            '你在本会话内还没读过这个文件（或读后它被改动过）。先用 read_file 读取当前内容，再按原文编辑',
          userText: '需要先读取文件'
        }
      if (a.old_string === a.new_string)
        return { error: '编辑无效：old_string 与 new_string 相同，没有任何改动', userText: '替换前后内容相同' }
      const before = readFileSync(abs, 'utf8')
      const n = before.split(a.old_string).length - 1
      if (a.old_string === '' || n === 0)
        return {
          error:
            '旧片段在文件中找不到。请重新 read_file 核对原文（返回里的行号前缀不算内容），按文件里的实际文本重新调用',
          userText: '旧片段未找到'
        }
      if (n > 1 && !a.replace_all)
        return {
          error: `旧片段在文件中出现 ${n} 处，无法定点替换。请补足前后文让它唯一，或传 replace_all 全部替换`,
          userText: '旧片段不唯一'
        }
      const auth = await ensureWriteAuth(abs, '修改', toolCallId, 'edit_file')
      if (auth) return auth
      const after = a.replace_all
        ? before.split(a.old_string).join(a.new_string)
        : before.replace(a.old_string, a.new_string)
      writeFileSync(abs, after, 'utf8')
      markRead(convId, abs)
      const b = lineCount(before)
      const c = lineCount(after)
      return `已更新 ${relPath(abs)}（替换 ${a.replace_all ? n : 1} 处${b === c ? `，${c} 行` : `，${b} 行 → ${c} 行`}）`
    }
  })

  return { read_file, list_dir, write_file, edit_file }
}
