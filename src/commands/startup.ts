import { execFileSync, spawn } from 'node:child_process'
import path from 'node:path'
import { createServer } from 'node:net'

import type { AppLayout } from '../core/app-layout.js'

export interface StartupGateOptions {
  timeoutMs?: number
  /** 进程存活但无页面的容忍时间，超过即判失败 */
  stallTimeoutMs?: number
  /** 额外启动参数 */
  args?: string[]
}

export interface StartupGateResult {
  ok: boolean
  detail: string
  elapsedMs: number | null
  pages: string[]
  exitCode: number | null
}

/** 统计系统中同名可执行文件的进程数，用于识别单例锁冲突。 */
export function countRunningInstances(executableName: string): number {
  try {
    if (process.platform === 'win32') {
      const output = execFileSync(
        'tasklist',
        ['/FI', `IMAGENAME eq ${executableName}.exe`, '/FO', 'CSV', '/NH'],
        { encoding: 'utf8' }
      )
      return output
        .split(/\r?\n/)
        .filter((line) => line.toLowerCase().includes(`${executableName.toLowerCase()}.exe`)).length
    }
    const output = execFileSync('ps', ['-axo', 'comm='], { encoding: 'utf8' })
    return output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && path.basename(line) === executableName).length
  } catch {
    return 0
  }
}

async function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(() => (port ? resolve(port) : reject(new Error('无法分配端口'))))
    })
  })
}

async function listPages(port: number, timeoutMs: number): Promise<string[]> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
      signal: controller.signal
    })
    if (!response.ok) return []
    const targets = (await response.json()) as Array<{ type?: string; url?: string }>
    return targets
      .filter((target) => target.type === 'page' && target.url && !target.url.startsWith('devtools://'))
      .map((target) => target.url as string)
  } catch {
    return []
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 启动门禁：用 CDP 探测应用是否真的创建了页面。
 * 只依赖 Electron 自带的 --remote-debugging-port，不需要应用配合。
 */
export async function assertAppStarts(
  layout: AppLayout,
  options: StartupGateOptions = {}
): Promise<StartupGateResult> {
  if (layout.platform !== process.platform) {
    return {
      ok: true,
      detail: `跳过：目标平台 ${layout.platform} 与当前 ${process.platform} 不同，无法在本机启动验证`,
      elapsedMs: null,
      pages: [],
      exitCode: null
    }
  }

  const running = countRunningInstances(layout.executableName)
  if (running > 0) {
    return {
      ok: false,
      detail:
        `检测到 ${running} 个同名进程正在运行（${layout.executableName}）。` +
        `应用通常使用单例锁，已运行的实例会阻止本次验证并可能弹出冲突对话框。请关闭后重试。`,
      elapsedMs: null,
      pages: [],
      exitCode: null
    }
  }

  const timeoutMs = options.timeoutMs ?? 60_000
  // 进程活着但一直没有页面，通常是单例锁被占用（另一个用同一 userData 的实例）。
  // 与其干等到超时，不如早点给出可操作提示。
  const stallTimeoutMs = options.stallTimeoutMs ?? 15_000
  const port = await pickFreePort()
  const startedAt = Date.now()
  const child = spawn(
    layout.executablePath,
    [
      `--remote-debugging-port=${port}`,
      ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
      ...(options.args ?? [])
    ],
    {
      cwd: layout.appRoot,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, NODE_OPTIONS: undefined },
      stdio: ['ignore', 'ignore', 'pipe']
    }
  )

  let stderr = ''
  child.stderr.on('data', (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-8 * 1024)
  })

  let exitCode: number | null = null
  child.once('exit', (code) => {
    exitCode = code
  })

  try {
    while (Date.now() - startedAt < timeoutMs) {
      if (exitCode !== null) {
        return {
          ok: false,
          detail: `应用启动后退出（code=${exitCode}）：${stderr.slice(-800) || '无输出'}`,
          elapsedMs: null,
          pages: [],
          exitCode
        }
      }
      const pages = await listPages(port, 1500)
      if (pages.length > 0) {
        return {
          ok: true,
          detail: `窗口就绪，页面数 ${pages.length}`,
          elapsedMs: Date.now() - startedAt,
          pages,
          exitCode: null
        }
      }
      if (Date.now() - startedAt > stallTimeoutMs) {
        return {
          ok: false,
          detail:
            `进程存活 ${stallTimeoutMs}ms 但未创建任何页面，最常见原因是已有实例占用同一 userData 的单例锁` +
            `（例如同名应用的开发版正在运行）。请关闭后重试。最近输出：${stderr.slice(-400) || '无'}`,
          elapsedMs: null,
          pages: [],
          exitCode
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 300))
    }
    return {
      ok: false,
      detail: `等待 ${timeoutMs}ms 未出现页面：${stderr.slice(-800) || '无输出'}`,
      elapsedMs: null,
      pages: [],
      exitCode
    }
  } finally {
    try {
      child.kill('SIGKILL')
    } catch {
      // 忽略
    }
  }
}
