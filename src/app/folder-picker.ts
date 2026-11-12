/**
 * p1.2：本机「选择文件夹」对话框。返回绝对路径。
 * 测试可注入 picker，或设环境变量 WORKBENCH_MOCK_FOLDER。
 */

import { spawn } from 'node:child_process'
import { access } from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import { AppError } from './errors.ts'
import { log } from '../logger.ts'

export type FolderPickerFn = () => Promise<string | null>

function whichOs(): 'darwin' | 'win32' | 'linux' | 'other' {
  if (process.platform === 'darwin') return 'darwin'
  if (process.platform === 'win32') return 'win32'
  if (process.platform === 'linux') return 'linux'
  return 'other'
}

function runCommand(command: string, args: string[], options: { timeoutMs?: number } = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new AppError(408, '选择文件夹超时。'))
    }, options.timeoutMs ?? 120_000)
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })
  })
}

async function commandExists(bin: string): Promise<boolean> {
  try {
    const result = await runCommand('sh', ['-c', `command -v ${bin}`], { timeoutMs: 5_000 })
    return result.code === 0 && result.stdout.trim().length > 0
  } catch {
    return false
  }
}

/** macOS 原生文件夹选择。 */
async function pickDarwin(): Promise<string | null> {
  const script =
    'try\n' +
    'set p to choose folder with prompt "选择工作目录"\n' +
    'return POSIX path of p\n' +
    'on error\n' +
    'return ""\n' +
    'end try'
  const result = await runCommand('osascript', ['-e', script])
  const path = result.stdout.trim().replace(/\/$/, '')
  return path || null
}

/** Windows PowerShell FolderBrowserDialog。 */
async function pickWindows(): Promise<string | null> {
  const ps = [
    'Add-Type -AssemblyName System.Windows.Forms;',
    '$d = New-Object System.Windows.Forms.FolderBrowserDialog;',
    '$d.Description = "选择工作目录";',
    'if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $d.SelectedPath }',
  ].join(' ')
  const result = await runCommand('powershell', ['-NoProfile', '-Command', ps])
  const path = result.stdout.trim()
  return path || null
}

/** Linux：优先 zenity，其次 kdialog。 */
async function pickLinux(): Promise<string | null> {
  if (await commandExists('zenity')) {
    const result = await runCommand('zenity', ['--file-selection', '--directory', '--title=选择工作目录'])
    if (result.code !== 0) return null
    const path = result.stdout.trim()
    return path || null
  }
  if (await commandExists('kdialog')) {
    const result = await runCommand('kdialog', ['--getexistingdirectory', `${process.env.HOME || '/'}`])
    if (result.code !== 0) return null
    const path = result.stdout.trim()
    return path || null
  }
  throw new AppError(501, '本机没有可用的目录选择器（需要 zenity 或 kdialog）。也可手动填写绝对路径。')
}

export async function nativePickFolder(): Promise<string | null> {
  const os = whichOs()
  if (os === 'darwin') return pickDarwin()
  if (os === 'win32') return pickWindows()
  if (os === 'linux') return pickLinux()
  throw new AppError(501, `当前平台 ${process.platform} 不支持系统选文件夹。`)
}

export type PickFolderOptions = {
  /** 测试注入；返回 null 表示用户取消。 */
  picker?: FolderPickerFn
}

/**
 * 打开本机目录选择器。
 * 优先：注入 picker → WORKBENCH_MOCK_FOLDER → 原生对话框。
 */
export async function pickFolder(options: PickFolderOptions = {}): Promise<{ path: string; cancelled?: false } | { path: null; cancelled: true }> {
  const mock = process.env.WORKBENCH_MOCK_FOLDER?.trim()
  const picker =
    options.picker ??
    (mock
      ? async () => mock
      : nativePickFolder)

  let selected: string | null
  try {
    selected = await picker()
  } catch (cause) {
    if (cause instanceof AppError) throw cause
    const message = cause instanceof Error ? cause.message : String(cause)
    log('warn', 'workspace', '选文件夹失败', { error: message })
    throw new AppError(500, `选文件夹失败：${message}`)
  }
  if (!selected?.trim()) return { path: null, cancelled: true }
  const absolute = selected.trim().replace(/\/$/, '') || selected.trim()
  try {
    await access(absolute, fsConstants.F_OK)
  } catch {
    // 允许尚未存在的路径仍返回（用户可选到空目录）；若不存在则仍回传，由绑定侧决定
    log('info', 'workspace', '选中路径当前不可访问，仍返回', { path: absolute })
  }
  log('info', 'workspace', '已选择工作目录', { path: absolute })
  return { path: absolute }
}
