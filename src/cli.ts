#!/usr/bin/env node
import { parseArgs } from 'node:util'

import { detectAppLayout } from './core/app-layout.js'
import { defaultPolicy, mergePolicy, type PolicyFile } from './core/policy.js'
import { inspectApp } from './commands/inspect.js'
import { verifyApp } from './commands/verify.js'
import { runWatermarkCommand } from './commands/watermark.js'
import { smokeTamper } from './commands/smoke.js'
import { assertAppStarts } from './commands/startup.js'
import { runProtectedBuild } from './commands/build.js'
import { initElectronBuilderPreset } from './commands/init.js'
import { buildProtectedModules, verifyProtectedModules } from './bytecode/pipeline.js'
import { findPlaintextScripts, hardenMainBundle } from './bytecode/harden.js'

const HELP = `bastion —— 通用 Electron 发布保护工具

用法：
  bastion inspect   <path> [--json] [--trace] [--executable <name>]
  bastion verify    <path> [--policy <file>] [--require-watermark] [--key-file <file>] [--executable <name>]
  bastion watermark <path> --build-id <id> [--customer <name>] [--key-file <file>] [--kid <id>] [--executable <name>]
  bastion trace     <path> [--key-file <file>] [--executable <name>]
  bastion smoke     <path> [--timeout <ms>] [--args <a,b>] [--executable <name>]
  bastion startup   <path> [--timeout <ms>]      # 启动门禁：拿不到窗口即失败
  bastion build     [electron-builder 参数...]   # 透传并强制保护参数
  bastion init      [--dry-run]                  # 生成 electron-builder 接入文件
  bastion bytecode build <rootDir> --out <dir> --electron <path> --module <src>:<exp1,exp2> [...]
  bastion bytecode verify <rootDir> --out <dir> --electron <path>
  bastion bytecode harden <path> --electron <path> [--encrypt] [--key-file <file>] [--include <file>] [--exclude <file>] [--dry-run]

说明：
  path 可以是 win-unpacked / linux-unpacked 目录、可执行文件或 macOS .app。
  环境变量 BASTION_WATERMARK_KEY 可替代 --key-file（32 字节，hex 或 base64）。
`

function fail(message: string): never {
  console.error(`bastion: ${message}`)
  process.exit(2)
}

async function main() {
  const [command, ...rest] = process.argv.slice(2)
  if (!command || command === '--help' || command === '-h' || command === 'help') {
    console.log(HELP)
    return
  }

  const common = {
    executable: { type: 'string' as const },
    json: { type: 'boolean' as const }
  }

  switch (command) {
    case 'inspect':
    case 'trace': {
      const { values, positionals } = parseArgs({
        args: rest,
        options: { ...common, trace: { type: 'boolean' as const } },
        allowPositionals: true
      })
      const target = positionals[0] ?? fail('缺少目标路径')
      const layout = await detectAppLayout(target, { executable: values.executable })
      const report = await inspectApp(layout)
      console.log(JSON.stringify(report, null, 2))
      if (command === 'trace' && !report.watermark) {
        console.error('bastion: 未找到构建水印')
        process.exit(1)
      }
      return
    }

    case 'verify': {
      const { values, positionals } = parseArgs({
        args: rest,
        options: {
          ...common,
          policy: { type: 'string' as const },
          'require-watermark': { type: 'boolean' as const },
          'key-file': { type: 'string' as const },
          smoke: { type: 'boolean' as const }
        },
        allowPositionals: true
      })
      const target = positionals[0] ?? fail('缺少目标路径')
      const layout = await detectAppLayout(target, { executable: values.executable })
      let policy = defaultPolicy(layout.platform)
      if (values.policy) {
        const content = await import('node:fs/promises').then((fs) =>
          fs.readFile(values.policy as string, 'utf8')
        )
        policy = mergePolicy(policy, JSON.parse(content) as PolicyFile)
      }
      if (values['require-watermark']) policy.requireWatermark = true
      const key = values['key-file']
        ? await import('./core/watermark.js').then((module) =>
            module.loadWatermarkKey({ keyFile: values['key-file'] as string })
          )
        : undefined
      const result = await verifyApp(layout, policy, { watermarkKey: key })
      if (values.smoke) {
        const startup = await assertAppStarts(layout)
        result.checks.push({ name: 'startup', ok: startup.ok, detail: startup.detail })
        result.ok = result.ok && startup.ok
      }
      console.log(JSON.stringify(result, null, 2))
      if (!result.ok) process.exit(1)
      return
    }

    case 'watermark': {
      const { values, positionals } = parseArgs({
        args: rest,
        options: {
          ...common,
          'build-id': { type: 'string' as const },
          customer: { type: 'string' as const },
          'key-file': { type: 'string' as const },
          kid: { type: 'string' as const },
          verify: { type: 'boolean' as const }
        },
        allowPositionals: true
      })
      const target = positionals[0] ?? fail('缺少目标路径')
      const buildId = values['build-id'] ?? (values.verify ? 'unused' : fail('缺少 --build-id'))
      const layout = await detectAppLayout(target, { executable: values.executable })
      const result = await runWatermarkCommand(layout, {
        buildId,
        customer: values.customer,
        keyFile: values['key-file'],
        kid: values.kid,
        verifyOnly: values.verify
      })
      console.log(JSON.stringify(result, null, 2))
      if (!result.ok) process.exit(1)
      return
    }

    case 'startup': {
      const { values, positionals } = parseArgs({
        args: rest,
        options: { ...common, timeout: { type: 'string' as const } },
        allowPositionals: true
      })
      const target = positionals[0] ?? fail('缺少目标路径')
      const layout = await detectAppLayout(target, { executable: values.executable })
      const result = await assertAppStarts(layout, {
        timeoutMs: values.timeout ? Number(values.timeout) : undefined
      })
      console.log(JSON.stringify(result, null, 2))
      if (!result.ok) process.exit(1)
      return
    }

    case 'smoke': {
      const { values, positionals } = parseArgs({
        args: rest,
        options: {
          ...common,
          timeout: { type: 'string' as const },
          args: { type: 'string' as const },
          'keep-temp': { type: 'boolean' as const }
        },
        allowPositionals: true
      })
      const target = positionals[0] ?? fail('缺少目标路径')
      const layout = await detectAppLayout(target, { executable: values.executable })
      const result = await smokeTamper(layout, {
        timeoutMs: values.timeout ? Number(values.timeout) : undefined,
        args: values.args ? String(values.args).split(',') : undefined,
        keepTemp: values['keep-temp']
      })
      console.log(JSON.stringify(result, null, 2))
      if (!result.ok) process.exit(1)
      return
    }

    case 'build': {
      const result = await runProtectedBuild(rest)
      console.log(JSON.stringify(result.plan, null, 2))
      if (result.exitCode !== 0) process.exit(result.exitCode)
      return
    }

    case 'init': {
      const { values } = parseArgs({
        args: rest,
        options: { 'dry-run': { type: 'boolean' as const } },
        allowPositionals: true
      })
      const result = await initElectronBuilderPreset(process.cwd(), {
        dryRun: values['dry-run']
      })
      console.log(JSON.stringify(result, null, 2))
      return
    }

    case 'bytecode': {
      const [action, ...bytecodeArgs] = rest
      const { values, positionals } = parseArgs({
        args: bytecodeArgs,
        options: {
          out: { type: 'string' as const },
          electron: { type: 'string' as const },
          module: { type: 'string' as const, multiple: true },
          include: { type: 'string' as const, multiple: true },
          exclude: { type: 'string' as const, multiple: true },
          encrypt: { type: 'boolean' as const },
          'key-file': { type: 'string' as const },
          'dry-run': { type: 'boolean' as const },
          'verify-startup': { type: 'boolean' as const },
          'startup-timeout': { type: 'string' as const }
        },
        allowPositionals: true
      })
      if (action === 'harden') {
        const target = positionals[0] ?? fail('缺少目标路径')
        const electronPath = values.electron ?? fail('缺少 --electron')
        const layout = await detectAppLayout(target)
        const report = await hardenMainBundle({
          layout,
          electronPath,
          include: values.include as string[] | undefined,
          exclude: values.exclude as string[] | undefined,
          encrypt: values.encrypt,
          keyFile: values['key-file'],
          dryRun: values['dry-run'] as boolean | undefined
        })
        const remaining = await findPlaintextScripts(layout.asarPath)
        const reportOut = { ...report, remainingScripts: remaining } as Record<string, unknown>
        if (values['verify-startup'] !== false) {
          const startup = await assertAppStarts(layout, {
            timeoutMs: values['startup-timeout'] ? Number(values['startup-timeout']) : undefined
          })
          reportOut.startup = startup
          console.log(JSON.stringify(reportOut, null, 2))
          if (!startup.ok) {
            console.error(`bastion: 启动门禁失败 —— ${startup.detail}`)
            process.exit(1)
          }
          return
        }
        console.log(JSON.stringify(reportOut, null, 2))
        return
      }
      const rootDir = positionals[0] ?? fail('缺少项目根目录')
      const outDir = values.out ?? fail('缺少 --out')
      const electronPath = values.electron ?? fail('缺少 --electron')
      if (action === 'build') {
        const modules = (values.module ?? []).map((entry) => {
          const [source, exports] = entry.split(':')
          return { source, exports: (exports ?? '').split(',').filter(Boolean) }
        })
        if (modules.length === 0) fail('缺少 --module <源文件>:<导出名,导出名>')
        const result = await buildProtectedModules({ rootDir, outDir, electronPath, modules })
        console.log(JSON.stringify(result.manifest, null, 2))
        return
      }
      if (action === 'verify') {
        const result = await verifyProtectedModules({ rootDir, outDir, electronPath })
        console.log(JSON.stringify(result, null, 2))
        if (!result.ok) process.exit(1)
        return
      }
      fail(`未知 bytecode 子命令：${action}`)
      return
    }

    default:
      fail(`未知命令：${command}`)
  }
}

main().catch((error: unknown) => {
  console.error(`bastion: ${(error as Error).message}`)
  process.exit(2)
})
