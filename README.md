# electron-bastion

通用 Electron 发布保护工具：产物体检、Fuse / 归档完整性门禁、构建水印、篡改冒烟、V8 字节码。

不依赖具体构建系统；`core/` 只读写文件与二进制，`builder/` 才依赖 electron-builder。

## 安装

```bash
npm install -D electron-bastion
```

## 命令

```bash
bastion inspect   <path>                  # 只读体检，输出 JSON
bastion verify    <path>                  # 发布门禁，任一断言失败退出码 1
bastion watermark <path> --build-id <id>  # 写入构建水印
bastion trace     <path>                  # 读回 buildId / customer
bastion smoke     <path>                  # 篡改归档，要求应用以完整性错误退出
bastion build     [electron-builder 参数] # 透传构建并按平台强制 Fuse / asar
bastion init                              # 生成 scripts/bastion-afterpack.mjs
bastion bytecode build <root> --out <dir> --electron <path> --module <src>:<exports>
bastion bytecode verify <root> --out <dir> --electron <path>
bastion bytecode harden <path> --electron <path> [--encrypt]  # 主进程整体转字节码，可再加密
```

`--electron` 必须指向**目标产物自带的** Electron（版本不一致时工具会直接拒绝，V8 字节码与版本强绑定）。

`bytecode harden` 直接作用于产物：解包 → 沿主入口的依赖图收集模块 → 编译成 `.jsc` → 删除明文 JS → 写入 loader → 重打 asar → 重算归档完整性。

主进程输出是 ESM 时会自动转成等价 CommonJS 再编译，**不需要改业务代码或构建配置**。唯一无法转换的是顶层 await，遇到会明确报错并指出文件。

`<path>` 可以是 `win-unpacked` / `linux-unpacked` 目录、可执行文件或 macOS `.app`。

## 接入 electron-builder

```bash
npx bastion init
```

然后在 `electron-builder.yml` 中加入生成的文件内容：

```yaml
asar: true
afterPack: scripts/bastion-afterpack.mjs
electronFuses:
  runAsNode: false
  enableNodeOptionsEnvironmentVariable: false
  enableNodeCliInspectArguments: false
  enableEmbeddedAsarIntegrityValidation: true
  onlyLoadAppFromAsar: true
```

打包时用 `bastion build` 替代 `electron-builder`，即可按平台强制参数（Linux 会自动整体关闭 Fuse 写入，避免写到 shell 启动器上）。

## 水印密钥

```bash
export BASTION_WATERMARK_KEY=<32 字节 hex 或 base64>
# 或
bastion watermark <path> --build-id v1.2.3 --key-file .bastion/watermark.key
```

水印写入 `resources/bastion.json`（全平台）与 Windows PE 版本信息（`BastionBuildId` 等）。`kid` 字段用于密钥轮换。

## 库用法

```js
import { detectAppLayout, verifyApp, defaultPolicy, writeWatermark, smokeTamper } from 'electron-bastion'

const layout = await detectAppLayout('dist/win-unpacked')
const result = await verifyApp(layout, defaultPolicy(layout.platform))
if (!result.ok) process.exit(1)
```

## 保护边界

- 能挡住：`asar extract` 后的改包分发、`--inspect` / `NODE_OPTIONS` / `runAsNode` 调试入口、静默替换归档。
- 挡不住：本机管理员、调试器附加后的内存读取、渲染进程 bundle 的阅读。
- 字节码**不是加密**：逻辑无法原样还原，但 `strings` 仍能提取字符串常量。加 `--encrypt` 后密文在磁盘上不可读，但密钥随包分发（`Resources/bastion.key`），有耐心的人仍能解密。
- 不实现：对抗式反调试、内存加密、内核级保护。这些在国产安全软件环境下误杀风险高于收益。

## 开发

```bash
npm install
npm run build
npm test
```
