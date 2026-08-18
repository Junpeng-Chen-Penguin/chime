// 技能库（015 Case 4）：userData/skills/ 下每技能一个文件夹，无 DB 表——
// 列表现场 readdir + 解析各 SKILL.md 的 YAML 头（量级几十个）；「最近更新」取文件夹 mtime。
// 校验照 Agent Skills 官方规则；zip 解压用系统 /usr/bin/unzip（macOS 恒有，不加解压依赖）。
// 已知限制（V3 已验，2026-08-17）：UTF-8 文件名（macOS 与现代工具打的包）正常；老式 Windows GBK
// 编码的包会出乱码文件名且 macOS unzip 无 -O 转码参数——技能文件夹名规则限定小写英文，影响面小。
import {
  existsSync,
  statSync,
  readFileSync,
  readdirSync,
  cpSync,
  rmSync,
  mkdtempSync,
  mkdirSync
} from 'fs'
import { join, resolve, basename, extname, relative } from 'path'
import { tmpdir } from 'os'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { tool, jsonSchema } from 'ai'
import type { Tool, ModelMessage } from 'ai'
import { load as yamlLoad } from 'js-yaml'
import { skillsRoot } from './engine/fs-tools'

const execFileP = promisify(execFile)

export interface SkillInfo {
  name: string
  description: string
  hasScripts: boolean
  updatedAt: number // 文件夹 mtime（导入 / 覆盖即刷新）
}

export type ImportResult =
  | { ok: true; name: string }
  | { conflict: string } // 重名：renderer 弹覆盖确认后带 overwrite 重调
  | { errors: string[] }

// SKILL.md 的 YAML 头解析：拿不到头或解析失败返回 null
function parseFrontMatter(text: string): Record<string, unknown> | null {
  const m = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/.exec(text)
  if (!m) return null
  try {
    const v = yamlLoad(m[1])
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function readSkillMeta(dir: string): { name: string; description: string } | null {
  const p = join(dir, 'SKILL.md')
  if (!existsSync(p)) return null
  const fm = parseFrontMatter(readFileSync(p, 'utf8'))
  if (!fm) return null
  return { name: String(fm.name ?? ''), description: String(fm.description ?? '') }
}

export function listSkills(): SkillInfo[] {
  const root = skillsRoot()
  if (!existsSync(root)) return []
  const out: SkillInfo[] = []
  for (const e of readdirSync(root, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue
    const dir = join(root, e.name)
    const meta = readSkillMeta(dir)
    if (!meta) continue // 库目录里的坏条目不进列表（手动放进去的残缺文件夹）
    out.push({
      name: e.name,
      description: meta.description,
      hasScripts: existsSync(join(dir, 'scripts')),
      updatedAt: statSync(dir).mtimeMs
    })
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt)
}

// 名字须在库里且不含路径穿越，返回技能目录绝对路径；不合法返回 null
function skillDir(name: string): string | null {
  const dir = resolve(skillsRoot(), name)
  if (!dir.startsWith(resolve(skillsRoot()) + '/')) return null
  return existsSync(join(dir, 'SKILL.md')) ? dir : null
}

// 明细页数据：全部文件的相对路径与文本内容（二进制给 null，只列不读）
export function getSkill(name: string): {
  name: string
  description: string
  hasScripts: boolean
  files: { path: string; content: string | null }[]
} | null {
  const dir = skillDir(name)
  if (!dir) return null
  const meta = readSkillMeta(dir)!
  const files: { path: string; content: string | null }[] = []
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name.startsWith('.')) continue
      const p = join(d, e.name)
      if (e.isDirectory()) {
        walk(p)
        continue
      }
      const buf = readFileSync(p)
      const isText = !buf.subarray(0, 8192).includes(0)
      files.push({ path: relative(dir, p), content: isText ? buf.toString('utf8') : null })
    }
  }
  walk(dir)
  // SKILL.md 排最前（明细页默认展示），其余按路径排序
  files.sort((a, b) =>
    a.path === 'SKILL.md' ? -1 : b.path === 'SKILL.md' ? 1 : a.path.localeCompare(b.path)
  )
  return {
    name,
    description: meta.description,
    hasScripts: existsSync(join(dir, 'scripts')),
    files
  }
}

export function deleteSkill(name: string): boolean {
  const dir = skillDir(name)
  if (!dir) return false
  rmSync(dir, { recursive: true, force: true })
  return true
}

// 官方校验规则（功能点 5 第 2 步），逐条报具体没过的哪条
function validate(
  meta: { name: string; description: string },
  folderName: string | null
): string[] {
  const errs: string[] = []
  const { name, description } = meta
  if (!name) errs.push('SKILL.md 的 YAML 头缺少 name')
  else {
    if (name.length > 64) errs.push('name 超过 64 字符')
    if (!/^[a-z0-9-]+$/.test(name)) errs.push('name 只能含小写字母、数字和连字符')
    else if (/--/.test(name) || name.startsWith('-') || name.endsWith('-'))
      errs.push('name 不得以连字符开头结尾或连续连字符')
    if (folderName !== null && folderName !== name)
      errs.push(`name（${name}）与技能文件夹名（${folderName}）不一致`)
  }
  if (!description) errs.push('SKILL.md 的 YAML 头缺少 description')
  else if (description.length > 1024) errs.push('description 超过 1024 字符')
  return errs
}

// ── 激活工具（015 Case 5 Feature 3）────────────────────────
// 正文以工具返回身份进对话记录（与检索返回同一通道），此后随历史逐轮发出，不进系统提示词。
// 压缩豁免（L1 不清、总量闸不落库）在 orchestrator 按工具名挂，这里只管激活语义。

export const ACTIVATE_TOOL_NAME = 'activate_skill'

// 描述是行为指引的主要载体（清单管发现，工具描述管怎么用——产品方案 Case 5 原文）
const ACTIVATE_TOOL_DESCRIPTION = `激活一个技能，取得它的完整正文。技能是针对某类任务的成套做法说明。
当前任务与「可用技能」清单中某条适用说明匹配时，先调用本工具再动手：正文返回后按它的流程执行，替代你默认的做法。不要凭清单里的一句适用说明猜测内容，也不要在没有匹配技能时强行激活。
入参 name：清单中的技能名。`

// 正文外层包装的头部标注：去重判定（轮内 Set + 历史扫描）都以这个前缀识别一次成功激活，
// 渲染层的标识行判定同一前缀——改这里三处一起改
export const SKILL_BODY_PREFIX = (name: string): string => `【技能：${name}】`

export function makeActivateSkillTool(opts: {
  names: string[] // 本轮可激活范围：Agent 清单现场对库过滤后的名字（C6 点名并入此处）
  getHistory: () => ModelMessage[] // 轮初组装、L2 裁剪后的历史——去重只认还在上下文里的正文
}): Tool {
  const { names, getHistory } = opts
  const activated = new Set<string>() // 轮内已激活：同轮第二次激活时第一次的返回不在轮初历史里
  // 该技能正文已在对话记录里且没被压缩掉（流程第 2 步）：扫历史 tool 消息里本工具的成功返回。
  // L1 与总量闸都豁免本工具，正文只要还在就一定是全文前缀可辨；L2 丢弃的消息已不在数组里
  const inHistory = (name: string): boolean =>
    getHistory().some((m) => {
      if ((m as { role: string }).role !== 'tool' || !Array.isArray(m.content)) return false
      return (
        m.content as { type?: string; toolName?: string; output?: { value?: unknown } }[]
      ).some(
        (p) =>
          p.type === 'tool-result' &&
          p.toolName === ACTIVATE_TOOL_NAME &&
          typeof p.output?.value === 'string' &&
          p.output.value.startsWith(SKILL_BODY_PREFIX(name))
      )
    })
  return tool({
    description: ACTIVATE_TOOL_DESCRIPTION,
    inputSchema: jsonSchema<{ name: string }>({
      type: 'object',
      properties: {
        name: { type: 'string', enum: names, description: '技能名，须在「可用技能」清单中' }
      },
      required: ['name']
    }),
    execute: async (args) => {
      const name = (args as { name?: unknown } | null)?.name
      // schema 里的 enum 只是给模型看的声明，SDK 不做运行时拦截（提问卡 minItems 先例）——显式校验
      if (typeof name !== 'string' || !names.includes(name))
        return {
          error: `技能「${typeof name === 'string' ? name : ''}」不在本轮可激活的范围内（可激活：${names.join('、')}）。不要虚构技能内容；没有匹配的技能就按你默认的方式处理`
        }
      if (activated.has(name) || inHistory(name))
        return `技能「${name}」已激活，完整正文已在上下文中，直接按正文行事，不必重复激活`
      const detail = getSkill(name)
      if (!detail)
        return {
          error: `技能「${name}」在技能库里已不存在。如实告知用户这个技能无法使用，不要虚构技能内容`
        }
      activated.add(name)
      const dir = join(skillsRoot(), name)
      const md = detail.files.find((f) => f.path === 'SKILL.md')?.content ?? ''
      const extras = detail.files.filter((f) => f.path !== 'SKILL.md')
      let out = `${SKILL_BODY_PREFIX(name)}以下是该技能的完整正文，按它的流程执行：\n\n${md}`
      if (extras.length)
        out += `\n\n—— 附带资源 ——\n该技能还带有以下文件，正文提到或需要时用 read_file 按路径读取（技能目录已授权）：\n${extras.map((f) => `- ${join(dir, f.path)}`).join('\n')}`
      if (detail.hasScripts)
        out += `\n\n—— 脚本说明 ——\n该技能带有 scripts/ 目录，但你没有执行脚本的能力：可以用 read_file 读脚本源码理解意图、用你可用的工具达成同样目的、或如实告知用户做不了；不得虚构脚本执行结果。`
      return out
    }
  })
}

// 导入（功能点 5 顺序执行，命中即出口）。input 为文件夹或 zip 的绝对路径
export async function importSkill(path: string, overwrite: boolean): Promise<ImportResult> {
  let root: string // 技能内容根（含 SKILL.md 的那层）
  let folderName: string | null // 与 name 比对的文件夹名；zip 根层直出 SKILL.md 时无文件夹可比
  let tmp: string | null = null
  try {
    if (!existsSync(path)) return { errors: ['文件不存在'] }
    if (statSync(path).isDirectory()) {
      root = path
      folderName = basename(path)
    } else if (extname(path).toLowerCase() === '.zip') {
      tmp = mkdtempSync(join(tmpdir(), 'chime-skill-'))
      try {
        await execFileP('/usr/bin/unzip', ['-qo', path, '-d', tmp])
      } catch {
        return { errors: ['zip 解压失败，请确认压缩包完整'] }
      }
      if (existsSync(join(tmp, 'SKILL.md'))) {
        root = tmp
        folderName = null
      } else {
        // zip 打包常多包一层：唯一一层子文件夹内找（__MACOSX 等杂项跳过）
        const dirs = readdirSync(tmp, { withFileTypes: true }).filter(
          (e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== '__MACOSX'
        )
        if (dirs.length === 1 && existsSync(join(tmp, dirs[0].name, 'SKILL.md'))) {
          root = join(tmp, dirs[0].name)
          folderName = dirs[0].name
        } else {
          return { errors: ['找不到 SKILL.md（解压根层与唯一子文件夹内都没有）'] }
        }
      }
    } else {
      return { errors: ['只支持技能文件夹或 zip 压缩包'] }
    }

    const meta = readSkillMeta(root)
    if (!existsSync(join(root, 'SKILL.md'))) return { errors: ['找不到 SKILL.md'] }
    if (!meta) return { errors: ['SKILL.md 的 YAML 头缺失或无法解析'] }
    const errs = validate(meta, folderName)
    if (errs.length) return { errors: errs }

    const dest = join(skillsRoot(), meta.name)
    if (existsSync(dest)) {
      if (!overwrite) return { conflict: meta.name }
      rmSync(dest, { recursive: true, force: true }) // 覆盖即技能的更新方式（功能点 5 第 4 步）
    }
    mkdirSync(skillsRoot(), { recursive: true }) // 首次导入时库根目录还不存在
    cpSync(root, dest, { recursive: true })
    return { ok: true, name: meta.name }
  } finally {
    if (tmp) rmSync(tmp, { recursive: true, force: true })
  }
}
