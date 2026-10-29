import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'

import type { AppLayout } from './app-layout.js'
import { readVersionStrings, writeVersionStrings } from './pe-resource.js'

export interface Watermark {
  schemaVersion: 1
  buildId: string
  customer?: string
  appId?: string
  version?: string
  createdAt: string
  kid?: string
  files: Record<string, string>
  sig?: string
}

export interface WatermarkOptions {
  buildId: string
  customer?: string
  key?: Buffer
  kid?: string
  createdAt?: string
}

export const WATERMARK_FILE = 'bastion.json'
export const PE_KEYS = {
  buildId: 'BastionBuildId',
  customer: 'BastionCustomer',
  createdAt: 'BastionBuiltAt',
  kid: 'BastionKeyId',
  sig: 'BastionSignature'
} as const

export function canonicalJson(value: unknown): string {
  const normalize = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(normalize)
    if (input && typeof input === 'object') {
      return Object.fromEntries(
        Object.entries(input as Record<string, unknown>)
          .filter(([, item]) => item !== undefined)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, item]) => [key, normalize(item)])
      )
    }
    return input
  }
  return JSON.stringify(normalize(value))
}

export function signWatermark(watermark: Watermark, key: Buffer): string {
  const { sig: _ignored, ...rest } = watermark
  return `hmac-sha256:${createHmac('sha256', key).update(canonicalJson(rest)).digest('hex')}`
}

export function verifyWatermarkSignature(watermark: Watermark, key: Buffer): boolean {
  if (!watermark.sig) return false
  const expected = Buffer.from(signWatermark(watermark, key))
  const actual = Buffer.from(watermark.sig)
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}

export function parseWatermarkKey(raw: string, source = 'watermark key'): Buffer {
  const trimmed = raw.trim()
  const buffer = /^[0-9a-fA-F]{64}$/.test(trimmed)
    ? Buffer.from(trimmed, 'hex')
    : Buffer.from(trimmed, 'base64')
  if (buffer.length !== 32) {
    throw new Error(`${source} 必须是 32 字节：64 位十六进制或 base64 编码`)
  }
  return buffer
}

export async function loadWatermarkKey(options: {
  keyFile?: string
  env?: NodeJS.ProcessEnv
}): Promise<Buffer | undefined> {
  if (options.keyFile) {
    const content = await fs.readFile(options.keyFile, 'utf8')
    return parseWatermarkKey(content, options.keyFile)
  }
  const fromEnv = (options.env ?? process.env).BASTION_WATERMARK_KEY
  if (fromEnv) return parseWatermarkKey(fromEnv, 'BASTION_WATERMARK_KEY')
  return undefined
}

async function hashFile(target: string): Promise<string | null> {
  try {
    const content = await fs.readFile(target)
    return `sha256:${createHash('sha256').update(content).digest('hex')}`
  } catch {
    return null
  }
}

export async function writeWatermark(
  layout: AppLayout,
  options: WatermarkOptions
): Promise<Watermark> {
  const files: Record<string, string> = {}
  for (const [name, target] of [
    ['app.asar', layout.asarPath],
    [layout.executableName, layout.executablePath]
  ] as const) {
    const hash = await hashFile(target)
    if (hash) files[name] = hash
  }
  const watermark: Watermark = {
    schemaVersion: 1,
    buildId: options.buildId,
    customer: options.customer,
    appId: layout.productName ?? undefined,
    version: layout.version ?? undefined,
    createdAt: options.createdAt ?? new Date().toISOString(),
    kid: options.kid,
    files
  }
  if (options.key) watermark.sig = signWatermark(watermark, options.key)
  else delete watermark.sig

  const target = path.join(layout.resourcesDir, WATERMARK_FILE)
  await fs.writeFile(target, `${JSON.stringify(watermark, null, 2)}\n`, 'utf8')

  if (layout.platform === 'win32') {
    const values: Record<string, string> = {
      [PE_KEYS.buildId]: watermark.buildId,
      [PE_KEYS.createdAt]: watermark.createdAt
    }
    if (watermark.customer) values[PE_KEYS.customer] = watermark.customer
    if (watermark.kid) values[PE_KEYS.kid] = watermark.kid
    if (watermark.sig) values[PE_KEYS.sig] = watermark.sig
    await writeVersionStrings(layout.executablePath, values)
  }
  return watermark
}

export interface WatermarkReadResult {
  watermark: Watermark
  source: 'manifest' | 'pe'
}

export async function readWatermark(layout: AppLayout): Promise<WatermarkReadResult | null> {
  const manifestPath = path.join(layout.resourcesDir, WATERMARK_FILE)
  try {
    const content = await fs.readFile(manifestPath, 'utf8')
    const parsed = JSON.parse(content) as Watermark
    if (parsed?.schemaVersion === 1 && parsed.buildId) {
      return { watermark: parsed, source: 'manifest' }
    }
  } catch {
    // 落到 PE 资源
  }
  if (layout.platform !== 'win32') return null
  const strings = await readVersionStrings(layout.executablePath)
  const buildId = strings[PE_KEYS.buildId]
  if (!buildId) return null
  return {
    watermark: {
      schemaVersion: 1,
      buildId,
      customer: strings[PE_KEYS.customer] || undefined,
      createdAt: strings[PE_KEYS.createdAt] || '',
      kid: strings[PE_KEYS.kid] || undefined,
      files: {},
      sig: strings[PE_KEYS.sig] || undefined
    },
    source: 'pe'
  }
}
