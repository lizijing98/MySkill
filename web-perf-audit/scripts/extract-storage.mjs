#!/usr/bin/env node
// 从本机 Chrome/Edge 的 profile 中导出指定站点的 localStorage，用于给检测浏览器"带上登录态"
// 用法:
//   node extract-storage.mjs --origin https://example.com [--profile <path>] [--out auth.json]
//   默认导出全部 key；可用 --keys a,b 只取需要的 key

import fs from "node:fs";
import path from "node:path";
import { findLeveldbDirs, readLocalStorage } from "./lib/leveldb.mjs";

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) out[key] = true;
    else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const origin = args.origin && args.origin !== true ? String(args.origin).replace(/#.*$/, "").replace(/\/$/, "") : null;

if (!origin) {
  console.error("用法: node extract-storage.mjs --origin https://example.com [--profile <path>] [--out auth.json] [--keys a,b]");
  process.exit(2);
}

// 允许 --profile 传三种路径：leveldb 目录 / profile 目录（Default）/ user-data 根目录
function resolveLeveldb(input) {
  if (!input || input === true) return null;
  const p = path.resolve(String(input));
  if (!fs.existsSync(p)) throw new Error(`路径不存在: ${p}`);
  if (p.endsWith(path.join("Local Storage", "leveldb"))) return p;
  const direct = path.join(p, "Local Storage", "leveldb");
  if (fs.existsSync(direct)) return direct;
  const nested = path.join(p, "Default", "Local Storage", "leveldb");
  if (fs.existsSync(nested)) return nested;
  throw new Error(`无法在该路径下找到 Local Storage/leveldb: ${p}`);
}

let dirs = [];
try {
  const explicit = resolveLeveldb(args.profile);
  dirs = explicit ? [{ browser: "指定路径", profile: "-", dir: explicit }] : findLeveldbDirs();
} catch (e) {
  console.error(e.message);
  process.exit(2);
}

if (!dirs.length) {
  console.error("未找到任何 Chrome / Edge profile，请用 --profile 指定 Local Storage/leveldb 目录。");
  process.exit(2);
}

const hits = [];
for (const d of dirs) {
  let rows = [];
  try {
    rows = readLocalStorage(d.dir, origin);
  } catch (e) {
    continue;
  }
  if (rows.length) hits.push({ ...d, rows });
}

if (!hits.length) {
  console.error(`所有 profile 中都没有 ${origin} 的 localStorage 记录。`);
  console.error("可能原因：站点未在该浏览器登录、记录已被压缩进 .ldb 文件、或用了无痕窗口。");
  console.error("兜底方案：在已登录页面打开 DevTools Console 执行下面一行，把输出保存为 auth.json 的 keys 字段：");
  console.error('  copy(JSON.stringify(Object.fromEntries(Object.entries(localStorage))))');
  process.exit(3);
}

// 多个 profile 命中时取记录最多的那个
hits.sort((a, b) => b.rows.length - a.rows.length);
const best = hits[0];

const wanted = typeof args.keys === "string" ? args.keys.split(",").map((s) => s.trim()).filter(Boolean) : null;
const keys = {};
for (const r of best.rows) {
  if (wanted && !wanted.includes(r.key)) continue;
  keys[r.key] = r.value;
}

const output = {
  origin,
  capturedAt: new Date().toISOString(),
  source: `${best.browser}/${best.profile}`,
  keys,
};

const outPath = args.out && args.out !== true ? path.resolve(String(args.out)) : path.resolve("perf-auth.json");
fs.writeFileSync(outPath, JSON.stringify(output, null, 2), { mode: 0o600 });

console.log(`来源: ${best.browser}/${best.profile}`);
console.log(`站点: ${origin}`);
console.log(`导出 ${Object.keys(keys).length} 个 key → ${outPath}`);
for (const [k, v] of Object.entries(keys)) {
  const preview = typeof v === "string" && v.length > 60 ? `${v.slice(0, 60)}…` : v;
  console.log(`  ${k.padEnd(24)} ${String(v).length} 字节  ${args["show-values"] ? preview : ""}`);
}
console.log("\n该文件含敏感凭证（token / 用户信息），已被打包脚本排除，请勿提交到仓库。");
