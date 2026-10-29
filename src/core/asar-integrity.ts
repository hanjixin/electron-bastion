import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'

import { getRawHeader } from '@electron/asar'

export interface AsarHeaderInfo {
  headerHash: string
  headerSize: number
  header: AsarHeaderNode
}

export interface AsarHeaderNode {
  files: Record<string, AsarHeaderEntry>
}

export interface AsarHeaderEntry {
  files?: Record<string, AsarHeaderEntry>
  link?: string
  unpacked?: boolean
  size?: number
  offset?: string
  integrity?: { algorithm: string; hash: string; blockSize: number; blocks: string[] }
}

export interface AsarVerifyResult {
  verifiedFiles: number
  unpackedFiles: number
  totalBytes: number
}

const digest = (data: Buffer | string) => createHash('sha256').update(data).digest('hex')

export function readAsarHeader(asarPath: string): AsarHeaderInfo {
  const { header, headerString, headerSize } = getRawHeader(asarPath)
  return {
    headerHash: digest(headerString),
    headerSize,
    header: header as unknown as AsarHeaderNode
  }
}

export function listAsarFiles(header: AsarHeaderNode): Array<{
  path: string
  size: number
  unpacked: boolean
}> {
  const result: Array<{ path: string; size: number; unpacked: boolean }> = []
  function visit(directory: Record<string, AsarHeaderEntry>, prefix = '') {
    for (const [name, entry] of Object.entries(directory)) {
      const filePath = `${prefix}${name}`
      if (entry.files) {
        visit(entry.files, `${filePath}/`)
        continue
      }
      if (entry.link) continue
      result.push({ path: filePath, size: entry.size ?? 0, unpacked: entry.unpacked === true })
    }
  }
  visit(header.files)
  return result.sort((a, b) => b.size - a.size)
}

/**
 * 校验归档内每个文件的块级摘要。包外（unpacked）文件不计入保护范围，
 * 只做计数——避免把"看起来都在归档里"误判为"都被保护了"。
 */
export async function verifyAsarBlocks(
  asarPath: string,
  options: { expectedHeaderHash?: string } = {}
): Promise<AsarVerifyResult> {
  const { header, headerHash, headerSize } = readAsarHeader(asarPath)
  if (options.expectedHeaderHash && headerHash !== options.expectedHeaderHash) {
    throw new Error(
      `ASAR header hash mismatch: expected ${options.expectedHeaderHash}, got ${headerHash}`
    )
  }
  const handle = await fs.open(asarPath, 'r')
  let verifiedFiles = 0
  let unpackedFiles = 0
  let totalBytes = 0
  try {
    const archiveSize = (await handle.stat()).size
    async function visit(directory: Record<string, AsarHeaderEntry>, prefix = '') {
      for (const [name, entry] of Object.entries(directory)) {
        const filePath = `${prefix}${name}`
        if (entry.files) {
          await visit(entry.files, `${filePath}/`)
          continue
        }
        if (entry.link) continue
        if (entry.unpacked) {
          unpackedFiles += 1
          continue
        }
        const { integrity, size = 0 } = entry
        const offset = Number(entry.offset)
        if (
          !Number.isSafeInteger(size) ||
          size < 0 ||
          !Number.isSafeInteger(offset) ||
          offset < 0 ||
          headerSize + 8 + offset + size > archiveSize
        ) {
          throw new Error(`Invalid ASAR file bounds: ${filePath}`)
        }
        if (
          integrity?.algorithm !== 'SHA256' ||
          !/^[a-f0-9]{64}$/.test(integrity.hash) ||
          !Number.isSafeInteger(integrity.blockSize) ||
          integrity.blockSize < 1 ||
          integrity.blockSize > 16 * 1024 * 1024 ||
          !Array.isArray(integrity.blocks)
        ) {
          throw new Error(`Missing or invalid ASAR integrity metadata: ${filePath}`)
        }
        let blocks = 0
        for (let position = 0; position < size || (size === 0 && blocks === 0); ) {
          const length = Math.min(integrity.blockSize, size - position)
          const buffer = Buffer.alloc(length)
          let consumed = 0
          while (consumed < length) {
            const { bytesRead } = await handle.read(
              buffer,
              consumed,
              length - consumed,
              headerSize + 8 + offset + position + consumed
            )
            if (!bytesRead) throw new Error(`Truncated ASAR file: ${filePath}`)
            consumed += bytesRead
          }
          if (digest(buffer) !== integrity.blocks[blocks]) {
            throw new Error(`ASAR block integrity mismatch: ${filePath}`)
          }
          blocks += 1
          position += length
        }
        // 部分版本的 @electron/asar 会在末尾额外记录一个空块摘要
        for (const trailing of integrity.blocks.slice(blocks)) {
          if (trailing !== digest(Buffer.alloc(0))) {
            throw new Error(`ASAR trailing block integrity mismatch: ${filePath}`)
          }
        }
        verifiedFiles += 1
        totalBytes += size
      }
    }
    await visit(header.files)
  } finally {
    await handle.close()
  }
  return { verifiedFiles, unpackedFiles, totalBytes }
}
