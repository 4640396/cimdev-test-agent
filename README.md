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

容器部署先复制`deploy/.env.example`为`deploy/.env`并替换全部示例值。Compose不会为数据库或API凭据提供可运行的默认口令；应用使用独立`test_agent`数据库账号，控制服务容器以非root用户、只读根文件系统和移除Linux capabilities的方式运行。

生产环境应使用角色Token分离控制面权限，格式为`角色=token1|token2;角色=token`：

```powershell
$env:TEST_AGENT_ROLE_TOKENS='admin=<admin-token>;operator=<operator-token>;viewer=<viewer-token>;worker=<worker-token>'
```

- `admin`：全部接口及审计查询；
- `operator`：项目、任务、计划与报告操作，但不能访问审计或Worker内部接口；
- `viewer`：只读业务接口，不含审计；
- `worker`：仅Worker注册、心跳和任务执行接口。

`TEST_AGENT_API_TOKEN`作为兼容管理员Token保留；生产环境应逐步迁移到角色Token，并为Desktop和Worker配置不同凭据。

## 启动Test Worker

```powershell
$env:TEST_AGENT_SERVER_URL='http://127.0.0.1:8088'
$env:TEST_AGENT_WORKER_API_TOKEN='<worker-role-token>'
$env:TEST_AGENT_PROVIDER='codex-cli'
$env:CODEX_CLI_EXECUTABLE="$env:APPDATA\npm\codex.cmd"
$env:TEST_AGENT_WORKER_CAPABILITIES='windows,node,codex-cli,go,java,vue,playwright'
$env:TEST_AGENT_ALLOWED_PROJECT_ROOTS='C:\works\approved-projects;D:\shared\test-workspaces'

npm run build
npm run worker
```

生产Worker必须通过`TEST_AGENT_ALLOWED_PROJECT_ROOTS`限制可测试目录；Windows使用分号、Linux使用冒号分隔多个根目录。Worker会解析真实路径后再检查包含关系，因此白名单目录内指向外部位置的符号链接也会被拒绝。未配置时仅允许Worker启动目录及其子目录，便于本地开发且不会默认开放整块磁盘。

对于已经拥有Maven测试套件、只需要确定性执行与质量门禁的项目，可设置`TEST_AGENT_PROVIDER=existing-maven`。它是Agent Provider而不是第四个测试插件：只负责把现有`*Test.java`、`*Tests.java`和`*IT.java`清点成结构化测试计划，真正执行仍唯一经过`maven_test`及其隔离Executor。

`maven_test`会把受限长度的原始工具输出保存为每次运行的`maven-test.log`制品，便于复核编译、测试发现和基础设施错误；质量门禁仍只使用结构化解析结果作决定，不采信Agent自行报告的通过数字。

Worker注册、心跳、按能力标签领取任务，调用Provider和真实测试工具，并回传结构化日志、报告与制品。

### Worker测试运行时

Worker借鉴DeepSeek Harness的能力分层，但保持专用测试Agent边界：

- `test_plan`、`maven_test`、`quality_gate`是固定的测试工作流插件；启动后注册表密封。
- 测试执行能力通过Definition/Provider/Consumer接口解耦；当前`maven`使用本地Provider，后续可替换为容器或远程Provider。
- 每个任务在`.test-agent/runs/<taskId>/events.jsonl`生成单调序号、版本化的追加式事件日志，并在任务完成前按序、幂等上送Java控制面，用于中央审计和回放。
- 插件支持超时、取消和仅限显式基础设施错误的有限重试；测试断言失败不会自动重试。

插件策略可由部署环境覆盖，并在Worker启动时完成校验：

```powershell
$env:TEST_AGENT_PLUGIN_POLICY_JSON='{"maven_test":{"timeoutMs":300000,"maxAttempts":1,"retryDelayMs":0}}'
```

允许的插件名只有`test_plan`、`maven_test`、`quality_gate`；未知插件、非正数超时和超过3次的重试配置会直接拒绝执行。

生产Worker可将Maven切换到Docker隔离Provider。镜像需由运维提前拉取；默认容器断网、移除Linux capabilities、启用`no-new-privileges`、只读根文件系统，并限制PID、内存和CPU：

```powershell
$env:TEST_AGENT_EXECUTION_MODE='docker'
$env:TEST_AGENT_WORKER_CAPABILITIES='windows,docker,codex-cli,java,vue,playwright'
$env:TEST_AGENT_MAVEN_DOCKER_IMAGE='maven:3.9.11-eclipse-temurin-17'
$env:TEST_AGENT_MAVEN_REPOSITORY='C:\test-agent-cache\maven-repository'
$env:TEST_AGENT_EXECUTION_MEMORY='2g'
$env:TEST_AGENT_EXECUTION_CPUS='2'
$env:TEST_AGENT_EXECUTION_PIDS_LIMIT='512'
```

Docker执行模式应由可信构建流程预热`TEST_AGENT_MAVEN_REPOSITORY`。Worker将其只读挂载到容器并以Maven离线模式使用，测试容器仍保持`--network none`；未配置仓库时，只有镜像本身已经预装全部插件和依赖的项目才能成功运行。

当前迭代默认使用`local`执行模式。生产环境必须显式设置`TEST_AGENT_ALLOWED_PROJECT_ROOTS`，Worker只接受真实路径位于白名单内的项目；需要容器隔离时再设置`TEST_AGENT_EXECUTION_MODE=docker`并启用Docker Provider。

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
npm run readiness:static
```

真实MySQL验收必须使用隔离测试库。复制`deploy/mysql-it.env.example`为仓库根目录`.env.mysql-it`并填写本机凭据，然后执行`npm run test:mysql`；也可以直接提供同名环境变量。该文件已被Git忽略。脚本拒绝`mysql`等系统库、正式库`cimdev_test_agent`以及未以`_it`或`_test`结尾的库名；密码仅通过子进程环境传递，不会出现在Maven命令行。默认连续执行两遍完整套件，并断言Flyway当前版本为V5，用于同时验证空库迁移后的行为和已有schema重复启动。生产基线采用Compose中固定的MySQL 8.4；迁移也已在本地MySQL 5.7通过，但该版本已超出当前Flyway社区版支持范围，只作为兼容性结果，不作为推荐生产版本。

控制服务暴露标准Spring Boot探针：`/actuator/health/liveness`用于判断进程存活，
`/actuator/health/readiness`用于判断是否可接收流量。Readiness会校验至少配置了一种认证凭据、
制品目录可写，且任务租约不少于Worker两个心跳周期；响应只公开检查结果，不公开Token或目录值。

中央`audit_log`是控制面审计事实源：人工操作记录为`role:<角色>`，Worker生命周期记录为`worker:<id>`，计划触发和Webhook分别使用稳定系统身份。任务创建、领取、完成、失败、取消以及项目、计划和Worker身份变更均写入该表；重复的同结果终态上报不会制造第二条事实，不同终态上报返回409。

OTLP链路外送默认关闭，避免未部署Collector时持续污染服务日志；接入企业观测平台后显式设置`TEST_AGENT_OTLP_ENABLED=true`和`OTEL_EXPORTER_OTLP_ENDPOINT`。

上线前在部署机执行`npm run readiness:production`。该门禁会拒绝缺失、示例值、短值或跨角色复用的密钥，并验证控制面readiness和执行模式匹配的在线Worker。本地模式要求显式、可读的项目根目录白名单和`java` Worker，不依赖Docker或MySQL root密码；Docker模式额外验证root密码、离线Maven仓库、Docker Engine、Compose模型及`java+docker` Worker。只有全部显示`PASS`且命令退出码为0，才具备进入客户项目试点的基础条件。

真实多Worker验收需要设置`TEST_AGENT_E2E_PROJECT_PATHS`为两个由所有Worker均可访问、彼此独立的绝对Maven工作区（Windows用分号、Linux用冒号分隔），并执行`npm run e2e:production -- --confirm-production-e2e`。脚本拒绝让两个任务共享同一输出目录；只有两条真实任务均通过质量门禁且分别由不同的合格Worker完成时才返回0：本地模式要求`java`，Docker模式要求`java+docker`；未提供确认参数时不会创建任务。

## 当前边界

- Workspace尚未正式接入；
- CimiCode命令契约尚未核验；
- 本地MySQL双轮迁移与双Worker竞争执行已经验收；服务高可用、故障注入和Docker隔离仍需在正式基础设施中验收；
- 已实现角色Token、Worker独立身份、任务所有权校验和密钥安全轮换；尚未接入企业SSO、集中密钥托管与证书身份；
- 尚未在客户Java/Vue试点项目中完成单元、回归、UI三类测试正式验收；
- C++与VB需要专用Windows Worker池和真实系统PoC；
- 目录重组完成不代表企业级验收通过。
