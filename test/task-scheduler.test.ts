import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, it } from 'node:test'
import { createTaskService } from '../src/app/tasks.ts'
import { openDatabase } from '../src/storage/database.ts'
import { seedIfEmpty } from '../src/storage/seed.ts'

const root = path.join(fileURLToPath(new URL('..', import.meta.url)))

describe('定时任务调度', () => {
  let directory = ''

  afterEach(async () => {
    if (!directory) return
    const target = directory
    directory = ''
    await rm(target, { recursive: true, force: true })
  })

  it('cron 命中的分钟自动运行；同一分钟不重复；手动/停用不跑', async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'wb-scheduler-'))
    const database = await openDatabase(path.join(directory, 'agent_workbench.json'))
    await seedIfEmpty(database)
    const ownerId = (await database.read()).stores.friends[0]!.id
    const calls: string[] = []
    const service = createTaskService(database, async (task) => {
      calls.push(task.id)
      return `完成 ${task.name}`
    })

    const cronTask = await service.upsert({
      name: '十分钟一次',
      friendId: ownerId,
      prompt: '',
      schedule: 'cron',
      cron: '*/10 * * * *',
    })
    const manual = await service.upsert({
      name: '手动',
      friendId: ownerId,
      prompt: '',
      schedule: 'manual',
    })
    const disabled = await service.upsert({
      name: '停用',
      friendId: ownerId,
      prompt: '',
      schedule: 'cron',
      cron: '* * * * *',
      enabled: false,
    })

    await service.tick(new Date(2026, 10, 3, 15, 10, 5))
    await waitFor(async () => {
      const task = (await service.list()).find((item) => item.id === cronTask.id)
      return task?.history[0]?.status === 'success'
    })
    assert.equal(calls.filter((id) => id === cronTask.id).length, 1)
    assert.equal(calls.includes(manual.id), false)
    assert.equal(calls.includes(disabled.id), false)

    // 同一分钟再扫一次：不重复
    await service.tick(new Date(2026, 10, 3, 15, 10, 40))
    assert.equal(calls.filter((id) => id === cronTask.id).length, 1)

    // 不命中的分钟
    await service.tick(new Date(2026, 10, 3, 15, 11, 0))
    assert.equal(calls.filter((id) => id === cronTask.id).length, 1)

    // 下一个命中分钟
    await service.tick(new Date(2026, 10, 3, 15, 20, 0))
    await waitFor(async () => {
      const task = (await service.list()).find((item) => item.id === cronTask.id)
      return task?.history[0]?.status === 'success' && calls.filter((id) => id === cronTask.id).length === 2
    })
    assert.equal(calls.filter((id) => id === cronTask.id).length, 2)

    // 手动任务立即运行时仍可用
    await service.run(manual.id)
    assert.equal(calls.filter((id) => id === manual.id).length, 1)
  })

  it('任务页显示下次运行并定时刷新历史', async () => {
    const page = await readFile(path.join(root, 'src/ui/tasks-page.tsx'), 'utf8')
    assert.match(page, /nextCronTime/)
    assert.match(page, /下次运行/)
    assert.match(page, /setInterval/)
    assert.match(page, /10_000/)
    const server = await readFile(path.join(root, 'src/server.ts'), 'utf8')
    assert.match(server, /tasks\.startScheduler\(\)/)
    assert.match(server, /tasks\.stopScheduler\(\)/)
  })

  it('保存时校验 Cron，写错不落库', async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'wb-scheduler-'))
    const database = await openDatabase(path.join(directory, 'agent_workbench.json'))
    await seedIfEmpty(database)
    const ownerId = (await database.read()).stores.friends[0]!.id
    const service = createTaskService(database, async () => 'ok')
    await assert.rejects(
      () =>
        service.upsert({
          name: '错 cron',
          friendId: ownerId,
          prompt: '',
          schedule: 'cron',
          cron: '*/0 * * * *',
        }),
      /步长/,
    )
    assert.equal((await service.list()).length, 0)
  })
})

async function waitFor(check: () => Promise<boolean> | boolean) {
  const started = Date.now()
  while (Date.now() - started < 3000) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 15))
  }
  throw new Error('等待超时')
}
