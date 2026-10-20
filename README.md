# WaytoMaster for Obsidian

将 WaytoMaster 生态产品中有权阅读的内容保存到 Obsidian。当前 0.2.0 候选版支持 WeChatRSS；SocialRSS 和 InvestorRSS 尚未接入。

这是独立插件仓库，仅通过产品公开 API 读取内容，不包含产品服务端、采集组件或服务端凭据。尚未公开发布或提交社区目录，开源许可证将在正式发布前确定。0.2.0 所需的账号服务、WeChatRSS 读取接口和授权页已上线，正在 Mac 专用笔记库内进行真实账号验收；尚未完成正式发布验收。

## 下载与安装（桌面测试版）

无需访问 GitHub：[下载 WaytoMaster Obsidian 0.2.0 测试版](https://wechatrss.waytomaster.com/api/downloads/plugins/obsidian-preview)。文件由官方产品服务跳转到 OSS 下载，当前通道为手动安装和升级。

1. 关闭 Obsidian，将 ZIP 解压得到的 `wechatrss` 文件夹放入目标笔记库的 `.obsidian/plugins/`。若已自定义配置目录，请使用该笔记库实际目录。
2. 打开 Obsidian，在「设置 → 第三方插件」启用 WaytoMaster，再进入插件设置连接账号。
3. 升级时关闭 Obsidian，仅替换 `main.js`、`manifest.json`、`styles.css`，保留 `data.json` 和已有笔记；不要删除整个插件目录。

当前需要桌面 Obsidian 1.11.4 或更新版本。Mac 已安装验证，Windows/Linux 实装与生产完整授权读取仍待验收；iOS/Android 暂不支持。此测试包不代表正式稳定版，也没有自动下载安装更新功能。

## 使用

要求桌面版 Obsidian 1.11.4 或更新版本。

1. 将构建后的 `main.js`、`manifest.json`、`styles.css` 放入专用测试笔记库的 `.obsidian/plugins/wechatrss/`，在第三方插件设置中启用 **WaytoMaster**。
2. 点击「连接 WeChatRSS」，在浏览器登录原来的 WeChatRSS 账号，确认账号与只读授权，再返回 Obsidian。无需填写服务地址、API Key 或 Secret，也无需登录微信。
3. 选择公众号，点击「手动同步」或「开启自动同步」。默认保存在 `WeChatRSS` 文件夹，按公众号整理，可以更改保存位置。

自动同步立即检查一次，以后每小时检查，需要保持 Obsidian 打开。「暂停」保留笔记和进度；重启会恢复连接，但自动同步需明确重新开启。旧日期筛选会显示，可点击取消。

「断开连接」停止同步、清除本机保存的授权并请求服务端撤销。若网络异常，按界面提示到 WaytoMaster 账号中心确认撤销。已有笔记不会删除。

## 账号、网络与数据

- 使用原 WeChatRSS 账号和已有套餐、余额与订阅；需要有效的付费套餐及相应阅读权益。插件不绕过套餐、配额或文章权限。
- 联网服务为 `https://account.waytomaster.com` 和 `https://wechatrss.waytomaster.com`，用于授权、身份验证和读取内容。授权不允许采集、购买或修改订阅。
- 浏览器授权使用 PKCE。访问令牌仅在内存中；续期授权交由 Obsidian 原生 SecretStorage 保存，不写入普通插件 `data.json`、笔记或日志。授权到期或续期失败时重新连接，已有内容保留。
- 不上传笔记库，无客户端遥测，不读取笔记库以外的文件。笔记及同步进度在本地保存；备份时同时保留插件 `data.json`，另一台设备需要单独授权。
- 图片保留远程链接，查看时可能访问图片所在服务；暂不支持离线图片。

## 同步与升级

重复同步复用已有笔记，用户修改或正在编辑的内容不会被覆盖。网络中断后可继续，服务限频时等待。每轮最多读取 20 页，更多内容在后续轮次继续。更改保存位置不会搬迁原有笔记。目前没有批注回传、冲突合并或跨设备状态合并。

插件 ID 保留 `wechatrss`，以兼容既有安装与数据位置。升级时仅替换三个插件文件，不删除插件目录或 `data.json`。已经验证过稳定账号身份的范围可以续用；早期从未验证身份的 Key 范围无法自动证明归属，OAuth 不会擅自接管或合并。完整旧版升级流程仍待验收。

## 构建与验证

要求 Node.js 22。

```sh
npm ci
npm test
npm run build
```

产物位于 `dist/`，仅分发三个插件文件，测试数据、依赖目录与 `data.json` 不进入安装包。OAuth 协议处理复用 `oauth4webapi`。

已验证授权取消与错 state、续期并发、撤销、账号隔离、断点恢复和编辑保护。Mac Obsidian 1.14.4 在专用笔记库内通过真实系统回跳、SecretStorage 恢复、重复同步、授权失效后的重连/清除和断开验证，云端响应采用隔离数据。隔离验证后曾恢复 0.1.1；配套上线后，Mac 专用笔记库已升级 0.2.0，73 篇原有笔记哈希不变，自动同步关闭。公网登录入口已验证，等待本人登录完成生产 OAuth 联调；Windows 实装及完整发布验收尚未完成。
