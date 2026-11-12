import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { findMention, handoffMention } from '../src/domain/mentions.ts'

const friends = [
  { id: 'owner', name: '群主' },
  { id: 'dev', name: '代码开发' },
  { id: 'short', name: '开发' },
  { id: 'ui', name: 'UI 设计师' },
]

describe('群聊 @ 解析', () => {
  it('认出 @ 后的群友，并拆出任务文本', () => {
    const match = findMention('请 @代码开发 把路由接上，再跑测试。', friends)
    assert.equal(match?.friend.id, 'dev')
    assert.equal(match?.task, '把路由接上，再跑测试。')
  })

  it('名字按长度匹配：「@代码开发」不会错成「@开发」', () => {
    assert.equal(findMention('@代码开发 看一下', friends)?.friend.id, 'dev')
    assert.equal(findMention('@开发 看一下', friends)?.friend.id, 'short')
  })

  it('支持全角 ＠、@ 与名字间空格、句首标点', () => {
    assert.equal(findMention('＠ UI 设计师 这个交互改一下', friends)?.friend.id, 'ui')
    assert.equal(findMention('@ 代码开发，请动手', friends)?.task, '请动手')
    assert.equal(findMention('找 @群主', friends)?.friend.id, 'owner')
  })

  it('没有 @、@ 了不存在的人、邮箱都不算', () => {
    assert.equal(findMention('帮我看看这个', friends), null)
    assert.equal(findMention('@不存在 你好', friends), null)
    assert.equal(findMention('发到 a@code.com', [...friends, { id: 'mail', name: 'code.com' }]), null)
  })

  it('交办取同一个人后面那段更完整的任务，不从顺口 @ 截起', () => {
    const text = [
      '步骤 4 已交给 @UI 设计师，文件落地后勾选。',
      '',
      '@UI 设计师 请在你的工作目录产出一份纯 HTML 单文件，包含首页和走势图，不要写到其他成员的目录。',
    ].join('\n')
    const match = handoffMention(text, friends, { excludeIds: ['owner'] })
    assert.equal(match?.friend.id, 'ui')
    assert.equal(match?.task, '请在你的工作目录产出一份纯 HTML 单文件，包含首页和走势图，不要写到其他成员的目录。')
  })

  it('可以排除群主，交给群主 @ 群友时只认别人', () => {
    assert.equal(findMention('@群主 你看', friends, { excludeIds: ['owner'] }), null)
    assert.equal(findMention('@代码开发 你来', friends, { excludeIds: ['owner'] })?.friend.id, 'dev')
  })
})
