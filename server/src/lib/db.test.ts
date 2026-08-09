import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AppDatabase } from './db.js'

const tempFiles: string[] = []

afterEach(() => {
  for (const file of tempFiles.splice(0)) {
    try {
      fs.rmSync(file, { force: true })
      fs.rmSync(`${file}-wal`, { force: true })
      fs.rmSync(`${file}-shm`, { force: true })
    } catch {
      // 清理失败不影响断言结果
    }
  }
})

function createTestDb() {
  const file = path.join(os.tmpdir(), `gip-db-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
  tempFiles.push(file)
  return new AppDatabase(file)
}

function insertProvider(db: AppDatabase, id: string, name: string) {
  const now = new Date().toISOString()
  db.sqlite.prepare(`
    INSERT INTO provider_profiles (
      id, name, base_url, api_key_encrypted, model, api_mode, timeout_seconds,
      created_at, updated_at
    )
    VALUES (?, ?, 'http://localhost', 'enc', 'model', 'images', 60, ?, ?)
  `).run(id, name, now, now)
}

function seedDatabase() {
  const db = createTestDb()
  insertProvider(db, 'p1', '端点一')
  insertProvider(db, 'p2', '端点二')
  db.createUsageCode({ id: 'u1', codeHash: 'h1', codeEncrypted: 'c1', name: '码A', imageQuota: null })
  db.createUsageCode({ id: 'u2', codeHash: 'h2', codeEncrypted: 'c2', name: '码B', imageQuota: null })
  db.createUsageCode({ id: 'u3', codeHash: 'h3', codeEncrypted: 'c3', name: '码C', imageQuota: null })

  db.createTask({ id: 't1', prompt: '任务一', paramsJson: '{}', providerProfileId: 'p1', ownerUsageCodeId: 'u1', ownerKind: 'usage_code' })
  db.createTask({ id: 't2', prompt: '任务二', paramsJson: '{}', providerProfileId: 'p2', ownerUsageCodeId: 'u1', ownerKind: 'usage_code' })
  db.createTask({ id: 't3', prompt: '任务三', paramsJson: '{}', providerProfileId: 'p1', ownerUsageCodeId: 'u2', ownerKind: 'usage_code' })
  db.createTask({ id: 't4', prompt: '任务四', paramsJson: '{}', providerProfileId: 'p1', ownerUsageCodeId: null, ownerKind: 'admin' })

  db.addTaskImage({ id: 'o1', taskId: 't1', kind: 'output', filePath: 'o1.png', mimeType: 'image/png', width: 1024, height: 1024, bytes: 1, sha256: 'a' })
  db.addTaskImage({ id: 'o2', taskId: 't1', kind: 'output', filePath: 'o2.png', mimeType: 'image/png', width: 512, height: 512, bytes: 1, sha256: 'b' })
  db.addTaskImage({ id: 'i1', taskId: 't1', kind: 'input', filePath: 'i1.png', mimeType: 'image/png', width: 800, height: 600, bytes: 1, sha256: 'c' })
  db.addTaskImage({ id: 'o3', taskId: 't2', kind: 'output', filePath: 'o3.png', mimeType: 'image/png', width: 256, height: 256, bytes: 1, sha256: 'd' })
  db.addTaskImage({ id: 'v1', taskId: 't2', kind: 'video_output', filePath: 'v1.mp4', mimeType: 'video/mp4', width: null, height: null, bytes: 1, sha256: 'e' })
  db.addTaskImage({ id: 'o4', taskId: 't3', kind: 'output', filePath: 'o4.png', mimeType: 'image/png', width: 100, height: 100, bytes: 1, sha256: 'f' })
  db.addTaskImage({ id: 'o5', taskId: 't4', kind: 'output', filePath: 'o5.png', mimeType: 'image/png', width: 200, height: 200, bytes: 1, sha256: 'g' })
  return db
}

describe('AppDatabase 任务列表查询', () => {
  it('listTaskPage 的 owner 统计与逐行子查询语义一致', () => {
    const db = seedDatabase()
    const rows = db.listTaskPage({
      includeUsageCodeTasksForAdmin: true,
      status: 'all',
      taskType: 'all',
      favorite: false,
      archived: false,
      limit: 10,
      offset: 0,
    })
    expect(rows).toHaveLength(4)
    const t1 = rows.find((row) => row.id === 't1')!
    const t2 = rows.find((row) => row.id === 't2')!
    const t3 = rows.find((row) => row.id === 't3')!
    const t4 = rows.find((row) => row.id === 't4')!

    // owner u1 全量：2 个任务、3 张输出图、1 个视频
    expect(t1.ownerUsageCodeTaskCount).toBe(2)
    expect(t1.ownerUsageCodeOutputImageCount).toBe(3)
    expect(t1.ownerUsageCodeOutputVideoCount).toBe(1)
    // provider 维度：t1 在 p1 下有 2 张输出图、0 个视频
    expect(t1.ownerUsageCodeProviderOutputImageCount).toBe(2)
    expect(t1.ownerUsageCodeProviderOutputVideoCount).toBe(0)
    // t2 在 p2 下有 1 张输出图、1 个视频
    expect(t2.ownerUsageCodeOutputImageCount).toBe(3)
    expect(t2.ownerUsageCodeOutputVideoCount).toBe(1)
    expect(t2.ownerUsageCodeProviderOutputImageCount).toBe(1)
    expect(t2.ownerUsageCodeProviderOutputVideoCount).toBe(1)

    // owner u2：1 个任务、1 张输出图
    expect(t3.ownerUsageCodeTaskCount).toBe(1)
    expect(t3.ownerUsageCodeOutputImageCount).toBe(1)
    expect(t3.ownerUsageCodeOutputVideoCount).toBe(0)
    expect(t3.ownerUsageCodeProviderOutputImageCount).toBe(1)
    expect(t3.ownerUsageCodeProviderOutputVideoCount).toBe(0)

    // admin 任务无 owner 统计
    expect(t4.ownerUsageCodeTaskCount).toBe(0)
    expect(t4.ownerUsageCodeOutputImageCount).toBe(0)
    expect(t4.ownerUsageCodeOutputVideoCount).toBe(0)
    expect(t4.ownerUsageCodeProviderOutputImageCount).toBe(0)
    expect(t4.ownerUsageCodeProviderOutputVideoCount).toBe(0)

    // ownerLabel 归属文案
    expect(t1.ownerLabel).toBe('码A')
    expect(t4.ownerLabel).toBe('管理员')
  })

  it('listTaskPageByIds 返回完整字段且统计正确', () => {
    const db = seedDatabase()
    const rows = db.listTaskPageByIds(['t1', 't2', 't3'])
    expect(rows).toHaveLength(3)
    const t2 = rows.find((row) => row.id === 't2')!
    expect(t2.ownerUsageCodeOutputImageCount).toBe(3)
    expect(t2.ownerUsageCodeOutputVideoCount).toBe(1)
    expect(t2.ownerUsageCodeProviderOutputImageCount).toBe(1)
    expect(t2.ownerUsageCodeProviderOutputVideoCount).toBe(1)
    expect(t2.prompt).toBe('任务二')
    expect(t2.ownerUsageCodeCodeEncrypted).toBe('c1')
  })

  it('listTaskPageByIds 空数组返回空', () => {
    const db = seedDatabase()
    expect(db.listTaskPageByIds([])).toEqual([])
  })

  it('listTaskPageLight 返回搜索所需字段', () => {
    const db = seedDatabase()
    const rows = db.listTaskPageLight({
      includeUsageCodeTasksForAdmin: true,
      status: 'all',
      taskType: 'all',
      favorite: false,
      archived: false,
      limit: 10,
      offset: 0,
    })
    expect(rows).toHaveLength(4)
    const t1 = rows.find((row) => row.id === 't1')!
    expect(t1.prompt).toBe('任务一')
    expect(t1.ownerKind).toBe('usage_code')
    expect(t1.ownerLabel).toBe('码A')
    expect(t1.ownerUsageCodeCodeEncrypted).toBe('c1')
    expect(t1.taskType).toBe('image')
    expect(t1.paramsJson).toBe('{}')
    const t4 = rows.find((row) => row.id === 't4')!
    expect(t4.ownerUsageCodeCodeEncrypted).toBeNull()
    expect(t4.ownerLabel).toBe('管理员')
  })
})