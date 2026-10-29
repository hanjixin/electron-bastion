import { promises as fs } from 'node:fs'
import path from 'node:path'

import { detectAppLayout } from '../core/app-layout.js'

export const HOOK_FILENAME = 'scripts/bastion-afterpack.mjs'

export const HOOK_TEMPLATE = `import { promises as fs } from 'node:fs'
import path from 'node:path'

import { detectAppLayout, loadWatermarkKey, writeWatermark } from 'electron-bastion'

/** electron-builder afterPack：写入构建水印。 */
export default async function bastionAfterPack(context) {
  const target = await resolveTarget(context.appOutDir)
  const layout = await detectAppLayout(target)
  const key = await loadWatermarkKey({})
  const buildId =
    process.env.BASTION_BUILD_ID ||
    \`\${layout.version ?? '0.0.0'}-\${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}\`
  const watermark = await writeWatermark(layout, {
    buildId,
    customer: process.env.BASTION_CUSTOMER,
    key
  })
  console.log(\`[bastion] watermark buildId=\${watermark.buildId} signed=\${Boolean(watermark.sig)}\`)
}

async function resolveTarget(appOutDir) {
  const entries = await fs.readdir(appOutDir, { withFileTypes: true })
  const bundle = entries.find((entry) => entry.isDirectory() && entry.name.endsWith('.app'))
  return bundle ? path.join(appOutDir, bundle.name) : appOutDir
}
`

export const YAML_SNIPPET = `# electron-builder.yml
asar: true
afterPack: scripts/bastion-afterpack.mjs
electronFuses:
  runAsNode: false
  enableNodeOptionsEnvironmentVariable: false
  enableNodeCliInspectArguments: false
  enableEmbeddedAsarIntegrityValidation: true
  onlyLoadAppFromAsar: true
`

export interface InitResult {
  created: string[]
  skipped: string[]
  yamlSnippet: string
}

export async function initElectronBuilderPreset(
  projectDir = process.cwd(),
  options: { dryRun?: boolean } = {}
): Promise<InitResult> {
  const created: string[] = []
  const skipped: string[] = []
  const hookPath = path.join(projectDir, HOOK_FILENAME)

  try {
    await fs.access(hookPath)
    skipped.push(hookPath)
  } catch {
    if (!options.dryRun) {
      await fs.mkdir(path.dirname(hookPath), { recursive: true })
      await fs.writeFile(hookPath, HOOK_TEMPLATE, 'utf8')
    }
    created.push(hookPath)
  }
  return { created, skipped, yamlSnippet: YAML_SNIPPET }
}
