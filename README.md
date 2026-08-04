# CIMDEV Test Agent

## 当前推荐架构

```text
Electron + Vue3 操作台
        ↓ REST / 轮询（服务端同时提供 SSE）
Java 17 + Spring Boot 控制服务
        ↓ MySQL任务队列 / Worker租约
Node.js Test Worker
        ↓
CimiCode / Codex CLI / 真实测试工具
```

- Electron只负责项目选择、发起任务和展示状态。
- Java服务负责项目、任务、日志、调度、Worker、报告和本地文件存储。
- Node Worker负责读取本地或检出的源码，调用Agent和真实测试工具。
- 生产默认使用MySQL；报告、截图和原始日志先保存到Java服务器本地目录。
- 原Node HTTP服务保留为兼容和开发验证入口，不再是推荐控制面。

## 启动Java控制服务

先创建MySQL账号并通过环境变量提供连接信息，不要把密码写入仓库：

```powershell
$env:TEST_AGENT_MYSQL_URL='jdbc:mysql://127.0.0.1:3306/cimdev_test_agent?useUnicode=true&characterEncoding=utf8&serverTimezone=Asia/Shanghai&createDatabaseIfNotExist=true'
$env:TEST_AGENT_MYSQL_USER='test_agent'
$env:TEST_AGENT_MYSQL_PASSWORD='<通过本机安全配置提供>'
$env:TEST_AGENT_STORAGE_ROOT='C:\test-agent-data'

cd server
mvn package
java -jar target\test-agent-server-0.1.0-SNAPSHOT.jar
```

服务默认监听 `127.0.0.1:8088`，Flyway会自动执行MySQL建表脚本。当前迁移已按MySQL 8设计。

## 启动测试Worker

```powershell
$env:TEST_AGENT_SERVER_URL='http://127.0.0.1:8088'
$env:TEST_AGENT_PROVIDER='codex-cli'
$env:CODEX_CLI_EXECUTABLE="$env:APPDATA\npm\codex.cmd"
$env:TEST_AGENT_WORKER_CAPABILITIES='windows,node,codex-cli,go,java,vue,playwright'

npm run build
npm run worker
```

Worker会注册、心跳、按能力标签领取任务、回传结构化日志，并把报告和截图上传到Java服务的本地存储目录。

## 启动Electron操作台

```powershell
$env:TEST_AGENT_SERVER_URL='http://127.0.0.1:8088'
npm run dev
```

Electron不再直接执行测试，也不再内嵌任务数据库；所有任务均通过Java服务创建，再由独立Worker执行。

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

## QA Pipeline 接口服务

桌面程序启动时会在 `127.0.0.1:4318` 同时启动本机 API。也可以不启动桌面界面，使用独立服务模式：

```powershell
$env:TEST_AGENT_PROVIDER='codex-cli'
$env:CODEX_CLI_EXECUTABLE="$env:APPDATA\npm\codex.cmd"
npm run build
npm run service
```

可配置项：

- `TEST_AGENT_API_HOST`：默认 `127.0.0.1`；除非已配置认证和网络边界，不要改为公网地址。
- `TEST_AGENT_API_PORT`：默认 `4318`。
- `TEST_AGENT_DATA_DIR`：独立服务的数据目录，默认当前目录下 `.test-agent-service`。
- `TEST_AGENT_CONCURRENCY`：同时执行的 Worker 数，默认 `1`。
- `CODEX_CLI_TIMEOUT_MS`：单任务超时，默认 30 分钟。

主要接口：

| 方法 | 地址 | 说明 |
|---|---|---|
| GET | `/health` | 服务健康检查 |
| GET | `/api/runtime` | Provider、队列和并发状态 |
| GET/POST | `/api/projects` | 查询或登记系统项目 |
| GET/POST | `/api/tasks` | 查询或创建测试任务 |
| GET | `/api/tasks/{id}` | 查询任务快照 |
| POST | `/api/tasks/{id}/cancel` | 取消任务 |
| POST | `/api/tasks/{id}/retry` | 重试任务 |
| GET | `/api/tasks/{id}/logs` | 查询结构化日志 |
| GET | `/api/tasks/{id}/events` | SSE 实时任务事件 |
| GET | `/api/tasks/{id}/report` | 查询综合报告 |
| GET | `/api/tasks/{id}/artifacts` | 查询产物列表 |
| GET | `/api/tasks/{id}/artifact?path=...` | 下载已登记产物 |
| GET/POST | `/api/schedules` | 查询或创建周期调度 |
| PUT/DELETE | `/api/schedules/{id}` | 更新或删除调度 |
| POST | `/api/webhooks/version-release` | 版本上线触发回归任务 |

服务使用 SQLite WAL 持久化项目、任务快照、结构化日志和调度配置。程序异常退出后，未完成任务会在下次启动时标记为失败，不会伪装为完成。当前队列是单机数据库加内存 Worker；扩展为多节点部署时，应替换为 Redis/RabbitMQ 和远程隔离 Worker。

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
