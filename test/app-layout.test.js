import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { createPackage } from '@electron/asar'

import { detectAppLayout, readBinaryArch } from '../dist/core/app-layout.js'

function elfBuffer(machine = 0x3e) {
  const buffer = Buffer.alloc(64)
  buffer.write('\x7fELF', 0, 'latin1')
  buffer.writeUInt16LE(machine, 0x12)
  return buffer
}

async function buildLayout() {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'bastion-layout-'))
  const source = path.join(root, 'src')
  await fs.mkdir(source, { recursive: true })
  await fs.writeFile(
    path.join(source, 'package.json'),
    JSON.stringify({ name: 'demo', productName: 'Demo', version: '2.3.4' })
  )
  await fs.mkdir(path.join(root, 'app', 'resources'), { recursive: true })
  await createPackage(source, path.join(root, 'app', 'resources', 'app.asar'))
  const executable = path.join(root, 'app', 'Demo')
  await fs.writeFile(executable, elfBuffer())
  await fs.chmod(executable, 0o755)
  return { root, appDir: path.join(root, 'app') }
}

test('识别 Linux 解包目录、架构与产品信息', async () => {
  const { root, appDir } = await buildLayout()
  try {
    const layout = await detectAppLayout(appDir)
    assert.equal(layout.platform, 'linux')
    assert.equal(layout.arch, 'x64')
    assert.equal(layout.executableName, 'Demo')
    assert.equal(layout.productName, 'Demo')
    assert.equal(layout.version, '2.3.4')
    assert.ok(layout.asarPath.endsWith(path.join('resources', 'app.asar')))
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('传入可执行文件时按目录识别', async () => {
  const { root, appDir } = await buildLayout()
  try {
    const layout = await detectAppLayout(path.join(appDir, 'Demo'))
    assert.equal(layout.appRoot, appDir)
    assert.equal(layout.executableName, 'Demo')
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('缺少 app.asar 时给出明确错误', async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'bastion-empty-'))
  try {
    await assert.rejects(() => detectAppLayout(root), /找不到.*app\.asar/)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('可执行文件架构嗅探覆盖 PE 与 ELF', () => {
  const pe = Buffer.alloc(0x100)
  pe.write('MZ', 0, 'latin1')
  pe.writeUInt32LE(0x40, 0x3c)
  pe.writeUInt32LE(0x00004550, 0x40)
  pe.writeUInt16LE(0x8664, 0x44)
  assert.equal(readBinaryArch(pe), 'x64')

  const peArm = Buffer.from(pe)
  peArm.writeUInt16LE(0xaa64, 0x44)
  assert.equal(readBinaryArch(peArm), 'arm64')

  assert.equal(readBinaryArch(elfBuffer(0xb7)), 'arm64')
  assert.equal(readBinaryArch(elfBuffer(0x03)), 'ia32')
  assert.equal(readBinaryArch(Buffer.from('not a binary')), 'unknown')
})
