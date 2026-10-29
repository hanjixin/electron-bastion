import { promises as fs } from 'node:fs'
import path from 'node:path'

import { build } from 'esbuild'

import {
  compileBytecodeModule,
  readRuntimeInfo,
  verifyBytecodeLoads,
  writeBytecodeManifest,
  type BytecodeArtifact,
  type BytecodeManifest
} from './compiler.js'

export interface ProtectedModule {
  /** 相对 rootDir 或绝对路径的入口文件 */
  source: string
  /** 需要校验可调用的导出名，用于构建期自检 */
  exports: string[]
  /** 额外的 esbuild 外部依赖，默认把 electron 与原生模块视为外部 */
  external?: string[]
}

export interface BuildProtectedModulesOptions {
  rootDir: string
  modules: ProtectedModule[]
  outDir: string
  /** 目标 Electron 可执行文件；不传则用 process.execPath 编译（仅同版本可用） */
  electronPath: string
  /** 编译后删除中间 CommonJS 产物，避免明文回流 */
  keepIntermediate?: boolean
}

export interface ProtectedModuleResult {
  source: string
  artifact: BytecodeArtifact
  exports: string[]
}

export interface BuildProtectedModulesResult {
  manifestPath: string
  manifest: BytecodeManifest
  modules: ProtectedModuleResult[]
}

/**
 * 把 TS/ESM 模块打包成 CommonJS，再编译成 V8 字节码，最后删除明文中间产物。
 * 字节码与目标 Electron 的 V8 版本强绑定，必须使用目标 Electron 编译。
 */
export async function buildProtectedModules(
  options: BuildProtectedModulesOptions
): Promise<BuildProtectedModulesResult> {
  const outDir = path.resolve(options.outDir)
  await fs.mkdir(outDir, { recursive: true })
  const runtime = await readRuntimeInfo(options.electronPath)
  const results: ProtectedModuleResult[] = []

  for (const module of options.modules) {
    const source = path.resolve(options.rootDir, module.source)
    const base = path.basename(source).replace(/\.[cm]?[jt]s$/, '')
    const intermediate = path.join(outDir, `${base}.cjs`)
    await build({
      entryPoints: [source],
      outfile: intermediate,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node22',
      external: ['electron', ...(module.external ?? [])],
      sourcemap: false,
      logLevel: 'silent'
    })

    const artifact = await compileBytecodeModule({
      filename: intermediate,
      output: path.join(outDir, `${base}.jsc`),
      electronPath: options.electronPath
    })
    if (!options.keepIntermediate) await fs.rm(intermediate, { force: true })

    // 构建期自检：确认字节码能在目标 Electron 里加载，并导出预期成员
    const loaded = (await verifyBytecodeLoads({
      electronPath: options.electronPath,
      jscPath: artifact.output,
      cwd: options.rootDir
    })) as { exports?: string[] }
    const missing = module.exports.filter((name) => !(loaded.exports ?? []).includes(name))
    if (missing.length > 0) {
      throw new Error(
        `模块 ${module.source} 的字节码缺少导出：${missing.join(', ')}（实际 ${(loaded.exports ?? []).join(', ')}）`
      )
    }

    results.push({ source, artifact, exports: module.exports })
  }

  const manifest: BytecodeManifest = {
    schemaVersion: 1,
    runtime,
    modules: results.map((item) => ({
      source: path.relative(options.rootDir, item.source),
      output: path.relative(outDir, item.artifact.output),
      sourceSha256: item.artifact.sourceSha256,
      outputSha256: item.artifact.outputSha256,
      bytes: item.artifact.bytes,
      exports: item.exports
    }))
  }
  const manifestPath = await writeBytecodeManifest(outDir, manifest)
  return { manifestPath, manifest, modules: results }
}

export async function verifyProtectedModules(options: {
  rootDir: string
  outDir: string
  electronPath: string
}): Promise<{ ok: boolean; problems: string[] }> {
  const outDir = path.resolve(options.outDir)
  const problems: string[] = []
  let manifest: BytecodeManifest
  try {
    manifest = JSON.parse(
      await fs.readFile(path.join(outDir, 'bytecode-manifest.json'), 'utf8')
    ) as BytecodeManifest
  } catch {
    return { ok: false, problems: ['缺少 bytecode-manifest.json'] }
  }
  const runtime = await readRuntimeInfo(options.electronPath)
  for (const key of ['platform', 'arch', 'electron', 'v8'] as const) {
    if (manifest.runtime[key] !== runtime[key]) {
      problems.push(`运行时 ${key} 不一致：清单 ${manifest.runtime[key]} / 当前 ${runtime[key]}`)
    }
  }
  for (const module of manifest.modules) {
    const output = path.join(outDir, module.output)
    const plaintext = path.join(outDir, module.output.replace(/\.jsc$/, '.cjs'))
    try {
      await fs.access(plaintext)
      problems.push(`发现明文中间产物：${plaintext}`)
    } catch {
      // 预期不存在
    }
    try {
      const stat = await fs.stat(output)
      if (stat.size !== 0 && module.bytes === stat.size) continue
      problems.push(`字节码体积不符：${module.output}`)
    } catch {
      problems.push(`缺少字节码：${module.output}`)
    }
  }
  return { ok: problems.length === 0, problems }
}
