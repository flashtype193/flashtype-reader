// reader 渲染 worker（原型）：
// 只负责 open / renderPage / fontBytes；主线程仍持有 ReaderCore 做目录、签名、页面尺寸。
// wasm / core14 都由主线程取好传进来 —— blob worker 不解析任何跨源 URL。
import init, { convertDoc, ReaderCore, setCore14 } from './reader-core.js'

let doc = null
let openedBytes = null
let booted = null

async function boot(wasmBytes, core14) {
  if (booted) return booted
  booted = (async () => {
    await init({ module_or_path: wasmBytes })
    if (Array.isArray(core14) && core14.length > 0 && typeof setCore14 === 'function') {
      setCore14(core14)
    }
  })()
  return booted
}

function fail(id, error) {
  self.postMessage({ type: 'error', id, error: String((error && error.message) || error) })
}

self.onmessage = async (event) => {
  const m = event.data || {}
  try {
    if (m.type === 'open') {
      await boot(m.wasmBytes, m.core14)
      if (doc && typeof doc.free === 'function') doc.free()
      openedBytes = new Uint8Array(m.bytes)
      doc = new ReaderCore(openedBytes, m.password)
      const pageSizes = []
      for (let i = 0; i < doc.pageCount; i += 1) pageSizes.push(Array.from(doc.pageSizeMm(i)))
      self.postMessage({
        type: 'open-ok',
        id: m.id,
        pageCount: doc.pageCount,
        permissions: doc.permissions,
        outlines: doc.outlines(),
        warnings: doc.warnings(),
        pageSizes,
      })
      return
    }
    if (m.type === 'convert') {
      // 同一个 worker 串行做互转：转换期间不渲染，但不额外占一份 wasm。
      const payload = []
      for (const f of m.fonts || []) {
        try {
          const r = await fetch(f.url)
          if (r.ok) payload.push({ name: f.name, bytes: new Uint8Array(await r.arrayBuffer()) })
        } catch {
          /* 单支取不到不致命 */
        }
      }
      const out = convertDoc(new Uint8Array(m.bytes), payload, m.rasterDpi ?? 0)
      const bytes = out.bytes instanceof Uint8Array ? out.bytes : new Uint8Array(out.bytes)
      self.postMessage(
        { type: 'convert-ok', id: m.id, ...out, bytes: bytes.buffer },
        [bytes.buffer],
      )
      return
    }
    if (!doc) throw new Error('reader worker: document not open')
    if (m.type === 'render') {
      const out = doc.renderPage(m.page, m.dpi)
      const png = out.png instanceof Uint8Array ? out.png : new Uint8Array(out.png)
      self.postMessage(
        { type: 'render-ok', id: m.id, ...out, png: png.buffer, warnings: doc.warnings() },
        [png.buffer],
      )
      return
    }
    if (m.type === 'signatures') {
      const reports = ReaderCore.verifySignatures(openedBytes, m.anchors || [])
      self.postMessage({ type: 'signatures-ok', id: m.id, reports })
      return
    }
    if (m.type === 'font') {
      const bytes = doc.fontBytes(m.index)
      self.postMessage({ type: 'font-ok', id: m.id, bytes: bytes.buffer }, [bytes.buffer])
      return
    }
    throw new Error(`reader worker: unknown message ${m.type}`)
  } catch (error) {
    fail(m.id, error)
  }
}
