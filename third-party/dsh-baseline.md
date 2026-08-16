# DeepSeek Harness 固定基线与供应链状态

本文件记录 Test Agent 复用 DeepSeek Harness 的固定基线和供应链要求。它只固定来源和门禁，不代替已验证事实。

## 固定来源

- 上游仓库：`C:\works\harness`（仅作为源码直读来源，产品构建不得依赖该物理路径）
- 固定 commit：`47f943859bef60e4160492346772ded9b24f765a`
- 固定包版本：`0.1.0-rc.5`
- 许可证：MIT
- Node.js 要求：`^22.19.0 || >=24.0.0`

## 复用策略

优先直接复用固定版本公共包及其原始测试；仅在企业认证、设备治理、中央审计和现有测试插件适配处新增代码。任何包如果无法脱离上游 workspace 安装，应先构建完整发布闭包；仍不可用时才按固定 commit vendoring，并保留目录结构、版权、原始测试和补丁清单。禁止无来源复制少量函数后宣称“参考 DSH”。

## 供应链门禁（状态：未执行）

以下步骤在当前环境尚未执行，不能视为已验证：

1. 从固定 commit 运行 DSH 自带测试、release pack 和 packed-install。
2. 把通过验证的包及完整依赖闭包镜像到公司内部 npm 仓库。
3. Test Agent 使用 exact version 和 lockfile，仅从内部制品库构建。
4. 记录每个包的来源 commit、哈希、许可证和本地补丁。
5. 生成 Third-Party Notices 和 SBOM。
6. 每次 DSH 升级建立独立候选版本，不自动覆盖生产基线。

阻塞原因：当前环境无法访问上游 npm 注册表/公司内部制品库，且未提供可写镜像目标；离线依赖闭包尚未验证。

## 当前未验证项

- DSH 公共包在公司离线环境中的 workspace 依赖闭包；
- Windows ACL Sandbox 与公司终端安全软件、域策略的兼容性；
- CimiCode/GLM-5.1 作为 DSH Provider 的真实契约；
- 企业 SSO、设备证书、集中密钥和自动更新平台接口。
