# CIMDEV Test Agent

Electron + Vue 3 的 PC 端 Test Agent 初版。当前提供可运行的安全模拟闭环，并预留 CimiCode CLI 真实进程适配器。

## 当前能力

- 选择本地项目目录；
- 配置系统、版本及单元/回归/UI 测试类型；
- 展示测试计划、任务分发、实时执行日志和三路状态；
- 生成模拟报告指标和制品清单；
- 通过 Electron 主进程安全启动 CimiCode CLI，默认关闭真实模式；
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

## 当前边界

- Workspace 查询为模拟日志，尚未接入真实 API；
- 报告数据为演示数据；
- CimiCode 命令契约尚未核验；
- Java、Vue、Playwright 测试工具尚未接入真实项目；
- 尚未实现安装包、自动更新、登录权限和中心服务。
