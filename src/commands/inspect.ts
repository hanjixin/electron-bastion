import path from 'node:path'

import { promises as fs } from 'node:fs'

import type { AppLayout } from '../core/app-layout.js'
import { listAsarFiles, readAsarHeader } from '../core/asar-integrity.js'
import { readFuses } from '../core/fuses.js'
import { readMacIntegrity } from '../core/mac-integrity.js'
import { readIntegrityResource } from '../core/pe-resource.js'
import { readWatermark } from '../core/watermark.js'

async function directoryStats(target: string) {
  try {
    let files = 0
    let bytes = 0
    const walk = async (dir: string) => {
      const entries = await fs.readdir(dir, { withFileTypes: true })
      for (const entry of entries) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) await walk(full)
        else if (entry.isFile()) {
          files += 1
          bytes += (await fs.stat(full)).size
        }
      }
    }
    await walk(target)
    return { files, bytes }
  } catch {
    return null
  }
}

export interface InspectReport {
  target: {
    platform: string
    arch: string
    productName: string | null
    version: string | null
    executable: string
  }
  asar: {
    path: string
    headerHash: string
    fileCount: number
    unpackedCount: number
    totalBytes: number
    plaintextJs: Array<{ path: string; size: number }>
  }
  unpacked: { files: number; bytes: number } | null
  fuses: Record<string, string> | null
  integrity: { source: string; matchesHeader: boolean | null; detail: string }
  watermark: {
    buildId: string
    customer?: string
    createdAt: string
    source: string
  } | null
  signature: { peSecurityDirectory: boolean | null }
}

export async function inspectApp(layout: AppLayout): Promise<InspectReport> {
  const { header, headerHash } = readAsarHeader(layout.asarPath)
  const files = listAsarFiles(header)
  const plaintextJs = files
    .filter((file) => !file.unpacked && /\.(?:[cm]?js|ts)$/i.test(file.path))
    .map((file) => ({ path: file.path, size: file.size }))
    .sort((a, b) => b.size - a.size)

  let fuses: Record<string, string> | null = null
  try {
    fuses = await readFuses(layout.executablePath)
  } catch {
    fuses = null
  }

  let integrity: InspectReport['integrity'] = {
    source: layout.platform,
    matchesHeader: null,
    detail: '当前平台未实现完整性资源读取'
  }
  if (layout.platform === 'darwin') {
    try {
      const map = await readMacIntegrity(path.join(layout.resourcesDir, '..', 'Info.plist'))
      const record = map
        ? Object.entries(map).find(([file]) => file.toLowerCase().endsWith('app.asar'))
        : undefined
      integrity = record
        ? {
            source: 'plist',
            matchesHeader: record[1].hash.toLowerCase() === headerHash,
            detail: `记录 ${record[1].hash}，实际 ${headerHash}`
          }
        : { source: 'plist', matchesHeader: null, detail: 'Info.plist 中没有 ElectronAsarIntegrity' }
    } catch (error) {
      integrity = { source: 'plist', matchesHeader: null, detail: (error as Error).message }
    }
  }
  if (layout.platform === 'win32') {
    try {
      const entries = await readIntegrityResource(layout.executablePath)
      if (!entries) {
        integrity = { source: 'pe', matchesHeader: null, detail: '没有 INTEGRITY 资源' }
      } else {
        const record = entries.find((entry) => entry.file.toLowerCase().endsWith('app.asar'))
        integrity = {
          source: 'pe',
          matchesHeader: record ? record.value.toLowerCase() === headerHash : null,
          detail: record ? `记录 ${record.value}，实际 ${headerHash}` : '资源中没有 app.asar'
        }
      }
    } catch (error) {
      integrity = { source: 'pe', matchesHeader: null, detail: (error as Error).message }
    }
  }

  const watermark = await readWatermark(layout)

  let peSecurityDirectory: boolean | null = null
  if (layout.platform === 'win32') {
    peSecurityDirectory = await hasSecurityDirectory(layout.executablePath)
  }

  return {
    target: {
      platform: layout.platform,
      arch: layout.arch,
      productName: layout.productName,
      version: layout.version,
      executable: layout.executableName
    },
    asar: {
      path: layout.asarPath,
      headerHash,
      fileCount: files.length,
      unpackedCount: files.filter((file) => file.unpacked).length,
      totalBytes: files.reduce((sum, file) => sum + file.size, 0),
      plaintextJs: plaintextJs.slice(0, 50)
    },
    unpacked: await directoryStats(layout.unpackedDir),
    fuses,
    integrity,
    watermark: watermark
      ? {
          buildId: watermark.watermark.buildId,
          customer: watermark.watermark.customer,
          createdAt: watermark.watermark.createdAt,
          source: watermark.source
        }
      : null,
    signature: { peSecurityDirectory }
  }
}

/** 只判断 Authenticode 安全目录是否存在，不验证证书链。 */
async function hasSecurityDirectory(executablePath: string): Promise<boolean | null> {
  try {
    const buffer = await fs.readFile(executablePath)
    const peOffset = buffer.readUInt32LE(0x3c)
    const optionalHeaderOffset = peOffset + 24
    const magic = buffer.readUInt16LE(optionalHeaderOffset)
    // PE32+ 的数据目录起始偏移是 112，PE32 是 96；安全目录是第 5 项
    const dataDirectoryOffset =
      optionalHeaderOffset + (magic === 0x20b ? 112 : 96) + 4 * 8
    const virtualAddress = buffer.readUInt32LE(dataDirectoryOffset)
    const size = buffer.readUInt32LE(dataDirectoryOffset + 4)
    return virtualAddress !== 0 && size !== 0
  } catch {
    return null
  }
}
