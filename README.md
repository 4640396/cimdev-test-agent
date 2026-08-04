# CIMDEV Test Agent

面向企业系统的独立QA Pipeline。当前采用一个Monorepo、三个部署单元：

```text
apps/desktop                  Electron + Vue 3 操作台
services/control-server       Java 17 + Spring Boot 控制面
workers/runner                Node.js Test Worker执行面
contracts                     Desktop与Worker共享契约
legacy/node-control-plane     早期Node控制面，仅供迁移追溯
```

## 架构边界

```text
Electron Desktop
        ↓ REST / SSE
Java Control Server
        ↓ MySQL任务队列 / Worker租约
Node Test Worker
        ↓
CimiCode / Codex CLI / 真实测试工具
```

- Desktop只负责项目选择、发起任务和展示状态。
- Java服务是项目、任务、日志、调度、Worker、报告和制品的唯一正式控制面。
- Worker负责读取本地或检出的源码，调用Agent和真实测试工具。
- 生产默认使用MySQL；报告、截图和原始日志首期保存到Java服务器本地目录。
- `legacy/node-control-plane`不进入正式构建和启动脚本，不再新增功能。

## 启动Java控制服务

先创建MySQL账号，并通过环境变量提供连接信息：

```powershell
$env:TEST_AGENT_MYSQL_URL='jdbc:mysql://127.0.0.1:3306/cimdev_test_agent?useUnicode=true&characterEncoding=utf8&serverTimezone=Asia/Shanghai&createDatabaseIfNotExist=true'
$env:TEST_AGENT_MYSQL_USER='test_agent'
$env:TEST_AGENT_MYSQL_PASSWORD='<通过本机安全配置提供>'
$env:TEST_AGENT_STORAGE_ROOT='C:\test-agent-data'

cd services\control-server
mvn package
java -jar target\test-agent-server-0.1.0-SNAPSHOT.jar
```

服务默认监听`127.0.0.1:8088`，Flyway自动执行数据库迁移。

## 启动Test Worker

```powershell
$env:TEST_AGENT_SERVER_URL='http://127.0.0.1:8088'
$env:TEST_AGENT_PROVIDER='codex-cli'
$env:CODEX_CLI_EXECUTABLE="$env:APPDATA\npm\codex.cmd"
$env:TEST_AGENT_WORKER_CAPABILITIES='windows,node,codex-cli,go,java,vue,playwright'

npm run build
npm run worker
```

Worker注册、心跳、按能力标签领取任务，调用Provider和真实测试工具，并回传结构化日志、报告与制品。

## 启动Desktop

```powershell
$env:TEST_AGENT_SERVER_URL='http://127.0.0.1:8088'
npm run dev
```

Desktop不直接执行测试，也不内嵌任务数据库。

## Agent Provider

当前包含以下适配入口：

- `cimicode`：公司正式目标，待核验OpenCode Fork的非交互契约和GLM-5.1配置；
- `codex-cli`：当前可用于真实研发验证；
- `claude-code`：可选验证Provider；
- `local-go`：确定性的本地Go测试入口。

模型负责理解、生成和失败分析。测试是否通过必须以Maven、Gradle、Vitest、Playwright、CTest、MSBuild等真实工具及其原始报告为准。

## 构建与验证

```powershell
npm run typecheck
npm test
npm run build
npm run server:build
```

## 当前边界

- Workspace尚未正式接入；
- CimiCode命令契约尚未核验；
- MySQL多Worker竞争、服务高可用和执行隔离尚未验收；
- 认证目前仍是基础API Token，尚未接入SSO、RBAC和Worker独立身份；
- 尚未在客户Java/Vue试点项目中完成单元、回归、UI三类测试正式验收；
- C++与VB需要专用Windows Worker池和真实系统PoC；
- 目录重组完成不代表企业级验收通过。
