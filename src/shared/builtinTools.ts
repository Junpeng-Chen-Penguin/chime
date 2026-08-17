// 内置工具登记表：函数名（模型可见、程序判定）与展示名（各处界面）的唯一对应（PRD Case 4）。
// 设置列表、时间线、测试记录都从这一份取——同一个工具在任何地方同名
export interface BuiltinToolEntry {
  name: string // 函数名：稳定标识，改展示名不影响历史用例
  display: string // 展示名：给人看的中文名（与既有时间线/测试记录一致，不改动）
  desc: string
}

export const BUILTIN_TOOLS: BuiltinToolEntry[] = [
  { name: 'search_knowledge_base', display: '检索知识库', desc: '在你选用的知识库中查找业务资料' },
  { name: 'ask_user_question', display: '询问用户', desc: '缺少关键信息时弹出选择卡片让你定夺' },
  { name: 'create_artifact', display: '生成制品', desc: '成批数据整理成表格，在侧板查看全貌' },
  {
    name: 'grep_result',
    display: '搜结果集',
    desc: '一次取回的资料超出篇幅时，按关键词定位到相关段落'
  },
  { name: 'read_result', display: '读结果集', desc: '按定位到的位置，读取该段落的完整原文' },
  { name: 'read_file', display: '读取文件', desc: '读取工作空间里的文本文件内容' },
  { name: 'list_dir', display: '列出目录', desc: '查看工作空间目录里有哪些文件' },
  {
    name: 'write_file',
    display: '写入文件',
    desc: '把内容写进工作空间里的文件，写入前征求你的同意'
  },
  {
    name: 'edit_file',
    display: '编辑文件',
    desc: '对工作空间里的文件做定点修改，修改前征求你的同意'
  }
]

export function builtinDisplay(name: string): string | undefined {
  return BUILTIN_TOOLS.find((t) => t.name === name)?.display
}
