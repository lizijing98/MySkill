#!/usr/bin/env node
// 性能采集主流程：启动 headless Chrome →（可选）注入登录态 → 清缓存 → 跑 N 次 Lighthouse → 产出 manifest
//
// 用法:
//   node audit.mjs --url https://example.com/page [--device mobile|desktop] [--runs 2] [--warm]
//                  [--auth perf-auth.json] [--out ./perf-audit] [--port 9333] [--keep-profile]
//
// 说明:
//   --auth 接受 extract-storage.mjs 产出的 { origin, keys } 结构，也接受扁平的 { key: value } 对象

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { clearCache, seedLocalStorage, waitForPort } from "./lib/cdp.mjs";
import { chromeVersion, findChrome, findLighthouse, run } from "./lib/env.mjs";

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const v = argv[i + 1];
  return !v || v.startsWith("--") ? true : v;
};

const url = arg("url");
if (!url || url === true) {
  console.error("缺少 --url，例如：node audit.mjs --url https://example.com/#/page");
  process.exit(2);
}

const device = arg("device", "mobile");
const runs = Number(arg("runs", 2));
const wantWarm = Boolean(arg("warm", false));
const port = Number(arg("port", 9333));
const keepProfile = Boolean(arg("keep-profile", false));
const authPath = arg("auth", null);

const chromePath = findChrome();
const lighthousePath = findLighthouse();
if (!chromePath) {
  console.error("未找到 Chrome，可设置 CHROME_PATH 环境变量后重试。");
  process.exit(2);
}
if (!lighthousePath) {
  console.error("未找到 lighthouse，请先 npm install -g lighthouse。");
  process.exit(2);
}

const host = new URL(url).host.replace(/[:.]/g, "-");
const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 16);
const outDir = path.resolve(String(arg("out", path.join("perf-audit", `${host}-${stamp}`))));
fs.mkdirSync(outDir, { recursive: true });

const profileDir = path.join(os.tmpdir(), `perf-audit-profile-${process.pid}`);
fs.mkdirSync(profileDir, { recursive: true });

let chromeProc = null;
function stopChrome() {
  if (chromeProc && !chromeProc.killed) {
    try {
      chromeProc.kill("SIGTERM");
    } catch {
      // ignore
    }
    chromeProc = null;
  }
}
process.on("exit", stopChrome);
process.on("SIGINT", () => {
  stopChrome();
  process.exit(130);
});

function launchChrome() {
  const args = [
    "--headless=new",
    // 在容器/沙箱里跑时 Chrome 自带沙箱常初始化失败，故关闭；仅用于本地配图与测量
    "--no-sandbox",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "about:blank",
  ];
  const proc = spawn(chromePath, args, { stdio: ["ignore", "pipe", "pipe"] });
  proc.stderr.on("data", () => {});
  proc.stdout.on("data", () => {});
  return proc;
}

function runLighthouse(targetUrl, basePath) {
  const bin = lighthousePath.endsWith(".js") ? process.execPath : lighthousePath;
  const args = [
    ...(bin === process.execPath ? [lighthousePath] : []),
    targetUrl,
    `--port=${port}`,
    "--disable-storage-reset",
    "--only-categories=performance",
    "--output=json",
    "--output=html",
    `--output-path=${basePath}`,
    "--quiet",
    ...(device === "desktop" ? ["--preset=desktop"] : []),
  ];
  return new Promise((resolve) => {
    const proc = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let err = "";
    proc.stderr.on("data", (d) => (err += d.toString()));
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
    }, 300000);
    proc.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0 && fs.existsSync(`${basePath}.report.json`), code, stderr: err.slice(-800) });
    });
  });
}

const manifest = {
  url: String(url),
  device,
  startedAt: new Date().toISOString(),
  chrome: { path: chromePath, version: chromeVersion(chromePath) },
  lighthouse: lighthousePath,
  lighthouseVersion: run(lighthousePath, ["--version"]),
  port,
  auth: { used: false, keys: [], origin: null },
  runs: [],
  outDir,
};

try {
  console.log(`[1/4] 启动 headless Chrome（端口 ${port}）…`);
  chromeProc = launchChrome();
  const version = await waitForPort(port);
  console.log(`      Chrome ${version.Browser} 就绪`);

  if (authPath && authPath !== true) {
    const raw = JSON.parse(fs.readFileSync(path.resolve(String(authPath)), "utf8"));
    const origin = raw.origin || new URL(String(url)).origin;
    const keys = raw.keys || Object.fromEntries(Object.entries(raw).filter(([k]) => !["origin", "capturedAt", "source"].includes(k)));
    if (!Object.keys(keys).length) throw new Error("auth 文件里没有任何 key");
    console.log(`[2/4] 注入登录态：${Object.keys(keys).length} 个 key → ${origin}`);
    const r = await seedLocalStorage(port, origin, keys);
    manifest.auth = { used: true, keys: r.keys, origin: r.origin };
    console.log(`      写入完成，origin=${r.origin}，key 数=${r.count}`);
  } else {
    console.log("[2/4] 未提供 --auth，按游客态检测（需要登录的页面可能被重定向到登录页）");
  }

  const total = runs + (wantWarm ? 1 : 0);
  let step = 0;
  for (let i = 1; i <= runs; i++) {
    step++;
    console.log(`[3/4] 冷启动测试 ${i}/${runs}（清缓存）…`);
    await clearCache(port);
    const base = path.join(outDir, `lh-cold-${i}`);
    const r = await runLighthouse(String(url), base);
    manifest.runs.push({ kind: "cold", index: i, ok: r.ok, json: `${base}.report.json`, html: `${base}.report.html`, stderr: r.ok ? undefined : r.stderr });
    console.log(r.ok ? "      完成" : `      失败：${r.stderr.slice(-300)}`);
  }

  if (wantWarm) {
    console.log("[3/4] 热缓存测试（不清缓存，模拟二次访问）…");
    const base = path.join(outDir, "lh-warm-1");
    const r = await runLighthouse(String(url), base);
    manifest.runs.push({ kind: "warm", index: 1, ok: r.ok, json: `${base}.report.json`, html: `${base}.report.html`, stderr: r.ok ? undefined : r.stderr });
    console.log(r.ok ? "      完成" : `      失败：${r.stderr.slice(-300)}`);
  }

  stopChrome();
  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  const okCount = manifest.runs.filter((r) => r.ok).length;
  console.log(`[4/4] 采集结束：成功 ${okCount}/${manifest.runs.length} 次，产物目录 ${outDir}`);
  console.log(`\n下一步：node report.mjs --manifest ${path.join(outDir, "manifest.json")}`);
  process.exit(okCount ? 0 : 1);
} catch (e) {
  stopChrome();
  console.error(`采集中断：${e.message}`);
  process.exit(1);
} finally {
  stopChrome();
  if (!keepProfile) {
    // profile 里存着刚注入的登录凭证，默认删除
    try {
      fs.rmSync(profileDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}
