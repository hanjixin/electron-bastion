import { promises as fs } from 'node:fs'
import path from 'node:path'

import { NtExecutable, NtExecutableResource, Resource } from 'resedit'

export interface IntegrityEntry {
  file: string
  alg: string
  value: string
}

const INTEGRITY_TYPE = 'INTEGRITY'
const INTEGRITY_ID = 'ELECTRONASAR'

async function loadExecutable(executablePath: string) {
  const buffer = await fs.readFile(executablePath)
  if (buffer.length < 2 || buffer[0] !== 0x4d || buffer[1] !== 0x5a) {
    throw new Error(`${executablePath} 不是 PE 可执行文件`)
  }
  const executable = NtExecutable.from(buffer)
  const resource = NtExecutableResource.from(executable)
  return { executable, resource }
}

async function saveExecutable(
  executablePath: string,
  executable: NtExecutable,
  resource: NtExecutableResource
) {
  resource.outputResource(executable)
  const temp = `${executablePath}.bastion.tmp`
  await fs.writeFile(temp, Buffer.from(executable.generate()))
  await fs.rename(temp, executablePath)
}

function normalizeResourceType(type: unknown): string {
  return typeof type === 'string' ? type.toUpperCase() : String(type).toUpperCase()
}

function readIntegrityEntries(resource: NtExecutableResource): IntegrityEntry[] | null {
  const entry = resource.entries.find(
    (item) =>
      normalizeResourceType(item.type) === INTEGRITY_TYPE &&
      String(item.id ?? '').toUpperCase() === INTEGRITY_ID
  )
  if (!entry?.bin) return null
  try {
    const parsed = JSON.parse(Buffer.from(entry.bin).toString('utf8'))
    return Array.isArray(parsed) ? (parsed as IntegrityEntry[]) : null
  } catch {
    return null
  }
}

export async function readIntegrityResource(
  executablePath: string
): Promise<IntegrityEntry[] | null> {
  const { resource } = await loadExecutable(executablePath)
  return readIntegrityEntries(resource)
}

/**
 * 覆写 PE 中的 INTEGRITY/ELECTRONASAR 资源。
 * afterPack 阶段修改过 app.asar 的项目必须调用，否则 Electron 启动即退出。
 */
export async function writeIntegrityResource(
  executablePath: string,
  entries: IntegrityEntry[]
): Promise<void> {
  const { executable, resource } = await loadExecutable(executablePath)
  const versionInfos = Resource.VersionInfo.fromEntries(resource.entries)
  if (versionInfos.length !== 1) {
    throw new Error(`无法解析 ${executablePath} 的版本信息`)
  }
  const languages = versionInfos[0].getAllLanguagesForStringValues()
  if (languages.length !== 1) {
    throw new Error(`无法定位 ${executablePath} 的版本语言`)
  }
  const payload = entries.map((entry) => ({
    file: path.win32.normalize(entry.file),
    alg: entry.alg,
    value: entry.value
  }))
  const existing = resource.entries.findIndex(
    (item) =>
      normalizeResourceType(item.type) === INTEGRITY_TYPE &&
      String(item.id ?? '').toUpperCase() === INTEGRITY_ID
  )
  const encoded = Buffer.from(JSON.stringify(payload))
  const bin = encoded.buffer.slice(
    encoded.byteOffset,
    encoded.byteOffset + encoded.byteLength
  ) as ArrayBuffer
  const next = {
    type: INTEGRITY_TYPE,
    id: INTEGRITY_ID,
    bin,
    lang: languages[0].lang,
    codepage: languages[0].codepage
  }
  if (existing >= 0) resource.entries[existing] = next
  else resource.entries.push(next)
  await saveExecutable(executablePath, executable, resource)
}

export async function readVersionStrings(executablePath: string): Promise<Record<string, string>> {
  const { resource } = await loadExecutable(executablePath)
  const versionInfos = Resource.VersionInfo.fromEntries(resource.entries)
  if (versionInfos.length === 0) return {}
  const languages = versionInfos[0].getAllLanguagesForStringValues()
  if (languages.length === 0) return {}
  return versionInfos[0].getStringValues(languages[0])
}

/**
 * 写入自定义版本信息字符串。用于水印：即使 app.asar 被整体替换，
 * 这些字段仍留在可执行文件里。
 */
export async function writeVersionStrings(
  executablePath: string,
  values: Record<string, string>
): Promise<void> {
  const { executable, resource } = await loadExecutable(executablePath)
  const versionInfos = Resource.VersionInfo.fromEntries(resource.entries)
  if (versionInfos.length !== 1) {
    throw new Error(`无法解析 ${executablePath} 的版本信息`)
  }
  const versionInfo = versionInfos[0]
  const languages = versionInfo.getAllLanguagesForStringValues()
  if (languages.length === 0) {
    throw new Error(`无法定位 ${executablePath} 的版本语言`)
  }
  for (const [key, value] of Object.entries(values)) {
    versionInfo.setStringValue(languages[0], key, value, true)
  }
  versionInfo.outputToResourceEntries(resource.entries)
  await saveExecutable(executablePath, executable, resource)
}
