// 极简 CDP 客户端：仅依赖 Node 18+ 内置 fetch 与 Node 22 内置 WebSocket
// 用于：启动调试 Chrome 后的页面操作（注入 storage、清缓存）

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function getJson(port, path, method = "GET") {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { method });
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`CDP HTTP 返回非 JSON: ${text.slice(0, 200)}`);
  }
}

export async function waitForPort(port, { timeoutMs = 25000, intervalMs = 300 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const v = await getJson(port, "/json/version");
      if (v && v.Browser) return v;
    } catch (e) {
      lastErr = e;
    }
    await sleep(intervalMs);
  }
  throw new Error(`等待调试端口 ${port} 超时${lastErr ? `: ${lastErr.message}` : ""}`);
}

export async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  const pending = new Map();
  let nextId = 0;

  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", (e) => reject(new Error(`WebSocket 连接失败: ${e.message || "unknown"}`)), {
      once: true,
    });
  });

  ws.addEventListener("message", (ev) => {
    let msg;
    try {
      msg = JSON.parse(typeof ev.data === "string" ? ev.data : "");
    } catch {
      return;
    }
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    }
  });

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error(`CDP 调用超时: ${method}`));
        }
      }, 30000);
    });

  return { send, close: () => ws.close() };
}

// 打开一个临时 target 并执行 fn，结束后关闭
export async function withPage(port, fn, { url = "about:blank" } = {}) {
  const target = await getJson(port, `/json/new?${encodeURIComponent(url)}`, "PUT");
  const page = await connect(target.webSocketDebuggerUrl);
  try {
    return await fn(page, target);
  } finally {
    page.close();
    await getJson(port, `/json/close/${target.id}`).catch(() => {});
  }
}

// 清空 HTTP 缓存（不动 cookie，避免把登录态一起清掉）
export async function clearCache(port) {
  return withPage(port, async (page) => {
    await page.send("Network.enable");
    await page.send("Network.clearBrowserCache");
    return true;
  });
}

// 在指定 origin 下写入 localStorage，返回写入后的校验结果
export async function seedLocalStorage(port, origin, storage) {
  return withPage(
    port,
    async (page) => {
      await page.send("Page.enable");
      await page.send("Page.navigate", { url: origin });
      await sleep(1500);
      const payload = JSON.stringify(storage);
      const expr = `(() => {
        const data = ${payload};
        for (const [k, v] of Object.entries(data)) localStorage.setItem(k, typeof v === "string" ? v : JSON.stringify(v));
        const keys = Object.keys(localStorage);
        return { origin: location.origin, keys, count: keys.length };
      })()`;
      const r = await page.send("Runtime.evaluate", { expression: expr, returnByValue: true });
      return r.result.value;
    },
    { url: origin }
  );
}
