# 关注整理所官网 / 隐私政策站点

Cloudflare Workers 静态资源站点，使用 `cf` CLI 部署。

- 线上地址：<https://tidyfollows.1475369.xyz>
- 隐私政策：<https://tidyfollows.1475369.xyz/privacy>
- 支持页：<https://tidyfollows.1475369.xyz/support>

## 结构

```
site/
  cloudflare.config.ts   # Worker 名称、兼容日期、自定义域名
  wrangler.config.ts     # 静态资源目录（public）
  package.json
  public/                # 实际对外提供的文件
    index.html
    privacy.html
    support.html
    terms.html
    404.html
    styles.css
    _headers             # 安全响应头
    robots.txt
    sitemap.xml
    assets/              # 图标
```

## 修改内容

直接编辑 `public/` 下的文件。HTML 里不要写内联样式或脚本：`_headers` 中的 CSP 是
`style-src 'self'; script-src 'none'`，内联内容会被浏览器拦截。

## 部署

```bash
cd site
cf deploy --message "Update privacy policy"
```

首次部署前确认 `cf auth whoami` 已登录。如果 `node_modules` 不存在（重新拉代码或清理后），先运行 `npm install`（或 `npm ci`）。部署会自动构建并生成 Build Output 到 `.cloudflare/output/v0/`，不需要手动打包。

自定义域名 `tidyfollows.1475369.xyz` 在 `cloudflare.config.ts` 的 `worker.domains` 中声明，
部署时自动绑定。

## 本地预览

```bash
cd site
cf dev
```

或直接用任意静态服务器指向 `public/`。注意：本地预览不会应用 `_headers` 中的响应头。
