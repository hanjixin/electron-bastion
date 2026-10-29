import { promises as fs } from 'node:fs'
import plist from 'plist'

export interface MacIntegrityRecord {
  algorithm: string
  hash: string
}

export type MacIntegrityMap = Record<string, MacIntegrityRecord>

/** 读取 macOS .app 的 Info.plist 中的 ElectronAsarIntegrity。 */
export async function readMacIntegrity(infoPlistPath: string): Promise<MacIntegrityMap | null> {
  const content = await fs.readFile(infoPlistPath, 'utf8')
  const parsed = plist.parse(content) as Record<string, unknown>
  const value = parsed.ElectronAsarIntegrity
  if (!value || typeof value !== 'object') return null
  const result: MacIntegrityMap = {}
  for (const [file, record] of Object.entries(value as Record<string, unknown>)) {
    if (record && typeof record === 'object') {
      const { algorithm, hash } = record as Record<string, unknown>
      if (typeof algorithm === 'string' && typeof hash === 'string') {
        result[file] = { algorithm, hash }
      }
    }
  }
  return Object.keys(result).length > 0 ? result : null
}

/** 写入 macOS 的 ElectronAsarIntegrity，用于 afterPack 修改过归档的场景。 */
export async function writeMacIntegrity(infoPlistPath: string, integrity: MacIntegrityMap): Promise<void> {
  const content = await fs.readFile(infoPlistPath, 'utf8')
  const parsed = plist.parse(content) as Record<string, unknown>
  parsed.ElectronAsarIntegrity = Object.fromEntries(
    Object.entries(integrity).map(([file, record]) => [
      file,
      { algorithm: record.algorithm, hash: record.hash }
    ])
  )
  await fs.writeFile(infoPlistPath, plist.build(parsed as plist.PlistValue), 'utf8')
}
