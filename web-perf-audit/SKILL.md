---
name: web-perf-audit
description: 用 Lighthouse + headless Chrome 检测指定网页的加载性能，产出含指标卡、请求瀑布图、文件体积分析的 HTML 报告；支持复用本机浏览器已登录状态，用于检测需要登录才能访问的页面。当用户要分析网页加载耗时、定位首屏瓶颈、生成性能报告或对比冷热启动时使用。
agent_created: true
---

# Web 页面性能检测

对任意 URL 做一次可复现的性能体检：环境自检 → 采集（可带登录态）→ 生成自包含 HTML 报告 → 给出优化建议。

## 何时使用

- 用户要分析某个页面/链接"加载为什么慢""耗时多少"
- 需要 FCP / LCP / TBT / CLS / TTI 等标准指标
- 需要请求瀑布、文件体积构成、第三方脚本占比
- 目标页面必须登录才能访问，且用户本机浏览器已登录

## 阶段 0：环境自检（必须先执行）

```bash
node scripts/preflight.mjs --json
```

读取 JSON 输出：

- `ok: true` → 进入阶段 1
- `ok: false` 或 `missing` 非空 → **用 AskUserQuestion 与用户确认**是否由助手安装缺失项，说明每项的作用与安装命令，得到同意后再执行，装完重跑自检。不要静默安装，也不要跳过自检直接采集。

| 缺失项 | 处理 |
| --- | --- |
| Node < 22 | `nvm install 22 && nvm use 22`（需要内置 WebSocket 驱动 CDP） |
| Lighthouse CLI | `npm install -g lighthouse` |
| Chrome | 安装 Chrome，或 `export CHROME_PATH=/path/to/chrome` |
| 端口占用 | `--port <n>` 换端口 |
| chrome-devtools-mcp | **可选**。缺失也能完成主流程，只影响交互式排查，询问用户是否需要 |

## 阶段 1：采集

### 1. 判断是否需要登录态

不需要登录、或游客态下内容等价 → 跳过本步。

需要登录 → 从用户本机浏览器导出该站点的 localStorage：

```bash
node scripts/extract-storage.mjs --origin https://example.com --out perf-auth.json
```

- 自动扫描 Chrome / Edge / Chromium 的 Default 与 Profile N
- 也可用 `--profile <path>` 指定 `Local Storage/leveldb`、profile 目录或 user-data 根目录
- 终端只打印 key 名与长度，值写入文件（权限 600）
- 失败时按 `references/troubleshooting.md` 的兜底方案处理

### 2. 跑采集

```bash
node scripts/audit.mjs \
  --url "https://example.com/#/some/page" \
  --auth perf-auth.json \
  --runs 2 --warm \
  --out ./perf-audit/example
```

要点：

- `--runs 2` 默认跑两次冷启动取中位数抗抖动；结果波动大时加到 3
- `--warm` 追加一次不清缓存的运行，用于对比"二次访问"，缓存问题一眼可见
- `--device desktop` 切换桌面预设（默认 mobile）
- 每次冷启动前通过 CDP 清 HTTP 缓存，**不清 cookie**，避免把登录态一起清掉
- 脚本自带 `--disable-storage-reset`，否则 Lighthouse 会清空 storage 导致掉登录
- 结束后默认删除临时 profile（内含刚注入的凭证），需要保留加 `--keep-profile`
- 产出：`manifest.json` + `lh-cold-N.report.{json,html}` + `lh-warm-1.report.{json,html}`

### 3. 可选：交互式补充排查

chrome-devtools-mcp 可用时，用它做截图、看控制台报错、抓真实设备 trace。它不是主流程依赖。

## 阶段 2：生成报告

```bash
node scripts/report.mjs --manifest ./perf-audit/example/manifest.json
```

生成 `report.html`（自包含、离线可看），用 `present_files` 展示。报告包含：

1. 核心指标卡（性能分数 / FCP / LCP / TBT / SI / TTI / CLS / 传输量）
2. 冷启动 vs 二次访问对比表
3. 请求瀑布图（按类型着色，标注实测 FCP / LCP）
4. 文件体积分析（环形图 + 分类占比 + 体积 Top 12）
5. 自动诊断（HTTP/1.1 占比、缺缓存头的资源、未使用 JS、polyfill 体积、最长任务、跨域来源）
6. 优化机会、主线程开销、第三方资源占用

## 阶段 3：解读与建议

报告出来后必须给结论，不要只丢文件：

1. 用 3 条以内说清"慢在哪、慢多少"
2. 面向上层给结论，面向开发给可执行项，按「收益 ÷ 成本」排序
3. 重点看三个反差：
   - **冷启动 vs 热缓存**：差距大 → 缓存策略或文件名哈希问题，通常是最便宜的收益
   - **传输体积 vs 主线程耗时**：JS 又大又执行久 → 拆包、按需加载、移除未用代码
   - **瀑布图尾部长**：看是不是第三方 SDK 或串行接口拖尾
4. 明确可优化点归属：前端代码 / 构建配置 / 运维响应头 / 第三方 SDK

## 口径说明（避免误读）

- 指标卡的 FCP / LCP / TBT 是 Lighthouse 用 **4G + 4 倍 CPU 降速** 模拟出来的
- 瀑布图时间轴是 **采集机真实网络** 的请求时序，不节流
- 两者刻度不同，不要直接对比；报告已用 `observed*` 值标注瀑布图上的 FCP / LCP
- headless 与真机渲染有差异（字体、GPU、合成器），绝对值当基线参考，趋势与瓶颈判断更可靠

## 常见陷阱

- 命令沙箱内启动 Chrome 必须带 `--no-sandbox`，脚本已内置，勿删
- 不要为"更干净"去清 cookie：多数 H5 登录态在 localStorage，清 cookie 可能连带失效
- 页面在无登录态下会重定向到登录页，测出来的就是登录页指标——先确认落地 URL 正确
- `perf-auth.json` 与临时 profile 都含敏感凭证，不要提交仓库、不要贴进对话
- Lighthouse 单次抖动可达 10%~20%，汇报时用中位数并说明样本数

## 文件说明

| 路径 | 作用 |
| --- | --- |
| `scripts/preflight.mjs` | 环境自检，输出 JSON（`--json`）或可读文本 |
| `scripts/extract-storage.mjs` | 从本机浏览器导出站点 localStorage |
| `scripts/audit.mjs` | 启动 Chrome、注入登录态、清缓存、跑 N 次 Lighthouse |
| `scripts/report.mjs` | 把 Lighthouse JSON 渲染成自包含 HTML 报告 |
| `scripts/lib/env.mjs` | 定位 Chrome / lighthouse 可执行文件 |
| `scripts/lib/cdp.mjs` | 极简 CDP 客户端（清缓存、注入 storage） |
| `scripts/lib/leveldb.mjs` | 解析 Chrome Local Storage 的 leveldb 日志 |
| `references/troubleshooting.md` | 排错手册：登录态取不到、Chrome 起不来、结果异常 |
