# CIMDEV Test Agent

Electron + Vue 3 的 PC 端 Test Agent。当前默认使用内置 Local Go Runner 执行现有 Go 测试，Claude Code 用于后续生成和补强测试，并保留 CimiCode 适配入口。应用不生成模拟测试结果；执行失败时直接披露真实原因。

## 使用 Codex CLI（推荐智能 Provider）

Codex CLI 负责分析代码、生成或补强测试、调用项目真实测试工具，并返回结构化结果。测试是否通过仍以真实编译和测试命令的退出结果为准。

```powershell
$env:TEST_AGENT_PROVIDER='codex-cli'
$env:CODEX_CLI_EXECUTABLE="$env:APPDATA\npm\codex.cmd"
npm run dev
```

启动前可执行以下命令检查环境：

```powershell
& "$env:APPDATA\npm\codex.cmd" --version
& "$env:APPDATA\npm\codex.cmd" login status
& "$env:APPDATA\npm\codex.cmd" exec --ephemeral --skip-git-repo-check --sandbox read-only "只回复 OK"
```

应用通过 `codex exec --json --sandbox workspace-write` 非交互调用 Codex，实时消费 JSONL 事件，并使用 JSON Schema 约束最终报告。产物写入被测项目的 `.test-agent/results/<时间戳>/`。可用 `CODEX_CLI_TIMEOUT_MS` 调整默认 30 分钟超时。

## 当前能力

- 选择本地项目目录；
- 配置系统、版本及单元/回归/UI 测试类型；
- 展示实时执行日志、三路状态、真实报告指标和实际制品路径；
- 通过 Electron 主进程启动 Claude Code 非交互 CLI；
- 要求 Claude Code 调用真实 Go、Maven、Gradle、npm、Vitest、Playwright 等工具，最终结果以真实退出结果为准；
- Provider 失败时不生成替代数字；
- `contextIsolation`、禁用渲染进程 Node 权限、`spawn` 禁用 shell。

## 开发运行

```powershell
npm install
npm run dev
```

## 验证

```powershell
npm run typecheck
npm test
npm run build
```

## 接入真实 CimiCode

P0 阶段确认公司 Fork 的非交互协议后，再设置：

```powershell
$env:CIMICODE_ENABLE_REAL='true'
$env:CIMICODE_EXECUTABLE='<CimiCode可执行文件>'
$env:CIMICODE_ARGS_JSON='["<非交互参数>"]'
npm run dev
```

真实模式通过标准输入传递任务提示词，不使用 `shell` 拼接命令。环境变量中的参数必须由受信任管理员配置，不能直接暴露给普通界面输入。

## 使用 Claude Code

安装并登录官方 Claude Code：

```powershell
npm install -g @anthropic-ai/claude-code
claude auth login
claude auth status
```

Test Agent 会自动查找 npm 全局安装目录中的原生 `claude.exe`。也可以显式配置：

```powershell
$env:CLAUDE_CODE_EXECUTABLE='<claude.exe绝对路径>'
$env:CLAUDE_CODE_MAX_TURNS='30'
$env:CLAUDE_CODE_MAX_BUDGET_USD='5'
```

支持三种就绪方式：Claude Code OAuth 登录、`ANTHROPIC_API_KEY`，或 `ANTHROPIC_AUTH_TOKEN` + `ANTHROPIC_BASE_URL` 企业网关。环境变量必须在启动 Test Agent 之前配置，以便 Electron 主进程和 Claude Code 子进程继承。

要显式启用 Claude Code Provider：

```powershell
$env:TEST_AGENT_PROVIDER='claude-code'
```

不设置 `TEST_AGENT_PROVIDER` 时使用 Local Go Runner。它会发现项目内 `.preview-toolchain/go/bin/go.exe` 或 `.toolchain/go/bin/go.exe`，对 `portal`、`gateway` module 执行 `go test -json -cover ./...`，并在项目 `.test-agent/results/` 下保存原始 JSONL 与报告。

用户点击“发起真实测试”会产生真实模型调用费用，并可能在所选项目内创建或修改测试文件。当前默认允许读取、检索、编辑和写入，并仅允许 Go、Maven、Gradle、npm、npx 及只读 Git 状态命令。Go 项目会优先发现项目内 `.preview-toolchain/go/bin` 或 `.toolchain/go/bin`。

## 当前边界

- Workspace 尚未接入；
- Claude Code 必须由用户完成登录；
- CimiCode 命令契约尚未核验；
- 尚未在客户 Java/Vue 试点项目中完成真实端到端验收；
- 尚未实现安装包、自动更新、登录权限和中心服务。
