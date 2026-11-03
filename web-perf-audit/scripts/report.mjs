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

const DEVICE_LABEL = { mobile: "移动端", desktop: "桌面端" };

// 资源类型统一走这张表，避免表格里漏出 Lighthouse 的英文原值
const typeZh = (t) => CATEGORY_LABEL[String(t || "other").toLowerCase()] || "其他";

/* ---------------- 中文文案表 ---------------- */
// 优化点的归属，与 SKILL.md 里"可优化点归属"的四个分类对齐
const OWNER_LABEL = {
  fe: "前端代码",
  build: "构建配置",
  ops: "运维响应头",
  third: "第三方 SDK",
};

// Lighthouse 审计项 → 中文标题 + 归属 + 对应措施。
// 按 audit id 索引（id 跨版本稳定），标题不依赖 Lighthouse 的语言包。
const OPP_ZH = {
  "render-blocking-resources": {
    t: "阻塞渲染的 CSS / JS",
    o: "fe",
    a: "内联首屏关键 CSS，其余样式改为异步加载（preload 后切 media）；非关键脚本加 defer / async，别让同步脚本卡住首屏解析。",
  },
  "unused-css-rules": {
    t: "未使用的 CSS",
    o: "fe",
    a: "用 PurgeCSS / UnCSS 按模板清理无用选择器；按路由拆分样式并按需加载；关键 CSS 内联进 HTML。",
  },
  "unused-javascript": {
    t: "加载了但没执行的 JS",
    o: "fe",
    a: "按路由做代码分割 + 动态 import 懒加载；开启 Tree-shaking；排查是否整包引入了组件库、图标库或语言包。",
  },
  "unminified-javascript": {
    t: "未压缩的 JS",
    o: "build",
    a: "生产构建开启压缩（Terser / esbuild），确认发布产物不是 debug 构建。",
  },
  "unminified-css": {
    t: "未压缩的 CSS",
    o: "build",
    a: "构建产物开启 CSS 压缩（cssnano / lightningcss），并去掉注释与 sourcemap 内联。",
  },
  "uses-text-compression": {
    t: "文本资源未压缩传输",
    o: "ops",
    a: "Nginx 或 CDN 对 html / css / js / json / svg 开启 Brotli（其次 gzip），并确认没有对图片等已压缩格式重复压缩。",
  },
  "uses-http2": {
    t: "未使用 HTTP/2",
    o: "ops",
    a: "域名接入 HTTP/2 或 HTTP/3，同域多请求可复用一条连接，省掉 6 连接上限带来的排队。",
  },
  "uses-optimized-images": {
    t: "图片未做压缩优化",
    o: "fe",
    a: "构建期用 sharp / squoosh 压缩并去掉元数据，按内容选质量（75~85）；大图交由 CDN 动态处理。",
  },
  "modern-image-formats": {
    t: "未使用 WebP / AVIF 等现代图片格式",
    o: "fe",
    a: "转 WebP / AVIF，用 picture + source type 兜底；接入 CDN 可按 Accept 头自动转换。",
  },
  "uses-responsive-images": {
    t: "图片尺寸与实际展示不符",
    o: "fe",
    a: "用 srcset / sizes 或 picture 输出多尺寸，配合 CDN 动态裁剪，避免下发远大于展示尺寸的图。",
  },
  "offscreen-images": {
    t: "屏幕外图片未懒加载",
    o: "fe",
    a: "加 loading=\"lazy\" 与 decoding=\"async\"；但首屏与 LCP 图片必须立即加载，不要 lazy。",
  },
  "efficient-animated-content": {
    t: "动图占用体积过大",
    o: "fe",
    a: "GIF 转 MP4 / WebM，用 video 标签 autoplay muted loop playsinline，体积通常能降一个量级。",
  },
  "uses-rel-preconnect": {
    t: "关键域名未预连接",
    o: "fe",
    a: "对字体、CDN、接口域名加 link rel=preconnect（跨域加 crossorigin），必要时补 dns-prefetch 兜底。",
  },
  "uses-rel-preload": {
    t: "关键请求未预加载",
    o: "fe",
    a: "对首屏必需的 JS / CSS / 字体加 preload，注意只预加载真正关键的资源，否则会和首屏资源抢带宽。",
  },
  "font-display": {
    t: "字体加载期间文字不可见",
    o: "fe",
    a: "@font-face 加 font-display: swap；字体做子集化并 preload 关键字体文件。",
  },
  "duplicated-javascript": {
    t: "同一模块被打包多份",
    o: "build",
    a: "用 splitChunks 或 npm dedupe 提取公共依赖，统一依赖版本，避免多份副本同时进首屏。",
  },
  "legacy-javascript": {
    t: "旧浏览器 polyfill 过多",
    o: "build",
    a: "收窄 browserslist targets，preset-env 用 useBuiltIns: usage；必要时做差异化构建（modern / legacy 双份产物）。",
  },
  "total-byte-weight": {
    t: "总传输体积偏大",
    o: "fe",
    a: "综合处理：图片压缩、代码分割、开启压缩、裁掉非必要第三方脚本；先看体积 Top 文件从最大的开始砍。",
  },
  "server-response-time": {
    t: "服务器响应慢（TTFB）",
    o: "ops",
    a: "加服务端缓存、补数据库索引、上 CDN 或边缘渲染，把 TTFB 压到 600ms 以内。",
  },
  redirects: {
    t: "存在多余重定向",
    o: "ops",
    a: "统一 http→https、去尾斜杠与大小写规则，把多次跳转合成一次，重定向链会直接占用首字节时间。",
  },
  "uses-long-cache-ttl": {
    t: "静态资源缓存时间偏短",
    o: "ops",
    a: "文件名带内容 hash，配 Cache-Control: public, max-age=31536000, immutable；HTML 入口保持短缓存。",
  },
  "critical-request-chains": {
    t: "关键请求链过长",
    o: "fe",
    a: "预加载链末端的关键资源，减少串行依赖层级，把阻塞首屏的资源提到最前面。",
  },
  "preload-lcp-image": {
    t: "LCP 图片未预加载",
    o: "fe",
    a: "加 link rel=preload as=image 并配 fetchpriority=\"high\"，确保 LCP 图尽早开始下载。",
  },
  "prioritize-lcp-image": {
    t: "LCP 图片优先级偏低",
    o: "fe",
    a: "给 LCP 图加 fetchpriority=\"high\"，避免被图片轮播、视频封面等非关键资源挤占带宽。",
  },
  "lcp-lazy-loaded": {
    t: "LCP 图片被懒加载",
    o: "fe",
    a: "移除首屏主图的 loading=\"lazy\"，改为立即加载。",
  },
  "non-composited-animations": {
    t: "动画未走合成层",
    o: "fe",
    a: "动画只用 transform / opacity 驱动，必要时加 will-change；避免直接改 top / left / width 触发重排。",
  },
  "unsized-images": {
    t: "图片缺少尺寸声明",
    o: "fe",
    a: "给图片设 width / height 或 aspect-ratio，让浏览器提前占位，减少布局偏移（CLS）。",
  },
  "avoid-large-complex-layouts": {
    t: "布局计算开销大",
    o: "fe",
    a: "减少 DOM 深度与同层元素数量，避免在循环里反复读写布局属性（强制同步布局）。",
  },
  "dom-size": {
    t: "DOM 节点过多",
    o: "fe",
    a: "长列表改虚拟滚动或分页渲染，精简无用的包装层与隐藏节点。",
  },
  "no-document-write": {
    t: "使用了 document.write",
    o: "fe",
    a: "改用 DOM API 或异步注入脚本，document.write 会阻塞 HTML 解析。",
  },
  "uses-passive-event-listeners": {
    t: "滚动 / 触摸监听未设 passive",
    o: "fe",
    a: "事件监听加 { passive: true }，让浏览器不等 JS 就能开始滚动。",
  },
  "avoid-enormous-network-payloads": {
    t: "单个请求体积过大",
    o: "ops",
    a: "拆分大文件、开启压缩、大接口改分页或增量返回。",
  },
  "bootup-time": {
    t: "JS 启动执行耗时高",
    o: "fe",
    a: "做代码分割、延后非关键脚本、减少首屏依赖链，把重计算移到 Web Worker。",
  },
  "mainthread-work-breakdown": {
    t: "主线程繁忙",
    o: "fe",
    a: "把长任务切片（scheduler.postTask / requestIdleCallback），减少首屏 DOM 数量与样式计算开销。",
  },
  "third-party-summary": {
    t: "第三方代码开销大",
    o: "third",
    a: "逐个评估 SDK 的必要性，能延后的延后（交互后再加载），能自建的换轻量实现，并给第三方脚本加 preconnect。",
  },
  "network-rtt": {
    t: "网络往返时延（RTT）偏高",
    o: "ops",
    a: "静态资源放到离用户更近的 CDN 节点，减少跨地域回源；条件允许时用 HTTP/3 降低握手开销。",
  },
  "network-server-latency": {
    t: "服务端排队与处理耗时高",
    o: "ops",
    a: "检查连接池与并发上限、补一层缓存，避免请求在服务端排队等待。",
  },
};

// 主线程活动分组的中文名（Lighthouse 的 group 字段是 camelCase 标识，跨版本稳定）
const MAIN_THREAD_ZH = {
  scriptEvaluation: "脚本执行",
  scriptParseCompile: "脚本解析与编译",
  styleLayout: "样式计算与布局",
  parseHTML: "解析 HTML 与 CSS",
  paintCompositeRender: "绘制与合成",
  garbageCollection: "垃圾回收",
  other: "其他",
};

const mtZh = (item) => {
  const byGroup = MAIN_THREAD_ZH[item.group];
  if (byGroup) return byGroup;
  // 少数版本只给 groupLabel（英文），按小写再兜一层
  const byLabel = Object.entries(MAIN_THREAD_ZH).find(
    ([k, v]) => String(item.groupLabel || "").toLowerCase() === k.toLowerCase() || item.groupLabel === v
  );
  return byLabel ? byLabel[1] : item.groupLabel || "其他";
};

// 第三方来源：先按品牌 / 域名匹配中文名与用途，匹配不到就原样显示域名
const THIRD_PARTY_MAP = [
  { keys: ["googletagmanager.com", "google tag manager"], zh: "谷歌代码管理器（GTM）", kind: "标签管理" },
  { keys: ["google-analytics.com", "google analytics"], zh: "谷歌分析（GA）", kind: "数据分析" },
  { keys: ["doubleclick.net", "googlesyndication.com", "google adsense", "google/doubleclick ads"], zh: "谷歌广告", kind: "广告投放" },
  { keys: ["fonts.googleapis.com", "fonts.gstatic.com", "google fonts"], zh: "谷歌字体", kind: "字体" },
  { keys: ["maps.googleapis.com", "google maps"], zh: "谷歌地图", kind: "地图服务" },
  { keys: ["gstatic.com", "google cdn"], zh: "谷歌静态资源", kind: "CDN" },
  { keys: ["googleapis.com", "other google apis/sdks"], zh: "谷歌 API 服务", kind: "接口服务" },
  { keys: ["connect.facebook.net", "facebook.net", "facebook.com", "facebook"], zh: "Meta（Facebook）", kind: "广告投放" },
  { keys: ["ads-twitter.com", "twitter.com", "twitter", "x.com"], zh: "X（推特）", kind: "广告投放" },
  { keys: ["youtube.com", "ytimg.com", "youtube"], zh: "YouTube", kind: "视频" },
  { keys: ["tiktok.com", "tiktok"], zh: "TikTok", kind: "广告投放" },
  { keys: ["hotjar.com", "hotjar"], zh: "Hotjar", kind: "行为分析" },
  { keys: ["sentry.io", "sentry-cdn.com", "sentry"], zh: "Sentry", kind: "错误监控" },
  { keys: ["intercom.io", "intercom"], zh: "Intercom", kind: "在线客服" },
  { keys: ["zendesk.com", "zendesk"], zh: "Zendesk", kind: "在线客服" },
  { keys: ["cdnjs.cloudflare.com", "cloudflare.com", "cloudflare"], zh: "Cloudflare", kind: "公共 CDN" },
  { keys: ["jsdelivr.net", "jsdelivr"], zh: "jsDelivr", kind: "公共 CDN" },
  { keys: ["unpkg.com", "unpkg"], zh: "unpkg", kind: "公共 CDN" },
  { keys: ["hm.baidu.com"], zh: "百度统计", kind: "数据分析" },
  { keys: ["bdstatic.com"], zh: "百度静态资源", kind: "CDN" },
  { keys: ["bcebos.com", "bcevod.com"], zh: "百度云存储", kind: "对象存储" },
  { keys: ["umeng.com", "cnzz.com", "umeng"], zh: "友盟 / CNZZ", kind: "数据分析" },
  { keys: ["alicdn.com"], zh: "阿里云 CDN", kind: "CDN" },
  { keys: ["bytecdn.cn", "byteimg.com", "bytednsdoc.com"], zh: "字节跳动 CDN", kind: "CDN" },
  { keys: ["gtimg.com", "qq.com", "tencent"], zh: "腾讯", kind: "静态资源" },
  { keys: ["aliyuncs.com", "alibaba"], zh: "阿里云", kind: "静态资源" },
  { keys: ["baidu.com", "baidu analytics", "baidu"], zh: "百度统计", kind: "数据分析" },
  { keys: ["stripe.com", "stripe"], zh: "Stripe", kind: "支付" },
];

function thirdPartyInfo(t) {
  const e = t.entity;
  const raw = typeof e === "string" ? e : (e && (e.text || e.url)) || "";
  const key = String(raw)
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "");
  if (!key) return { name: "未知来源", kind: "未识别来源", domain: "" };
  const hit = THIRD_PARTY_MAP.find((m) =>
    m.keys.some((k) => key === k || key.endsWith(`.${k}`) || key.includes(k))
  );
  // entity.text 可能是域名，也可能是品牌名（如 "Baidu Analytics"），只有域名才在名称下方补一行
  const looksLikeDomain = /^[a-z0-9.-]+\.[a-z]{2,}$/.test(key);
  const domain = hit ? (looksLikeDomain ? key : "") : "";
  return hit ? { name: hit.zh, kind: hit.kind, domain } : { name: key, kind: "未识别来源", domain: "" };
}

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

// 脚本 URL 展示：去掉协议，Lighthouse 的占位词换成中文说明
const scriptLabel = (u) => {
  const s = String(u || "").replace(/^https?:\/\//, "");
  if (/^\(?unattributable\)?$/i.test(s)) return "无法归属到具体脚本";
  return s.length > 90 ? `${s.slice(0, 90)}…` : s;
};

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
    out.push(`最长任务 <b>${ms(worst.duration)}</b>，来自 <code>${esc(scriptLabel(worst.url || "未知"))}</code>。`);
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

// 优化机会：Lighthouse 的 numericValue 单位不统一（有的按 ms，有的按字节），
// 直接按它排序会让纯体积项挤掉真正拖慢首屏的项。这里统一取 overallSavingsMs / Bytes 再排序。
function savingsOf(audit) {
  const d = audit.details || {};
  const time = Number(d.overallSavingsMs) || 0;
  const bytes = Number(d.overallSavingsBytes) || 0;
  if (time > 0 && bytes > 0) return `省时 ${ms(time)} · 省 ${kb(bytes)}`;
  if (time > 0) return `省时 ${ms(time)}`;
  if (bytes > 0) return `省 ${kb(bytes)}`;
  // 少量审计项不带明细，只能退回 numericValue，单位按 id 猜
  const n = Number(audit.numericValue) || 0;
  if (!n) return "-";
  return /byte|weight|size|image|font|resource/i.test(audit.id) ? `省 ${kb(n)}` : `省时 ${ms(n)}`;
}

const opportunities = Object.entries(audits)
  .filter(([, a]) => {
    if (!a || !a.details || a.details.type !== "opportunity") return false;
    const d = a.details;
    return (
      (Number(d.overallSavingsMs) || 0) > 0 ||
      (Number(d.overallSavingsBytes) || 0) > 0 ||
      (typeof a.numericValue === "number" && a.numericValue > 0)
    );
  })
  .map(([id, audit]) => ({
    id,
    audit,
    time: Number(audit.details.overallSavingsMs) || 0,
    bytes: Number(audit.details.overallSavingsBytes) || 0,
  }))
  // 先按省下的阻塞时间排，时间相同的再按体积排；纯体积项排在后半段
  .sort((a, b) => b.time - a.time || b.bytes - a.bytes)
  .slice(0, 12);

const thirdParties = (audits["third-party-summary"]?.details?.items || [])
  .filter((i) => i.transferSize > 1024 || i.blockingTime > 10)
  .sort((a, b) => (b.transferSize || 0) - (a.transferSize || 0))
  .slice(0, 8);

const mainThreadAll = audits["mainthread-work-breakdown"]?.details?.items || [];
const mainThread = mainThreadAll.slice(0, 7);
const mainThreadTotal = mainThreadAll.reduce((s, i) => s + (i.duration || 0), 0);
const bootupAll = audits["bootup-time"]?.details?.items || [];
const bootup = bootupAll.slice(0, 8);
const bootupTotal = bootupAll.reduce((s, i) => s + (i.total || 0), 0);

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
  .opp-title { font-weight: 500; }
  .tag { display: inline-block; margin-left: 6px; padding: 0 6px; border: 1px solid #dfe3e6; border-radius: 10px;
    background: #fafbfb; color: #6d7883; font-size: 10.5px; font-weight: 400; vertical-align: 1px; white-space: nowrap; }
  .ent { font-size: 11px; color: #98a2a9; margin-top: 2px; word-break: break-all; }
  td.advice { color: #3c4a56; min-width: 320px; }
  @media (max-width: 820px) { .two { grid-template-columns: 1fr; } }
</style>
</head>
<body>
<div class="wrap">
  <h1>页面性能报告</h1>
  <div class="sub">${esc(manifest.url)}</div>
  <div class="meta">
    <span>设备<code>${esc(DEVICE_LABEL[manifest.device] || manifest.device || "-")}</code></span>
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
          )}</td><td>${esc(typeZh(f.resourceType))}</td><td class="num">${kb(
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
      <thead><tr><th style="width:230px">优化点</th><th class="num" style="width:140px">预估收益</th><th>对应措施</th></tr></thead>
      <tbody>
      ${
        opportunities
          .map(({ id, audit }) => {
            const zh = OPP_ZH[id] || {};
            const owner = OWNER_LABEL[zh.o];
            const title = zh.t || audit.title;
            const advice = zh.a || "按 Lighthouse 该审计项的明细处理，具体资源清单见原始报告。";
            return `<tr><td><div class="opp-title">${esc(title)}${
              owner ? `<span class="tag">${esc(owner)}</span>` : ""
            }</div>${zh.t ? "" : `<div class="ent">原项：${esc(audit.title)}</div>`}</td><td class="num">${esc(
              savingsOf(audit)
            )}</td><td class="advice">${esc(advice)}</td></tr>`;
          })
          .join("") || '<tr><td colspan="3" style="color:#98a2a9">本次没有检测到明显机会</td></tr>'
      }
      </tbody>
    </table>
    <div class="note">收益为 Lighthouse 预估的「阻塞时间缩短 / 传输字节减少」，按省下的时间优先排序；标签标注该优化点的归属方。未收录的审计项保留 Lighthouse 原标题，措施按其明细执行。</div>
  </div>

  ${
    mainThread.length
      ? `<h2>主线程开销</h2>
  <div class="panel"><table>
    <thead><tr><th>活动</th><th class="num">耗时</th><th style="width:190px">占主线程</th></tr></thead>
    <tbody>${mainThread
      .map((i) => {
        const pct = mainThreadTotal ? (i.duration / mainThreadTotal) * 100 : 0;
        return `<tr><td>${esc(mtZh(i))}</td><td class="num">${ms(i.duration)}</td><td><div class="pct"><span class="pct-bar"><i style="width:${Math.max(
          pct,
          1.5
        ).toFixed(1)}%"></i></span><span class="pct-txt">${pct.toFixed(1)}%</span></div></td></tr>`;
      })
      .join("")}</tbody>
  </table>
  <div class="note">主线程总耗时 ${ms(mainThreadTotal)}。单个任务超过 50&#8239;ms 就会推迟交互，脚本执行占比越高越该先做代码分割与长任务切片。</div>
  ${
    bootup.length
      ? `<table style="margin-top:14px"><thead><tr><th>脚本执行耗时 Top</th><th class="num">小计</th><th class="num">其中解析编译</th></tr></thead><tbody>${bootup
          .map(
            (i) =>
              `<tr><td style="word-break:break-all">${esc(scriptLabel(i.url))}</td><td class="num">${ms(
                i.total
              )}</td><td class="num">${ms(i.scriptParseCompile || 0)}</td></tr>`
          )
          .join("")}</tbody></table>
  <div class="note">脚本执行合计 ${ms(bootupTotal)}，解析编译耗时偏高的脚本通常是体积过大或未做压缩。</div>`
      : ""
  }
  </div>`
      : ""
  }

  ${
    thirdParties.length
      ? `<h2>第三方资源占用</h2>
  <div class="panel"><table>
    <thead><tr><th>来源</th><th>用途</th><th class="num">传输量</th><th class="num">主线程耗时</th><th class="num">阻塞时间</th></tr></thead>
    <tbody>${thirdParties
      .map((t) => {
        const info = thirdPartyInfo(t);
        return `<tr><td><div class="opp-title">${esc(info.name)}</div>${
          info.domain ? `<div class="ent">${esc(info.domain)}</div>` : ""
        }</td><td>${esc(info.kind)}</td><td class="num">${kb(t.transferSize || 0)}</td><td class="num">${ms(
          t.mainThreadTime || 0
        )}</td><td class="num">${ms(t.blockingTime || 0)}</td></tr>`;
      })
      .join("")}</tbody>
  </table>
  <div class="note">仅列出传输量超过 1&#8239;KB 或阻塞主线程超过 10&#8239;ms 的来源，按传输量排序。「阻塞时间」是其中同步执行、直接推迟交互的部分，第三方 SDK 自身无法改造时优先考虑延后加载或替换。</div></div>`
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
