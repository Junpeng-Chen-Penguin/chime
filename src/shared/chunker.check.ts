// chunker 最小自检：node --experimental-strip-types src/shared/chunker.check.ts
import { strict as assert } from 'node:assert'
// eslint-disable-next-line -- strip-types 直跑需要带扩展名,electron-vite 构建不含本文件
import { chunkMarkdown, estimateTokens } from './chunker.ts'

// 1. 标题链与行号
{
  const md = ['# 计费', '', '## 续签', '续签时按新计费规则执行，历史订单不受影响。这条规则自发布之日起生效。', '', '## 退款', '退款按原路退回，七个工作日内到账，逾期请联系客服处理。'].join('\n')
  const cs = chunkMarkdown(md)
  assert.equal(cs.length, 2)
  assert.equal(cs[0].headingPath, '计费 › 续签')
  assert.equal(cs[0].startLine, 4)
  assert.equal(cs[0].endLine, 4)
  assert.equal(cs[1].headingPath, '计费 › 退款')
  assert.ok(cs[1].content.includes('原路退回'))
}

// 2. front matter 跳过，行号仍准
{
  const md = ['---', 'title: x', '---', '# A', '正文第一行，长度足够不被合并规则吃掉，用来验证行号偏移是否正确。'].join('\n')
  const cs = chunkMarkdown(md)
  assert.equal(cs.length, 1)
  assert.equal(cs[0].startLine, 5)
  assert.ok(!cs[0].content.includes('title'))
}

// 3. 围栏代码原子：# 在代码里不算标题
{
  const md = ['# A', '说明文字，这一段有五十个字符以上的长度要求需要满足合并阈值。', '```bash', '# 注释不是标题', 'echo hi', '```'].join('\n')
  const cs = chunkMarkdown(md)
  assert.equal(cs.length, 1)
  assert.ok(cs[0].content.includes('# 注释不是标题'))
}

// 4. 表格原子 + 超长切分：长表格不从中间断
{
  const para = '这是一个用于凑长度的业务规则说明段落，反复说明计费口径与生效时间的细节。'.repeat(8)
  const table = ['| 项 | 值 |', '| --- | --- |', ...Array.from({ length: 20 }, (_, i) => `| 规则${i} | 说明${i} |`)]
  const md = ['# A', para, '', ...table, '', para].join('\n')
  const cs = chunkMarkdown(md)
  assert.ok(cs.length >= 2, '超预算应切开')
  const tableChunk = cs.find((c) => c.content.includes('| 规则0 |'))!
  assert.ok(tableChunk.content.includes('| 规则19 |'), '表格必须整体在同一片段')
}

// 5. 短块合并
{
  const md = ['# A', '短句。', '', '这一段比较长，超过五十个字符的门槛，用来接收前面的短句合并进来一起成为片段。'].join('\n')
  const cs = chunkMarkdown(md)
  assert.equal(cs.length, 1)
}

// 6. token 估算：中文 1 字 1 token,英文约 2 字符 1 token
assert.equal(estimateTokens('中文四字'), 4)
assert.equal(estimateTokens('abcd'), 2)

console.log('[chunker-check] PASS')
