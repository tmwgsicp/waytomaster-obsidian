# WaytoMaster for Obsidian

将 WaytoMaster 生态产品中有权阅读的内容保存到 Obsidian。当前 0.2.0 候选版支持 WeChatRSS；SocialRSS 和 InvestorRSS 尚未接入。

本项目的独立仓库为 [tmwgsicp/waytomaster-obsidian](https://github.com/tmwgsicp/waytomaster-obsidian)，仅通过产品公开 API 读取内容，不包含产品服务端、采集组件或服务端凭据。源码采用 [MIT 许可证](LICENSE) 开源，尚未提交 Obsidian 社区目录或发布正式稳定版。0.2.0 所需的账号服务、WeChatRSS 读取接口和授权页已上线，正在 Mac 专用笔记库内进行真实账号验收；尚未完成正式发布验收。

## 下载与安装（桌面测试版）

首次使用请先查看[功能与使用指南](https://wechatrss.waytomaster.com/obsidian)，也可以在 WeChatRSS「AI / 集成 → Obsidian · 笔记同步」找到同一份说明。

推荐使用桌面 Chrome 或 Edge 打开[网页安装助手](https://wechatrss.waytomaster.com/api/downloads/plugins/obsidian-preview/install)。笔记库就是存放 Obsidian 笔记的文件夹。已有笔记库可在 Obsidian 左下角的「管理笔记库」查看路径；新用户先在 Obsidian 创建，例如「文稿 / 我的资料库」。关闭 Obsidian，选择这个文件夹本身，允许浏览器修改文件，再点击安装。无需访问 GitHub、解压或查找隐藏目录。

安装助手沿用 WeChatRSS 网站的配色、字体和外观设置，可在顶部返回 SaaS 的 Obsidian 集成页或使用指南。插件版本与测试状态在页脚说明；安装完成后的返回按钮不会删除笔记或撤销已有连接。

安装完成后，打开 Obsidian，在「设置 → 第三方插件」启用 WaytoMaster，再进入插件设置连接账号。网页只写入三个插件文件，保留笔记、账号配置和同步进度；升级前备份旧插件文件，普通写入失败会尝试恢复。浏览器授权由用户确认，安装不会自动启用第三方插件。

Safari 或使用自定义配置目录时，可[下载 ZIP](https://wechatrss.waytomaster.com/api/downloads/plugins/obsidian-preview) 手动安装：关闭 Obsidian，将 `wechatrss` 文件夹放到笔记库的 `.obsidian/plugins/`（或实际配置目录）。升级只替换 `main.js`、`manifest.json`、`styles.css`，保留 `data.json`。移动端插件暂不支持。

当前需要桌面 Obsidian 1.11.4 或更新版本。Mac 已安装验证，Windows/Linux 实装与生产完整授权读取仍待验收；iOS/Android 暂不支持。此测试包不代表正式稳定版，也没有自动下载安装更新功能。

## 使用

要求桌面版 Obsidian 1.11.4 或更新版本。

1. 按上方说明安装，在 Obsidian 第三方插件设置中启用 **WaytoMaster**。首次体验建议使用单独的测试笔记库。
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
npm run build:installer
```

产物位于 `dist/`；`WaytoMaster-Obsidian-Install.html` 内嵌与当前构建相同的三个插件文件及校验值。ZIP 仅分发三个插件文件，测试数据、依赖目录与 `data.json` 不进入安装包。OAuth 协议处理复用 `oauth4webapi`。

已验证授权取消与错 state、续期并发、撤销、账号隔离、断点恢复和编辑保护。Mac Obsidian 1.14.4 已验证真实系统回跳、SecretStorage 恢复、重复同步、授权失效后的重连与断开，云端响应使用隔离测试数据；这些结果不代表生产真实账号全流程已通过。Windows/Linux 实装、生产 OAuth 授权读取及完整发布验收仍待完成。

## 许可证

本仓库代码采用 [MIT 许可证](LICENSE)。第三方依赖遵循各自许可证。插件开源不授予 WaytoMaster 云端产品的付费权益；读取内容仍需账号授权和相应产品权限。
