/**
 * 浏览器侧的模块图不能碰服务端依赖。
 *
 * p1.4.1 的回归：任务页为了两个常量 import 了 app/mail-instructions，
 * 那个模块又 re-export mail-transport，于是 imapflow / nodemailer 被拖进
 * 开发时的页面模块图和 vite build，页面白屏、构建报 "Transform is not exported"。
 * 这里静态走一遍 src/ui 的 value import 图（type import 会被擦除，跳过），
 * 一旦可达 node: 内置模块或邮件库就失败。
 */

import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

const root = path.join(fileURLToPath(new URL('..', import.meta.url)))
const uiDir = path.join(root, 'src')

const SERVER_ONLY = /^(node:|imapflow$|nodemailer$|mailparser$)/
const IMPORT_RE = /(?:^|\n)\s*(?:import|export)\s+(?!type\b)[^;]*?\bfrom\s+['"]([^'"]+)['"]/g

async function listUiFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const files = await Promise.all(
    entries.map(async (entry) => {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) return listUiFiles(full)
      return /\.(ts|tsx)$/.test(entry.name) ? [full] : []
    }),
  )
  return files.flat()
}

function valueImports(source: string): string[] {
  const specifiers: string[] = []
  for (const match of source.matchAll(IMPORT_RE)) specifiers.push(match[1])
  // 副作用 import（import './styles.css'）没有 from。
  for (const match of source.matchAll(/(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g)) specifiers.push(match[1])
  return specifiers
}

/** 从每个 UI 模块出发，找第一条通往服务端依赖的链路。 */
async function findServerOnlyChain(): Promise<string[] | null> {
  const uiFiles = await listUiFiles(path.join(uiDir, 'ui'))
  const checked = new Set<string>()

  async function walk(file: string, chain: string[]): Promise<string[] | null> {
    if (checked.has(file)) return null
    checked.add(file)
    const source = await readFile(file, 'utf8')
    for (const specifier of valueImports(source)) {
      if (SERVER_ONLY.test(specifier)) return [...chain, file, specifier]
      if (!specifier.startsWith('.')) continue
      const target = path.resolve(path.dirname(file), specifier)
      if (!target.startsWith(uiDir + path.sep)) continue
      const found = await walk(target, [...chain, file])
      if (found) return found
    }
    return null
  }

  for (const file of uiFiles) {
    const chain = await walk(file, [])
    if (chain) return chain
  }
  return null
}

describe('p1.4.1 页面模块图只含浏览器能跑的代码', () => {
  it('src/ui 的可达模块不 import node: 内置模块或邮件服务端库', async () => {
    const chain = await findServerOnlyChain()
    assert.equal(
      chain,
      null,
      chain
        ? `页面会加载服务端依赖：${chain.map((item) => path.relative(root, item)).join(' -> ')}`
        : undefined,
    )
  })

  it('任务页的邮箱常量来自 domain/mail-constants，且该模块不 import 任何东西', async () => {
    const tasks = await readFile(path.join(uiDir, 'ui/tasks-page.tsx'), 'utf8')
    assert.match(tasks, /from '\.\.\/domain\/mail-constants\.ts'/)
    assert.doesNotMatch(tasks, /from '\.\.\/app\/mail-instructions\.ts'/)
    const constants = await readFile(path.join(uiDir, 'domain/mail-constants.ts'), 'utf8')
    assert.doesNotMatch(constants, /\bfrom\s+['"]/)
  })
})
