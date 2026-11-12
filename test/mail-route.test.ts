/**
 * 邮件点名：尾部「，好友简称的」转给该好友，群名转进对应群。
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { resolveMailRoute, type MailRouteFriend, type MailRouteGroup } from '../src/app/mail-route.ts'

const friends: MailRouteFriend[] = [
  { id: 'owner', name: '群主', isOwnerTemplate: true },
  { id: 'park', name: '停车场业务开发' },
  { id: 'ui', name: 'UI 设计师' },
]

const groups: MailRouteGroup[] = [
  { id: 'old-lottery', title: '彩票走势图群', updatedAt: 1, lineageId: 'lottery' },
  { id: 'lottery', title: '彩票走势图群', updatedAt: 10, lineageId: 'lottery' },
  { id: 'archived', title: '超级智能体开发', archived: true, updatedAt: 20, lineageId: 'old' },
]

describe('邮件点名好友或群', () => {
  it('尾部「，停车场业务的」交给名称更长的好友，并去掉点名', () => {
    const route = resolveMailRoute({
      body: '帮我看看小程序长租车都返回了什么字段，停车场业务的',
      friends,
      groups,
    })
    assert.equal(route?.kind, 'friend')
    assert.equal(route?.id, 'park')
    assert.equal(route?.name, '停车场业务开发')
    assert.equal(route?.instruction, '帮我看看小程序长租车都返回了什么字段')
  })

  it('没点名时不改道', () => {
    const route = resolveMailRoute({
      body: '帮我看看小程序长租车都返回了什么字段',
      friends,
      groups,
    })
    assert.equal(route, null)
  })

  it('群主自己的名字不转交', () => {
    const route = resolveMailRoute({
      body: '帮我看一下，群主的',
      friends,
      groups,
    })
    assert.equal(route, null)
  })

  it('@全名时把后面的话交给该好友', () => {
    const route = resolveMailRoute({
      body: '@停车场业务开发 帮我看看返回字段',
      friends,
      groups,
    })
    assert.equal(route?.id, 'park')
    assert.equal(route?.instruction, '帮我看看返回字段')
  })

  it('尾部群名交给最新一段未归档群聊', () => {
    const route = resolveMailRoute({
      body: '帮我看开奖走势，彩票走势图群',
      friends,
      groups,
    })
    assert.equal(route?.kind, 'group')
    assert.equal(route?.id, 'lottery')
    assert.equal(route?.instruction, '帮我看开奖走势')
  })

  it('句子里出现群名也转入该群，正文保留群名', () => {
    const route = resolveMailRoute({
      body: '在彩票走势图群里看一下走势',
      friends,
      groups,
    })
    assert.equal(route?.kind, 'group')
    assert.equal(route?.id, 'lottery')
    assert.equal(route?.instruction, '在彩票走势图群里看一下走势')
  })

  it('两个好友简称一样长时不猜', () => {
    const route = resolveMailRoute({
      body: '看一下字段，停车场业务的',
      friends: [
        ...friends,
        { id: 'park-2', name: '停车场业务测试' },
      ],
      groups,
    })
    assert.equal(route, null)
  })

  it('主题里点名、正文是任务', () => {
    const route = resolveMailRoute({
      subject: '停车场业务的',
      body: '帮我看看小程序长租车都返回了什么字段',
      friends,
      groups,
    })
    assert.equal(route?.id, 'park')
    assert.equal(route?.instruction, '帮我看看小程序长租车都返回了什么字段')
  })

  it('已归档的群不接', () => {
    const route = resolveMailRoute({
      body: '看一下，超级智能体开发',
      friends,
      groups,
    })
    assert.equal(route, null)
  })
})
