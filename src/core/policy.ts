import type { TargetPlatform } from './app-layout.js'
import type { FuseValue } from './fuses.js'

export interface VerifyPolicy {
  requireFuses: Record<string, Exclude<FuseValue, 'unknown'>>
  requireIntegrity: boolean
  asarBlockCheck: boolean
  /** 归档内不得出现的明文特征串（用于确认受保护模块没有回流） */
  forbidPlaintext: string[]
  requireWatermark: boolean
  /** 超过该体积的文件不做明文特征扫描，避免误伤大数据文件 */
  plaintextScanMaxBytes: number
}

export function defaultPolicy(platform: TargetPlatform): VerifyPolicy {
  const fuses: VerifyPolicy['requireFuses'] = {
    runAsNode: 'disabled',
    enableNodeOptionsEnvironmentVariable: 'disabled',
    enableNodeCliInspectArguments: 'disabled',
    onlyLoadAppFromAsar: 'enabled'
  }
  if (platform === 'win32' || platform === 'darwin') {
    fuses.enableEmbeddedAsarIntegrityValidation = 'enabled'
  }
  return {
    requireFuses: fuses,
    // Linux 不支持归档完整性校验，只能依赖 Fuses
    requireIntegrity: platform === 'win32' || platform === 'darwin',
    asarBlockCheck: true,
    forbidPlaintext: [],
    requireWatermark: false,
    plaintextScanMaxBytes: 32 * 1024 * 1024
  }
}

export interface PolicyFile extends Partial<VerifyPolicy> {
  schemaVersion?: number
}

export function mergePolicy(base: VerifyPolicy, overrides: PolicyFile): VerifyPolicy {
  return {
    ...base,
    ...overrides,
    requireFuses: { ...base.requireFuses, ...(overrides.requireFuses ?? {}) }
  }
}
