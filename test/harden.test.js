import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { createPackage } from '@electron/asar'

import { hardenMainBundle } from '../dist/bytecode/harden.js'

async function fixture(extra = {}) {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'bastion-harden-'))
  const source = path.join(root, 'src')
  await fs.mkdir(path.join(source, 'out', 'main'), { recursive: true })
  await fs.writeFile(
    path.join(source, 'package.json'),
    JSON.stringify({ name: 'demo', version: '1.0.0', main: 'out/main/index.js' })
  )
  await fs.writeFile(path.join(source, 'out', 'main', 'index.js'), 'module.exports = {}\n')
  await fs.mkdir(path.join(root, 'app', 'resources'), { recursive: true })
  await createPackage(source, path.join(root, 'app', 'resources', 'app.asar'))
  const layout = {
    platform: 'linux',
    arch: 'x64',
    appRoot: path.join(root, 'app'),
    resourcesDir: path.join(root, 'app', 'resources'),
    asarPath: path.join(root, 'app', 'resources', 'app.asar'),
    unpackedDir: path.join(root, 'app', 'resources', 'app.asar.unpacked'),
    executablePath: path.join(root, 'app', 'Demo'),
    executableName: 'Demo',
    productName: 'Demo',
    version: '1.0.0',
    ...extra
  }
  return { root, layout, source }
}

test('已经加固过的产物拒绝二次加固', async () => {
  const { root, layout, source } = await fixture()
  try {
    await fs.writeFile(path.join(source, 'bastion-loader.cjs'), "'use strict'\n")
    await createPackage(source, layout.asarPath)
    await assert.rejects(
      () => hardenMainBundle({ layout, electronPath: '/nonexistent/electron' }),
      /已经加固过/
    )
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('ESM 应用使用 --exclude 直接拒绝', async () => {
  const { root, layout, source } = await fixture()
  try {
    await fs.writeFile(
      path.join(source, 'out', 'main', 'index.js'),
      "import { app } from 'electron'\nconsole.log(app)\n"
    )
    await fs.writeFile(
      path.join(source, 'package.json'),
      JSON.stringify({ name: 'demo', version: '1.0.0', type: 'module', main: 'out/main/index.js' })
    )
    await createPackage(source, layout.asarPath)
    await assert.rejects(
      () =>
        hardenMainBundle({
          layout,
          electronPath: '/nonexistent/electron',
          exclude: ['out/main/other.js']
        }),
      /不支持 --exclude/
    )
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})
