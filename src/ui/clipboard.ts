/**
 * 聊天输入框粘贴附件：从剪贴板挑出文件，并给无名截图补一个可读文件名。
 * 纯文字粘贴不受影响——没有文件时调用方直接放行浏览器默认行为。
 */

type ClipboardItemLike = {
  kind: string
  getAsFile: () => File | null
}

type ClipboardLike = {
  files?: ArrayLike<File> | null
  items?: ArrayLike<ClipboardItemLike> | null
}

/** 优先用 files（Chrome/Safari 粘贴截图、Finder 复制文件都会填），再退回 items。 */
export function filesFromClipboard(clipboard: ClipboardLike | null | undefined): File[] {
  if (!clipboard) return []
  const direct = Array.from(clipboard.files ?? [])
  if (direct.length > 0) return direct
  const files: File[] = []
  for (const item of Array.from(clipboard.items ?? [])) {
    if (item.kind !== 'file') continue
    const file = item.getAsFile()
    if (file) files.push(file)
  }
  return files
}

/**
 * 截图粘贴常常没有文件名（或只有 blob / image）；按 MIME 补扩展名与时间戳。
 * 已有正常文件名的保持原对象，不重复包装。
 */
export function namePastedFiles(files: File[], now: Date = new Date()): File[] {
  return files.map((file, index) => {
    const name = (file.name ?? '').trim()
    if (hasUsableName(name)) return file
    const stem = name && name !== 'blob' && name !== 'image' ? name : '粘贴附件'
    const suffix = files.length > 1 ? `-${index + 1}` : ''
    const next = `${stem}-${pasteStamp(now)}${suffix}.${extensionForType(file.type)}`
    return new File([file], next, {
      type: file.type || 'application/octet-stream',
      lastModified: file.lastModified,
    })
  })
}

function hasUsableName(name: string): boolean {
  if (!name || name === 'blob') return false
  return /\.[a-z0-9]{1,8}$/i.test(name)
}

const EXT_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'application/pdf': 'pdf',
  'text/plain': 'txt',
  'text/markdown': 'md',
}

function extensionForType(type: string): string {
  const mime = (type || '').toLowerCase().split(';')[0]?.trim() ?? ''
  if (EXT_BY_MIME[mime]) return EXT_BY_MIME[mime]
  if (mime.startsWith('image/')) {
    const sub = mime.slice('image/'.length).replace(/[^a-z0-9]/g, '')
    return sub || 'png'
  }
  const sub = mime.split('/')[1]?.replace(/[^a-z0-9]/g, '')
  return sub || 'bin'
}

function pasteStamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}
