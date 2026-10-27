# Chrome Web Store 上架材料

> 逐步提交清单见 [`submission-checklist.md`](submission-checklist.md)。

## 基本信息

| 字段 | 内容 |
|---|---|
| 商店名称（中文，需与 manifest 一致） | 关注整理所 · 互关检测与关注清理 |
| 英文名（用于描述/宣传） | TidyFollows — Mutual Follow Detection |
| 短描述（中文） | 检测 X 互关关系，找出没有回关你的人，在你确认后逐个清理。数据只保存在本机。 |
| 短描述（英文） | Detect mutual follows on X, find accounts that don't follow you back, and unfollow selected accounts after confirmation. All data stays local. |
| 类别 | 生产力工具（Productivity） |
| 语言 | 中文（简体），可追加 English |
| 官网 | https://tidyfollows.1475369.xyz |
| 支持 | https://tidyfollows.1475369.xyz/support |
| 隐私政策 | https://tidyfollows.1475369.xyz/privacy |

> 商店名称不要包含 X / Twitter，避免商标与隶属暗示；在描述里写「for X」即可。

## 详细描述（中文）

```
把关注理清楚，把时间留给值得的人。

关注整理所是一款 X（Twitter）关注关系整理工具。它会读取你自己的「正在关注」和「关注我的人」名单，帮你找出：

• 你关注了、对方没有回关的人
• 对方关注了你、你还没有回关的人
• 互相关注的人

你可以先预览名单，再勾选要清理的账号，确认后逐个取关。支持特别关注保护、随时停止、断点续跑。

【本地运行】
• 使用你当前浏览器已登录的 x.com 会话，不需要购买 X API
• 账号、关系记录、任务进度全部保存在本机浏览器
• 不上传名单、账号或任何个人数据到服务器
• 没有统计、广告或远程代码

【安全与节奏】
• 取关必须经过你勾选和二次确认，不会自动执行
• 固定 4–8 秒随机间隔，降低触发 X 限流的概率
• 特别关注的人永远不会被批量清理
• 任务可随时停止，中断后可继续

【说明】
• 本扩展不是 X Corp. 官方产品，与 X 无隶属关系
• X 的网页接口可能变化，若检测失败可在设置中刷新接口参数
• 请遵守 X 的服务条款，合理控制操作频率

数据只留在你的电脑上。
```

## 详细描述（英文）

```
TidyFollows helps you understand and tidy up your X (Twitter) follow relationships. It reads your own Following and Followers lists and shows:

• People you follow who don't follow you back
• People who follow you but you don't follow back
• Mutual follows

Review the list, select the accounts you want to clean up, and confirm. Protected accounts are never touched. Tasks can be stopped and resumed.

Everything runs locally:
• Uses your existing x.com browser session — no X API key required
• Accounts, relationship records and task progress stay in your browser
• No uploads, analytics, ads or remote code

Unfollows always require your selection and confirmation, with a fixed 4–8 second randomized interval. This extension is not affiliated with X Corp.
```

## 权限说明（用于审核备注）

| 权限 | 用途 |
|---|---|
| `storage` / `unlimitedStorage` | 在本机保存关系记录、特别关注、任务进度 |
| `tabs` | 打开并管理专用的 x.com 执行标签页 |
| `scripting` | 向已经打开的 x.com 标签页补注入内容脚本 |
| `alarms` | 清理预热标签页、任务看门狗 |
| `host_permissions: https://x.com/*, https://twitter.com/*` | 只在实际使用 X 时读取用户自己的关注关系并执行用户确认的操作 |

没有 `cookies` 权限；没有远程代码；没有分析或广告 SDK。

## 数据使用披露建议

- 不收集、不传输、不出售个人数据
- 访问 X 账号信息与关注/粉丝名单，仅用于在本机提供功能
- 数据保存在 `chrome.storage.local`，可在「备份与恢复 → 清空所有数据」删除
- 商店数据披露表如询问，可如实选择「网站内容 / 身份验证信息」，并说明仅本地处理、不上传

## 单一用途说明（可粘贴）

```
中文：在本地检测并整理用户自己的 X 关注关系：读取用户本人的关注/粉丝名单，计算互关关系，并在用户逐条勾选与确认后执行取关。所有数据仅保存在本机浏览器。

English: Local detection and management of the user's own X follow relationships. The extension reads the user's own Following/Followers lists, computes mutual-follow relationships, and unfollows only accounts the user explicitly selects and confirms. All data stays in the browser.
```

## 审核备注（可粘贴）

```
Single purpose: local management of the user's own X follow relationships.

The extension uses the user's existing x.com session to read their own Following/Followers lists and to unfollow accounts the user explicitly selects and confirms. It does not collect, transmit, or sell any data; all records stay in chrome.storage.local. There is no remote code, analytics, or advertising.

A MAIN-world content script observes the x.com web client's own GraphQL request metadata (query id, features, transaction id) and captures the first page of the user's own follow lists locally. This is required because X's web endpoints reject replayed requests. No data leaves the browser.

The extension reuses the page's own session. It reads the ct0 CSRF token from document.cookie in the x.com page context only to sign requests to X; it does not request the cookies permission, does not read other cookies, and never transmits the token elsewhere.

Unfollows require explicit selection and confirmation with a fixed 4–8 second randomized interval. Protected accounts are always skipped. This extension is not affiliated with X Corp.
```

## 素材清单

- [x] 128×128 图标（`icons/icon128.png`）
- [x] 商店截图 1280×800 ×3（RGB、无 alpha，2026-10-25 用当前版本重新生成）：
  1. `docs/preview-overview.png` — 概览
  2. `docs/preview-relations.png` — 关系名单
  3. `docs/preview-settings.png` — 设置
- [x] 小型宣传图 440×280（`docs/promo-440x280.png`）
- [x] 隐私政策公网 URL：https://tidyfollows.1475369.xyz/privacy
- [x] 支持邮箱 / 主页：support@1475369.xyz / https://tidyfollows.1475369.xyz
- [x] ZIP 包（manifest 位于根目录）：`dist/tidyfollows-1.0.2.zip`，由 `./scripts/package.sh` 生成

## 上架前检查

- [ ] 商标检索（CNIPA / USPTO）与 `tidyfollows` 域名、社交账号可用性
- [x] 商店名称与 manifest `name` 一致：关注整理所 · 互关检测与关注清理
- [x] 版本号 1.0.2，ZIP 已重新打包
- [x] 描述里没有「自动取关」「批量取消关注」等强自动化措辞
- [x] 隐私政策 URL 可公开访问
- [x] 截图使用演示数据，不包含真实账号
