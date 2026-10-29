import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

import bytenode from 'bytenode'

export interface CompileBytecodeOptions {
  /** 待编译的 CommonJS 源文件 */
  filename: string
  /** 输出路径，默认把 .js/.cjs 换成 .jsc */
  output?: string
  /** 目标 Electron 可执行文件；跨版本字节码不兼容，必须与运行时一致 */
  electronPath?: string
  /** Electron 42+ 需要在 Electron 主进程内编译 */
  electronMain?: boolean
}

export interface BytecodeArtifact {
  source: string
  output: string
  sourceSha256: string
  outputSha256: string
  bytes: number
}

const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest('hex')

export async function compileBytecodeModule(
  options: CompileBytecodeOptions
): Promise<BytecodeArtifact> {
  const source = path.resolve(options.filename)
  const output = path.resolve(options.output ?? source.replace(/\.[cm]?js$/, '.jsc'))
  const sourceBuffer = await fs.readFile(source)
  await bytenode.compileFile({
    filename: source,
    output,
    compileAsModule: true,
    electron: Boolean(options.electronPath),
    electronPath: options.electronPath,
    electronMain: options.electronMain
  })
  const outputBuffer = await fs.readFile(output)
  if (outputBuffer.length === 0) {
    throw new Error(`字节码产物为空：${output}`)
  }
  return {
    source,
    output,
    sourceSha256: sha256(sourceBuffer),
    outputSha256: sha256(outputBuffer),
    bytes: outputBuffer.length
  }
}

/**
 * 用目标 Electron 的 Node 模式实际加载字节码并执行导出函数，
 * 确认 V8 版本与目标运行时一致。跨 OS/架构的字节码不能复用。
 */
export async function verifyBytecodeLoads(options: {
  electronPath: string
  jscPath: string
  /** 传入则调用该导出，不传只校验模块可加载并返回导出名列表 */
  exportName?: string
  args?: unknown[]
  cwd?: string
}): Promise<unknown> {
  const bytenodePath = createRequire(import.meta.url).resolve('bytenode')
  const script = `
    require(${JSON.stringify(bytenodePath)})
    const target = require(${JSON.stringify(path.resolve(options.jscPath))})
    const exportName = ${JSON.stringify(options.exportName ?? null)}
    if (exportName === null) {
      console.log('BASTION_BYTECODE_OK=' + JSON.stringify({ loaded: true, exports: Object.keys(target) }))
    } else {
      const fn = target[exportName]
      if (typeof fn !== 'function') {
        console.error('EXPORT_NOT_FUNCTION: ' + exportName)
        process.exit(3)
      }
      const value = fn(...${JSON.stringify(options.args ?? [])})
      console.log('BASTION_BYTECODE_OK=' + JSON.stringify(value))
    }
  `
  const { spawn } = await import('node:child_process')
  const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>(
    (resolve, reject) => {
      const child = spawn(options.electronPath, ['-e', script], {
        cwd: options.cwd ?? process.cwd(),
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '' }
      })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()))
      child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()))
      child.on('error', reject)
      child.on('close', (code) => resolve({ code, stdout, stderr }))
    }
  )
  if (result.code !== 0) {
    throw new Error(`字节码加载失败（code=${result.code}）：${result.stderr.slice(-800)}`)
  }
  const line = result.stdout.split(/\r?\n/).find((item) => item.startsWith('BASTION_BYTECODE_OK='))
  if (!line) throw new Error(`字节码加载未返回结果：${result.stdout.slice(-500)}`)
  return JSON.parse(line.slice('BASTION_BYTECODE_OK='.length))
}

export interface BytecodeManifest {
  schemaVersion: 1
  runtime: { platform: string; arch: string; electron: string; v8: string }
  modules: Array<{
    source: string
    output: string
    sourceSha256: string
    outputSha256: string
    bytes: number
    exports: string[]
  }>
}

export async function readRuntimeInfo(electronPath: string): Promise<BytecodeManifest['runtime']> {
  const { spawn } = await import('node:child_process')
  const output = await new Promise<string>((resolve, reject) => {
    const child = spawn(
      electronPath,
      ['-p', 'JSON.stringify({platform:process.platform,arch:process.arch,electron:process.versions.electron,v8:process.versions.v8})'],
      { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '' } }
    )
    let stdout = ''
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()))
    child.on('error', reject)
    child.on('close', () => resolve(stdout))
  })
  return JSON.parse(output.trim()) as BytecodeManifest['runtime']
}

export async function writeBytecodeManifest(
  targetDir: string,
  manifest: BytecodeManifest
): Promise<string> {
  const target = path.join(targetDir, 'bytecode-manifest.json')
  await fs.writeFile(target, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  return target
}
