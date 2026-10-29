import { spawn } from 'node:child_process'
import { constants, promises as fs } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'

import { getRawHeader } from '@electron/asar'

import type { AppLayout } from '../core/app-layout.js'

export interface SmokeOptions {
  /** 启动参数；默认只传 --noerrdialogs 这类无副作用参数 */
  args?: string[]
  timeoutMs?: number
  /** 保留临时目录，便于排查 */
  keepTemp?: boolean
}

export interface SmokeResult {
  ok: boolean
  exitCode: number | null
  detail: string
}

const INTEGRITY_FAILURE = /Integrity check failed|ASAR.{0,80}(integrity|hash).{0,80}(mismatch|failed|invalid)/i

/** 翻转归档内某个已打包文件的一个字节，制造可被完整性校验发现的最小篡改。 */
export async function tamperAsarFile(
  asarPath: string,
  entryName = 'package.json'
): Promise<void> {
  const { header, headerSize } = getRawHeader(asarPath)
  const entry = entryName
    .split('/')
    .reduce<Record<string, unknown> | undefined>(
      (node, part) => (node?.files as Record<string, Record<string, unknown>> | undefined)?.[part],
      header as unknown as Record<string, unknown>
    )
  const target = entry as
    | { unpacked?: boolean; link?: string; size?: number; offset?: string }
    | undefined
  if (!target || target.unpacked || target.link || !target.size) {
    throw new Error(`找不到可篡改的已打包文件：${entryName}`)
  }
  const offset = headerSize + 8 + Number(target.offset)
  const handle = await fs.open(asarPath, 'r+')
  try {
    const byte = Buffer.alloc(1)
    if ((await handle.read(byte, 0, 1, offset)).bytesRead !== 1) {
      throw new Error('篡改目标读取失败')
    }
    byte[0] ^= 1
    await handle.write(byte, 0, 1, offset)
  } finally {
    await handle.close()
  }
}

/**
 * 篡改冒烟：复制产物 → 改归档 → 启动 → 必须看到完整性错误并以失败退出。
 * 普通崩溃、启动失败、超时都不算通过。
 */
export async function smokeTamper(
  layout: AppLayout,
  options: SmokeOptions = {}
): Promise<SmokeResult> {
  const timeoutMs = options.timeoutMs ?? 30_000
  const root = await fs.mkdtemp(path.join(tmpdir(), 'bastion-smoke-'))
  // macOS 必须复制整个 .app 包，只复制 Contents 会让 Electron 找不到 Helper
  const bundleRoot = layout.platform === 'darwin' ? path.dirname(layout.appRoot) : layout.appRoot
  const copyDir = path.join(root, path.basename(bundleRoot))
  try {
    await fs.cp(bundleRoot, copyDir, {
      recursive: true,
      mode: constants.COPYFILE_FICLONE
    })
    const copiedAsar = path.join(copyDir, path.relative(bundleRoot, layout.asarPath))
    await tamperAsarFile(copiedAsar)
    const executable = path.join(copyDir, path.relative(bundleRoot, layout.executablePath))

    const child = spawn(executable, options.args ?? ['--noerrdialogs'], {
      cwd: copyDir,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, NODE_OPTIONS: undefined },
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true
    })

    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-64 * 1024)
    })

    let timer: NodeJS.Timeout | undefined
    try {
      const outcome = await Promise.race([
        new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
          child.once('error', reject)
          child.once('close', (code, signal) => resolve({ code, signal }))
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('篡改冒烟超时')), timeoutMs)
        })
      ])
      if (outcome.code === 0 && !outcome.signal) {
        return {
          ok: false,
          exitCode: outcome.code,
          detail: '篡改后的应用正常退出，完整性校验未生效'
        }
      }
      if (!INTEGRITY_FAILURE.test(stderr)) {
        return {
          ok: false,
          exitCode: outcome.code,
          detail: `未观察到完整性错误（code=${outcome.code}, signal=${outcome.signal}）：${stderr.slice(-500)}`
        }
      }
      return {
        ok: true,
        exitCode: outcome.code,
        detail: '篡改后以完整性错误退出',
      }
    } finally {
      clearTimeout(timer)
      if (child.exitCode === null) child.kill('SIGKILL')
    }
  } catch (error) {
    return { ok: false, exitCode: null, detail: (error as Error).message }
  } finally {
    if (!options.keepTemp) await fs.rm(root, { recursive: true, force: true })
  }
}
