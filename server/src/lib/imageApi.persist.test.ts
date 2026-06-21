import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { writeOutputImage, type GeneratedImageResult } from './imageApi.js'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

function pngImage(byte: number): GeneratedImageResult {
  const buffer = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    byte, byte, byte, byte,
  ])
  return { buffer, mimeType: 'image/png' }
}

describe('writeOutputImage', () => {
  it('不同 fileId 会写入不同文件，避免并发覆盖', async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'output-image-'))
    tempDirs.push(outputDir)

    const first = await writeOutputImage(outputDir, '11111111-1111-4111-8111-111111111111', pngImage(1))
    const second = await writeOutputImage(outputDir, '22222222-2222-4222-8222-222222222222', pngImage(2))

    expect(first.fileName).not.toBe(second.fileName)
    expect(first.sha256).not.toBe(second.sha256)

    const files = await fs.readdir(outputDir)
    expect(files).toHaveLength(2)
  })
})