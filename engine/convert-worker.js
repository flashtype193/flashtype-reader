// **互转 worker** ✓（2026-09-25 ✓）：转换跑在**这里** ✗→✓ —— 十几秒的活**不冻界面** ✓
//（实测：`xsl11.pdf` 514 页那件 3.2 s，主线程的 10 ms 定时器照跑 **322 下** ✓）。
//
// ⚠ **手写、不走打包器** ✗：库构建会把 worker 内联成 base64 ✗ ⇒ VS Code 那侧就得连它一起吞 ✗。
// 手写 ＋ 原样拷 ⇒ 它跟引擎 glue **同目录** ✓、共用**同一份 wasm** ✓ —— 那份本来就在浏览器缓存里 ✓
//（把转换器并进引擎实测只多 **47 KB** ✗→✓，见 `crates/x2y-core/src/lib.rs` 与 `reader-core/Cargo.toml` ✓）。
import init, { convertDoc } from './reader-core.js';

// ── **wasm 的来路** ✓（2026-09-29 ✓）──
// 默认 ✓：**同目录**那份 ✓（`init()` 自己按 `import.meta.url` 找 ✓）。
// 主线程给了 `wasmUrl` ✓（**发布版** ✓ ⇒ COS 上那份 **gzip** 件 ✓ 2.4 MB ⇒ 1.44 MB ✓）⇒ 取它 ✓。
//
// ⚠ 这份文件是**手写**的 ✗（不进打包器 ✗ ⇒ 没法 `import` 库里那份 TS ✗）⇒ 解压这段是**同款抄**
// 了一份 ✓（`src/core.ts` 的 `loadWasm` ✓）—— 改一边就要改另一边 ✓。
async function loadWasm(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch wasm failed: ${res.status} ${url}`);
  // ① 服务端声明了 `Content-Encoding` ✓ ⇒ 浏览器**已经**解好了 ⇒ 整个交出去 ✓（**边下边编** ✓）
  const enc = (res.headers.get('content-encoding') || '').toLowerCase();
  if (enc.includes('gzip') || enc.includes('br') || enc.includes('deflate')) return res;
  const buf = await res.arrayBuffer();
  const head = Array.from(new Uint8Array(buf.slice(0, 4))).join(',');
  const isWasm = head === '0,97,115,109'; // `\0asm` ✓ ⇒ ② 裸 wasm ⇒ 直接给
  const isGzip = head.startsWith('31,139'); // `1f 8b` ✓ ⇒ ③ 自己解
  if (!isGzip || isWasm) return buf;
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('this browser has no DecompressionStream ⇒ serve wasm with Content-Encoding: gzip');
  }
  return await new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
}

async function boot(wasmUrl) {
  if (!wasmUrl) return init();
  try {
    return await init({ module_or_path: await loadWasm(wasmUrl) });
  } catch (e) {
    return init(); // 远端取不到 ⇒ 退回**同目录**那份 ✓
  }
}

let booted = null;

self.onmessage = async (event) => {
  const { id, bytes, fonts, rasterDpi, wasmUrl } = event.data || {};
  try {
    booted = booted ?? boot(wasmUrl);
    await booted;
    // `fonts` 是 `{ name, url }[]` ✓（core14 那 14 支 ✓，见 `core14Files` ✓）——
    // **在 worker 里 fetch** ✓（不占主线程 ✓）；取不到的跳过 ✓（引擎那边照旧"跳过 + 告警"✓）。
    const payload = [];
    for (const f of fonts || []) {
      try {
        const r = await fetch(f.url);
        if (r.ok) payload.push({ name: f.name, bytes: new Uint8Array(await r.arrayBuffer()) });
      } catch (e) {
        /* 单支取不到不致命 ✓ */
      }
    }
    const out = convertDoc(new Uint8Array(bytes), payload, rasterDpi ?? 0);
    // 产物**转移**回去 ✓（`ArrayBuffer` 转移零拷贝 ✓ —— 别退化成 base64 ✗，那正是这一轮在拔的东西 ✗）。
    self.postMessage(
      {
        id,
        ok: true,
        direction: out.direction,
        pages: out.pages,
        vectorPages: out.vectorPages,
        rasterPages: out.rasterPages,
        fonts: out.fonts,
        warnings: out.warnings,
        bytes: out.bytes,
      },
      [out.bytes.buffer],
    );
  } catch (e) {
    self.postMessage({ id, ok: false, error: String((e && e.message) || e) });
  }
};
