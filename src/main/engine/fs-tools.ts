// 本地文件能力（015）。C1 先落路径判定助手；四个文件工具（读/列/写/编辑）在 C2 加入。
// 白名单语义：会话 ws_list（授权清单）∪ 技能库根目录；路径先 resolve 归一再判前缀，防「../」逃逸。
import { resolve, basename } from 'path'

// 目标路径已被清单中某目录覆盖（等于它，或是它的子路径）——「已在授权范围内」判定，
// Agent 编辑页 / 选择器 / 工作面板三个添加入口与 conv:wsAdd 复用
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
