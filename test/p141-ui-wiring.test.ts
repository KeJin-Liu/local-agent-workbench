import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

const root = path.join(fileURLToPath(new URL('..', import.meta.url)))

describe('p1.4.1 UI 接线（邮箱测试连接人话）', () => {
  it('正典 mail-work-inbox.html：测试连接成功/失败人话 + shot', async () => {
    const html = await readFile(path.join(root, 'docs/p141-ui/mail-work-inbox.html'), 'utf8')
    assert.match(html, /测试连接/)
    assert.match(html, /IMAP\/SMTP 连接正常/)
    assert.match(html, /IMAP 连不上/)
    assert.match(html, /凭证或 TLS/)
    assert.match(html, /任务历史/)
    assert.match(html, /不会静默/)
    assert.match(html, /test=fail|runMailTest/)

    const shot = await readFile(path.join(root, 'docs/p141-ui/shots/mail-test-connect.png'))
    assert.ok(shot.byteLength > 1000)
  })

  it('server 注入 createMailTransport；骨架空拉已移除', async () => {
    const server = await readFile(path.join(root, 'src/server.ts'), 'utf8')
    assert.match(server, /createMailTransport/)
    assert.match(server, /mailTransport\.fetchInbox/)
    assert.match(server, /mailTransport\.sendSmtp/)
    assert.match(server, /WORKBENCH_MAIL_DRY_RUN/)
    assert.doesNotMatch(server, /defaultFetchInbox/)
    assert.doesNotMatch(server, /骨架未真发/)

    const transport = await readFile(path.join(root, 'src/app/mail-transport.ts'), 'utf8')
    assert.match(transport, /imapflow/)
    assert.match(transport, /nodemailer/)
    assert.match(transport, /humanizeMailError/)
    assert.match(transport, /找不到主机/)
  })
})
