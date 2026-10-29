import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { createPackage } from '@electron/asar'

import {
  listAsarFiles,
  readAsarHeader,
  verifyAsarBlocks
} from '../dist/core/asar-integrity.js'
import { tamperAsarFile } from '../dist/commands/smoke.js'

async function buildFixture() {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'bastion-asar-'))
  const source = path.join(root, 'src')
  await fs.mkdir(path.join(source, 'out', 'main'), { recursive: true })
  await fs.writeFile(
    path.join(source, 'package.json'),
    JSON.stringify({ name: 'demo', version: '1.0.0', main: 'out/main/index.js' })
  )
  await fs.writeFile(path.join(source, 'out', 'main', 'index.js'), 'console.log("hello")\n')
  const asarPath = path.join(root, 'app.asar')
  await createPackage(source, asarPath)
  return { root, asarPath }
}

test('归档头哈希稳定，块级校验通过', async () => {
  const { root, asarPath } = await buildFixture()
  try {
    const first = readAsarHeader(asarPath)
    const second = readAsarHeader(asarPath)
    assert.equal(first.headerHash, second.headerHash)
    assert.match(first.headerHash, /^[a-f0-9]{64}$/)

    const files = listAsarFiles(first.header)
    assert.deepEqual(
      files.map((file) => file.path).sort(),
      ['out/main/index.js', 'package.json']
    )
    const result = await verifyAsarBlocks(asarPath, { expectedHeaderHash: first.headerHash })
    assert.equal(result.verifiedFiles, 2)
    assert.equal(result.unpackedFiles, 0)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('头哈希不匹配时校验失败', async () => {
  const { root, asarPath } = await buildFixture()
  try {
    await assert.rejects(
      () => verifyAsarBlocks(asarPath, { expectedHeaderHash: '0'.repeat(64) }),
      /header hash mismatch/
    )
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('篡改一个字节后块校验失败', async () => {
  const { root, asarPath } = await buildFixture()
  try {
    const { headerHash } = readAsarHeader(asarPath)
    await tamperAsarFile(asarPath, 'package.json')
    // 头哈希不变（只改了数据区），但文件块摘要必须失败
    await assert.rejects(
      () => verifyAsarBlocks(asarPath, { expectedHeaderHash: headerHash }),
      /ASAR (block|trailing block) integrity mismatch/
    )
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('篡改目标不存在时报错', async () => {
  const { root, asarPath } = await buildFixture()
  try {
    await assert.rejects(() => tamperAsarFile(asarPath, 'nope.json'), /找不到可篡改/)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})
