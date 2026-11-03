// 从 Chrome/Edge 的 Local Storage leveldb 中读取指定 origin 的 localStorage
// 原理：解析 leveldb 的 write-ahead log（*.log 中的 WriteBatch 记录），
// 不依赖任何第三方库；读取在 Chrome 运行时也可进行（只读文件）。

import fs from "node:fs";
import path from "node:path";

const BLOCK_SIZE = 32768;

function readVarint(buf, p) {
  let result = 0;
  let shift = 0;
  let byte;
  do {
    byte = buf[p++];
    result += (byte & 0x7f) * Math.pow(2, shift);
    shift += 7;
  } while (byte & 0x80 && shift < 64);
  return [result, p];
}

// 把物理块中的分片记录还原成逻辑记录（FULL / FIRST+MIDDLE+LAST）
function readLogRecords(buf) {
  const logical = [];
  let partial = null;
  for (let off = 0; off < buf.length; off += BLOCK_SIZE) {
    const blockEnd = Math.min(off + BLOCK_SIZE, buf.length);
    let p = off;
    while (p + 7 <= blockEnd) {
      const len = buf.readUInt16LE(p + 4);
      const type = buf[p + 6];
      if (type === 0 || p + 7 + len > blockEnd) break;
      const payload = buf.subarray(p + 7, p + 7 + len);
      if (type === 1) logical.push(payload);
      else if (type === 2) partial = [payload];
      else if (type === 3) partial && partial.push(payload);
      else if (type === 4) {
        if (partial) {
          partial.push(payload);
          logical.push(Buffer.concat(partial));
          partial = null;
        }
      }
      p += 7 + len;
    }
  }
  return logical;
}

// 解析 WriteBatch：seq(8) + count(4) + [tag(1) + keylen + key + vallen + value]*
function parseBatch(batch) {
  if (batch.length < 12) return [];
  const count = batch.readUInt32LE(8);
  const entries = [];
  let p = 12;
  for (let i = 0; i < count && p < batch.length; i++) {
    const tag = batch[p++];
    let klen;
    [klen, p] = readVarint(batch, p);
    const key = batch.subarray(p, p + klen);
    p += klen;
    let vlen;
    [vlen, p] = readVarint(batch, p);
    const value = batch.subarray(p, p + vlen);
    p += vlen;
    entries.push({ tag, key, value });
  }
  return entries;
}

function decodeStorageKey(keyBuf, origin) {
  const raw = keyBuf.toString("latin1");
  if (!raw.startsWith("_") || !raw.includes(origin)) return null;
  let tail = raw.slice(raw.indexOf(origin) + origin.length);
  // 去掉分隔用的控制字节（\x00、\x01），剩下的就是业务 key
  tail = tail.replace(/^[\x00-\x08]+/, "");
  return tail || null;
}

function decodeStorageValue(valueBuf) {
  if (!valueBuf.length) return "";
  const tag = valueBuf[0];
  const body = valueBuf.subarray(1);
  return tag === 0 ? body.toString("utf16le") : body.toString("latin1");
}

/**
 * @param {string} leveldbDir 形如 <profile>/Default/Local Storage/leveldb
 * @param {string} origin 例如 https://example.com
 * @returns {{key:string, value:string, source:string}[]}
 */
export function readLocalStorage(leveldbDir, origin) {
  if (!fs.existsSync(leveldbDir)) {
    throw new Error(`找不到 Local Storage 目录: ${leveldbDir}`);
  }
  const files = fs
    .readdirSync(leveldbDir)
    .filter((f) => f.endsWith(".log"))
    .map((f) => path.join(leveldbDir, f))
    .sort((a, b) => fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs);

  const result = new Map();
  for (const file of files) {
    const buf = fs.readFileSync(file);
    for (const record of readLogRecords(buf)) {
      for (const entry of parseBatch(record)) {
        const key = decodeStorageKey(entry.key, origin);
        if (!key) continue;
        if (entry.tag === 0) {
          result.delete(key);
          continue;
        }
        result.set(key, { key, value: decodeStorageValue(entry.value), source: path.basename(file) });
      }
    }
  }
  return [...result.values()];
}

// 在常见的 Chrome / Edge 安装位置里定位 Local Storage 目录
export function findLeveldbDirs(home = process.env.HOME) {
  const roots = {
    darwin: [
      `${home}/Library/Application Support/Google/Chrome`,
      `${home}/Library/Application Support/Microsoft Edge`,
      `${home}/Library/Application Support/Chromium`,
      `${home}/Library/Application Support/Arc/User Data`,
    ],
    linux: [
      `${home}/.config/google-chrome`,
      `${home}/.config/chromium`,
      `${home}/.config/microsoft-edge`,
    ],
    win32: [
      `${process.env.LOCALAPPDATA}\\Google\\Chrome\\User Data`,
      `${process.env.LOCALAPPDATA}\\Microsoft\\Edge\\User Data`,
    ],
  }[process.platform] || [];

  const found = [];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    let profiles = [];
    try {
      profiles = fs.readdirSync(root).filter((d) => {
        if (!(d === "Default" || /^Profile \d+$/.test(d))) return false;
        try {
          return fs.statSync(path.join(root, d)).isDirectory();
        } catch {
          // Chrome 运行时会留下 SingletonLock 等悬空软链，stat 会抛 ENOENT
          return fs.existsSync(path.join(root, d, "Local Storage", "leveldb"));
        }
      });
    } catch {
      continue;
    }
    for (const profile of profiles) {
      const dir = path.join(root, profile, "Local Storage", "leveldb");
      if (fs.existsSync(dir)) found.push({ browser: path.basename(root), profile, dir });
    }
  }
  return found;
}
