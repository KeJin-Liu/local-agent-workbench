import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { createProposalService } from '../src/app/proposals.ts'
import { createTaskService } from '../src/app/tasks.ts'
import { openDatabase } from '../src/storage/database.ts'
import { seedIfEmpty } from '../src/storage/seed.ts'

describe('确认卡和自动化任务', () => {
  let directory = ''

  afterEach(async () => {
    if (directory) await rm(directory, { recursive: true, force: true })
  })

  it('未确认不落库，取消丢草稿，失败不写入任务', async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'wb-proposal-'))
    const database = await openDatabase(path.join(directory, 'agent_workbench.json'))
    await seedIfEmpty(database)
    const proposals = createProposalService(database)
    const friendId = (await database.read()).stores.friends[0]!.id
    const pending = await proposals.stage({
      conversationId: 'c1',
      kind: 'task',
      name: '每日站会摘要',
      summary: '工作日早上',
      draft: { friendId, schedule: 'cron', cron: '0 9 * * 1-5', body: '汇总进度' },
    })
    assert.equal((await database.read()).stores.tasks.length, 0)
    assert.equal((await proposals.listPending('c1')).length, 1)

    await assert.rejects(() => proposals.confirm(pending.id, 'friends', ['missing-friend']))
    assert.equal((await database.read()).stores.tasks.length, 0)
    assert.match((await database.read()).stores.proposals[0]?.error ?? '', /好友/)

    const saved = await proposals.confirm(pending.id, 'friends', [friendId])
    assert.equal(saved.status, 'confirmed')
    assert.equal((await database.read()).stores.tasks.length, 1)
    assert.equal((await database.read()).stores.tasks[0]?.friendId, friendId)
    assert.deepEqual((await database.read()).stores.tasks[0]?.friendIds, [friendId])

    const another = await proposals.stage({
      conversationId: 'c1',
      kind: 'skill',
      name: '周报',
      draft: { body: '先列事实' },
    })
    await proposals.cancel(another.id)
    assert.equal((await database.read()).stores.proposals.some((item) => item.id === another.id), false)
    assert.equal((await database.read()).stores.skills.length, 0)
  })

  it('立即运行成功或失败都会记入历史', async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'wb-task-'))
    const database = await openDatabase(path.join(directory, 'agent_workbench.json'))
    await seedIfEmpty(database)
    const friendId = (await database.read()).stores.friends[0]!.id
    const ok = createTaskService(database, async () => '三条要点')
    const task = await ok.upsert({ name: '巡检', friendId, prompt: '看依赖', schedule: 'manual' })
    const done = await ok.run(task.id)
    assert.equal(done.lastStatus, 'success')
    assert.equal(done.history[0]?.result, '三条要点')

    const failing = createTaskService(database, async () => {
      throw new Error('提供方超时')
    })
    await assert.rejects(() => failing.run(task.id), /提供方超时/)
    const after = (await database.read()).stores.tasks.find((item) => item.id === task.id)
    assert.equal(after?.lastStatus, 'error')
    assert.equal(after?.history[0]?.error, '提供方超时')
  })
})