import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { cronMatches, nextCronTime, parseCron } from '../src/app/cron.ts'

function at(hour: number, minute: number, day = 3): Date {
  // 2026-11-03 是周二
  return new Date(2026, 10, day, hour, minute, 0, 0)
}

describe('Cron 解析与匹配', () => {
  it('*/10 每十分钟命中，其他分钟不命中', () => {
    assert.equal(cronMatches('*/10 * * * *', at(15, 10)), true)
    assert.equal(cronMatches('*/10 * * * *', at(15, 20)), true)
    assert.equal(cronMatches('*/10 * * * *', at(15, 11)), false)
    assert.equal(cronMatches('*/10 * * * *', at(15, 9)), false)
  })

  it('范围、列表、步长、工作日', () => {
    assert.equal(cronMatches('5,10-20/5 * * * *', at(9, 5)), true)
    assert.equal(cronMatches('5,10-20/5 * * * *', at(9, 10)), true)
    assert.equal(cronMatches('5,10-20/5 * * * *', at(9, 20)), true)
    assert.equal(cronMatches('5,10-20/5 * * * *', at(9, 12)), false)
    assert.equal(cronMatches('0 9 * * 1-5', at(9, 0)), true) // 周二
    assert.equal(cronMatches('0 9 * * 0', at(9, 0)), false)
  })

  it('周日写成 0 或 7 都认；日/周都限制时任一命中', () => {
    const sunday = new Date(2026, 10, 8, 12, 0, 0, 0) // 2026-11-08 周日
    assert.equal(cronMatches('0 12 * * 0', sunday), true)
    assert.equal(cronMatches('0 12 * * 7', sunday), true)
    const first = new Date(2026, 10, 1, 9, 0, 0, 0) // 11 月 1 日，周日
    assert.equal(cronMatches('0 9 1 * 1', first), true)
    const monday = new Date(2026, 10, 2, 9, 0, 0, 0)
    assert.equal(cronMatches('0 9 1 * 1', monday), true)
  })

  it('非法表达式给人话', () => {
    assert.throws(() => parseCron('* * * *'), /5 段/)
    assert.throws(() => parseCron('60 * * * *'), /分钟要在 0–59/)
    assert.throws(() => parseCron('*/0 * * * *'), /步长/)
    assert.throws(() => parseCron('20-5 * * * *'), /起点大于终点/)
    assert.throws(() => parseCron('* * * * MON'), /周要在 0–7/)
  })

  it('下次运行严格晚于当前分钟', () => {
    assert.equal(nextCronTime('*/10 * * * *', at(15, 3))?.getMinutes(), 10)
    assert.equal(nextCronTime('*/10 * * * *', at(15, 10))?.getMinutes(), 20)
    const tomorrow = nextCronTime('0 9 * * *', at(10, 0))
    assert.equal(tomorrow?.getDate(), 4)
    assert.equal(tomorrow?.getHours(), 9)
  })
})
