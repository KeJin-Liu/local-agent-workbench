import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import { buildAppSettingsDiff } from '../src/ui/propose-config-diff.ts'

const root = path.join(fileURLToPath(new URL('..', import.meta.url)))

describe('p1.4 UI 接线', () => {
  it('ConfirmCard 分 kind 对齐 propose.html：脱敏 / diff / 好友名 / 成员 / 保险库', async () => {
    const pane = await readFile(path.join(root, 'src/ui/conversation-pane.tsx'), 'utf8')
    assert.match(pane, /ConfigProposalBody/)
    assert.match(pane, /isConfigKind/)
    assert.match(pane, /确认落库/)
    assert.match(pane, /provider\|app_settings\|friend_patch\|group\|vault_binding/)

    const body = await readFile(path.join(root, 'src/ui/propose-config-body.tsx'), 'utf8')
    assert.match(body, /key-mask/)
    assert.match(body, /vault-bind-chip/)
    assert.match(body, /propose-diff/)
    assert.match(body, /friend-patch-target/)
    assert.match(body, /friend-patch-name/)
    assert.match(body, /propose-member-list/)
    assert.match(body, /不回显全文/)
    assert.match(body, /data-config-kind="provider"/)
    assert.match(body, /data-config-kind="app_settings"/)
    assert.match(body, /data-config-kind="friend_patch"/)
    assert.match(body, /data-config-kind="group"/)
    assert.match(body, /data-config-kind="vault_binding"/)
    assert.doesNotMatch(body, /session_prefs/)

    const css = await readFile(path.join(root, 'src/ui/styles.css'), 'utf8')
    assert.match(css, /\.propose-diff/)
    assert.match(css, /\.key-mask/)
    assert.match(css, /\.vault-bind-chip/)
    assert.match(css, /\.friend-patch-target/)
    assert.match(css, /\.propose-member-list/)
  })

  it('正典 propose.html 与 shots 已入 docs/p14-ui', async () => {
    const html = await readFile(path.join(root, 'docs/p14-ui/propose.html'), 'utf8')
    assert.match(html, /p1\.4/)
    assert.match(html, /data-kind="provider"/)
    assert.match(html, /data-kind="app_settings"/)
    assert.match(html, /data-kind="friend_patch"/)
    assert.match(html, /data-kind="group"/)
    assert.match(html, /data-kind="vault_binding"/)
    assert.match(html, /propose-diff/)
    assert.match(html, /key-mask/)
    assert.match(html, /vault-bind-chip/)
    assert.doesNotMatch(html, /session_prefs/)

    for (const shot of [
      'propose-provider.png',
      'propose-app-settings.png',
      'propose-friend-patch.png',
      'propose-group.png',
      'propose-vault-binding.png',
    ]) {
      const buf = await readFile(path.join(root, 'docs/p14-ui/shots', shot))
      assert.ok(buf.byteLength > 1000, shot)
    }
  })

  it('buildAppSettingsDiff 只亮 patch 字段', () => {
    const items = buildAppSettingsDiff({
      sendWaitSeconds: 5,
      mailInstructions: { enabled: true, whitelist: ['a@b.com'] },
    })
    const changed = items.filter((item) => !item.unchanged).map((item) => item.key)
    assert.ok(changed.includes('sendWaitSeconds'))
    assert.ok(changed.includes('mailInstructions.enabled') || changed.includes('mailInstructions.whitelist'))
    assert.ok(items.some((item) => item.key === 'planModePrompt' && item.unchanged))
  })
})
