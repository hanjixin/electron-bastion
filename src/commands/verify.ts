import { extractFile } from '@electron/asar'

import path from 'node:path'

import type { AppLayout } from '../core/app-layout.js'
import { listAsarFiles, readAsarHeader, verifyAsarBlocks } from '../core/asar-integrity.js'
import { readFuses } from '../core/fuses.js'
import { readMacIntegrity } from '../core/mac-integrity.js'
import { readIntegrityResource } from '../core/pe-resource.js'
import type { VerifyPolicy } from '../core/policy.js'
import { readWatermark, verifyWatermarkSignature } from '../core/watermark.js'

export interface CheckResult {
  name: string
  ok: boolean
  detail: string
}

export interface VerifyResult {
  ok: boolean
  checks: CheckResult[]
}

async function checkFuses(layout: AppLayout, policy: VerifyPolicy): Promise<CheckResult> {
  try {
    const fuses = await readFuses(layout.executablePath)
    const mismatches = Object.entries(policy.requireFuses)
      .filter(([name, expected]) => fuses[name] !== expected)
      .map(([name, expected]) => `${name}=${fuses[name] ?? 'missing'}（要求 ${expected}）`)
    return {
      name: 'fuses',
      ok: mismatches.length === 0,
      detail: mismatches.length === 0 ? JSON.stringify(fuses) : mismatches.join('; ')
    }
  } catch (error) {
    return { name: 'fuses', ok: false, detail: `读取 Fuse 失败：${(error as Error).message}` }
  }
}

async function checkIntegrity(layout: AppLayout, policy: VerifyPolicy): Promise<CheckResult> {
  if (!policy.requireIntegrity) {
    return { name: 'asar-integrity', ok: true, detail: '当前平台不要求归档完整性校验，已跳过' }
  }
  if (layout.platform === 'darwin') {
    try {
      const infoPlist = path.join(layout.resourcesDir, '..', 'Info.plist')
      const map = await readMacIntegrity(infoPlist)
      if (!map) {
        return { name: 'asar-integrity', ok: false, detail: 'Info.plist 中没有 ElectronAsarIntegrity' }
      }
      const { headerHash } = readAsarHeader(layout.asarPath)
      const record = Object.entries(map).find(([file]) => file.toLowerCase().endsWith('app.asar'))
      if (!record) {
        return {
          name: 'asar-integrity',
          ok: false,
          detail: `ElectronAsarIntegrity 中没有 app.asar：${Object.keys(map).join(', ')}`
        }
      }
      const ok = record[1].hash.toLowerCase() === headerHash
      return {
        name: 'asar-integrity',
        ok,
        detail: ok ? `header ${headerHash}` : `记录 ${record[1].hash} != 实际 ${headerHash}`
      }
    } catch (error) {
      return { name: 'asar-integrity', ok: false, detail: `校验失败：${(error as Error).message}` }
    }
  }
  if (layout.platform !== 'win32') {
    return {
      name: 'asar-integrity',
      ok: false,
      detail: `平台 ${layout.platform} 的完整性资源读取尚未实现`
    }
  }
  try {
    const entries = await readIntegrityResource(layout.executablePath)
    if (!entries) {
      return { name: 'asar-integrity', ok: false, detail: '可执行文件中没有 INTEGRITY 资源' }
    }
    const { headerHash } = readAsarHeader(layout.asarPath)
    const expectedFile = 'resources\\app.asar'
    const record = entries.find(
      (entry) =>
        entry.file.replace(/\//g, '\\').toLowerCase() === expectedFile ||
        entry.file.toLowerCase().endsWith('app.asar')
    )
    if (!record) {
      return {
        name: 'asar-integrity',
        ok: false,
        detail: `完整性资源中没有 app.asar 记录：${JSON.stringify(entries)}`
      }
    }
    const ok = record.value.toLowerCase() === headerHash
    return {
      name: 'asar-integrity',
      ok,
      detail: ok ? `header ${headerHash}` : `记录 ${record.value} != 实际 ${headerHash}`
    }
  } catch (error) {
    return {
      name: 'asar-integrity',
      ok: false,
      detail: `校验失败：${(error as Error).message}`
    }
  }
}

async function checkBlocks(layout: AppLayout, policy: VerifyPolicy): Promise<CheckResult> {
  if (!policy.asarBlockCheck) {
    return { name: 'asar-blocks', ok: true, detail: '已按策略跳过' }
  }
  try {
    const result = await verifyAsarBlocks(layout.asarPath)
    return {
      name: 'asar-blocks',
      ok: true,
      detail: `校验 ${result.verifiedFiles} 个文件，包外 ${result.unpackedFiles} 个未计入`
    }
  } catch (error) {
    return { name: 'asar-blocks', ok: false, detail: (error as Error).message }
  }
}

async function checkPlaintext(layout: AppLayout, policy: VerifyPolicy): Promise<CheckResult> {
  if (policy.forbidPlaintext.length === 0) {
    return { name: 'plaintext', ok: true, detail: '未配置禁止特征串，已跳过' }
  }
  const { header } = readAsarHeader(layout.asarPath)
  const candidates = listAsarFiles(header).filter(
    (file) =>
      !file.unpacked &&
      /\.(?:[cm]?js|ts)$/i.test(file.path) &&
      file.size <= policy.plaintextScanMaxBytes
  )
  const hits: string[] = []
  for (const file of candidates) {
    let content: Buffer
    try {
      content = extractFile(layout.asarPath, file.path)
    } catch {
      continue
    }
    const text = content.toString('utf8')
    for (const marker of policy.forbidPlaintext) {
      if (text.includes(marker)) {
        hits.push(`${file.path} 命中「${marker}」`)
        break
      }
    }
  }
  return {
    name: 'plaintext',
    ok: hits.length === 0,
    detail: hits.length === 0 ? `扫描 ${candidates.length} 个脚本，未发现明文特征` : hits.join('; ')
  }
}

async function checkWatermark(layout: AppLayout, policy: VerifyPolicy): Promise<CheckResult> {
  const found = await readWatermark(layout)
  if (!found) {
    return {
      name: 'watermark',
      ok: !policy.requireWatermark,
      detail: policy.requireWatermark ? '未找到构建水印' : '未找到构建水印（非强制）'
    }
  }
  return {
    name: 'watermark',
    ok: true,
    detail: `buildId=${found.watermark.buildId} customer=${found.watermark.customer ?? '-'} 来源=${found.source}`
  }
}

export async function verifyApp(
  layout: AppLayout,
  policy: VerifyPolicy,
  options: { watermarkKey?: Buffer } = {}
): Promise<VerifyResult> {
  const checks: CheckResult[] = []
  checks.push(await checkFuses(layout, policy))
  checks.push(await checkIntegrity(layout, policy))
  checks.push(await checkBlocks(layout, policy))
  checks.push(await checkPlaintext(layout, policy))
  const watermarkCheck = await checkWatermark(layout, policy)
  checks.push(watermarkCheck)

  if (options.watermarkKey) {
    const found = await readWatermark(layout)
    if (found) {
      const ok = verifyWatermarkSignature(found.watermark, options.watermarkKey)
      checks.push({
        name: 'watermark-signature',
        ok,
        detail: ok ? 'HMAC 校验通过' : 'HMAC 校验失败'
      })
    }
  }
  return { ok: checks.every((check) => check.ok), checks }
}
