import type { AppLayout } from '../core/app-layout.js'
import { loadWatermarkKey, readWatermark, verifyWatermarkSignature, writeWatermark } from '../core/watermark.js'

export interface WatermarkCommandOptions {
  buildId: string
  customer?: string
  keyFile?: string
  kid?: string
  verifyOnly?: boolean
}

export async function runWatermarkCommand(layout: AppLayout, options: WatermarkCommandOptions) {
  const key = await loadWatermarkKey({ keyFile: options.keyFile })

  if (options.verifyOnly) {
    const found = await readWatermark(layout)
    if (!found) return { ok: false, detail: '未找到水印' }
    const signatureOk = key ? verifyWatermarkSignature(found.watermark, key) : null
    return {
      ok: signatureOk !== false,
      detail: signatureOk === false ? 'HMAC 校验失败' : '水印存在',
      watermark: found.watermark,
      source: found.source,
      signatureOk
    }
  }

  const watermark = await writeWatermark(layout, {
    buildId: options.buildId,
    customer: options.customer,
    kid: options.kid,
    key
  })
  return {
    ok: true,
    detail: `已写入 buildId=${watermark.buildId}${watermark.sig ? '（已签名）' : '（未签名）'}`,
    watermark,
    signed: Boolean(watermark.sig)
  }
}
