import { promises as fs } from 'node:fs'
import path from 'node:path'

import { extractFile } from '@electron/asar'
import plist from 'plist'

export type TargetPlatform = 'win32' | 'linux' | 'darwin'

export interface AppLayout {
  platform: TargetPlatform
  arch: string
  /** 包含 resources/ 的目录；macOS 是 .app/Contents */
  appRoot: string
  resourcesDir: string
  asarPath: string
  unpackedDir: string
  executablePath: string
  executableName: string
  productName: string | null
  version: string | null
}

export interface DetectOptions {
  /** 显式指定可执行文件名，用于产物里存在多个候选的场景 */
  executable?: string
}

async function statOrNull(target: string) {
  try {
    return await fs.stat(target)
  } catch {
    return null
  }
}

function readPeArch(buffer: Buffer): string {
  if (buffer.length < 0x40) return 'unknown'
  const peOffset = buffer.readUInt32LE(0x3c)
  if (peOffset + 6 > buffer.length) return 'unknown'
  switch (buffer.readUInt16LE(peOffset + 4)) {
    case 0x8664:
      return 'x64'
    case 0xaa64:
      return 'arm64'
    case 0x14c:
      return 'ia32'
    default:
      return 'unknown'
  }
}

function readElfArch(buffer: Buffer): string {
  if (buffer.length < 0x14 || buffer.toString('latin1', 1, 4) !== 'ELF') return 'unknown'
  switch (buffer.readUInt16LE(0x12)) {
    case 0x3e:
      return 'x64'
    case 0xb7:
      return 'arm64'
    case 0x03:
      return 'ia32'
    default:
      return 'unknown'
  }
}

export function readBinaryArch(buffer: Buffer): string {
  if (buffer.length >= 2 && buffer[0] === 0x4d && buffer[1] === 0x5a) return readPeArch(buffer)
  return readElfArch(buffer)
}

function readAppInfo(asarPath: string): { productName: string | null; version: string | null } {
  try {
    const raw = extractFile(asarPath, 'package.json')
    const manifest = JSON.parse(raw.toString('utf8')) as {
      name?: string
      productName?: string
      version?: string
    }
    return { productName: manifest.productName ?? manifest.name ?? null, version: manifest.version ?? null }
  } catch {
    return { productName: null, version: null }
  }
}

async function pickWindowsExecutable(appRoot: string, productName: string | null, explicit?: string) {
  if (explicit) return path.join(appRoot, ensureExeSuffix(explicit))
  if (productName) {
    const preferred = path.join(appRoot, `${productName}.exe`)
    if (await statOrNull(preferred)) return preferred
  }
  const entries = await fs.readdir(appRoot, { withFileTypes: true })
  const candidates = entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.exe'))
    .map((entry) => entry.name)
    .filter((name) => !/uninstall|crash|report/i.test(name))
  if (candidates.length === 1) return path.join(appRoot, candidates[0])
  if (candidates.length === 0) throw new Error(`在 ${appRoot} 中找不到可执行文件（.exe）`)
  throw new Error(
    `在 ${appRoot} 中找到多个可执行文件：${candidates.join(', ')}；请用 --executable 指定`
  )
}

async function pickLinuxExecutable(appRoot: string, productName: string | null, explicit?: string) {
  if (explicit) {
    const target = path.join(appRoot, explicit)
    if (await statOrNull(target)) return target
    throw new Error(`指定的可执行文件不存在：${target}`)
  }
  const entries = await fs.readdir(appRoot, { withFileTypes: true })
  const candidates: string[] = []
  for (const entry of entries) {
    if (!entry.isFile()) continue
    const target = path.join(appRoot, entry.name)
    const stat = await fs.stat(target)
    if ((stat.mode & 0o111) === 0) continue
    const head = await fs.readFile(target).then((buffer) => buffer.subarray(0, 4))
    if (head.toString('latin1') === '\x7fELF') candidates.push(entry.name)
  }
  if (productName && candidates.includes(productName)) return path.join(appRoot, productName)
  // Linux 的 afterPack 常把真实二进制改名后放置 shell 启动器，优先选择 .bin
  const renamed = candidates.filter((name) => name.endsWith('.bin'))
  if (renamed.length === 1) return path.join(appRoot, renamed[0])
  if (candidates.length === 1) return path.join(appRoot, candidates[0])
  if (candidates.length === 0) throw new Error(`在 ${appRoot} 中找不到 ELF 可执行文件`)
  throw new Error(`在 ${appRoot} 中找到多个 ELF 可执行文件：${candidates.join(', ')}；请用 --executable 指定`)
}

function ensureExeSuffix(name: string): string {
  return name.toLowerCase().endsWith('.exe') ? name : `${name}.exe`
}

async function detectMac(appPath: string, options: DetectOptions): Promise<AppLayout> {
  const contents = path.join(appPath, 'Contents')
  const resourcesDir = path.join(contents, 'Resources')
  const asarPath = path.join(resourcesDir, 'app.asar')
  if (!(await statOrNull(asarPath))) {
    throw new Error(`找不到 ${asarPath}，目标不是打包后的 Electron 应用`)
  }
  const executableDir = path.join(contents, 'MacOS')
  const explicit = options.executable
  const entries = await fs.readdir(executableDir, { withFileTypes: true })
  const candidates = entries.filter((entry) => entry.isFile()).map((entry) => entry.name)
  const executableName = explicit ?? (candidates.length === 1 ? candidates[0] : null)
  if (!executableName) {
    throw new Error(`多个可执行文件：${candidates.join(', ')}；请用 --executable 指定`)
  }
  const info = await readMacAppInfo(contents, asarPath)
  const executablePath = path.join(executableDir, executableName)
  const head = await fs.readFile(executablePath)
  return {
    platform: 'darwin',
    arch: readMachOArch(head),
    appRoot: contents,
    resourcesDir,
    asarPath,
    unpackedDir: path.join(resourcesDir, 'app.asar.unpacked'),
    executablePath,
    executableName,
    ...info
  }
}

async function readMacAppInfo(
  contents: string,
  asarPath: string
): Promise<{ productName: string | null; version: string | null }> {
  try {
    const content = await fs.readFile(path.join(contents, 'Info.plist'), 'utf8')
    const parsed = plist.parse(content) as Record<string, unknown>
    const productName =
      typeof parsed.CFBundleDisplayName === 'string'
        ? parsed.CFBundleDisplayName
        : typeof parsed.CFBundleName === 'string'
          ? parsed.CFBundleName
          : null
    const version =
      typeof parsed.CFBundleShortVersionString === 'string'
        ? parsed.CFBundleShortVersionString
        : null
    if (productName || version) return { productName, version }
  } catch {
    // 落回 asar 内的 package.json
  }
  return readAppInfo(asarPath)
}

function readMachOArch(buffer: Buffer): string {
  if (buffer.length < 8) return 'unknown'
  const magic = buffer.readUInt32LE(0)
  if (magic === 0xcffaedfe || magic === 0xfeedfacf) {
    switch (buffer.readUInt32LE(4)) {
      case 0x01000007:
        return 'x64'
      case 0x0100000c:
        return 'arm64'
      default:
        return 'unknown'
    }
  }
  return 'unknown'
}

/**
 * 识破解包后的应用布局。输入可以是 win-unpacked / linux-unpacked 目录、
 * 可执行文件或 macOS .app。
 */
export async function detectAppLayout(
  input: string,
  options: DetectOptions = {}
): Promise<AppLayout> {
  const resolved = path.resolve(input)
  const stat = await statOrNull(resolved)
  if (!stat) throw new Error(`路径不存在：${resolved}`)

  if (stat.isFile()) {
    const dir = path.dirname(resolved)
    return detectAppLayout(dir, { ...options, executable: path.basename(resolved) })
  }

  if (resolved.endsWith('.app')) return detectMac(resolved, options)

  const resourcesDir = path.join(resolved, 'resources')
  const asarPath = path.join(resourcesDir, 'app.asar')
  if (!(await statOrNull(asarPath))) {
    // 传入的是 macOS .app 之外的目录时给出明确提示
    throw new Error(`找不到 ${asarPath}，目标不是解包后的 Electron 应用目录`)
  }
  const info = readAppInfo(asarPath)
  const entries = await fs.readdir(resolved, { withFileTypes: true })
  const hasExe = entries.some((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.exe'))
  const executablePath = hasExe
    ? await pickWindowsExecutable(resolved, info.productName, options.executable)
    : await pickLinuxExecutable(resolved, info.productName, options.executable)
  const head = await fs.readFile(executablePath)
  return {
    platform: hasExe ? 'win32' : 'linux',
    arch: readBinaryArch(head),
    appRoot: resolved,
    resourcesDir,
    asarPath,
    unpackedDir: path.join(resourcesDir, 'app.asar.unpacked'),
    executablePath,
    executableName: path.basename(executablePath),
    ...info
  }
}
