import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

const root = path.join(fileURLToPath(new URL('..', import.meta.url)))

describe('p1.3 UI 接线源码', () => {
  it('会话 sheet / 确认卡 / 抽技能提示 / 好友系统提示词已接线', async () => {
    const pane = await readFile(path.join(root, 'src/ui/conversation-pane.tsx'), 'utf8')
    assert.match(pane, /SaveSkillSessionsSheet/)
    assert.match(pane, /开始总结/)
    assert.match(pane, /SkillExtractCard/)
    assert.match(pane, /LegacySkillSheet/)

    const card = await readFile(path.join(root, 'src/ui/skill-extract-card.tsx'), 'utf8')
    assert.match(card, /保存为好友技能/)
    assert.match(card, /skill-extracts/)

    const mail = await readFile(path.join(root, 'src/ui/mail-settings-page.tsx'), 'utf8')
    assert.match(mail, /skillExtractPrompt/)
    assert.match(mail, /DEFAULT_SKILL_EXTRACT_PROMPT/)
    assert.match(mail, /抽技能 · 系统提示词/)

    const friend = await readFile(path.join(root, 'src/ui/friend-panel.tsx'), 'utf8')
    assert.match(friend, /friend-sysprompt-ta/)
    assert.match(friend, /未设置/)
    assert.match(friend, /skill-preview/)

    const css = await readFile(path.join(root, 'src/ui/styles.css'), 'utf8')
    assert.match(css, /session-pick-item/)
    assert.match(css, /extracting-pill/)
  })
})
