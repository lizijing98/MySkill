// 共享的环境探测：Chrome 与 lighthouse 可执行文件定位

import fs from "node:fs";
import os from "node:os";
import { execFileSync } from "node:child_process";

export function run(cmd, argv, opts = {}) {
  try {
    return execFileSync(cmd, argv, { encoding: "utf8", timeout: 20000, ...opts }).trim();
  } catch {
    return null;
  }
}

export function which(bin) {
  const out = run(process.platform === "win32" ? "where" : "which", [bin]);
  return out ? out.split(/\r?\n/)[0].trim() : null;
}

export function chromeCandidates() {
  const list = {
    darwin: [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      `${os.homedir()}/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`,
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    ],
    linux: [
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
    ],
    win32: [
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    ],
  }[process.platform] || [];
  return [process.env.CHROME_PATH, ...list].filter(Boolean);
}

export function findChrome() {
  for (const p of chromeCandidates()) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {
      // 忽略悬空软链
    }
  }
  return null;
}

export function findLighthouse() {
  const fromPath = which("lighthouse");
  if (fromPath) return fromPath;
  const globalRoot = run("npm", ["root", "-g"]);
  if (globalRoot) {
    const candidate = `${globalRoot}/lighthouse/cli/index.js`;
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // ignore
    }
  }
  return null;
}

export function chromeVersion(bin) {
  return run(bin, ["--version"]);
}
