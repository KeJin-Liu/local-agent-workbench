import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'
import { filesFromClipboard, namePastedFiles } from '../src/ui/clipboard.ts'

const root = path.join(fileURLToPath(new URL('..', import.meta.url)))

function png(name: string): File {
  return new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], name, { type: 'image/png' })
}

describe('聊天输入框粘贴附件', () => {
  it('优先取剪贴板 files，其次取 items 里的文件；纯文字返回空数组', () => {
    const fromFiles = png('a.png')
    const fromItems = png('b.png')
    assert.deepEqual(
      filesFromClipboard({ files: [fromFiles], items: [{ kind: 'file', getAsFile: () => fromItems }] }),
      [fromFiles],
    )
    assert.deepEqual(
      filesFromClipboard({
        files: [],
        items: [
          { kind: 'string', getAsFile: () => null },
          { kind: 'file', getAsFile: () => null },
          { kind: 'file', getAsFile: () => fromItems },
        ],
      }),
      [fromItems],
    )
    assert.deepEqual(filesFromClipboard({ files: [], items: [] }), [])
    assert.deepEqual(filesFromClipboard(null), [])
  })

  it('无名截图补时间戳文件名，已有文件名保持原样', () => {
    const now = new Date(2026, 10, 3, 15, 20, 31)
    const [unnamed] = namePastedFiles([png('')], now)
    assert.equal(unnamed?.name, '粘贴附件-20261103-152031.png')

    const [blob] = namePastedFiles([png('blob')], now)
    assert.equal(blob?.name, '粘贴附件-20261103-152031.png')

    const named = png('shot.png')
    assert.equal(namePastedFiles([named], now)[0], named)

    const multiple = namePastedFiles([png(''), png('blob')], now)
    assert.deepEqual(
      multiple.map((file) => file.name),
      ['粘贴附件-20261103-152031-1.png', '粘贴附件-20261103-152031-2.png'],
    )
  })

  it('输入框和聊天区都接了粘贴附件，且纯文字粘贴放行', async () => {
    const pane = await readFile(path.join(root, 'src/ui/conversation-pane.tsx'), 'utf8')

    assert.match(pane, /onPaste=\{onComposerPaste\}/)
    assert.match(pane, /ref=\{composerRef\}/)
    assert.match(pane, /addEventListener\('paste', onWindowPaste\)/)
    assert.match(pane, /closest\('input, textarea, select, \[contenteditable="true"\], \[role="dialog"\]'\)/)

    // 先判断有没有文件，再 preventDefault，纯文字粘贴不受影响。
    assert.match(
      pane,
      /function onComposerPaste[\s\S]*?if \(files\.length === 0\) return\s*\n\s*event\.preventDefault\(\)[\s\S]*?enqueueUploads\(namePastedFiles\(files\)\)/,
    )
    assert.match(
      pane,
      /const files = filesFromClipboard\(event\.clipboardData\)\s*\n\s*if \(files\.length === 0\) return\s*\n\s*event\.preventDefault\(\)[\s\S]*?enqueueUploads\(namePastedFiles\(files\)\)/,
    )
  })

  it('切换模式、推理程度、模型时不清空输入框', async () => {
    const pane = await readFile(path.join(root, 'src/ui/conversation-pane.tsx'), 'utf8')
    const reset = pane.match(/只在换会话时清空草稿和消息[\s\S]*?\}, \[conversationId\]\)/)
    assert.ok(reset, '清空草稿的 effect 应该只依赖 conversationId')
    assert.match(reset[0], /setDraft\(''\)/)
    assert.doesNotMatch(reset[0], /chatMode|reasoningLevel|speakerModel/)

    const sync = pane.match(/setChatMode\(conversation\?\.chatMode[\s\S]*?\}, \[conversationId, conversation\?\.chatMode, conversation\?\.reasoningLevel\]\)/)
    assert.ok(sync, '模式和推理程度应单独同步，不跟草稿重置绑在一起')
    assert.doesNotMatch(sync[0], /setDraft\(''\)/)
  })
})
