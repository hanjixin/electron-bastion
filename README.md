# electron-bastion

> Electron 发布保护工具：把「能不能发」变成构建流水线里的一个断言，而不是靠人记得检查。

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Electron 应用打成 asar 之后，`npx @electron/asar extract app.asar` 就能拿到全部主进程源码；换掉入口重新打包，也没有任何东西会拦你。electron-builder 提供了 Fuses 和归档完整性校验，但它们默认不开，而且开没开、开对了没有，构建产物里看不出来。

electron-bastion 补齐这一段：**体检、门禁、追溯、启动验证**，再加可选的字节码加固。

```
产物 → 体检(inspect) → 加固(harden) → 门禁(verify) → 启动验证(startup) → 发布
                            ↓
                        水印(watermark) → 泄漏可追溯
```

## 它做什么，不做什么

| 能力 | 状态 | 说明 |
|---|---|---|
| 产物体检 | ✅ | Fuses、归档完整性、明文暴露、签名状态 |
| 发布门禁 | ✅ | 任一断言失败即非 0 退出，可直接卡住发布 |
| 篡改冒烟 | ✅ | 改一个字节，应用必须以完整性错误退出 |
| 构建水印 | ✅ | buildId + HMAC，泄漏后可定位到构建批次/客户 |
| 启动门禁 | ✅ | 加固后拉起应用，拿不到窗口即判失败 |
| 主进程字节码 | ✅ | 构建产物整体转 V8 字节码，源码不再以明文下发 |
| 字节码加密 | ✅ | AES-256-GCM，内存解密执行 |
| 渲染进程加密 | ❌ | Chromium 必须读到可执行 JS，技术上不可行 |
| 反调试 / 内存保护 | ❌ | 见「保护边界」 |
| 商业壳替代 | ❌ | 不做代码虚拟化 |

一句话：**它防的是「改包分发」和「明文源码下发」，不是「绝对不可逆向」**。客户端要执行代码，明文必然在运行期出现在内存里。

## 安装

```bash
npm install -D electron-bastion
```

要求 Node.js ≥ 22。支持 Windows、Linux、macOS 产物；`inspect` / `verify` / `watermark` / `startup` 与构建系统无关，`build` 与字节码加固依赖 electron-builder / electron-vite。

## 快速开始

```bash
# 1. 体检：当前产物到底保护了什么
npx bastion inspect dist/win-unpacked

# 2. 接入 electron-builder（生成 afterPack 钩子）
npx bastion init

# 3. 用守卫替代直接调用 electron-builder
npx bastion build --win --x64

# 4. 发布门禁（失败即非 0 退出）
npx bastion verify dist/win-unpacked --require-watermark

# 5. 启动验证：拿不到窗口就失败
npx bastion startup dist/win-unpacked
```

`<path>` 可以是 `win-unpacked` / `linux-unpacked` 目录、可执行文件，或 macOS `.app`。

## 命令

| 命令 | 作用 | 失败退出码 |
|---|---|---|
| `bastion inspect <path>` | 只读体检，输出 JSON | 0（路径无法识别除外） |
| `bastion verify <path>` | 门禁：Fuses / 完整性 / 块校验 / 明文 / 水印 | 1 |
| `bastion watermark <path> --build-id <id>` | 写入构建水印 | 0 |
| `bastion trace <path>` | 读回 buildId / customer | 无水印时 1 |
| `bastion smoke <path>` | 篡改归档，要求应用拒绝启动 | 1 |
| `bastion startup <path>` | 启动门禁，等待窗口就绪 | 1 |
| `bastion build [args]` | 透传 electron-builder，按平台强制保护参数 | 同 electron-builder |
| `bastion init` | 生成 `scripts/bastion-afterpack.mjs` | 0 |
| `bastion bytecode harden <path>` | 主进程整体转字节码（可选加密） | 1 |
| `bastion bytecode build/verify` | 单个 CommonJS 模块的字节码编译与校验 | 1 |

`verify` 加 `--smoke` 会在门禁里附带一次启动验证。

## 三级保护，按需取用

### 1. 门禁：让坏包发不出去

```bash
npx bastion verify dist/win-unpacked --require-watermark
```

断言项：

- Fuses 状态（`runAsNode`、`NODE_OPTIONS`、`--inspect` 关闭，`onlyLoadAppFromAsar` 与归档完整性开启）
- Windows PE 的 `INTEGRITY/ELECTRONASAR` 或 macOS `Info.plist` 的 `ElectronAsarIntegrity` 与归档头哈希一致
- 归档内逐块 SHA256 校验
- 归档内不出现指定模块的明文特征
- 水印存在且 HMAC 校验通过

`app.asar.unpacked` 里的文件**不计入保护范围**，报告中单独计数——避免「看起来全保护了」的误判。

### 2. 水印：泄漏后能追到人

```bash
export BASTION_WATERMARK_KEY=<32 字节 hex 或 base64>
npx bastion watermark dist/win-unpacked --build-id v1.2.3 --customer acme
npx bastion trace dist/win-unpacked
```

写入两处：

- `resources/bastion.json`（全平台）
- Windows PE 版本信息（`BastionBuildId` / `BastionCustomer` / `BastionSignature`），asar 被整体替换后仍在

`sig = HMAC-SHA256(key, canonicalJson(...))`，`kid` 字段支持密钥轮换。密钥通过 `--key-file` 或环境变量提供，**不要提交进仓库**。

### 3. 字节码：源码不以明文下发

```bash
# --electron 必须指向目标产物自带的 Electron
npx bastion bytecode harden dist/win-unpacked \
  --electron ./node_modules/electron/dist/electron.exe

# 连磁盘上的字节码也不想被读，再加 --encrypt
npx bastion bytecode harden dist/win-unpacked \
  --electron ./node_modules/electron/dist/electron.exe --encrypt
```

流程：解包 → 沿主入口依赖图收集模块 → 编译 `.jsc` → 删除明文 JS → 写入 loader → 重打 asar → 重算归档完整性 → **启动门禁**。

- **ESM 自动转 CJS**：主进程输出是 ESM 时，对构建产物逐文件转换，不改业务代码与构建配置。
- **版本强绑定**：字节码与目标 Electron 的 V8 版本严格对应，版本不一致直接拒绝。
- **只覆盖静态依赖图**：`utilityProcess.fork` 的 worker、运行时拼接路径加载的插件保持明文且不受影响。
- **固有限制**：顶层 await 无法转换，遇到会报错并指出文件；ESM-only 依赖若被命名绑定静态导入，需要先改成动态导入。
- **幂等保护**：已经加固过的产物会被拒绝，不会产出递归 loader。

> 字节码不是加密。逻辑无法原样还原，但 `strings` 仍能提取字符串常量。`--encrypt` 后磁盘上的密文不可读，但密钥随包分发（`Resources/bastion.key`），有耐心的人仍能解密。**不要把密钥、固定盐值、内部地址写进客户端代码。**

## 接入 electron-builder

```bash
npx bastion init
```

```yaml
# electron-builder.yml
asar: true
afterPack: scripts/bastion-afterpack.mjs
electronFuses:
  runAsNode: false
  enableNodeOptionsEnvironmentVariable: false
  enableNodeCliInspectArguments: false
  enableEmbeddedAsarIntegrityValidation: true
  onlyLoadAppFromAsar: true
```

打包时用 `bastion build` 替代 `electron-builder`：它会读取项目自身的 electron-builder 配置与 CLI 优先级，Windows/macOS 强制开启归档与两项完整性 Fuse，Linux 自动关闭 Fuse 写入（Linux 的 afterPack 常把真实二进制改名成 shell 启动器，写 Fuse 会写到脚本上）。

环境变量：

| 变量 | 用途 |
|---|---|
| `BASTION_WATERMARK_KEY` | 水印密钥（32 字节 hex / base64） |
| `BASTION_BUILD_ID` | 覆盖自动生成的 buildId |
| `BASTION_CUSTOMER` | 客户标识，写入水印 |
| `BASTION_DEBUG` | 加载器输出模块加载与错误信息 |

## CI 集成

```yaml
- name: Package
  run: npx bastion build --win --x64

- name: Verify
  run: npx bastion verify dist/win-unpacked --require-watermark --smoke
  env:
    BASTION_WATERMARK_KEY: ${{ secrets.BASTION_WATERMARK_KEY }}
```

`startup` 门禁依赖真实运行环境：跨平台产物会被跳过并标注原因，需要在对应平台的 runner 上执行。若系统中已有同一应用实例（共享 userData 的单例锁），门禁会给出明确提示而不是傻等到超时。

## 库用法

```js
import {
  detectAppLayout,
  verifyApp,
  defaultPolicy,
  loadWatermarkKey,
  writeWatermark,
  assertAppStarts
} from 'electron-bastion'

const layout = await detectAppLayout('dist/win-unpacked')
const result = await verifyApp(layout, defaultPolicy(layout.platform))
if (!result.ok) throw new Error(JSON.stringify(result.checks, null, 2))

await writeWatermark(layout, {
  buildId: process.env.BASTION_BUILD_ID,
  key: await loadWatermarkKey({})
})

const startup = await assertAppStarts(layout)
if (!startup.ok) throw new Error(startup.detail)
```

`core/` 只依赖文件与二进制格式，可以脱离 electron-builder，单独用于验收第三方交付物。

## 保护边界

**能挡住**

- `asar extract` 后的改包分发：归档完整性校验会让应用拒绝启动
- `--inspect` / `NODE_OPTIONS` / `runAsNode` 三条常见调试入口
- 静默替换 `app.asar` 或包外资源
- 主进程源码以明文形式下发（启用字节码后）

**挡不住**

- 拥有本机管理员权限的人
- 调试器附加后的内存读取
- 渲染进程 bundle 的阅读（Chromium 必须读取可执行 JS）
- 密钥随包分发带来的离线解密

**不实现**

反调试、代码虚拟化、内存加密、内核级保护。这类行为特征与恶意加壳高度重合，在企业终端安全软件（EDR / 国产杀软）环境下误杀风险高于收益。如合同强制要求原生反调试，应单独评估原生保护方案，不要用本工具的产物冒充。

## 验证状态

| 能力 | 验证情况 |
|---|---|
| inspect / verify / watermark / smoke / startup | 真实产物端到端验证（macOS arm64） |
| 字节码加固、加密、动态导入、ESM 转换 | 真实产物端到端验证（Electron 43） |
| Windows PE 资源读写 | 代码完成，**尚未在真实 Windows 产物上验证** |
| Linux 产物 | 代码完成，**尚未在真实 Linux 产物上验证** |

## 开发

```bash
npm install
npm run build
npm test
```

14 项测试覆盖归档块校验、水印签名、产物布局识别、二次加固拒绝等。设计文档见 [`docs/specs/electron-bastion/design.md`](docs/specs/electron-bastion/design.md)，记录了实现过程中遇到的全部问题和取舍。

## License

[MIT](LICENSE)
