import path from 'node:path'
import { createRequire } from 'node:module'

const REQUIRED_ASAR_FUSES = [
  'enableEmbeddedAsarIntegrityValidation',
  'onlyLoadAppFromAsar'
] as const

const WIN_MAC = new Set(['win32', 'darwin'])

export interface ProtectionPlan {
  args: string[]
  platforms: string[]
  fuseOverrides: Record<string, boolean | null>
}

/** 移除命令行里所有 --config.electronFuses 覆盖，避免与我们的注入顺序冲突。 */
export function withoutFuseOverrides(args: string[]): string[] {
  const result: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    const equals = argument.indexOf('=')
    const flag = equals < 0 ? argument : argument.slice(0, equals)
    if (!/^(-c|--config)\.electronFuses(?:\.|$)/.test(flag)) {
      result.push(argument)
      continue
    }
    if (equals < 0 && args[index + 1] && !args[index + 1].startsWith('-')) index += 1
  }
  return result
}

export function resolveProtectionArgs(
  args: string[],
  platformNames: string[],
  config: {
    asar?: boolean
    electronFuses?: Record<string, boolean | null | undefined>
    win?: { asar?: boolean }
    mac?: { asar?: boolean }
    linux?: { asar?: boolean }
  }
): ProtectionPlan {
  if (platformNames.length === 0) {
    throw new Error('[bastion] 无法从参数中确定目标平台，请显式传入 --win / --mac / --linux')
  }

  if (platformNames.includes('linux')) {
    if (platformNames.length !== 1) {
      throw new Error('[bastion] Linux 必须与 Windows/macOS 分开构建')
    }
    // Linux 的 afterPack 可能把真实二进制改成 shell 启动器，写入 Fuse 会定位到脚本。
    // 用空字符串让 electron-builder 的 AJV 归一化为 null，从而整体跳过 Fuse 写入。
    return {
      args: [...withoutFuseOverrides(args), '--config.electronFuses='],
      platforms: platformNames,
      fuseOverrides: {}
    }
  }

  const unsupported = platformNames.filter((name) => !WIN_MAC.has(name))
  if (unsupported.length > 0) {
    throw new Error(`[bastion] 不支持的目标平台：${unsupported.join(', ')}`)
  }

  if (config.asar === false) {
    throw new Error('[bastion] Windows/macOS 构建必须开启 asar')
  }
  for (const name of platformNames) {
    const section = (config as Record<string, { asar?: boolean } | undefined>)[name]
    if (section?.asar === false) {
      throw new Error(`[bastion] ${name} 配置中 asar 被显式关闭`)
    }
  }

  const fuses: Record<string, boolean> = {}
  for (const [name, value] of Object.entries(config.electronFuses ?? {})) {
    if (value != null) fuses[name] = value
  }
  for (const name of REQUIRED_ASAR_FUSES) {
    if (fuses[name] === false) {
      throw new Error(`[bastion] Windows/macOS 构建要求 electronFuses.${name}=true`)
    }
    fuses[name] = true
  }

  return {
    args: [
      ...withoutFuseOverrides(args),
      ...Object.entries(fuses).map(([name, value]) => `--config.electronFuses.${name}=${value}`)
    ],
    platforms: platformNames,
    fuseOverrides: fuses
  }
}

interface BuilderModule {
  createYargs: () => unknown
  configureBuildCommand: (yargs: unknown) => { parse: (args: string[]) => unknown }
  normalizeOptions: (options: unknown) => {
    targets: Map<{ nodeName: string }, Map<string, string[]>>
  }
}

interface PackagerLike {
  config: {
    asar?: boolean
    electronFuses?: Record<string, boolean | null | undefined>
    win?: { asar?: boolean }
    mac?: { asar?: boolean }
    linux?: { asar?: boolean }
  }
  validateConfig: () => Promise<void>
}

function loadBuilder(projectDir: string) {
  const projectRequire = createRequire(path.join(projectDir, 'package.json'))
  const builderRequire = createRequire(projectRequire.resolve('electron-builder/cli.js'))
  const builder = builderRequire('./out/builder.js') as BuilderModule
  const { Packager } = builderRequire('app-builder-lib') as {
    Packager: new (options: Record<string, unknown>) => PackagerLike
  }
  return { projectRequire, builder, Packager }
}

/**
 * 使用目标项目自身安装的 electron-builder 解析参数与配置，再注入保护相关覆盖。
 * 这样配置文件继承、CLI 优先级、自定义文件名等行为与真实打包完全一致。
 */
export async function planProtectedBuild(
  args: string[],
  projectDir: string
): Promise<ProtectionPlan & { electronBuilderPath: string }> {
  const { projectRequire, builder, Packager } = loadBuilder(projectDir)
  const parsed = builder.configureBuildCommand(builder.createYargs()).parse(args)
  const options = builder.normalizeOptions(parsed)
  // Mac App Store 目标不适用归档完整性校验，必须显式拒绝，避免产物被误认为普通 macOS 包
  for (const [platform, archToTypes] of options.targets) {
    if (platform.nodeName !== 'darwin') continue
    for (const targetNames of archToTypes.values()) {
      const masTarget = targetNames.find((name) =>
        ['mas', 'mas-dev'].includes(name.toLowerCase().trim())
      )
      if (masTarget) {
        throw new Error(`[bastion] 不支持 Mac App Store 目标（${masTarget}）`)
      }
    }
  }
  const platformNames = [...options.targets.keys()].map((platform) => platform.nodeName)
  const packager = new Packager({ projectDir, ...options })
  await packager.validateConfig()
  const plan = resolveProtectionArgs(args, platformNames, packager.config)
  return { ...plan, electronBuilderPath: projectRequire.resolve('electron-builder/cli.js') }
}
