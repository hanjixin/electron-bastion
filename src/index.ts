export { detectAppLayout, readBinaryArch } from './core/app-layout.js'
export type { AppLayout, DetectOptions, TargetPlatform } from './core/app-layout.js'
export { readFuses } from './core/fuses.js'
export type { FuseReport, FuseValue } from './core/fuses.js'
export {
  listAsarFiles,
  readAsarHeader,
  verifyAsarBlocks,
  type AsarHeaderEntry,
  type AsarHeaderInfo,
  type AsarHeaderNode,
  type AsarVerifyResult
} from './core/asar-integrity.js'
export {
  readIntegrityResource,
  readVersionStrings,
  writeIntegrityResource,
  writeVersionStrings,
  type IntegrityEntry
} from './core/pe-resource.js'
export {
  canonicalJson,
  loadWatermarkKey,
  parseWatermarkKey,
  PE_KEYS,
  readWatermark,
  signWatermark,
  verifyWatermarkSignature,
  WATERMARK_FILE,
  writeWatermark,
  type Watermark,
  type WatermarkOptions
} from './core/watermark.js'
export { defaultPolicy, mergePolicy, type PolicyFile, type VerifyPolicy } from './core/policy.js'
export { readMacIntegrity, writeMacIntegrity, type MacIntegrityMap, type MacIntegrityRecord } from './core/mac-integrity.js'
export { planProtectedBuild, resolveProtectionArgs, withoutFuseOverrides, type ProtectionPlan } from './builder/args.js'
export { runProtectedBuild, type BuildResult } from './commands/build.js'
export { HOOK_FILENAME, HOOK_TEMPLATE, initElectronBuilderPreset, YAML_SNIPPET, type InitResult } from './commands/init.js'
export {
  buildProtectedModules,
  verifyProtectedModules,
  type BuildProtectedModulesOptions,
  type BuildProtectedModulesResult,
  type ProtectedModule
} from './bytecode/pipeline.js'
export {
  compileBytecodeModule,
  readRuntimeInfo,
  verifyBytecodeLoads,
  writeBytecodeManifest,
  type BytecodeArtifact,
  type BytecodeManifest
} from './bytecode/compiler.js'
export { inspectApp, type InspectReport } from './commands/inspect.js'
export { verifyApp, type CheckResult, type VerifyResult } from './commands/verify.js'
export { smokeTamper, tamperAsarFile, type SmokeOptions, type SmokeResult } from './commands/smoke.js'
export { assertAppStarts, type StartupGateOptions, type StartupGateResult } from './commands/startup.js'
