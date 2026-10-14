---
name: zotero-codex
description: 维护 Zotero Codex MCP 插件时使用。涵盖 Zotero 原生插件、MCP 服务、Better Notes 联动、运行组件安装、缓存清理、设置页设计、测试和 GitHub Release 流程。
---

# Zotero Codex repository skill

## 适用范围

这是一个 Zotero 10 插件和本地 MCP 服务项目。插件负责阅读器上下文、区域截图、设置页、Zotero 本地 API 和运行组件生命周期；MCP 服务负责向 Codex 等客户端暴露论文、PDF、选区和 Better Notes 工具。

维护时先读与任务相关的文档：

- `docs/local-setup.md`：安装、连接和自动运行组件说明。
- `docs/better-notes-api.md`：Better Notes 适配边界。
- `docs/settings-redesign.md`：设置页设计背景。
- `docs/remote-access-design.md`：远程访问仍处于设计阶段。
- `docs/release-<version>.md`：对应版本发布说明。

不要把 Neuink 或旧版 `legacy/` 当作当前实现。`vendor/zotero-native-mcp` 是复用的上游实现，除非任务明确要求，不要重复实现已有工具。

## 工程结构和边界

- `addon/bootstrap.js` 按顺序加载 `core.js`、`mcp-schema.js`、`runtime-core.js`、`cache.js`、`runtime.js`、`plugin.js`。新增共享模块必须同时加入加载顺序和打包测试。
- `addon/content/plugin.js` 管理 Zotero 窗口、阅读器上下文、选区和 Better Notes 适配。`snapshots`、`revisions`、`writes` 等内存映射承担并发和去重职责，清理阅读上下文时只能清理快照，不能顺便删除写入版本或冲突状态。
- `addon/content/runtime.js` 管理 Node.js 发现、运行包下载、校验、安装、配置和停止。安装、连接和缓存维护必须互斥；所有长操作都要有状态、可取消或可重试反馈。
- `addon/content/cache.js` 是缓存策略的纯逻辑层。它只能识别插件自己生成的精确临时文件名，不能接受设置页传入的任意路径，也不能跟随符号链接。
- `mcp/server.mjs` 是 MCP 入口；`mcp/native.mjs` 是 Zotero 本地 API 适配层；`runtime/configure.mjs` 负责客户端配置的原子迁移和备份。
- `addon/content/preferences.xhtml`、`preferences.css`、`preferences.js` 构成原生设置页。状态由 runtime API 驱动，按钮不能只依赖定时刷新解锁。

## 数据、安全和文件操作

- 不输出或提交连接令牌、`zotero-codex-mcp.json`、用户库、PDF、Better Notes 正文、个人配置和本地路径中的敏感内容。
- 本地 API 默认只接受 loopback 和配对令牌。不要扩大监听地址、关闭认证、接受浏览器来源或把令牌放进复制配置、诊断信息和日志。
- 运行包必须经过版本、平台、大小、SHA-256、路径和 Node.js 版本校验。压缩包路径拒绝绝对路径、`..`、NTFS 流、保留设备名、重复路径和符号链接。
- Codex 配置写入必须原子替换、私有权限、保留其他客户端和模型设置，并创建可恢复的 `before-zotero` 备份。
- 不删除已安装运行组件：旧版本、备用 Node.js 可能仍被 Codex、Cursor 或其他 MCP 客户端引用。
- 缓存清理只处理运行目录下、名称完全匹配的 `.download-<uuid>.zip`、`.install-<uuid>`、`probe-<uuid>.json`、`configure-<uuid>.json`。默认只清理超过 24 小时的临时项；近期项、符号链接、变化中的目录和无法读取的项必须保留并计入跳过数。
- 自动缓存清理只能在用户开启后运行。阈值范围为 `0–102400 MB`，周期只允许 `1`、`7`、`30` 天；先检查可清理字节数，达到阈值后才删除。阈值为 0 表示到期即清理。手动清理不受自动规则限制。
- 删除前重新检查文件类型、修改时间、大小、父目录和目录内容；部分失败要报告实际删除数量和字节数，不能声称全部清理成功。

## 阅读上下文和 Better Notes

- 文字选区和区域截图都应支持自动捕获；区域批注生成截图后自动写入上下文，不要求用户拖拽。
- 自动捕获不会自动发送 AI 消息。关闭自动捕获时清除对应的自动快照，但保留用户已经保存的批注和笔记；手动“添加到 MCP”仍然可用。
- PDF 全文按 PDF 页读取；不要恢复旧的字符偏移分页方案。
- Better Notes 的源文件是 HTML 富文本。通过适配层和已暴露 API 编辑，不能直接改数据库或绕过 revision/冲突保护。
- 笔记写入使用读到的 revision；冲突必须显式返回，不能静默覆盖用户修改。Markdown 同步属于显式功能，不要假设导出就是同步。

## 设置页 UI 规范

设计目标是 Zotero 原生、安静、清晰、轻量的设置界面：浅色和深色都可读，圆角卡片但不过度装饰，控件对齐优先于视觉效果。

- 以“连接与运行、阅读上下文、其他客户端、缓存与存储、连接诊断”分组。高级或低频内容默认折叠。
- 每个设置项只保留一句动作说明；详细范围、保留项和例外放进折叠的“清理范围”或高级说明。
- 复用现有 CSS 变量：`--zc-border`、`--zc-surface`、`--zc-subtle`、`--zc-ink`、`--zc-secondary`，使用 `light-dark()` 支持主题。
- 卡片圆角使用现有 14px；按钮和输入框保持统一高度，当前缓存规则控件为 36px 并且底边对齐。
- 数字输入框左对齐，单位（MB）独立显示；周期使用原生下拉选择，不要显示浏览器默认数字微调器。自动清理使用有明确开关状态的 switch。
- 反馈文字放在操作按钮右侧，允许换行；不要使用底部指示线、蓝色选中框或强烈深色背景。
- 所有控件必须有可访问名称、键盘 focus 状态和 disabled 状态。文本使用 `overflow-wrap:anywhere`，窄窗口不能横向溢出。
- 状态文案优先短句：`尚未检查缓存`、`检查完成`、`规则已保存`、`最近自动清理：...`。避免重复解释同一安全边界。
- 不要在定时刷新中覆盖用户尚未保存的输入；编辑规则时保持草稿，保存后再写入偏好。

## 测试要求

先运行与改动相关的最小验证，再运行完整检查：

```sh
npm test
npm run test:upstream
npm run build
```

缓存改动必须覆盖：旧临时文件删除、近期文件保护、运行组件保留、连接配置保留、符号链接、路径变化、部分失败、阈值边界、1/7/30 天周期、禁用自动清理和安装/连接互斥。

设置页改动必须通过隔离 Zotero profile 的 `scripts/settings-host-smoke.js`，至少检查：

- 浅色和深色主题。
- 360px 左右的窄窗口无横向溢出。
- 输入控件高度和基线对齐。
- 键盘/按钮可用状态、保存反馈和定时刷新不覆盖草稿。
- 不写入用户真实文库、PDF、连接令牌或日常配置。

宿主测试结束后必须按精确 profile 路径停止隔离 Zotero，并删除临时 profile。不要停止用户日常 Zotero。

## 版本和发布

- 版本号必须同步更新：`package.json`、`package-lock.json` 根版本、`addon/manifest.json`、MCP 服务版本字符串和必要的测试 fixture。
- 发布说明写具体行为、兼容性和验证结果，不写废弃实现的过程叙述。
- 提交前运行 `git diff --check`，确认无令牌和本地路径，检查 XPI 内容和 `manifest.json` 版本。
- GitHub Actions `runtime.yml` 构建 macOS Apple Silicon/Intel、Windows x64、Linux x64/arm64，并执行 Node 22.13.1 兼容性测试。不要在本地伪造运行包校验值。
- Release 先核对 XPI 与源码逐文件一致、`runtime-manifest.json` 的 5 个平台资产和 SHA-256 一致，再发布 draft。正式发布后更新根目录 `updates.json` 的新版本、下载地址和 SHA-256，并从公开 raw URL 验证。
- 发布完成后再生成或替换本地安装包；不能把开发预览包称为正式版。安装后重启 Zotero，检查插件版本、MCP 状态和关键设置页。

## 交付沟通

用中文简洁说明结果、改动、测试和发布状态。明确区分“已写入仓库”“已构建”“已发布”“已安装”。如果云端构建仍在运行，不要声称发布完成；如果只生成预览包，不要声称用户本机已替换。
