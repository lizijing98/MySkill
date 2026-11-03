# 排错手册

## 一、登录态取不到

`extract-storage.mjs` 返回"所有 profile 中都没有该站点的 localStorage"。

按可能性排序：

1. **站点不在这个浏览器登录**。脚本会扫描 Chrome / Edge / Chromium 所有 profile，终端会打印来源。若来源不是用户实际使用的浏览器，用 `--profile <path>` 指定。
2. **记录已被压缩进 `.ldb`**。本工具解析的是 leveldb 的 write-ahead log（`*.log`），刚写入的数据一定在这里；如果距上次登录很久、Chrome 已完成 compaction，数据可能只在 `.ldb` 的 SSTable 里，当前版本不解析。解决办法：让用户在目标页面做一次会写 localStorage 的操作（切换 tab、刷新后重新进入业务流程），新值会重新落到 `.log`。
3. **用了无痕窗口**。无痕的存储不落盘，无法导出。
4. **origin 写错**。必须是 `https://host`（含协议、不含路径和 hash）。`http` 与 `https`、有无 `www` 都算不同 origin。

兜底方案（任一即可）：

- 让用户在已登录页面打开 DevTools → Console，执行：
  ```js
  copy(JSON.stringify(Object.fromEntries(Object.entries(localStorage))))
  ```
  把剪贴板内容保存成 `perf-auth.json`，格式为扁平 `{ key: value }`，`audit.mjs` 直接接受。
- 或者手工只取关键 key：
  ```bash
  node scripts/extract-storage.mjs --origin https://example.com --keys token,userInfo --out perf-auth.json
  ```

验证注入是否生效：`audit.mjs` 会打印 `写入完成，origin=..., key 数=N`。若之后仍被重定向到登录页，说明认证还依赖 cookie、IndexedDB 或请求头，本工具不覆盖这些场景，需改用 `chrome-devtools-mcp` 手工在真实浏览器里测。

## 二、Chrome 起不来

**`sandbox initialization failed: Operation not permitted`**
命令执行环境（容器、CI、受限 shell）里 Chrome 无法初始化自己的 sandbox。`audit.mjs` 已默认带 `--no-sandbox`，请勿删除。仅在本地个人机器上可考虑去掉。

**`The browser is already running for <profile>` / `SingletonLock`**
同一 user-data-dir 已有实例，或上次异常退出留下悬空软链。处理：

```bash
ls -l <profile>/Singleton*     # 看是否指向不存在的目标
rm -f <profile>/SingletonLock <profile>/SingletonSocket <profile>/SingletonCookie
```

`audit.mjs` 每次用 `os.tmpdir()/perf-audit-profile-<pid>` 独立目录，正常不会撞。

**端口被占用**
`--port 9444` 换端口；`preflight.mjs` 会报告端口状态。

**GPU 相关崩溃**
headless 下 `--disable-gpu` 已默认开启，一般无需处理。

## 三、Lighthouse 报错

**测出来是登录页 / 分数异常高**
Lighthouse 默认会清空 storage（cookie、localStorage、cache）。必须带 `--disable-storage-reset`，`audit.mjs` 已内置。若仍掉登录，检查：

- 注入的 origin 与 `--url` 的 origin 是否一致（hash 不影响）
- 页面是否用 `sessionStorage`（不跨标签页共享，Lighthouse 新开 tab 拿不到）

**`NO_FCP` / 白屏超时**
- 页面依赖登录态且未注入 → 走"登录态取不到"排查
- 页面强依赖移动端 UA 或特定 viewport → 用 `--device mobile`（默认），或改用 `chrome-devtools-mcp` 手工模拟

**`ChromeLauncher` / 找不到 Chrome**
`export CHROME_PATH=/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`，或在 preflight 输出确认 `chromePath`。

**运行很慢或卡住**
单次 Lighthouse 通常 30~90 s；页面请求多、接口慢会更久。`audit.mjs` 给每次运行 5 min 上限，超时会 kill 并记 `ok:false`，其余运行继续。

## 四、结果怎么看、什么时候不可信

| 现象 | 说明 | 处理 |
| --- | --- | --- |
| 两次分数差 10 分以上 | Lighthouse 固有抖动 | 加 `--runs 3`，看中位数 |
| 冷启动 1.4 MB、热缓存 76 KB | 静态资源缺长效缓存或文件名无 hash | 这是真实问题，优先修 |
| 指标卡 LCP 10 s，瀑布图 2 s 就结束 | 卡片是 4G+4x CPU 模拟，瀑布是实测 | 正常，口径不同，勿直接对比 |
| 主线程耗时很高但 JS 体积不大 | 执行/解析成本，或 long task 集中在某个 SDK | 看"主线程开销"和"最长任务" |
| 与用户主观感受不符 | headless 无 GPU 合成、字体不同、无真实网络抖动 | 结论看瓶颈位置，不看绝对值 |

## 五、和 chrome-devtools-mcp 配合

MCP 适合做本工具覆盖不到的排查：

- 看控制台报错、失败请求（`list_console_messages`、`list_network_requests`）
- 截图确认页面是否真的渲染出内容（而非登录页/骨架屏）
- 抓真实设备上的 trace（`performance_start_trace`）做 LCP 细分

MCP 的 profile 是独立的（`~/.cache/chrome-devtools-mcp/chrome-profile`），**不带用户的登录态**。若要用它测登录页，需要先在该 profile 的浏览器里手工登录一次，或用同样方式注入 storage。
