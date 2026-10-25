# Chrome Web Store 提交清单 — v1.0.0

> 配合 `docs/store-listing.md` 使用。所有 URL 已于 2026-10-25 验证可公开访问。

## 0. 账号前提

- [ ] 开发者账号已支付 $5，联系邮箱已验证
- [ ] 已开启两步验证（未开启无法发布）
- [ ] 发布者身份验证已完成（新开发者通常需要，可能要等 1–3 个工作日）
- [ ] 发布者名称（公开显示）已设置
- [ ] 如果分发到欧盟：已完成 trader / non-trader 声明；不想处理就先把 EU 地区排除

## 1. 上传包

| 项 | 值 |
|---|---|
| 文件 | `dist/tidyfollows-1.0.0.zip` |
| SHA256 | `9dc0d6d9922e86197dc1aa846a29ff7dfebf95d3529f106ab16db55e67d7b7cd` |
| 版本 | 1.0.0 |
| 内容 | 仅 `manifest.json`、`background.js`、`src/`、`icons/` |

上传后确认后台显示的版本是 1.0.0，名称是「关注整理所 · 互关检测与关注清理」。

## 2. Store listing

| 字段 | 内容 |
|---|---|
| 名称 | 关注整理所 · 互关检测与关注清理（跟随 manifest，不要改） |
| 简短描述 | 检测 X 互关关系，找出没有回关你的人，在你确认后逐个清理。数据只保存在本机。 |
| 类别 | Productivity |
| 语言 | 中文（简体） |
| 官网 | https://tidyfollows.1475369.xyz |
| 支持 URL | https://tidyfollows.1475369.xyz/support |
| 隐私政策 | https://tidyfollows.1475369.xyz/privacy |
| 截图（按顺序） | `docs/preview-overview.png`、`docs/preview-relations.png`、`docs/preview-settings.png` |
| 小型宣传图 | `docs/promo-440x280.png` |
| 详细描述 | 复制 `docs/store-listing.md` 的「详细描述（中文）」 |

截图都是 1280×800、RGB、无 alpha；内容是演示数据，不含真实账号。

## 3. Privacy practices / 隐私权实务

### 单一用途说明

```
中文：在本地检测并整理用户自己的 X 关注关系：读取用户本人的关注/粉丝名单，计算互关关系，并在用户逐条勾选与确认后执行取关。所有数据仅保存在本机浏览器。

English: Local detection and management of the user's own X follow relationships. The extension reads the user's own Following/Followers lists, computes mutual-follow relationships, and unfollows only accounts the user explicitly selects and confirms. All data stays in the browser.
```

### 权限理由

| 权限 | 粘贴内容 |
|---|---|
| `storage` | 在本机保存关系记录、特别关注、任务进度与设置。 |
| `unlimitedStorage` | 关注/粉丝名单较大时，避免超出默认存储额度；数据仍只保存在本机。 |
| `tabs` | 打开、检查和关闭扩展专用的 x.com 执行标签页；判断执行页是否被关闭或跳转。 |
| `scripting` | 向已打开的 x.com 标签页补注入内容脚本，用于任务续跑。 |
| `alarms` | 定时清理临时标签页、监控任务状态。 |
| `https://x.com/*`、`https://twitter.com/*` | 读取用户自己的关注关系，并在用户确认后执行取关。X 同时使用 x.com 与 twitter.com 两个域名。 |

### 远程代码

选择 **No**：没有远程代码、eval、动态加载脚本或外部 CDN。

### 数据使用

后台问法会随版本调整，按以下原则如实填写：

- 扩展不把数据传给我们或任何第三方服务器，不上传、不出售、不用于广告或画像。
- 扩展会读取并只在本机保存：用户自己的 X 关注/粉丝名单、账号标识、关系记录、设置与任务进度。
- 会复用 x.com 页面自身的会话；捕获的接口请求头（含 `ct0` CSRF 令牌）只在本机内存/本地存储中使用，导出备份时会被排除。
- 如果表单要求选择数据类型：选 **网站内容（Website content）**；如同时询问会话/鉴权信息，再选 **身份验证信息（Authentication information）**；如果后台把用户名/显示名称算作 **Personally identifiable information**，也一并勾选。
- 对选中的数据一律选择：**不出售**、**不用于与单一用途无关的用途**、**不用于信用评估/放贷**。
- 如果后台把「收集」定义为「数据离开设备」，本扩展不收集；在说明/审核备注里写明仅本地处理即可。
- 三个 Limited Use 认证勾选项全部勾选。

## 4. 分发设置

| 项 | 建议 |
|---|---|
| 价格 | 免费 |
| 可见性 | 先 **Unlisted** 跑 1–2 天安装流程，确认商店版能装、能连账号，再切 Public |
| 地区 | 全地区；不分发欧盟就先排除 EU，省掉 trader 声明 |

## 5. 审核备注

复制 `docs/store-listing.md` 的「审核备注（可粘贴）」。重点已覆盖：

- 只处理用户自己的关注关系，取关必须逐条勾选 + 二次确认；
- 固定 4–8 秒随机间隔、特别关注跳过；
- MAIN world 脚本只用于读取页面自身的 GraphQL 元数据和第一页响应，不向外发送数据；
- 无远程代码、无分析/广告、无服务器。

## 6. 提交后

- 审核通常 1–3 个工作日；涉及社交平台自动化可能更久。
- 如果被拒，不要原样重提；按反馈补充说明或调整描述，再提交。
- 通过后：从商店安装一次，跑「设置 → 运行自检」；再把商店链接加到官网首页和 README。

## 7. 已知审核风险

| 风险 | 说明 | 已做的缓解 |
|---|---|---|
| 自动化操作 X / 违反第三方条款 | 取关是写操作 | 用户勾选 + 二次确认；固定 4–8 秒；可随时停止；特别关注跳过 |
| 抓取 X 内部 GraphQL 参数 | MAIN world 旁路 fetch | 只记录页面自身请求的元数据；第一页直接使用页面响应；不向外发送 |
| 读取 `ct0` | 复用页面会话 | 无 `cookies` 权限；隐私政策明确披露；仅内存使用 |
| 权限偏多 | `tabs` / `scripting` / `alarms` / `unlimitedStorage` | 每项都有明确用途说明；未申请 `cookies`、`webRequest` 等 |
| 审核追问权限 | 可能要求删减 | `unlimitedStorage` 和 `tabs` 都可尝试移除（需重跑 `scripts/dev/` 回归），先按现版本提交，按反馈再收 |

如果最终因「自动化」被拒且沟通无果，备选方案：改为 Unlisted 分发、或先以 ZIP/官网分发，商店版再按反馈调整措辞和功能入口。
