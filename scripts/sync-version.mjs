import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, '..')

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'))
}

function writeJson(filePath, value) {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

const rootPackagePath = path.join(rootDir, 'package.json')
const rootLockPath = path.join(rootDir, 'package-lock.json')
const serverPackagePath = path.join(rootDir, 'server', 'package.json')
const serverLockPath = path.join(rootDir, 'server', 'package-lock.json')

const rootPackage = readJson(rootPackagePath)
const version = String(rootPackage.version ?? '').trim()

if (!version) {
  throw new Error('根目录 package.json 缺少 version')
}

const rootLock = readJson(rootLockPath)
rootLock.version = version
if (rootLock.packages?.['']) {
  rootLock.packages[''].version = version
}
writeJson(rootLockPath, rootLock)

const serverPackage = readJson(serverPackagePath)
serverPackage.version = version
writeJson(serverPackagePath, serverPackage)

const serverLock = readJson(serverLockPath)
serverLock.version = version
if (serverLock.packages?.['']) {
  serverLock.packages[''].version = version
}
writeJson(serverLockPath, serverLock)

console.log(`已同步版本号 ${version}`)
