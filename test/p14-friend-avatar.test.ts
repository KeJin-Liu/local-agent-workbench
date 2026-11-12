import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

const root = path.join(fileURLToPath(new URL('..', import.meta.url)))

describe('p1.4 好友头像上传回显', () => {
  it('编辑页的上传块回显已上传头像，并可点它换图', async () => {
    const friend = await readFile(path.join(root, 'src/ui/friend-panel.tsx'), 'utf8')

    assert.match(friend, /const uploadedAvatar = form\?\.avatar\.kind === 'upload' && form\.avatar\.path \? form\.avatar : null/)
    assert.match(friend, /avatar-opt-upload\$\{uploadedAvatar \? ' has-image is-selected' : ''\}/)
    assert.match(friend, /<img className="avatar-opt-img" src=\{uploadedAvatar\.path\}/)
    assert.match(friend, /更换头像/)
    assert.match(friend, /更换/)
    // 选同一张图也能重新触发上传
    assert.match(friend, /event\.target\.value = ''/)
  })

  it('上传块回显样式：图片铺满、圆角裁切、底部「更换」浮层', async () => {
    const css = await readFile(path.join(root, 'src/ui/styles.css'), 'utf8')
    assert.match(css, /\.avatar-opt-upload\.has-image/)
    assert.match(css, /\.avatar-opt-upload \.avatar-opt-img/)
    assert.match(css, /object-fit: cover/)
    assert.match(css, /\.avatar-opt-upload \.avatar-opt-change/)
  })
})
