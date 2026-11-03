#!/usr/bin/env node
// 把 Lighthouse 的 JSON 结果渲染成一份自包含 HTML 报告：指标卡 + 请求瀑布 + 体积构成 + 优化机会
//
// 用法: node report.mjs --manifest <outDir>/manifest.json [--open]

import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";

const argv = process.argv.slice(2);
const arg = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d;
};

const manifestPath = path.resolve(String(arg("manifest", "")));
if (!fs.existsSync(manifestPath)) {
  console.error("找不到 manifest，请先运行 audit.mjs。用法: node report.mjs --manifest <path>");
  process.exit(2);
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const outDir = path.dirname(manifestPath);

const TYPE_COLORS = {
  document: "#3d4f5f",
  script: "#d9822b",
  stylesheet: "#8e6bbf",
  image: "#2a9d8f",
  font: "#3d7dd8",
  xhr: "#4a9d5f",
  fetch: "#4a9d5f",
  preflight: "#b9c2c9",
  other: "#9aa5ad",
};

const CATEGORY_LABEL = {
  script: "JS",
  stylesheet: "CSS",
  image: "图片",
  font: "字体",
  document: "HTML",
  xhr: "接口",
  fetch: "接口",
  preflight: "预检",
  other: "其他",
};

const esc = (s) =>
  String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

let mainHost = "";
try {
  mainHost = new URL(manifest.url).host;
} catch {
  mainHost = "";
}

const localTime = (iso) => {
  try {
    return new Date(iso).toLocaleString("zh-CN", { hour12: false });
  } catch {
    return iso;
  }
};

const kb = (bytes) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(2)} MB` : `${Math.round(bytes / 1024)} KB`);
const ms = (v) => (v >= 1000 ? `${(v / 1000).toFixed(2)} s` : `${Math.round(v)} ms`);

function loadRuns(kind) {
  const resolve = (p) => (path.isAbsolute(p) ? p : path.join(outDir, p));
  return manifest.runs
    .filter((r) => r.kind === kind && r.ok)
    .map((r) => ({ ...r, data: JSON.parse(fs.readFileSync(resolve(r.json), "utf8")), relHtml: path.basename(r.html) }))
    .filter((r) => r.data && r.data.audits);
}

const coldRuns = loadRuns("cold");
const warmRuns = loadRuns("warm");
if (!coldRuns.length && !warmRuns.length) {
  console.error("manifest 里没有成功的 Lighthouse 结果。");
  process.exit(1);
}

const median = (arr) => {
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

function metricsOf(run) {
  const a = run.data.audits;
  const num = (id) => (a[id] && typeof a[id].numericValue === "number" ? a[id].numericValue : null);
  return {
    score: Math.round(run.data.categories.performance.score * 100),
    fcp: num("first-contentful-paint"),
    lcp: num("largest-contentful-paint"),
    tbt: num("total-blocking-time"),
    cls: num("cumulative-layout-shift"),
    si: num("speed-index"),
    tti: num("interactive"),
    bytes: num("total-byte-weight"),
    requests: a["network-requests"] && a["network-requests"].details ? a["network-requests"].details.items.length : 0,
  };
}

const primary = coldRuns[0] || warmRuns[0];
const coldMetricList = coldRuns.map(metricsOf);
const cold = coldMetricList.length
  ? Object.fromEntries(
      Object.keys(coldMetricList[0]).map((k) => [k, median(coldMetricList.map((m) => m[k]).filter((v) => v != null))])
    )
  : null;
const warm = warmRuns.length ? metricsOf(warmRuns[0]) : null;

// 多次运行的波动区间，用于在卡片上如实展示样本离散度
function rangeOf(key, fmt = ms) {
  const vals = coldMetricList.map((m) => m[key]).filter((v) => v != null);
  if (vals.length < 2) return null;
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  // 格式化后仍然相同就没有展示价值
  if (fmt(lo) === fmt(hi)) return null;
  return `${vals.length} 次：${fmt(lo)}–${fmt(hi)}`;
}

const audits = primary.data.audits;
const netItems = (audits["network-requests"]?.details?.items || []).filter((i) => i.url && !i.url.startsWith("data:"));

/* ---------------- 瀑布图 ---------------- */
function waterfallSvg(items, { marks = [], width = 1180 } = {}) {
  const labelW = 330;
  const rightPad = 60;
  const chartW = width - labelW - rightPad;
  const rowH = 15;
  const barH = 9;
  const topPad = 34;
  const maxEnd = Math.max(...items.map((i) => i.networkEndTime || 0), 1);
  const scale = chartW / maxEnd;
  const height = topPad + items.length * rowH + 34;
  const x = (t) => labelW + t * scale;

  const rows = items
    .slice()
    .sort((a, b) => (a.networkRequestTime || 0) - (b.networkRequestTime || 0))
    .map((it, idx) => {
      const start = Math.max(it.networkRequestTime || 0, 0);
      const end = Math.max(it.networkEndTime || start, start + 1);
      const type = (it.resourceType || "other").toLowerCase();
      const color = TYPE_COLORS[type] || TYPE_COLORS.other;
      const y = topPad + idx * rowH;
      const w = Math.max((end - start) * scale, 1.5);
      const raw = String(it.url);
      let uri = raw;
      try {
        const u = new URL(raw);
        // 主站资源只显示路径，跨域资源保留域名
        uri = u.host === mainHost ? u.pathname : `${u.host}${u.pathname}`;
      } catch {
        uri = raw.replace(/^https?:\/\//, "");
      }
      // 中间截断：保留尾部，才能区分同一目录下 hash 不同的 chunk
      const label = uri.length > 60 ? `${uri.slice(0, 20)}…${uri.slice(-38)}` : uri;
      const sizeTxt = it.transferSize ? kb(it.transferSize) : "";
      return `<g>
  <rect x="0" y="${y - 2}" width="${width}" height="${rowH}" fill="${idx % 2 ? "#fbfbfa" : "transparent"}"/>
  <text x="0" y="${y + barH - 1}" font-size="10.5" fill="#5b6670">${esc(label)}</text>
  <rect x="${x(start).toFixed(1)}" y="${y}" width="${w.toFixed(1)}" height="${barH}" rx="1.5" fill="${color}"><title>${esc(uri)}\n开始 ${ms(start)} · 耗时 ${ms(end - start)} · ${sizeTxt}</title></rect>
  <text x="${(x(end) + 5).toFixed(1)}" y="${y + barH - 1}" font-size="9.5" fill="#8b959d">${sizeTxt}</text>
</g>`;
    })
    .join("\n");

  const ticks = [];
  const tickStep = maxEnd > 8000 ? 2000 : maxEnd > 4000 ? 1000 : maxEnd > 1500 ? 500 : 200;
  for (let t = 0; t <= maxEnd; t += tickStep) {
    ticks.push(`<line x1="${x(t).toFixed(1)}" y1="${topPad - 10}" x2="${x(t).toFixed(1)}" y2="${height - 30}" stroke="#e6e8ea" stroke-width="1"/>
  <text x="${x(t).toFixed(1)}" y="${height - 14}" font-size="10" fill="#98a2a9" text-anchor="middle">${ms(t)}</text>`);
  }

  const markSvg = marks
    .filter((m) => m.time != null && m.time <= maxEnd)
    .map(
      (m) => `<line x1="${x(m.time).toFixed(1)}" y1="${topPad - 10}" x2="${x(m.time).toFixed(1)}" y2="${height - 30}" stroke="${m.color}" stroke-width="1.2" stroke-dasharray="4 3"/>
  <text x="${x(m.time).toFixed(1)}" y="${topPad - 16}" font-size="10.5" fill="${m.color}" text-anchor="middle" font-weight="500">${esc(m.label)}</text>`
    )
    .join("\n");

  return `<svg viewBox="0 0 ${width} ${height}" width="100%" role="img" aria-label="请求瀑布图">
${ticks.join("\n")}
${markSvg}
${rows}
</svg>`;
}

/* ---------------- 体积构成 ---------------- */
function categoryStats(items) {
  const map = new Map();
  for (const it of items) {
    const raw = (it.resourceType || "other").toLowerCase();
    // fetch 与 xhr 同属接口，合并展示；未登记的类型归到 other
    const type = raw === "fetch" ? "xhr" : CATEGORY_LABEL[raw] ? raw : "other";
    const cur = map.get(type) || { type, count: 0, bytes: 0 };
    cur.count++;
    cur.bytes += it.transferSize || 0;
    map.set(type, cur);
  }
  return [...map.values()].sort((a, b) => b.bytes - a.bytes);
}

function donutSvg(stats, size = 190) {
  const total = stats.reduce((s, x) => s + x.bytes, 0) || 1;
  const cx = size / 2;
  const cy = size / 2;
  const r = size / 2 - 12;
  let angle = -Math.PI / 2;
  const slices = stats
    .map((s) => {
      const sweep = (s.bytes / total) * Math.PI * 2;
      const a0 = angle;
      const a1 = angle + sweep;
      angle = a1;
      const large = sweep > Math.PI ? 1 : 0;
      const p0 = [cx + r * Math.cos(a0), cy + r * Math.sin(a0)];
      const p1 = [cx + r * Math.cos(a1), cy + r * Math.sin(a1)];
      const color = TYPE_COLORS[s.type] || TYPE_COLORS.other;
      if (stats.length === 1) {
        return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${color}" stroke-width="26"/>`;
      }
      return `<path d="M${cx} ${cy} L${p0[0].toFixed(1)} ${p0[1].toFixed(1)} A${r} ${r} 0 ${large} 1 ${p1[0].toFixed(1)} ${p1[1].toFixed(1)} Z" fill="${color}" stroke="#fff" stroke-width="1"><title>${esc(CATEGORY_LABEL[s.type] || s.type)} ${kb(s.bytes)}</title></path>`;
    })
    .join("\n");
  return `<svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" role="img" aria-label="体积构成环形图">
${slices}
<circle cx="${cx}" cy="${cy}" r="${r - 17}" fill="#ffffff"/>
<text x="${cx}" y="${cy - 4}" text-anchor="middle" font-size="17" font-weight="600" fill="#22303c">${kb(total)}</text>
<text x="${cx}" y="${cy + 14}" text-anchor="middle" font-size="10.5" fill="#8b959d">总传输量</text>
</svg>`;
}

/* ---------------- 诊断 ---------------- */
function diagnostics(items, audits) {
  const out = [];
  const h1 = items.filter((i) => i.protocol === "http/1.1").length;
  if (h1 > items.length * 0.5) out.push(`<b>${h1}/${items.length}</b> 个请求走 HTTP/1.1，受 6 连接上限约束，建议启用 HTTP/2。`);

  const noCache = audits["uses-long-cache-ttl"]?.details?.items || [];
  if (noCache.length) {
    const bytes = noCache.reduce((s, i) => s + (i.totalBytes || 0), 0);
    out.push(`<b>${noCache.length}</b> 个静态资源缺少长效缓存头，重复访问要多下载 <b>${kb(bytes)}</b>。`);
  }

  const unused = audits["unused-javascript"]?.details?.items || [];
  if (unused.length) {
    const bytes = unused.reduce((s, i) => s + (i.wastedBytes || 0), 0);
    out.push(`JS 中有 <b>${kb(bytes)}</b> 的代码在本次加载中未被执行，可拆分或按需加载。`);
  }

  const legacy = audits["legacy-javascript"]?.details?.items || [];
  if (legacy.length) {
    const bytes = legacy.reduce((s, i) => s + (i.wastedBytes || 0), 0);
    out.push(`有 <b>${kb(bytes)}</b> 是旧浏览器 polyfill，收窄浏览器目标可裁掉。`);
  }

  const longTasks = audits["long-tasks"]?.details?.items || [];
  if (longTasks.length) {
    const worst = longTasks.slice().sort((a, b) => b.duration - a.duration)[0];
    out.push(`最长任务 <b>${ms(worst.duration)}</b>，来自 <code>${esc(String(worst.url || "未知").replace(/^https?:\/\//, "").slice(0, 70))}</code>。`);
  }

  const hosts = new Map();
  for (const i of items) {
    try {
      const h = new URL(i.url).host;
      if (h !== new URL(manifest.url).host) hosts.set(h, (hosts.get(h) || 0) + 1);
    } catch {
      // ignore
    }
  }
  if (hosts.size) {
    out.push(
      `${hosts.size} 个跨域来源参与首屏：` +
        [...hosts.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 6)
          .map(([h, n]) => `<code>${esc(h)}</code>(${n})`)
          .join("、")
    );
  }
  return out;
}

/* ---------------- 组装 HTML ---------------- */
// 瀑布图画在"实测"时间轴上，因此标记也用 observed* 值；
// 卡片里的 FCP/LCP 是 Lighthouse 模拟 4G + 4x CPU 的结果，两者不能混在同一刻度上。
const observed = (audits.metrics && audits.metrics.details && audits.metrics.details.items[0]) || {};
const markList = [];
if (observed.observedFirstContentfulPaint) {
  markList.push({ time: observed.observedFirstContentfulPaint, label: `FCP ${ms(observed.observedFirstContentfulPaint)}`, color: "#d9822b" });
}
if (observed.observedLargestContentfulPaint) {
  markList.push({ time: observed.observedLargestContentfulPaint, label: `LCP ${ms(observed.observedLargestContentfulPaint)}`, color: "#c0392b" });
}

const stats = categoryStats(netItems);

const metricCard = (label, value, hint = "", tone = "") =>
  `<div class="card metric ${tone}"><div class="m-label">${esc(label)}</div><div class="m-value">${value}</div>${
    hint ? `<div class="m-hint">${hint}</div>` : ""
  }</div>`;

const scoreTone = (s) => (s >= 90 ? "good" : s >= 50 ? "warn" : "bad");

const opportunities = Object.entries(audits)
  .filter(([, a]) => a && a.details && a.details.type === "opportunity" && typeof a.numericValue === "number" && a.numericValue > 0)
  .sort((a, b) => b[1].numericValue - a[1].numericValue)
  .slice(0, 12);

const thirdParties = (audits["third-party-summary"]?.details?.items || [])
  .filter((i) => i.transferSize > 1024 || i.blockingTime > 10)
  .sort((a, b) => (b.transferSize || 0) - (a.transferSize || 0))
  .slice(0, 8);

const mainThread = (audits["mainthread-work-breakdown"]?.details?.items || []).slice(0, 7);
const bootup = (audits["bootup-time"]?.details?.items || []).slice(0, 8);

const topFiles = netItems
  .slice()
  .sort((a, b) => (b.transferSize || 0) - (a.transferSize || 0))
  .slice(0, 12);

const comparisonRows = warm
  ? [
      ["性能分数", `${cold ? cold.score : "-"}`, `${warm.score}`],
      ["FCP", cold ? ms(cold.fcp) : "-", ms(warm.fcp)],
      ["LCP", cold ? ms(cold.lcp) : "-", ms(warm.lcp)],
      ["TBT", cold ? ms(cold.tbt) : "-", ms(warm.tbt)],
      ["传输体积", cold ? kb(cold.bytes) : "-", kb(warm.bytes)],
    ]
      .map(([k, a, b]) => `<tr><td>${k}</td><td>${a}</td><td>${b}</td></tr>`)
      .join("\n")
  : "";

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>性能报告 · ${esc(manifest.url)}</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 32px 28px 64px; background: #f6f7f8; color: #22303c;
    font: 14px/1.6 -apple-system, "PingFang SC", "Segoe UI", system-ui, sans-serif; }
  .wrap { max-width: 1240px; margin: 0 auto; }
  h1 { font-size: 20px; font-weight: 600; margin: 0 0 6px; }
  h2 { font-size: 15px; font-weight: 600; margin: 36px 0 12px; }
  .sub { color: #6d7883; font-size: 12.5px; word-break: break-all; }
  .meta { display: flex; flex-wrap: wrap; gap: 16px; margin-top: 10px; color: #6d7883; font-size: 12px; }
  .meta code { background: #eceff1; padding: 1px 6px; border-radius: 4px; font-size: 11.5px; }
  .panel { background: #fff; border: 1px solid #e6e8ea; border-radius: 10px; padding: 18px 20px; }
  .grid { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); }
  .card.metric { background: #fff; border: 1px solid #e6e8ea; border-radius: 10px; padding: 14px 16px; }
  .m-label { font-size: 12px; color: #6d7883; }
  .m-value { font-size: 24px; font-weight: 600; letter-spacing: -0.4px; margin-top: 2px; }
  .m-hint { font-size: 11.5px; color: #98a2a9; margin-top: 2px; }
  .good .m-value { color: #2f8f4e; }
  .warn .m-value { color: #b9770e; }
  .bad .m-value { color: #c0392b; }
  table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
  th, td { text-align: left; padding: 7px 10px; border-bottom: 1px solid #eef0f1; vertical-align: top; }
  th { color: #6d7883; font-weight: 500; background: #fafbfb; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .legend { display: flex; flex-wrap: wrap; gap: 14px; font-size: 12px; color: #52606b; margin-top: 10px; }
  .legend i { width: 9px; height: 9px; border-radius: 2px; display: inline-block; margin-right: 5px; }
  .note { margin-top: 10px; font-size: 11.5px; color: #8b959d; line-height: 1.55; }
  .two { display: grid; gap: 22px; grid-template-columns: 210px 1fr; align-items: start; }
  ul.diag { margin: 0; padding-left: 18px; }
  ul.diag li { margin: 6px 0; color: #3c4a56; }
  code { background: #f1f3f4; padding: 1px 5px; border-radius: 4px; font-size: 11.5px; }
  .foot { margin-top: 36px; color: #98a2a9; font-size: 11.5px; }
  .bar { height: 6px; background: #eef0f1; border-radius: 3px; overflow: hidden; }
  .bar > span { display: block; height: 100%; background: #4a7bd6; }
  .pct { display: flex; align-items: center; gap: 8px; }
  .pct-bar { flex: 1; min-width: 40px; height: 6px; background: #eef0f1; border-radius: 3px; overflow: hidden; }
  .pct-bar > i { display: block; height: 100%; background: #4a7bd6; border-radius: 3px; }
  .pct-txt { font-size: 11px; color: #98a2a9; font-variant-numeric: tabular-nums; width: 40px; text-align: right; }
  @media (max-width: 820px) { .two { grid-template-columns: 1fr; } }
</style>
</head>
<body>
<div class="wrap">
  <h1>页面性能报告</h1>
  <div class="sub">${esc(manifest.url)}</div>
  <div class="meta">
    <span>设备<code>${esc(manifest.device)}</code></span>
    <span>采集<code>${esc(localTime(manifest.startedAt))}</code></span>
    <span>Lighthouse<code>${esc(manifest.lighthouseVersion || "-")}</code></span>
    <span>冷启动样本<code>${coldRuns.length}</code></span>
    <span>登录态<code>${manifest.auth && manifest.auth.used ? `已注入 ${manifest.auth.keys.length} 个 key` : "未使用"}</code></span>
  </div>

  <h2>核心指标</h2>
  <div class="grid">
    ${cold ? metricCard("性能分数", cold.score, rangeOf("score", (v) => String(Math.round(v))) || "Lighthouse 综合评分", scoreTone(cold.score)) : ""}
    ${cold ? metricCard("FCP", ms(cold.fcp), rangeOf("fcp") || "首次内容绘制") : ""}
    ${cold ? metricCard("LCP", ms(cold.lcp), rangeOf("lcp") || "最大内容绘制") : ""}
    ${cold ? metricCard("TBT", ms(cold.tbt), rangeOf("tbt") || "总阻塞时间") : ""}
    ${cold ? metricCard("SI", ms(cold.si), rangeOf("si") || "速度指数") : ""}
    ${cold ? metricCard("TTI", ms(cold.tti), rangeOf("tti") || "可交互时间") : ""}
    ${cold ? metricCard("CLS", Number(cold.cls).toFixed(3), rangeOf("cls", (v) => Number(v).toFixed(3)) || "布局偏移") : ""}
    ${cold ? metricCard("传输量", kb(cold.bytes), rangeOf("bytes", kb) || `${cold.requests} 个请求`) : ""}
  </div>
  ${
    warm
      ? `<h2>冷启动 vs 二次访问</h2>
  <div class="panel"><table>
    <thead><tr><th>指标</th><th>冷启动（清缓存）</th><th>热缓存</th></tr></thead>
    <tbody>${comparisonRows}</tbody>
  </table>
  <div class="legend">差距越大，说明缓存策略越值得优化。</div></div>`
      : ""
  }

  <h2>请求瀑布</h2>
  <div class="panel">
    ${waterfallSvg(netItems, { marks: markList })}
    <div class="legend">
      ${Object.entries(TYPE_COLORS)
        .filter(([k]) => netItems.some((i) => (i.resourceType || "other").toLowerCase() === k))
        .map(([k, v]) => `<span><i style="background:${v}"></i>${CATEGORY_LABEL[k] || k}</span>`)
        .join("")}
    </div>
    <div class="note">时间轴为采集机上的真实请求时序（未做带宽/CPU 节流）；上方卡片中的 FCP / LCP / TBT 为 Lighthouse 模拟 4G + 4 倍 CPU 降速后的结果，刻度不同，请勿直接对比。</div>
  </div>

  <h2>文件体积分析</h2>
  <div class="panel two">
    <div>${donutSvg(stats)}</div>
    <div>
      <table>
        <thead><tr><th>类型</th><th class="num">请求数</th><th class="num">传输量</th><th style="width:110px">占比</th></tr></thead>
        <tbody>
        ${stats
          .map((s) => {
            const total = stats.reduce((a, b) => a + b.bytes, 0) || 1;
            const pct = (s.bytes / total) * 100;
            return `<tr><td>${CATEGORY_LABEL[s.type] || s.type}</td><td class="num">${s.count}</td><td class="num">${kb(
              s.bytes
            )}</td><td><div class="pct"><span class="pct-bar"><i style="width:${Math.max(pct, 1.5).toFixed(
              1
            )}%"></i></span><span class="pct-txt">${pct.toFixed(1)}%</span></div></td></tr>`;
          })
          .join("")}
        </tbody>
      </table>
    </div>
  </div>

  <h2>体积最大的文件</h2>
  <div class="panel">
    <table>
      <thead><tr><th>文件</th><th>类型</th><th class="num">传输</th><th class="num">解压后</th></tr></thead>
      <tbody>
      ${topFiles
        .map(
          (f) => `<tr><td style="word-break:break-all">${esc(
            String(f.url).replace(/^https?:\/\//, "")
          )}</td><td>${esc(f.resourceType)}</td><td class="num">${kb(
            f.transferSize || 0
          )}</td><td class="num">${kb(f.resourceSize || 0)}</td></tr>`
        )
        .join("")}
      </tbody>
    </table>
  </div>

  <h2>自动诊断</h2>
  <div class="panel"><ul class="diag">${diagnostics(netItems, audits)
    .map((d) => `<li>${d}</li>`)
    .join("")}</ul></div>

  <h2>优化机会</h2>
  <div class="panel">
    <table>
      <thead><tr><th>项目</th><th class="num">预估收益</th></tr></thead>
      <tbody>
      ${opportunities
        .map(([, a]) => `<tr><td>${esc(a.title)}</td><td class="num">${esc(a.displayValue || ms(a.numericValue))}</td></tr>`)
        .join("") || '<tr><td colspan="2" style="color:#98a2a9">本次没有检测到明显机会</td></tr>'}
      </tbody>
    </table>
  </div>

  ${
    mainThread.length
      ? `<h2>主线程开销</h2>
  <div class="panel"><table>
    <thead><tr><th>活动</th><th class="num">耗时</th></tr></thead>
    <tbody>${mainThread
      .map((i) => `<tr><td>${esc(i.groupLabel || i.group)}</td><td class="num">${ms(i.duration)}</td></tr>`)
      .join("")}</tbody>
  </table>
  ${
    bootup.length
      ? `<table style="margin-top:14px"><thead><tr><th>JS 执行 Top</th><th class="num">耗时</th></tr></thead><tbody>${bootup
          .map(
            (i) =>
              `<tr><td style="word-break:break-all">${esc(String(i.url).replace(/^https?:\/\//, "").slice(0, 90))}</td><td class="num">${ms(
                i.total
              )}</td></tr>`
          )
          .join("")}</tbody></table>`
      : ""
  }
  </div>`
      : ""
  }

  ${
    thirdParties.length
      ? `<h2>占用资源的第三方</h2>
  <div class="panel"><table>
    <thead><tr><th>来源</th><th class="num">传输量</th><th class="num">主线程阻塞</th></tr></thead>
    <tbody>${thirdParties
      .map(
        (t) =>
          `<tr><td>${esc((t.entity && (t.entity.text || t.entity.type)) || t.entity || "未知")}</td><td class="num">${kb(
            t.transferSize || 0
          )}</td><td class="num">${ms(t.blockingTime || 0)}</td></tr>`
      )
      .join("")}</tbody>
  </table></div>`
      : ""
  }

  <div class="foot">
    数据来源：Lighthouse ${esc(String(manifest.lighthouse || ""))}，Chrome ${esc(
      String((manifest.chrome && manifest.chrome.version) || "")
    )}。
    原始报告：${coldRuns
      .map((r) => `<a href="${esc(r.relHtml)}">${esc(r.relHtml)}</a>`)
      .concat(warmRuns.map((r) => `<a href="${esc(r.relHtml)}">${esc(r.relHtml)}</a>`))
      .join(" · ")}
  </div>
</div>
</body>
</html>`;

const reportPath = path.join(outDir, "report.html");
fs.writeFileSync(reportPath, html);
console.log(`报告已生成：${reportPath}`);
if (argv.includes("--open")) {
  execFile(process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open", [reportPath]);
}
