# 扩展运行时测试脚本

在 headless Chrome for Testing 中加载扩展，通过 CDP 驱动界面和模拟 X 接口。
这些脚本不参与商店打包（`scripts/package.sh` 只打 `manifest.json`、`background.js`、`src/`、`icons/`）。

## 启动测试浏览器

```bash
"/tmp/chrome-testing/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing" \
  --headless=new --remote-debugging-port=9333 \
  --user-data-dir=/tmp/lanchrome-profile \
  --no-first-run --no-default-browser-check --disable-gpu \
  --disable-extensions-except=/Users/zhibo/zhibo/lanchrome \
  --load-extension=/Users/zhibo/zhibo/lanchrome \
  --window-size=1280,800
```

- 正式版 Chrome 156 的 `--load-extension` 不生效，必须用 Chrome for Testing。
- 扩展 ID 由路径推导，当前为 `lhjcbgklocfcaphoilhanbafgfmkaikl`；换路径后脚本里的常量要一起改。
- 测试脚本默认连接 `127.0.0.1:9333`，截图输出到 `/tmp/lanchrome-shots`。

## 脚本

| 脚本 | 用途 |
|---|---|
| `ui-test.mjs` | 注入演示数据，逐页截图，检查各页面、勾选、导出过滤、清空数据、弹窗 |
| `pipeline-test.mjs` | 用 CDP `Fetch` 伪造 x.com 文档与 GraphQL 响应，端到端跑「检测 → 分页 → 互关核对 → 取关」 |
| `followers-pagination-test.mjs` | 模拟粉丝后续页重放失败，验证小窗口滚动加载能把第 2 页补全 |
| `degrade-test.mjs` | 模拟粉丝接口 401，验证降级：仍完成「未回关我」，`我未回关` 置为不可用 |

```bash
node scripts/dev/ui-test.mjs
node scripts/dev/pipeline-test.mjs
node scripts/dev/followers-pagination-test.mjs
node scripts/dev/degrade-test.mjs
```

## 限制

- 直接访问真实 `https://x.com` 在 headless 下返回 403，所以内容脚本与接口测试都用
  `Fetch.fulfillRequest` 伪造响应；真实登录会话下的回归仍需人工在正常 Chrome 里做。
- 脚本会写入 `chrome.storage.local` 的演示数据；`ui-test.mjs` 结束时会清空。
