// chunker 最小自检：node --experimental-strip-types src/shared/chunker.check.ts
import { strict as assert } from 'node:assert'

import { chunkMarkdown, estimateTokens } from './chunker.ts'

// 1. 标题链与行号
{
  const md = [
    '# 计费',
    '',
    '## 续签',
    '续签时按新计费规则执行，历史订单不受影响。这条规则自发布之日起生效。',
    '',
    '## 退款',
    '退款按原路退回，七个工作日内到账，逾期请联系客服处理。'
  ].join('\n')
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
  const md = [
    '---',
    'title: x',
    '---',
    '# A',
    '正文第一行，长度足够不被合并规则吃掉，用来验证行号偏移是否正确。'
  ].join('\n')
  const cs = chunkMarkdown(md)
  assert.equal(cs.length, 1)
  assert.equal(cs[0].startLine, 5)
  assert.ok(!cs[0].content.includes('title'))
}

// 3. 围栏代码原子：# 在代码里不算标题
{
  const md = [
    '# A',
    '说明文字，这一段有五十个字符以上的长度要求需要满足合并阈值。',
    '```bash',
    '# 注释不是标题',
    'echo hi',
    '```'
  ].join('\n')
  const cs = chunkMarkdown(md)
  assert.equal(cs.length, 1)
  assert.ok(cs[0].content.includes('# 注释不是标题'))
}

// 4. 表格原子 + 超长切分：长表格不从中间断
{
  const para = '这是一个用于凑长度的业务规则说明段落，反复说明计费口径与生效时间的细节。'.repeat(8)
  const table = [
    '| 项 | 值 |',
    '| --- | --- |',
    ...Array.from({ length: 20 }, (_, i) => `| 规则${i} | 说明${i} |`)
  ]
  const md = ['# A', para, '', ...table, '', para].join('\n')
  const cs = chunkMarkdown(md)
  assert.ok(cs.length >= 2, '超预算应切开')
  const tableChunk = cs.find((c) => c.content.includes('| 规则0 |'))!
  assert.ok(tableChunk.content.includes('| 规则19 |'), '表格必须整体在同一片段')
}

// 4b. 超预算表格按行切：每片带表头、行不丢不断、坐标指向真实数据行
{
  const rows = Array.from(
    { length: 30 },
    (_, i) => `| 术语${i} | 这是第${i}个术语的定义说明，内容足够长以便让整张表超出切块预算。 |`
  )
  const table = ['| 术语 | 定义 |', '| --- | --- |', ...rows]
  const md = ['# 术语表', ...table].join('\n')
  const cs = chunkMarkdown(md)
  assert.ok(cs.length >= 2, '超预算表格应切成多片')
  for (const c of cs) {
    assert.ok(c.content.startsWith('| 术语 | 定义 |'), '每片都要带表头')
    assert.ok(estimateTokens(c.content) <= 240, '每片装得进重排窗口')
  }
  assert.ok(
    cs[0].content.includes('| 术语0 |') && cs[cs.length - 1].content.includes('| 术语29 |'),
    '首尾行都在'
  )
  assert.equal(
    cs.map((c) => c.content.match(/\| 术语\d+ \|/g)!.length).reduce((a, b) => a + b),
    30,
    '数据行不丢不重'
  )
  assert.equal(cs[0].startLine, 2, '首片坐标从表头起')
  const second = cs[1]
  assert.ok(
    second.content.includes(`| 术语${second.startLine - 4} |`),
    '后续片坐标指向自己的第一个数据行'
  )
}

// 5. 短块合并
{
  const md = [
    '# A',
    '短句。',
    '',
    '这一段比较长，超过五十个字符的门槛，用来接收前面的短句合并进来一起成为片段。'
  ].join('\n')
  const cs = chunkMarkdown(md)
  assert.equal(cs.length, 1)
}

// 6. token 估算：中文 1 字 1 token,英文约 2 字符 1 token
assert.equal(estimateTokens('中文四字'), 4)
assert.equal(estimateTokens('abcd'), 2)

console.log('[chunker-check] PASS')
