import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, '..')
const rootPackage = JSON.parse(readFileSync(path.join(rootDir, 'package.json'), 'utf8'))
const version = String(rootPackage.version ?? '').trim()

if (!version) {
  throw new Error('根目录 package.json 缺少 version')
}

const tagName = `v${version}`

try {
  execFileSync('git', ['rev-parse', '--verify', tagName], {
    cwd: rootDir,
    stdio: 'ignore',
  })
  throw new Error(`标签 ${tagName} 已存在`)
} catch (error) {
  if (!(error instanceof Error) || !error.message.includes('已存在')) {
    // rev-parse 失败表示标签不存在，继续执行。
  } else {
    throw error
  }
}

execFileSync('git', ['tag', '-a', tagName, '-m', tagName], {
  cwd: rootDir,
  stdio: 'inherit',
})

console.log(`已创建标签 ${tagName}`)
