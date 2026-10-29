import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { tmpdir } from 'node:os'

import { createPackageWithOptions, extractAll } from '@electron/asar'
import { transform } from 'esbuild'

import type { AppLayout } from '../core/app-layout.js'
import { listAsarFiles, readAsarHeader } from '../core/asar-integrity.js'
import { readMacIntegrity, writeMacIntegrity } from '../core/mac-integrity.js'
import { writeIntegrityResource } from '../core/pe-resource.js'
import { compileBytecodeModule, readRuntimeInfo } from './compiler.js'

export interface HardenOptions {
  layout: AppLayout
  /** 目标 Electron 可执行文件，必须与产物运行时一致 */
  electronPath: string
  /** 除主入口依赖图外，额外编入字节码的文件（相对 app.asar 根） */
  include?: string[]
  /** 排除的文件（相对 app.asar 根） */
  exclude?: string[]
  /** 加密字节码文件（.enc），由 loader 在内存中解密后执行 */
  encrypt?: boolean
  /** 加密密钥文件路径；不传则随机生成并写入产物 */
  keyFile?: string
  dryRun?: boolean
}

export interface HardenReport {
  mainEntry: string
  mode: 'cjs' | 'esm-converted'
  compiled: string[]
  loader: string
  encrypted: boolean
  keyFile?: string
  preservedUnpacked: string[]
  skipped: string[]
}

const SCRIPT_EXT = /\.(?:c?js|mjs)$/i
const REQUIRE_PATTERN = /require\(\s*['"](\.[^'"]+)['"]\s*\)/g
const ESM_PATTERN = /(?:import|export)[^'"\n]*?from\s*['"](\.[^'"]+)['"]|import\(\s*['"](\.[^'"]+)['"]\s*\)/g
const LOADER_NAME = 'bastion-loader.cjs'
const RUNTIME_DIR = 'bastion/bytenode'

const LOADER_TEMPLATE_CJS = (entry: string) => `'use strict'
// bastion 生成的主进程加载器：注册字节码扩展后加载真实入口。
globalThis.__bastionImport = (specifier) => import(specifier)
require('./${RUNTIME_DIR}/index.cjs')
if (process.env.BASTION_DEBUG) {
  process.on('uncaughtException', (error) => console.error('[bastion] uncaughtException:', error))
  process.on('unhandledRejection', (error) => console.error('[bastion] unhandledRejection:', error))
  process.on('exit', (code) => { if (code !== 0) console.error('[bastion] process exit with code', code) })
  const electronApp = require('electron').app
  for (const name of ['exit', 'quit']) {
    const original = electronApp[name].bind(electronApp)
    electronApp[name] = (...args) => {
      console.error('[bastion] app.' + name + ' called:', JSON.stringify(args), new Error('stack').stack)
      return original(...args)
    }
  }
  const originalExit = process.exit.bind(process)
  process.exit = (code) => { console.error('[bastion] process.exit called:', code, new Error('stack').stack); return originalExit(code) }
}
try {
  require('./${entry.replace(/\\/g, '/').replace(/\.[cm]?js$/, '')}')
  if (process.env.BASTION_DEBUG) process.stdout.write('[bastion] 入口模块加载完成\n')
} catch (error) {
  process.stdout.write('[bastion] 入口加载失败: ' + (error && error.stack || error) + '\n')
  process.exit(2)
}
`

const LOADER_TEMPLATE_ENC = (entry: string) => `'use strict'
// bastion 生成的主进程加载器：内存解密 + 执行字节码，明文不落盘。
globalThis.__bastionImport = (specifier) => import(specifier)
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')

const createBytecodeRuntime = require('./${RUNTIME_DIR}/bytecode-runtime.cjs')
const compileCode = require('./${RUNTIME_DIR}/compiler.cjs')
const { generateScript } = createBytecodeRuntime(compileCode, false)

function loadKey() {
  const candidates = [
    process.resourcesPath ? path.join(process.resourcesPath, 'bastion.key') : null,
    path.join(__dirname, '..', '..', 'bastion.key')
  ].filter(Boolean)
  for (const candidate of candidates) {
    try {
      return Buffer.from(fs.readFileSync(candidate, 'utf8').trim(), 'base64')
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }
  throw new Error('bastion: 找不到解密密钥')
}

const key = loadKey()
if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('bastion: 密钥长度非法')

function decrypt(buffer) {
  if (buffer.length < 29) throw new Error('bastion: 密文损坏')
  const iv = buffer.subarray(0, 12)
  const tag = buffer.subarray(12, 28)
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(buffer.subarray(28)), decipher.final()])
}

Module._extensions['.enc'] = function loadEncryptedModule(fileModule, filename) {
  const script = generateScript(decrypt(fs.readFileSync(filename)), filename)
  function localRequire(id) {
    return fileModule.require(id)
  }
  localRequire.resolve = function (request, options) {
    return Module._resolveFilename(request, fileModule, false, options)
  }
  localRequire.extensions = Module._extensions
  localRequire.cache = Module._cache
  const wrapper = script.runInThisContext({ filename, displayErrors: true })
  return wrapper.apply(fileModule.exports, [
    fileModule.exports,
    localRequire,
    fileModule,
    filename,
    path.dirname(filename),
    process,
    global
  ])
}

require('./${entry.replace(/\\/g, '/').replace(/\.[cm]?js$/, '')}')
`

async function pathExists(target: string) {
  try {
    await fs.access(target)
    return true
  } catch {
    return false
  }
}

async function resolveRequire(fromFile: string, specifier: string): Promise<string | null> {
  const base = path.resolve(path.dirname(fromFile), specifier)
  const candidates = [
    base,
    `${base}.js`,
    `${base}.cjs`,
    `${base}.json`,
    `${base}.node`,
    path.join(base, 'index.js'),
    path.join(base, 'index.cjs')
  ]
  for (const candidate of candidates) {
    if (await pathExists(candidate)) {
      const stat = await fs.stat(candidate)
      if (stat.isFile()) return candidate
    }
  }
  return null
}

/** 从主入口出发，收集 ESM 依赖图里的脚本文件。 */
async function collectEsmGraph(entryFile: string): Promise<string[]> {
  const visited = new Set<string>()
  const queue = [entryFile]
  while (queue.length > 0) {
    const current = queue.shift() as string
    if (visited.has(current)) continue
    visited.add(current)
    if (!SCRIPT_EXT.test(current)) continue
    const source = await fs.readFile(current, 'utf8')
    for (const match of source.matchAll(ESM_PATTERN)) {
      const specifier = match[1] ?? match[2]
      if (!specifier) continue
      const resolved = await resolveRequire(current, specifier)
      if (resolved && !visited.has(resolved)) queue.push(resolved)
    }
  }
  return [...visited]
}

/**
 * 把构建产物里的 ESM 文件转成等价的 CommonJS，保留目录结构。
 * 只处理构建输出，不触碰源码。
 */
async function convertEsmToCjs(file: string, targetExt = 'jsc'): Promise<void> {
  const source = await fs.readFile(file, 'utf8')
  // 相对路径的动态 import 在 vm 中不可用，降级为 require；
  // 裸包名必须保留 import（ESM-only 依赖 require 不到），由加载器提供回调。
  const withRelativeImportsLowered = source.replace(
    /\bimport\(\s*(['"])(\.[^'"]*)\1\s*\)/g,
    (_m, quote: string, specifier: string) =>
      `Promise.resolve().then(() => require(${quote}${specifier}${quote}))`
  )
  // 其余动态 import（裸包名/计算路径）在 vm 内需要 --experimental-vm-modules，
  // 生产环境 Fuse 禁用 NODE_OPTIONS，改为调用加载器注入的宿主函数。
  const withHostImports = withRelativeImportsLowered.replace(/\bimport\s*\(/g, 'globalThis.__bastionImport(')
  // 用独立的中转变量，避免源码本身声明 __filename/__dirname 时产生自引用
  const META = { url: '__bastionMetaUrl', dirname: '__bastionMetaDirname', filename: '__bastionMetaFilename' }
  const rewritten =
    'const __bastionMetaFilename = __filename\n' +
    'const __bastionMetaDirname = __dirname\n' +
    "const __bastionMetaUrl = require('node:url').pathToFileURL(__filename).href\n" +
    withHostImports
      .replace(/\bimport\.meta\.url\b/g, META.url)
      .replace(/\bimport\.meta\.dirname\b/g, META.dirname)
      .replace(/\bimport\.meta\.filename\b/g, META.filename)
      // CommonJS 包装器已提供 __filename / __dirname，源码顶层的同名声明必须去掉，
      // 否则会与包装器形参重名而抛 "Identifier '__filename' has already been declared"
      .replace(/^(?:const|let|var)\s+__filename\s*=[^\n]*\n/gm, '')
      .replace(/^(?:const|let|var)\s+__dirname\s*=[^\n]*\n/gm, '')
  let code: string
  try {
    const result = await transform(rewritten, {
      loader: 'js',
      format: 'cjs',
      target: 'node22',
      sourcefile: file
    })
    code = result.code
  } catch (error) {
    throw new Error(
      `ESM→CJS 转换失败（${path.basename(file)}）：${(error as Error).message}。` +
        `顶层 await 无法转换，需要把该模块单独保留为明文或改造。`
    )
  }
  // 编译后扩展名会变成 .jsc，import 说明符必须同步改写，否则运行时解析不到
  code = code.replace(
    /require\((['"])(\.[^'"]*?)\.(?:c|m)?js\1\)/g,
    (_match, quote: string, specifier: string) => `require(${quote}${specifier}.${targetExt}${quote})`
  )
  await fs.writeFile(file, code, 'utf8')
}

/** 已打包的 CommonJS 文件里，显式 .js 说明符要跟着扩展名一起改。 */
async function rewriteCjsSpecifiers(file: string, targetExt: string): Promise<void> {
  const source = await fs.readFile(file, 'utf8')
  if (!source.includes("require('.") && !source.includes('require(".')) return
  const code = source.replace(
    /require\((['"])(\.[^'"]*?)\.(?:c|m)?js\1\)/g,
    (_match, quote: string, specifier: string) => `require(${quote}${specifier}.${targetExt}${quote})`
  )
  if (code !== source) await fs.writeFile(file, code, 'utf8')
}

const ENC_EXT = '.enc'

/** 从产物本身读出 Electron 版本，避免用错编译器产出被 V8 拒绝的字节码。 */
async function readTargetElectronVersion(layout: AppLayout): Promise<string | null> {
  try {
    if (layout.platform === 'darwin') {
      const plistPath = path.join(
        layout.appRoot,
        'Frameworks',
        'Electron Framework.framework',
        'Versions',
        'A',
        'Resources',
        'Info.plist'
      )
      const plist = (await import('plist')).default
      const parsed = plist.parse(await fs.readFile(plistPath, 'utf8')) as Record<string, unknown>
      const version = parsed.CFBundleVersion ?? parsed.CFBundleShortVersionString
      return typeof version === 'string' ? version : null
    }
    const versionFile = path.join(layout.resourcesDir, '..', 'version')
    const raw = (await fs.readFile(versionFile, 'utf8')).trim()
    return raw || null
  } catch {
    return null
  }
}
const encryptionDisabled = (options: HardenOptions) => !options.encrypt

function encryptBuffer(plain: Buffer, key: Buffer): Buffer {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const body = Buffer.concat([cipher.update(plain), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), body])
}

/** 从主入口出发，收集静态 require 依赖图里的脚本文件。 */
async function collectMainGraph(entryFile: string): Promise<string[]> {
  const visited = new Set<string>()
  const queue = [entryFile]
  while (queue.length > 0) {
    const current = queue.shift() as string
    if (visited.has(current)) continue
    visited.add(current)
    if (!SCRIPT_EXT.test(current)) continue
    const source = await fs.readFile(current, 'utf8')
    for (const match of source.matchAll(REQUIRE_PATTERN)) {
      const resolved = await resolveRequire(current, match[1])
      if (resolved && !visited.has(resolved)) queue.push(resolved)
    }
  }
  return [...visited]
}

/**
 * 复制 bytenode 运行时并改名为 .cjs。
 * 目标应用若声明 "type": "module"，.js 会被当成 ESM，里面的 require 全部失效。
 */
async function copyRuntime(runtimeTarget: string) {
  const source = path.dirname(createRequire(import.meta.url).resolve('bytenode'))
  await fs.mkdir(runtimeTarget, { recursive: true })
  for (const entry of await fs.readdir(source, { withFileTypes: true })) {
    if (!entry.isFile()) continue
    if (entry.name.endsWith('.d.ts')) continue
    const from = path.join(source, entry.name)
    const toName = entry.name.endsWith('.js') ? `${entry.name.slice(0, -3)}.cjs` : entry.name
    let content: Buffer | string = await fs.readFile(from)
    if (entry.name.endsWith('.js')) {
      let text = content
        .toString('utf8')
        .replace(/require\((['"])(\.[^'"]*?)\1\)/g, (_m, quote: string, spec: string) =>
          `require(${quote}${spec}.cjs${quote})`
        )
      if (entry.name === 'module-loader.js') {
        // vm 里执行字节码时必须显式提供 dynamic import 回调
        text = text.replace(
          'runInThisContext({',
          'runInThisContext({ importModuleDynamically: (specifier) => import(specifier),'
        )
        text = text.replace(
          'Module._extensions[extension] = function loadBytecodeModule (fileModule, filename) {',
          'Module._extensions[extension] = function loadBytecodeModule (fileModule, filename) {\n    if (process.env.BASTION_DEBUG) console.log("[bastion] load", filename)'
        )
        // 模块执行期异常也带上文件名，否则只剩一个无信息的退出码
        text = text.replace(
          'return compiledWrapper.apply(fileModule.exports, args);',
          "try {\n      return compiledWrapper.apply(fileModule.exports, args);\n    } catch (error) {\n      process.stdout.write(\"[bastion] module threw: \" + filename + \" \" + (error && error.stack || error) + String.fromCharCode(10));\n      throw error;\n    }"
        )
      }
      content = text
    }
    await fs.writeFile(path.join(runtimeTarget, toName), content)
  }
}

/**
 * 把已打包应用的主进程静态依赖图整体编译成 V8 字节码。
 * 前提：主进程必须是 CommonJS；ESM 输出会被拒绝。
 */
export async function hardenMainBundle(options: HardenOptions): Promise<HardenReport> {
  const { layout } = options
  if (layout.platform === 'linux' && !options.electronPath) {
    throw new Error('必须指定 --electron')
  }
  const beforeHeader = readAsarHeader(layout.asarPath)
  const beforeFiles = listAsarFiles(beforeHeader.header)
  const alreadyHardened = beforeFiles.find(
    (file) => file.path === LOADER_NAME || file.path.startsWith(`${RUNTIME_DIR}/`)
  )
  if (alreadyHardened) {
    throw new Error(
      `[bastion] 目标已经加固过（发现 ${alreadyHardened.path}），不能重复加固。` +
        `请从原始构建产物重新开始。`
    )
  }
  const unpackedBefore = beforeFiles
    .filter((file) => file.unpacked)
    .map((file) => file.path)

  const workspace = await fs.mkdtemp(path.join(tmpdir(), 'bastion-harden-'))
  try {
    await extractAll(layout.asarPath, workspace)
    const manifestPath = path.join(workspace, 'package.json')
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as {
      main?: string
      exports?: unknown
    }
    const mainEntry = manifest.main
    if (!mainEntry) throw new Error('app.asar 的 package.json 没有 main 字段')
    const entryFile = path.resolve(workspace, mainEntry)
    if (!(await pathExists(entryFile))) {
      throw new Error(`main 指向的入口不存在：${mainEntry}`)
    }
    const entrySource = await fs.readFile(entryFile, 'utf8')
    const isEsm = /^\s*(?:import|export)\s/m.test(entrySource)
    // 先做不依赖 Electron 的检查，避免用户等完版本探测才看到配置错误
    if (isEsm && (options.exclude?.length ?? 0) > 0) {
      throw new Error(
        '[bastion] ESM 应用不支持 --exclude：被排除的模块保持明文，但引用方仍会指向已编译产物，' +
          '运行时会找不到模块。请全量加固，或先改源码消除 ESM-only 依赖。'
      )
    }

    const targetElectron = await readTargetElectronVersion(layout)
    const compilerRuntime = await readRuntimeInfo(options.electronPath)
    if (targetElectron && compilerRuntime.electron !== targetElectron) {
      throw new Error(
        `编译用 Electron ${compilerRuntime.electron} 与目标产物 ${targetElectron} 不一致。` +
          `V8 字节码与版本强绑定，必须用目标 Electron 编译（如产物自带的那份）。`
      )
    }
    const graph = (isEsm ? await collectEsmGraph(entryFile) : await collectMainGraph(entryFile)).filter(
      (file) => SCRIPT_EXT.test(file)
    )
    const excluded = new Set((options.exclude ?? []).map((item) => path.resolve(workspace, item)))
    const extra = (options.include ?? []).map((item) => path.resolve(workspace, item))
    const targets = [...new Set([...graph, ...extra])].filter(
      (file) => !excluded.has(file) && !file.endsWith(LOADER_NAME)
    )

    const targetExt = options.encrypt ? 'enc' : 'jsc'
    const report: HardenReport = {
      mainEntry,
      compiled: [],
      mode: isEsm ? 'esm-converted' : 'cjs',
      loader: LOADER_NAME,
      encrypted: Boolean(options.encrypt),
      preservedUnpacked: unpackedBefore,
      skipped: []
    }

    if (options.dryRun) {
      report.compiled = targets.map((file) => path.relative(workspace, file))
      return report
    }

    if (isEsm) {
      for (const file of targets) await convertEsmToCjs(file, targetExt)
    } else if (options.encrypt) {
      for (const file of targets) await rewriteCjsSpecifiers(file, targetExt)
    }

    let encryptionKey: Buffer | undefined
    if (options.encrypt) {
      encryptionKey = options.keyFile
        ? Buffer.from((await fs.readFile(options.keyFile, 'utf8')).trim(), 'base64')
        : randomBytes(32)
      if (encryptionKey.length !== 32) {
        throw new Error('加密密钥必须是 32 字节（base64 编码）')
      }
    }

    for (const file of targets) {
      const relative = path.relative(workspace, file)
      const bytecode = file.replace(/\.(?:c?m?js)$/i, '.jsc')
      await compileBytecodeModule({
        filename: file,
        output: bytecode,
        electronPath: options.electronPath
      })
      await fs.rm(file)
      if (encryptionDisabled(options)) {
        report.compiled.push(`${relative} -> ${path.relative(workspace, bytecode)}`)
        continue
      }
      const encryptedPath = file.replace(/\.(?:c?m?js)$/i, ENC_EXT)
      await fs.writeFile(
        encryptedPath,
        encryptBuffer(await fs.readFile(bytecode), encryptionKey as Buffer)
      )
      await fs.rm(bytecode, { force: true })
      report.compiled.push(`${relative} -> ${path.relative(workspace, encryptedPath)}`)
    }

    await copyRuntime(path.join(workspace, RUNTIME_DIR))
    const keyTarget = path.join(layout.resourcesDir, 'bastion.key')
    if (options.encrypt) {
      await fs.writeFile(keyTarget, `${(encryptionKey as Buffer).toString('base64')}\n`, 'utf8')
      report.keyFile = keyTarget
    }
    await fs.writeFile(
      path.join(workspace, LOADER_NAME),
      options.encrypt ? LOADER_TEMPLATE_ENC(mainEntry) : LOADER_TEMPLATE_CJS(mainEntry),
      'utf8'
    )
    manifest.main = LOADER_NAME
    delete manifest.exports
    await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

    // asar 的 unpack 通配是拿绝对路径去 minimatch，必须带上工作目录
    const toGlob = (relative: string) =>
      path.join(workspace, relative).split(path.sep).join('/')
    const unpackPattern =
      unpackedBefore.length > 0 ? `{${unpackedBefore.map(toGlob).join(',')}}` : undefined
    await createPackageWithOptions(workspace, layout.asarPath, {
      unpack: unpackPattern,
      globOptions: { dot: true }
    })

    const afterHeader = readAsarHeader(layout.asarPath)
    const unpackedAfter = listAsarFiles(afterHeader.header)
      .filter((file) => file.unpacked)
      .map((file) => file.path)
    if (JSON.stringify([...unpackedAfter].sort()) !== JSON.stringify([...unpackedBefore].sort())) {
      throw new Error(
        `重打包后包外文件集合发生变化，已中止。前：${unpackedBefore.length} 个，后：${unpackedAfter.length} 个`
      )
    }

    await rewriteIntegrity(layout, afterHeader.headerHash)
    return report
  } finally {
    await fs.rm(workspace, { recursive: true, force: true })
  }
}

async function rewriteIntegrity(layout: AppLayout, headerHash: string) {
  if (layout.platform === 'win32') {
    const relative = path
      .relative(path.dirname(layout.executablePath), layout.asarPath)
      .replace(/\//g, '\\')
    await writeIntegrityResource(layout.executablePath, [
      { file: relative, alg: 'SHA256', value: headerHash }
    ])
    return
  }
  if (layout.platform === 'darwin') {
    const infoPlist = path.join(layout.resourcesDir, '..', 'Info.plist')
    const existing = (await readMacIntegrity(infoPlist)) ?? {}
    const key =
      Object.keys(existing).find((file) => file.toLowerCase().endsWith('app.asar')) ??
      'Resources/app.asar'
    await writeMacIntegrity(infoPlist, {
      ...existing,
      [key]: { algorithm: 'SHA256', hash: headerHash }
    })
  }
}

/** 校验加固后的归档里不再残留被编译文件的明文。 */
export async function findPlaintextScripts(asarPath: string): Promise<string[]> {
  const { header } = readAsarHeader(asarPath)
  return listAsarFiles(header)
    .filter((file) => SCRIPT_EXT.test(file.path))
    .map((file) => file.path)
    .filter((file) => file !== LOADER_NAME)
    .sort()
}
