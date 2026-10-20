# Obsidian 笔记同步

把 WeChatRSS 公众号文章存进 Obsidian，与自己的笔记连在一起。

- 按公众号整理，保存为 Markdown。
- 手动或每小时自动同步，重复同步不重复创建。
- 保留你修改过的笔记，断开连接也不会删除内容。

[安装插件](https://wechatrss.waytomaster.com/dashboard/integrations?tab=obsidian&install=1) · [下载 ZIP](https://wechatrss.waytomaster.com/api/downloads/plugins/obsidian-preview) · [使用帮助](https://wechatrss.waytomaster.com/dashboard/integrations?tab=obsidian)

## 开始使用

1. **安装**：用电脑上的 Chrome / Edge 打开安装助手，选择或拖入存放笔记的位置，找到笔记库后退出 Obsidian，再安装。第一次使用时，先在 Obsidian“快速开始”中新建仓库，记住存放位置，再回来安装。
2. **连接**：重新打开 Obsidian，在「设置 → 第三方插件」启用 WaytoMaster。进入插件设置，点击「连接 WeChatRSS」，登录原账号。
3. **同步**：选择公众号，点击「手动同步」。文章保存在「WeChatRSS → 公众号名称」下，重名时加序号区分。

需要桌面 Obsidian 1.11.4+ 和有效的 WeChatRSS 付费套餐、相应阅读权益，无需填写 API Key 或服务地址。目前接入 WeChatRSS。

<details>
<summary>安装、更新与兼容性</summary>

笔记库就是存放笔记的文件夹。首次使用时在 Obsidian 新建一个；已有文件夹则选择「打开本地仓库」。安装助手可以从你选的位置查找笔记库，不需要远程同步或购买 Obsidian Sync。

Safari 或自定义配置目录可下载 ZIP：关闭 Obsidian，将 `wechatrss` 文件夹放入笔记库的 `.obsidian/plugins/`（或实际配置目录），重新打开并启用插件。Mac 按 Command + Shift + . 显示隐藏文件。

升级时再次运行安装助手，或只替换 `main.js`、`manifest.json`、`styles.css`，保留 `data.json` 和笔记。换电脑需要重新授权。目前不支持自动安装更新或跨设备状态合并。

Windows/macOS 桌面基础流程已验证；Linux 尚未完成验证，手机端暂不支持。尚未上架 Obsidian 社区插件目录，请使用上方安装入口。

</details>

<details>
<summary>同步与账号</summary>

自动同步每小时检查，需要保持 Obsidian 打开，重启后重新开启。文章按公众号保存，图片需要联网查看。

沿用原账号的套餐、余额、订阅和阅读权益。没有文章时，先确认同一账号能在 WeChatRSS 阅读正文；连接失效可重新连接。插件不会自动获取全部历史文章。

授权时先确认 WeChatRSS 账号，再进入账号中心确认只读权限。没有统一账号时会自动开通，不必重复注册。账号中心未登录时需要登录：新开通的账号可使用原平台密码；已有统一账号则使用它原有的密码。

可在插件设置中断开连接，或在 [WaytoMaster 账号中心](https://account.waytomaster.com/me/apps) 管理授权。笔记和同步进度保存在本地，备份时保留插件数据。

</details>

## 隐私

插件不上传笔记库，无客户端遥测。仅连接 `account.waytomaster.com` 和 `wechatrss.waytomaster.com` 进行账号授权与内容读取；查看远程图片时会访问图片所在服务。

使用浏览器只读授权。访问令牌仅在内存中，续期授权保存在 Obsidian 原生 SecretStorage，不写入普通插件配置或笔记。

<details>
<summary>参与开发</summary>

需要 Node.js 22：

```sh
npm ci
npm test
npm run build
npm run build:installer
```

产物位于 `dist/`。插件 ID 保留 `wechatrss`，OAuth 复用 `oauth4webapi`。本仓库只包含插件与安装助手。

</details>

## 许可证

[MIT](LICENSE)。第三方依赖遵循各自许可证。插件开源不授予云端产品的付费权益。
