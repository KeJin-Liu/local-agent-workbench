import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

const root = path.join(fileURLToPath(new URL('..', import.meta.url)))

describe('p1.3.1 UI 接线源码', () => {
  it('任务页系统拉信徽章 / 只读说明 / 链到邮箱设置；普通任务仍可编辑提示词', async () => {
    const tasks = await readFile(path.join(root, 'src/ui/tasks-page.tsx'), 'utf8')
    assert.match(tasks, /系统拉信/)
    assert.match(tasks, /system_mail_poll/)
    assert.match(tasks, /MAIL_POLL_TASK_ID/)
    assert.match(tasks, /说明（非好友提示词）/)
    assert.match(tasks, /模型不连邮箱/)
    assert.match(tasks, /onOpenMail/)
    assert.match(tasks, /设置 → 邮箱 \/ 工作指令/)
    assert.match(tasks, /!mailSystem \?[\s\S]*提示词/)
    assert.match(tasks, /readOnly=\{mailSystem\}/)

    const mail = await readFile(path.join(root, 'src/ui/mail-settings-page.tsx'), 'utf8')
    assert.match(mail, /应用侧拉信/)
    assert.match(mail, /模型不连邮箱/)

    const server = await readFile(path.join(root, 'src/server.ts'), 'utf8')
    assert.match(server, /isMailPollTask/)
    assert.match(server, /runMailPollPipeline/)
  })
})
