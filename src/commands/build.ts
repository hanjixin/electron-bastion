import { spawn } from 'node:child_process'

import { planProtectedBuild } from '../builder/args.js'

export interface BuildResult {
  exitCode: number
  plan: { platforms: string[]; fuseOverrides: Record<string, boolean | null> }
}

export async function runProtectedBuild(
  args: string[],
  projectDir = process.cwd()
): Promise<BuildResult> {
  const plan = await planProtectedBuild(args, projectDir)
  const exitCode = await new Promise<number>((resolve, reject) => {
    const child = spawn(process.execPath, [plan.electronBuilderPath, ...plan.args], {
      cwd: projectDir,
      stdio: 'inherit'
    })
    child.on('close', (code) => resolve(code ?? 1))
    child.on('error', reject)
  })
  return {
    exitCode,
    plan: { platforms: plan.platforms, fuseOverrides: plan.fuseOverrides }
  }
}
