import { FuseState, FuseV1Options, getCurrentFuseWire } from '@electron/fuses'

export type FuseValue = 'enabled' | 'disabled' | 'removed' | 'inherit' | 'unknown'

export type FuseReport = Record<string, FuseValue>

const FUSE_NAMES: Record<number, string> = {
  [FuseV1Options.RunAsNode]: 'runAsNode',
  [FuseV1Options.EnableCookieEncryption]: 'enableCookieEncryption',
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: 'enableNodeOptionsEnvironmentVariable',
  [FuseV1Options.EnableNodeCliInspectArguments]: 'enableNodeCliInspectArguments',
  [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]:
    'enableEmbeddedAsarIntegrityValidation',
  [FuseV1Options.OnlyLoadAppFromAsar]: 'onlyLoadAppFromAsar',
  [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]: 'loadBrowserProcessSpecificV8Snapshot',
  [FuseV1Options.GrantFileProtocolExtraPrivileges]: 'grantFileProtocolExtraPrivileges'
}

function toValue(state: FuseState): FuseValue {
  switch (state) {
    case FuseState.ENABLE:
      return 'enabled'
    case FuseState.DISABLE:
      return 'disabled'
    case FuseState.REMOVED:
      return 'removed'
    case FuseState.INHERIT:
      return 'inherit'
    default:
      return 'unknown'
  }
}

export async function readFuses(executablePath: string): Promise<FuseReport> {
  const wire = await getCurrentFuseWire(executablePath)
  const report: FuseReport = {}
  for (const [key, state] of Object.entries(wire)) {
    if (key === 'version' || typeof state !== 'number') continue
    const name = FUSE_NAMES[Number(key)]
    if (!name) continue
    report[name] = toValue(state as FuseState)
  }
  return report
}
