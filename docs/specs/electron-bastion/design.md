# electron-bastion 设计文档：通用 Electron 发布保护工具包

- 状态：待评审
- 日期：2026-10-29（第二次修订）
- 基线：一个真实 Electron 生产应用（Electron 43，Windows/Linux）的既有保护分支
- 定位：独立 npm 包，提供 CLI 与库两种用法，适用于任意 Electron 项目

---

## 0. 修订说明

第二次修订：将基线分支中的**全部**保护能力通用化，不再保留"仓库内实现"的例外。

| 基线能力 | 本文档处置 |
|---|---|
| `verify-package-protection.mjs` | → `bastion verify`（CLI）+ `verifyApp()`（库） |
| `package-protection.mjs` | → `bastion build`（打包器守卫） |
| `bytecode-protection.mjs` + bytecode 构建配置 | → `bastion/bytecode` 插件与编译器 |
| `asar-tamper-smoke.mjs` | → `bastion smoke` |
| `run-win-unpacked-smoke.mjs` 的保护检查 | → `bastion smoke --app-smoke` |
| （无） | → `bastion watermark` / `bastion inspect`（新增） |

目标：任何 Electron 项目接入 bastion 后，不再需要自行编写保护脚本；目标仓库内脚本改为调用 bastion 的薄封装，原项目的保护相关测试保留为回归门禁。

## 1. 产品形态

一个包，六项能力，三个接入面：

```
接入面 ①  CLI        bastion verify | inspect | watermark | smoke | build | init
接入面 ②  electron-builder 集成   afterPack hook + 打包参数守卫
接入面 ③  库 API      verifyApp() / createBytecodePlugin() / watermark() / ...
```

核心模块不依赖 Electron 运行、不依赖 electron-builder，可在验收机上独立执行；只有 `builder` 适配层依赖 electron-builder。

## 2. 通用能力矩阵

| # | 能力 | 通用化方式 | 外部依赖 | 适用项目 |
|---|---|---|---|---|
| 1 | 产物体检 | `inspectApp(path)` | 无 | 任意 Electron 产物 |
| 2 | 完整性 / Fuse 校验 | `verifyApp(path, policy)` | 无 | 任意 Electron 产物 |
| 3 | 篡改冒烟 | `smokeTamper(path)` | 无（需目标平台运行权限） | 任意 Electron 产物 |
| 4 | 构建水印 | `watermark(path, options)` | 无 | 任意 Electron 产物 |
| 5 | 打包器守卫 | `resolveProtectionArgs()` | electron-builder | 使用 electron-builder 的项目 |
| 6 | 字节码保护 | `createBytecodePlugin()` / `compileBytecodeModule()` | electron-vite 或 esbuild | 使用 CJS 子构建的项目 |

能力 1–4 是构建系统无关的，这是"通用"的实质：换一个项目、换一套打包工具，这四项照常可用。

## 3. 能力边界

| 能力 | 本包 | 说明 |
|---|---|---|
| 通用产物体检与门禁 | ✅ | 任意 Electron 产物 |
| 构建水印与泄漏追溯 | ✅ | |
| 多模块 V8 字节码 | ✅ | 仅 CJS 输出；ESM 主进程走桥接模式 |
| 打包参数按平台强制 | ✅ | electron-builder |
| ASAR 加密 + 自定义加载器 | ❌ | 见 §5 |
| 运行期反调试 / 内存保护 | ❌ | 见 §12 |
| 渲染进程 bundle 加密 | ❌ | Chromium 需要可读资源 |

## 4. 已验证的技术事实

1. `electron-builder@26.15.3` 顺序：`copyAppFiles → computeData（算 asar 头哈希）→ 写 INTEGRITY 资源 → copyFiles → afterPack → sanityCheck → 翻 Fuses → 签名`（`out/platformPackager.js:222-264`）。
2. Windows 完整性资源：`resedit` 写入 `type: "INTEGRITY"`、`id: "ELECTRONASAR"`，内容 `[{file, alg, value}]`（`out/electron/electronWin.js`）。
3. macOS：写入 `Info.plist` 的 `ElectronAsarIntegrity`。
4. 在 afterPack 中修改 `app.asar` 必须重算并覆写完整性资源，否则启动即退出。
5. 目标应用 主进程为 ESM（`"type": "module"`），字节码必须以独立 CJS 子构建 + `createRequire` 桥接接入。
6. Linux 不支持 `EnableEmbeddedAsarIntegrityValidation`；且 Linux 的 `afterPack` 会把原生可执行文件改名并写入 shell 启动器，builder 随后写入 Fuse 会定位到脚本上——基线通过整体清空 Fuse 配置规避。

## 5. ASAR 加密与加载器（已实现，边界如下）

初版曾以"主进程是 ESM，解密加载器只能走 CJS"为由砍掉该能力。该前提在实现 ESM→CJS 产物转换后已不成立，因此补齐：

- `bastion bytecode harden --encrypt` 把编译后的 `.jsc` 用 AES-256-GCM 加密为 `.enc`，并删除字节码文件；
- 加载器在内存中解密（`generateScript` 直接吃 Buffer），**明文不落盘**；
- 密钥生成后写入 `<resources>/bastion.key`（base64）。

**它买到了什么**：`strings` / `grep` 在磁盘上再也读不到字符串常量——这是纯字节码方案的已知泄露点。

**它没买到什么**：密钥与密文同包分发。读走 `bastion.key` 就能离线解密全部模块。因此这不是"密钥管理"，只是"把密钥和密文分开放"。

**真正提升密钥强度的三条路**（均未实现）：

1. 密钥下沉到 N-API 原生模块——提高 hook 成本，但仍可从进程内存取出；
2. 机器绑定：首启激活时由服务端下发与设备指纹绑定的密钥——需要许可证与运维体系；
3. 服务端签发：会话密钥短时有效——需要联网，违背离线交付场景。

**明确不可行**：把整个 `app.asar` 加密成单一 blob。Electron 原生加载器与 `onlyLoadAppFromAsar` + 完整性校验都要求 asar 结构可解析，只能加密文件体。

## 6. 集成顺序约束

```
copyAppFiles → computeData → 写 INTEGRITY 资源 → copyFiles
→ afterPack（bastion watermark 在此）→ sanityCheck → 翻 Fuses → 签名
```

1. 修改 `app.asar` 的变换必须在 afterPack 后重算头哈希并覆写 PE/plist 资源。
2. 修改二进制的步骤必须在签名前，不能放 `afterSign`。
3. `verify` 必须读回二进制资源并与当前 asar 哈希比对。
4. v1 的水印写入 PE 版本信息资源与包外清单，不触碰 asar，不触发第 1 条。

## 7. 架构

```
bastion/
├── src/
│   ├── cli.ts
│   ├── core/                    # 与构建系统无关
│   │   ├── app-layout.ts        # 识别 win-unpacked / .app / 安装目录
│   │   ├── fuses.ts             # Fuse 状态读取
│   │   ├── asar-integrity.ts    # 头哈希 + 块级校验
│   │   ├── pe-resource.ts       # INTEGRITY / 版本信息资源读写
│   │   ├── plist.ts             # macOS ElectronAsarIntegrity
│   │   ├── watermark.ts         # 写入 / 读取 / HMAC
│   │   ├── policy.ts            # 保护策略模型（哪些必须为真）
│   │   └── report.ts            # 统一 JSON 报告
│   ├── commands/
│   │   ├── inspect.ts
│   │   ├── verify.ts
│   │   ├── watermark.ts
│   │   ├── smoke.ts
│   │   ├── build.ts             # electron-builder 守卫
│   │   └── init.ts
│   ├── bytecode/
│   │   ├── plugin.ts            # electron-vite / vite 插件
│   │   ├── compiler.ts          # 独立模块编译（esbuild + electron Node 模式）
│   │   ├── bridge.ts            # 生成 ESM 桥接代码
│   │   └── manifest.ts          # 构建清单与校验
│   └── builder/
│       ├── args.ts              # 平台化 Fuse / ASAR 参数解析
│       └── hook.ts              # afterPack 适配
├── templates/
└── docs/specs/
```

**隔离原则**：`core/` 只依赖文件与二进制格式，不 import electron 或 electron-builder；`builder/` 是会随 electron-builder 版本变化的唯一区域。

## 8. 各能力设计

### 8.1 `inspectApp(path)` / `bastion inspect`

只读，不修改文件。输入：`win-unpacked` 目录、`.exe`、`.app`、解开的安装目录。

输出：Electron 版本、平台/架构、五个 Fuse 状态、asar 头哈希与二进制记录是否一致、归档内明文 JS 清单（按体积排序）、`unpacked` 与 `extraResources` 统计、PE 安全目录是否存在。

退出码恒为 0（除非路径无法识别）；报告为稳定 JSON。用途是"体检"，不是"门禁"。

### 8.2 `verifyApp(path, policy)` / `bastion verify`

门禁。policy 显式声明必须成立的断言：

```ts
{
  requireFuses: ['enableEmbeddedAsarIntegrityValidation', 'onlyLoadAppFromAsar', 'runAsNode:false'],
  requireIntegrity: true,
  asarBlockCheck: true,
  forbidPlaintext: ['许可证校验模块', 'verifyLicensePayload'],
  requireWatermark: false
}
```

逐项断言，任一失败退出码非 0 并输出具体失败项。`unpacked` 文件单独计数，不计入保护范围——沿用基线口径，避免"看起来全保护了"的误判。

### 8.3 `smokeTamper(path)` / `bastion smoke`

从基线 `asar-tamper-smoke.mjs` 通用化：

1. 复制产物到临时目录；
2. 修改归档内 `package.json` 数据；
3. 启动，要求以完整性错误退出（匹配 `ASAR Integrity Violation`）；
4. 普通崩溃、超时、无法启动均判为失败。

需要传入启动参数与超时；平台可执行文件名从产物布局推断，也可显式指定。

### 8.4 `watermark(path, options)` / `bastion watermark`

写入位置：

| 平台 | 位置 | 特性 |
|---|---|---|
| Windows | PE 版本信息 `StringFileInfo` 自定义键 | asar 被整体替换后仍在 |
| 全平台 | `resources/bastion.json` | 便于脚本读取 |

内容与签名：

```json
{
  "schemaVersion": 1,
  "buildId": "01JB...",
  "customer": "customer-a",
  "appId": "com.example.app",
  "version": "6.10.27",
  "createdAt": "2026-10-29T00:00:00Z",
  "files": { "app.asar": "sha256:...", "目标应用.exe": "sha256:..." },
  "sig": "hmac-sha256:..."
}
```

`sig = HMAC-SHA256(buildKey, canonicalJson(除 sig 外全部字段))`；`buildKey` 由 `--key-file` 或环境变量提供，不入库。`inspect --trace` 读回 buildId/customer/时间，用于泄漏溯源。

不承诺防删除：目标是让"批量分发前顺手抹掉"必须变成主动动作，并让留存的包可定位。

### 8.5 `bastion build` / `resolveProtectionArgs()`

从基线 `package-protection.mjs` 通用化，行为保持：

- 复用目标项目已安装的 electron-builder 自身解析器读取配置与优先级（不自己实现 YAML 合并）；
- Windows/macOS：强制 `asar: true` 与两项完整性 Fuse；检测到 `asar: false` 或 Fuse 被显式关掉则报错退出；
- Linux：整体清空 Fuse 配置，规避启动器路径问题；
- 混合 Linux 与其他平台：直接拒绝，要求分开构建；
- 目标平台不在 win32/darwin/linux 内：拒绝；
- macOS `mas` / `mas-dev`：拒绝。

`bastion build` 是 `electron-builder` 的透传守卫：`bastion build --win --x64` 等价于 `electron-builder --win --x64` 但附加参数校验。

### 8.6 主进程整体字节码化 `bastion bytecode harden`

作用于**已打包产物**，不要求接入方改源码：

1. 解包 `app.asar`，读取 `package.json` 的 `main`；
2. 从主入口出发收集静态 `require` 依赖图（rollup CJS 产物以静态 require 为主）；
3. 逐文件编译成 `.jsc` 并删除明文 `.js`；
4. 写入 `bastion-loader.cjs`（几十行，只做两件事：注册字节码扩展、加载真实入口）；
5. 把 bytenode 运行时复制进归档，避免依赖接入方的 `node_modules`；
6. 重打 asar，并校验包外（unpacked）文件集合与重打前一致，不一致直接中止；
7. 重算归档头哈希并覆写 Windows PE / macOS plist 的完整性资源。

**ESM 支持（不改业务代码）**：检测到主入口是 ESM 时，对**构建产物**逐文件做 ESM→CJS 转换（esbuild transform），保留目录结构与相对路径，再把 `require('./x.js')` 说明符改写为 `./x.jsc`。源码与构建配置都不需要改。

转换覆盖：`import.meta.url` → `pathToFileURL(__filename)`、`import.meta.dirname` → `__dirname`、`import.meta.filename` → `__filename`、ESM 命名导出 → CJS getter。

不支持：顶层 await（esbuild 无法在 CJS 输出中表达，遇到直接报错并指出文件）。

**运行时自包含**：bytenode 运行时以 `.cjs` 后缀复制进归档。原因是 ESM 应用的 `"type": "module"` 会让 `.js` 被当成 ESM，运行时内的 `require` 全部失效——这是实测踩到的坑。

**保护范围只覆盖静态依赖图**：`utilityProcess.fork` 的 worker、按运行时拼接路径加载的插件、动态 `import()` 的目标都不在图中，保持明文且不受影响。这是有意的：覆盖它们会改变加载语义。

**已验证的边界**：字节码能消除源码文本（控制流、注释、结构），但字符串常量仍然可以被 `strings` 提取。因此密钥、固定盐值、内部地址等不得写入客户端代码。

## 8.7 `createBytecodePlugin(options)` / `compileBytecodeModule()`

把基线的单模块实现抽象为多模块配置：

```ts
createBytecodePlugin({
  rootDir,
  modules: [
    {
      source: 'src/main/presenter/licensePresenter/许可证校验模块.ts',
      chunk: 'license-core',
      exports: ['parseLicenseFile', 'verifyLicensePayload', 'checkLicenseIPs']
    }
  ],
  outDir: 'out/main/protected'
})
```

插件职责（与基线一致，逐条通用化）：

1. 生产构建中把对 `source` 的导入替换为虚拟桥接模块，桥接内容由 `exports` 自动生成；
2. `generateBundle` 检查源模块没有回流进主产物；
3. `writeBundle` 触发独立 CJS 子构建，产出 `.cjsc` + 薄入口 + 加载器；
4. 用目标 Electron 的 Node 模式实际加载，跑调用方提供的自检回调；
5. 写清单：OS、CPU、Electron/V8、源码摘要、产物摘要；
6. 自校验：缺文件、空文件、摘要不符、运行时版本不符均报错。

通用化的新增约束（基线未覆盖，需按项目提示）：

- 模块内出现 `fn.toString()` / `Function.prototype.toString` 时告警——这些函数经序列化后无法保留（基线文档记录的 `某函数序列化路径` 即属此类）；
- 只支持 CJS 输出；检测到目标项目主进程为 ESM 时，强制走桥接模式而不是整体转换；
- 构建必须发生在目标 OS/架构；`--skip-build` 复用时校验清单中的运行时信息。

非 electron-vite 项目使用 `compileBytecodeModule()` 直接编译单个 CJS 模块，接口同上但跳过 Vite 插件部分。

## 9. 保护范围矩阵

| 代码/资源 | 保护方式 | 剩余风险 |
|---|---|---|
| 白名单核心模块 | V8 字节码 | 字符串可读 |
| 主进程其余模块 | 明文（asar 内） | 可 `asar extract` |
| preload | 明文 | 可读；不为它降级沙箱 |
| 渲染进程 | 打包压缩 | 可读 |
| `app.asar.unpacked` / `extraResources` | 不保护 | 可替换 |
| 归档整体 | ASAR 完整性 + Fuses（Windows/macOS） | 本机管理员仍可绕过 |

随交付说明一起提供，避免"已加固"被理解为"全部不可读"。

## 10. CLI 一览

```
bastion inspect   <path> [--json] [--trace]
bastion verify    <path> [--policy <file>] [--require-watermark] [--json]
bastion watermark <path> --build-id <id> [--customer <name>] [--key-file <path>]
bastion smoke     <path> [--timeout <ms>] [--executable <name>]
bastion build     [electron-builder 参数...]
bastion init      --preset electron-builder|electron-vite [--dry-run]
```

## 11. 目标应用 接入后形态

| 仓库文件 | 变更 |
|---|---|
| `scripts/verify-package-protection.mjs` | 改为 `export { verifyApp as ... }` 的薄封装，或直接删除并改调用 CLI |
| `scripts/package-protection.mjs` | 改为调用 `bastion build` |
| `scripts/bytecode-protection.mjs` | 改为 `createBytecodePlugin({ modules: [...] })` 的配置 |
| `scripts/asar-tamper-smoke.mjs` | 改为调用 `bastion smoke` |
| `scripts/run-win-unpacked-smoke.mjs` | 保护检查改为 `verifyApp()` |
| `test/main/scripts/*` | 保留，作为 bastion 的回归门禁 |

迁移方式：先在 bastion 内实现并通过基线测试，再替换仓库实现，最后删除重复代码。

## 12. 明确不做

- 代码虚拟化、内存加密、反 dump；
- 调试器检测、时序检测、自修改代码；
- 内核态或驱动级保护。

原因：在国产安全软件与 EDR 环境下，这些行为特征与木马加壳高度重合，误杀风险大于收益。客户合同若强制要求原生反调试，应单独评估原生保护方案，不以本工具产物冒充。

## 13. 验收标准

1. `verify` 对真实产物全绿；对未加固产物必须如实失败。
2. 篡改测试：修改归档后以 `ASAR Integrity Violation` 退出；崩溃/超时不判通过。
3. 水印：写入后读回一致；篡改 `sig` 后 HMAC 失败。
4. 字节码：清单、运行时版本、明文回流、产物摘要四项校验全部生效；至少两个模块同时受保护。
5. 打包守卫：`asar:false`、Fuse 被关、混合 Linux 构建、`mas` 目标四类情况均报错。
6. 跨平台：Windows x64、Linux x64 实际跑通；macOS 由基线既有验证覆盖。
7. 通用性验证：在一个最小 Electron 示例工程上，仅通过 `init` + 三条命令完成加固与验收，证明不依赖 目标应用 专有结构。

## 14. 风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| 字节码多模块通用化时踩到 ESM/`toString` 边界 | 高 | 插件内主动检测并报错，不静默降级 |
| PE 版本信息资源写入破坏可执行文件 | 高 | `resedit` 实现；写入后立即冒烟 |
| 抽接口过程中回归基线能力 | 中 | 原项目的保护相关测试先行跑通 |
| electron-builder 升级改变顺序或字段 | 中 | 适配集中在 `builder/`；CI 固定版本 |
| 客户误解"已加固"含义 | 中 | §9 矩阵随交付说明提供 |

## 15. 里程碑

- **M1**：`inspect` / `verify` / `watermark` / `smoke` + `core/` 分层。这四项构建系统无关，先独立可用。
- **M2**：`build` 守卫 + `init` 预设，接入 目标应用 打包链。
- **M3**：`bytecode` 插件多模块化，接入现有门禁与回归测试。
- **M4（可选）**：asar 级变换（混淆），此时实现 §6 的完整性重写；或按 §5 条件重新评估加密加载器。

## 16. 已定决策

初版遗留的待确认项，按最优方案直接确定，不再等待确认：

| 项 | 决策 | 依据 |
|---|---|---|
| 水印密钥保管 | CI 用 secret `BASTION_WATERMARK_KEY`（32 字节 hex/base64）；本地用 `--key-file`，文件不入库 | 与环境变量/文件两种场景都覆盖，避免密钥进仓库 |
| 密钥轮换 | 水印中带 `kid`，校验端按 `kid` 选密钥 | 轮换时旧包仍可验证 |
| NSIS 安装包 | 水印在 `win-unpacked` 阶段写入，NSIS 打包自动带入；不额外改安装器 | 避免二次修改安装包带来的签名问题 |
| 字节码白名单 | 由接入方配置，默认只含许可证模块；M3 提供 `bastion bytecode scan` 给出候选建议 | 白名单是项目决策，不是工具决策 |
| 包名与渠道 | `electron-bastion`，私有 registry，semver | 不公开发布，避免维护公开 API 兼容负担 |
| Electron Forge | v1 不支持 | 当前目标项目全部使用 electron-builder；适配层预留接口 |

## 17. 实现状态（2026-10-29）

M1–M3 全部实现，并在独立 Electron 项目上完成端到端验证。

| 能力 | 命令 / API | 状态 |
|---|---|---|
| 产物体检 | `bastion inspect` | ✅ 真实产物验证 |
| Fuse + 完整性门禁 | `bastion verify` | ✅ 真实产物验证（macOS），Windows 待实测 |
| 逐块归档校验 | `verifyAsarBlocks` | ✅ 单测 + 真实产物 |
| 篡改冒烟 | `bastion smoke` | ✅ 真实产物验证 |
| 构建水印 | `bastion watermark` / `trace` | ✅ 真实产物验证 |
| 打包参数守卫 | `bastion build` | ✅ 代码完成，待真实打包链验证 |
| 接入模板 | `bastion init` | ✅ 在验证项目中生成并被 electron-builder 执行 |
| 字节码编译 | `bastion bytecode build` | ✅ 真实 Electron 43 编译 + 加载验证 |
| 主进程整体字节码化 | `bastion bytecode harden` | ✅ 真实产物验证（CJS 与 ESM 两种应用） |
| 字节码加密 + 内存解密加载器 | `--encrypt` | ✅ 真实产物验证：`.enc` 解包后无明文，`strings` 不再命中 |

测试：`npm test` 12 项全部通过。

## 18. 独立验证记录

在 `bastion-verify` 新建了一个与 目标应用 无关的最小 Electron 项目（Electron 43.8.4 + electron-builder 26.18.0，macOS arm64），用 `bastion init` 生成的 afterPack 钩子接入，实际打包并验证：

| 验证项 | 结果 |
|---|---|
| afterPack 钩子写入水印 | 通过，`buildId=1.0.0-20261028161433` |
| Fuse 实际写入手续 | 通过，`runAsNode` / `NODE_OPTIONS` / `--inspect` 均为 disabled，两个分完整性 Fuse 为 enabled |
| Info.plist 的 `ElectronAsarIntegrity` 与归档头哈希一致 | 通过 |
| `bastion verify` 全绿 | 通过，退出码 0 |
| 篡改一个字节后启动 | 通过，退出码 1，`bastion smoke` 判定成功 |
| 干净包正常启动并写入标记文件 | 通过 |
| `ELECTRON_RUN_AS_NODE=1` 执行代码 | 被 Fuse 阻止，未进入 Node 模式 |
| TS 模块 → esbuild CJS → `.jsc` → Electron 加载 | 通过，导出成员校验一致，无明文中间产物残留 |
| `bytecode harden` 真实产物 | 通过：`src/main.js`、`src/lib/secret.js` 均变为 `.jsc`，应用启动并正确输出计算结果 |
| 加固后 `verify` | 通过：Fuses、完整性（已重算）、块校验、水印全部为真 |
| 加固后篡改冒烟 | 通过：以完整性错误退出 |
| 加固后 `strings` 提取 | **字符串常量仍可提取**（`bastion-secret-marker-42`、`compute`），逻辑不可读但常量可见 |
| ESM 应用 `"type": "module"` + `import.meta.url` | 通过：自动转 CJS，`import.meta.url` 正确指向 `.jsc`，应用输出与加固前一致 |
| ESM 应用加固后 `verify` / `smoke` | 通过，退出码与完整性判定与 CJS 应用一致 |
| `--encrypt` 后运行 | 通过，输出与加固前一致 |
| `--encrypt` 后解包 | 仅有 `.enc`，`grep` 不到任何字符串常量 |
| 密钥暴露面 | `Resources/bastion.key` 可直接读取，可离线解密——已记录为已知边界 |

验证过程中发现并修复了两个真实缺陷：

1. `defaultPolicy` 在 macOS 上把 `requireIntegrity` 设为 false，导致完整性检查被静默跳过。
2. `smoke` 只复制了 `.app/Contents`，Electron 报 `Unable to find helper app`；已改为复制整个 `.app`。

## 19. 仍未验证

| 项 | 原因 | 补齐方式 |
|---|---|---|
| Windows PE 完整性资源读写 | 本机无 Windows 产物 | 在 Windows 构建机跑 `bastion verify` |
| Windows 篡改冒烟 | 同上 | 同上 |
| Linux 产物 Fuse 读取 | 同上 | 在 Linux 构建机执行 |
| `bastion build` 守卫 | 需接真实 electron-builder 打包链 | 在 目标应用 构建流程中替换验证 |
| Vite 插件封装 | 已提供 `buildProtectedModules` 通用管线，插件适配未实现 | 待接入 electron-vite 项目时补 |

## 20. 真实产物验证（目标应用 / Electron 43.6.0 / macOS arm64）

在独立验证目录用真实产物（归档约 160MB）执行 `bytecode harden`，暴露并修复了三个工具缺陷，同时确认了一个不可绕过的架构约束。

### 已修复

1. **编译器版本必须等于目标 Electron**。首次用 43.8.4 编译、产物是 43.6.0，运行时报 `cachedDataRejected`。现在 `harden` 会从 `Contents/Frameworks/Electron Framework.framework` 的 `Info.plist` 读取目标版本，不一致直接拒绝。此前所有基于错误版本的基准数据作废。
2. **顶层 `__filename` / `__dirname` 声明与 CJS 包装器形参冲突**。源码里 `const __filename = import.meta.filename` 转换后变成 `const __filename = __filename`，编译报 `Identifier '__filename' has already been declared`。现在改用独立中转变量并剥离顶层同名声明。
3. **动态 `import()` 在 vm 中不可用**。相对路径降级为 `require`；裸包名改走加载器注入的 `globalThis.__bastionImport`，在模块作用域外执行真实 `import()`，从而避开 `--experimental-vm-modules`（生产环境被 Fuse 禁用）。

### 不可绕过

`某 ESM-only 依赖` 是 **ESM-only**（`type: module`，exports 只有 `import` 条件）。`某适配器模块:9` 以命名绑定静态导入它：

```ts
import { ... } from '某 ESM-only 依赖'
```

ESM→CJS 转换会把静态 import 变成 `require`，ESM-only 包无法 `require`，运行时报 `ERR_PACKAGE_PATH_NOT_EXPORTED`。其余 4 处是纯副作用导入，可改为异步宿主 import；这一处带命名绑定，无法同步转换。

**结论**：目标应用 主进程整体字节码化，不改业务代码做不到；需要改这 1 个文件的导入方式（或等该依赖提供 CJS 入口）。除此之外的 16 个主进程模块均可转换。

### 性能数据

由于上述阻塞，目标应用 的端到端启动对比**没有取得有效数据**，此前测得的数字不采用。仅在最小 demo 上测得：159ms（原始） / 156ms（字节码） / 156ms（加密），包体积 3.8KB → 56.9KB。

## 21. 目标应用 跑通记录（2026-10-29）

在 worktree `feat/字节码加固分支` 修改 `某适配器模块`：把对 ESM-only 包 `某 ESM-only 依赖` 的命名绑定静态导入改为缓存的动态导入（`loadPiAiCompat()`），使用处改为 `await`。调用点本就在 async IIFE 内，语义不变。

真实产物（Electron 43，macOS arm64，归档约 160MB）流程：worktree 构建 → electron-builder 打包 → `bastion bytecode harden` → 启动。

结果：**加固包成功启动并创建渲染进程**（主进程 1 个 + renderer 2 个，存活超过 15 秒）。主进程 16 个模块转为 `.jsc`，`verify` 的完整性、块校验、水印三项通过；Fuses 未通过是因为该测试包使用了不含 `electronFuses` 的临时打包配置，与字节码无关。

### 排查中确认的两个关键事实

1. **应用在启动早期调用 `hookConsole()`**（`out/main/chunks/index-*.js` 第 1719 行附近），把 `console.log/error/warn` 全部劫持到自身日志系统。任何依赖 console 的注入探针在此之后都收不到输出——排查必须用 `process.stdout.write`。
2. **此前的 `exit code 1` 是测试脚本未清理旧实例导致的单例锁冲突**，不是加固缺陷。`app.requestSingleInstanceLock()` 失败时应用静默退出，排查时容易被误判。用手工 PID 追踪并确保无残留进程后，加固包稳定运行。

### 仍未完成

- 该测试包未启用 Fuses（临时配置），也未安装运行时时序（打包跳过了 `afterPack`）；
- `agentEngineWorker.js`、`fileWatcherUtilityHost.js`、`pdfRenderUtilityHost.js`、`workshopOfficePreviewWorkerEntry.js`、`extension-api.preload.cjs` 仍是明文，它们不在主入口静态图内（`utilityProcess.fork` 按路径加载，属设计内）；
- 渲染进程 39MB 仍为明文；
- 未做启动耗时对比（渲染进程探测脚本未稳定拿到时间点）。

## 22. 已知缺陷修复状态（2026-10-29）

| 缺陷 | 状态 |
|---|---|
| 重复加固导致 loader 递归自爆 | ✅ 已修：入口先查归档清单，发现 `bastion-loader.cjs` 或 `bastion/bytenode/` 直接拒绝 |
| ESM 应用使用 `--exclude` 产出坏包 | ✅ 已修：ESM 模式下直接拒绝，并说明原因 |
| 加固后不验证能否启动 | ❌ 未修：需要目标平台可执行环境，建议在 CI 中对产物跑一次启动冒烟 |
| bytenode 运行时带入编译器/CLI | ❌ 未修：多约 30KB，且扩大攻击面 |
| 靠字符串替换 patch bytenode 内部实现 | ❌ 未修：bytenode 升级需回归 |
| Windows/Linux 的 PE 资源读写未实测 | ❌ 未验证：代码完成，缺真实产物 |
| 输出泄漏绝对路径 | ❌ 未修：线上日志可见用户安装路径 |

新增测试：`test/harden.test.js` 覆盖二次加固拒绝与 ESM `--exclude` 拒绝。当前共 14 项测试全部通过。

## 23. 打包层启动门禁（2026-10-29）

「加固后不验证能否启动」这条缺陷改为在打包层解决，而不是靠人工跑一遍。

实现：`bastion startup`，以及 `bastion verify --smoke`、`bastion bytecode harden`（默认开启，可用 `--verify-startup=false` 关闭）。

机制：

1. 选一个空闲端口，用 `--remote-debugging-port=<port>` 启动产物；
2. 轮询 `http://127.0.0.1:<port>/json/list`，出现 `page` 目标即判定窗口就绪；
3. 判定失败的三类情况：进程提前退出（附退出码与 stderr 尾部）、进程存活但超过 `stallTimeoutMs`（默认 15s）无页面、总超时（默认 60s）。

单例锁问题：已运行的实例会占用同一 userData 的单例锁，使新进程弹对话框阻塞。门禁不干等：进程存活但无页面超过 15s 时直接失败，并明确提示「可能有另一实例占用单例锁」。同名进程预检查也能覆盖同类可执行文件的情况。

验证：

- 正向：最小 demo 应用 3373ms 内检出页面；
- 负向：存在另一个共享 userData 的实例时，15s 内给出明确原因而不是超时。

限制：无法在构建机上运行其他平台产物时自动跳过并标注原因；跨平台门禁需要在对应平台的 CI 上执行。
