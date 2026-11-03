#!/usr/bin/env node
// 环境自检：检查 node / lighthouse / Chrome / 调试端口 / chrome-devtools-mcp 配置
// 用法: node preflight.mjs [--json] [--port 9333]

import fs from "node:fs";
import os from "node:os";
import net from "node:net";
import path from "node:path";
import { chromeVersion, findChrome, findLighthouse, run } from "./lib/env.mjs";

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const asJson = argv.includes("--json");
const port = Number(flag("port") || process.env.PERF_PORT || 9333);

function checkPortFree(p) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.once("listening", () => srv.close(() => resolve(true)));
    srv.listen(p, "127.0.0.1");
  });
}

const [major] = process.versions.node.split(".").map(Number);
const hasWebSocket = typeof WebSocket === "function";

const lighthousePath = findLighthouse();
const lighthouseVersion = lighthousePath ? run(lighthousePath, ["--version"]) : null;

const chromePath = findChrome();
const chromeVer = chromePath ? chromeVersion(chromePath) : null;

const mcpConfigPath = path.join(os.homedir(), ".workbuddy", "mcp.json");
let mcpConfigured = false;
try {
  const raw = JSON.parse(fs.readFileSync(mcpConfigPath, "utf8"));
  mcpConfigured = Boolean(raw.mcpServers && raw.mcpServers["chrome-devtools-mcp"]);
} catch {
  mcpConfigured = false;
}

const portFree = await checkPortFree(port);

const checks = [
  {
    id: "node",
    label: "Node.js",
    ok: major >= 22 && hasWebSocket,
    found: `v${process.versions.node}${hasWebSocket ? "（内置 WebSocket）" : "（缺少内置 WebSocket）"}`,
    need: ">= 22，需要内置 WebSocket 来驱动 CDP 注入登录态",
    install: "nvm install 22 && nvm use 22",
    critical: true,
  },
  {
    id: "lighthouse",
    label: "Lighthouse CLI",
    ok: Boolean(lighthousePath),
    found: lighthousePath ? `${lighthouseVersion}（${lighthousePath}）` : "未安装",
    need: "npm 全局包 lighthouse",
    install: "npm install -g lighthouse",
    critical: true,
  },
  {
    id: "chrome",
    label: "Chrome 浏览器",
    ok: Boolean(chromePath),
    found: chromePath ? `${chromeVer}（${chromePath}）` : "未找到 Chrome / Chromium / Edge",
    need: "本机安装 Chrome，或用 CHROME_PATH 指定路径",
    install: "安装 Google Chrome 后重跑自检；也可 export CHROME_PATH=/path/to/chrome",
    critical: true,
  },
  {
    id: "port",
    label: `调试端口 ${port}`,
    ok: portFree,
    found: portFree ? "可用" : "已被占用",
    need: "需要一个空闲端口启动 headless Chrome",
    install: `用 --port 换一个端口，或释放 ${port} 上的进程`,
    critical: false,
  },
  {
    id: "mcp",
    label: "chrome-devtools-mcp（可选）",
    ok: mcpConfigured,
    found: mcpConfigured ? `已配置（${mcpConfigPath}）` : "未配置",
    need: "仅用于交互式 trace / 截图 / 控制台排查；缺失不影响瀑布图与指标产出",
    install: '在 ~/.workbuddy/mcp.json 的 mcpServers 中添加 chrome-devtools-mcp，参数含 --headless=true',
    critical: false,
  },
];

const missingCritical = checks.filter((c) => c.critical && !c.ok);
const result = {
  ok: missingCritical.length === 0,
  platform: process.platform,
  node: process.versions.node,
  chromePath,
  chromeVersion: chromeVer,
  lighthousePath,
  lighthouseVersion,
  port,
  mcpConfigured,
  checks,
  missing: checks
    .filter((c) => !c.ok)
    .map((c) => ({ id: c.id, label: c.label, critical: c.critical, install: c.install })),
};

if (asJson) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(`\n环境自检 · ${process.platform} · node v${process.versions.node}\n`);
  for (const c of checks) {
    console.log(`[${c.ok ? "通过" : c.critical ? "缺失" : "注意"}] ${c.label}：${c.found}`);
    if (!c.ok) {
      console.log(`        需要：${c.need}`);
      console.log(`        处理：${c.install}`);
    }
  }
  console.log(
    missingCritical.length
      ? `\n结论：缺少 ${missingCritical.length} 个必需组件，先安装再继续。\n`
      : "\n结论：必需组件齐全，可以开始检测。\n"
  );
}

process.exit(result.ok ? 0 : 1);
