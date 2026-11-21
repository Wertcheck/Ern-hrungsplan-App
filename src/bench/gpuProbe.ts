/**
 * Roh-Test der WebGPU-Pipeline OHNE Sprachmodell: reproduziert, ob Rücklesen (mapAsync) zuverlässig ist, ob f16/f32-Rechnen korrekte Ergebnisse liefert,
 * wie hoch der Durchsatz ist und ob er unter Dauerlast abfällt (Drosselung). Alles wird gemessen, nichts geschätzt; Fehler werden aufgezeichnet, nicht verborgen.
 */
type Any = any // eslint-disable-line @typescript-eslint/no-explicit-any

const wgsl = (f16: boolean) => `${f16 ? 'enable f16;\n' : ''}alias T = ${f16 ? 'f16' : 'f32'};
@group(0) @binding(0) var<storage, read> A: array<T>;
@group(0) @binding(1) var<storage, read> B: array<T>;
@group(0) @binding(2) var<storage, read_write> C: array<T>;
struct P { n: u32 }
@group(0) @binding(3) var<uniform> p: P;
var<workgroup> ta: array<T, 256>;
var<workgroup> tb: array<T, 256>;
@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) g: vec3<u32>, @builtin(local_invocation_id) l: vec3<u32>) {
  let n = p.n;
  var acc: T = T(0);
  for (var t = 0u; t < n / 16u; t++) {
    ta[l.y * 16u + l.x] = A[g.y * n + t * 16u + l.x];
    tb[l.y * 16u + l.x] = B[(t * 16u + l.y) * n + g.x];
    workgroupBarrier();
    for (var k = 0u; k < 16u; k++) { acc += ta[l.y * 16u + k] * tb[k * 16u + l.x]; }
    workgroupBarrier();
  }
  C[g.y * n + g.x] = acc;
}`

// WebGPU-Konstanten (Typen sind im Projekt nicht eingebunden)
const GPUBufferUsage = { MAP_READ: 1, COPY_SRC: 4, COPY_DST: 8, UNIFORM: 64, STORAGE: 128 }
const GPUMapMode = { READ: 1 }
const err = (e: unknown) => String((e as Error)?.message ?? e)
const half = (x: number) => { // float → f16-Bits (nur für Werte wie 1.0)
  const f = new Float32Array([x]), i = new Uint32Array(f.buffer)[0]; const s = (i >> 16) & 0x8000; let e = ((i >> 23) & 0xff) - 127 + 15; const m = (i >> 13) & 0x3ff
  if (e <= 0) return s; if (e >= 31) return s | 0x7c00; return s | (e << 10) | m
}

export async function runGpuProbe(log: (t: string) => void): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = { startedAt: new Date().toISOString() }
  const gpu = (navigator as Any).gpu
  if (!gpu) return { ...out, error: 'WebGPU nicht verfügbar' }
  const adapter = await gpu.requestAdapter(); if (!adapter) return { ...out, error: 'kein Adapter' }
  const info = adapter.info ?? (adapter.requestAdapterInfo ? await adapter.requestAdapterInfo() : {})
  out.adapter = { vendor: info.vendor ?? null, architecture: info.architecture ?? null, isFallbackAdapter: adapter.isFallbackAdapter ?? null, hasF16: adapter.features.has('shader-f16') }
  const feats = adapter.features.has('shader-f16') ? ['shader-f16'] : []
  const device = await adapter.requestDevice({ requiredFeatures: feats })
  let lost: string | null = null; device.lost.then((l: Any) => { lost = `${l.reason}: ${l.message}`; (out as Any).deviceLost = lost })
  const uncaught: string[] = []; device.addEventListener('uncapturederror', (e: Any) => uncaught.push(String(e.error?.message ?? e.error).slice(0, 200)))
  out.uncapturedErrors = uncaught

  const run = async (f16: boolean, n: number, iters: number, tag: string) => {
    const r: Record<string, unknown> = { f16, n }
    try {
      device.pushErrorScope('validation')
      const mod = device.createShaderModule({ code: wgsl(f16) })
      const pipe = device.createComputePipeline({ layout: 'auto', compute: { module: mod, entryPoint: 'main' } })
      const bytes = n * n * (f16 ? 2 : 4)
      const mk = (usage: number) => device.createBuffer({ size: bytes, usage })
      const bA = mk(GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST), bB = mk(GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST), bC = mk(GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC)
      const bU = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
      const ones = f16 ? new Uint16Array(n * n).fill(half(1)) : new Float32Array(n * n).fill(1)
      device.queue.writeBuffer(bA, 0, ones); device.queue.writeBuffer(bB, 0, ones); device.queue.writeBuffer(bU, 0, new Uint32Array([n, 0, 0, 0]))
      const bg = device.createBindGroup({ layout: pipe.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: bA } }, { binding: 1, resource: { buffer: bB } }, { binding: 2, resource: { buffer: bC } }, { binding: 3, resource: { buffer: bU } }] })
      const ev = await device.popErrorScope(); if (ev) throw new Error(`Validierung/Shader: ${ev.message.slice(0, 300)}`)
      const dispatch = (enc: Any) => { const p = enc.beginComputePass(); p.setPipeline(pipe); p.setBindGroup(0, bg); p.dispatchWorkgroups(n / 16, n / 16); p.end() }
      // Korrektheit: A=B=1 ⇒ jedes C-Element muss exakt n sein (n ≤ 2048 ist in f16 exakt darstellbar)
      const enc = device.createCommandEncoder(); dispatch(enc); const st = device.createBuffer({ size: bytes, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }); enc.copyBufferToBuffer(bC, 0, st, 0, bytes)
      device.queue.submit([enc.finish()]); await st.mapAsync(GPUMapMode.READ)
      const raw = st.getMappedRange().slice(0); st.unmap(); st.destroy()
      const vals = f16 ? new Uint16Array(raw) : new Float32Array(raw)
      const dec = f16 ? (b: number) => { const e = (b >> 10) & 31, m = b & 1023; return e === 0 ? m * 2 ** -24 : e === 31 ? NaN : (1 + m / 1024) * 2 ** (e - 15) } : (x: number) => x
      let bad = 0; for (let i = 0; i < vals.length; i++) if (dec(vals[i] as number) !== n) bad++
      r.correct = bad === 0; r.wrongElements = bad; r.sample = dec(vals[0] as number)
      // Durchsatz
      await device.queue.onSubmittedWorkDone(); const t0 = performance.now()
      const e2 = device.createCommandEncoder(); for (let i = 0; i < iters; i++) dispatch(e2); device.queue.submit([e2.finish()]); await device.queue.onSubmittedWorkDone()
      const ms = performance.now() - t0; r.ms = Math.round(ms); r.gflops = +((2 * n ** 3 * iters) / (ms / 1000) / 1e9).toFixed(1)
      ;(r as Any)._run = async (secs: number) => { // Dauerlast: GFLOPS pro Sekunde
        const per: number[] = []; const end = performance.now() + secs * 1000
        while (performance.now() < end) { const s = performance.now(); let k = 0; while (performance.now() - s < 1000) { const e = device.createCommandEncoder(); for (let i = 0; i < 4; i++) dispatch(e); device.queue.submit([e.finish()]); await device.queue.onSubmittedWorkDone(); k += 4 } per.push(+((2 * n ** 3 * k) / ((performance.now() - s) / 1000) / 1e9).toFixed(1)) }
        return per
      }
    } catch (e) { r.error = err(e) }
    log(`${tag}: ${r.error ?? `korrekt=${r.correct} ${r.gflops} GFLOPS`}`); return r
  }

  // 1) Rücklesen unter Wiederholung (mapAsync-Zuverlässigkeit), unabhängig von Rechenlast
  try {
    log('Rücklesen 200× …'); const n = 64 * 1024; const src = device.createBuffer({ size: n, usage: GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST }); device.queue.writeBuffer(src, 0, new Uint8Array(n).fill(7))
    const res = { iterations: 200, failures: 0 as number, wrongData: 0 as number, firstError: null as string | null, maxMs: 0, totalMs: 0 }
    for (let i = 0; i < 200; i++) {
      const t = performance.now()
      try { const st = device.createBuffer({ size: n, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }); const e = device.createCommandEncoder(); e.copyBufferToBuffer(src, 0, st, 0, n); device.queue.submit([e.finish()]); await st.mapAsync(GPUMapMode.READ); const v = new Uint8Array(st.getMappedRange()); if (v[0] !== 7 || v[n - 1] !== 7) res.wrongData++; st.unmap(); st.destroy() }
      catch (e) { res.failures++; res.firstError ??= err(e); if (res.failures >= 5) break }
      const d = performance.now() - t; res.totalMs += d; res.maxMs = Math.max(res.maxMs, Math.round(d))
    }
    out.readback = { ...res, avgMs: +(res.totalMs / res.iterations).toFixed(2) }
  } catch (e) { out.readback = { error: err(e) } }

  // 2) Korrektheit + Durchsatz f32 und f16
  const f32 = await run(false, 1024, 10, 'f32 1024²'); const f32run = (f32 as Any)._run; delete (f32 as Any)._run; out.matmul_f32 = f32
  let f16r: Record<string, unknown> | null = null; let f16run: Any = null
  if (feats.length) { f16r = await run(true, 1024, 10, 'f16 1024²'); f16run = (f16r as Any)._run; delete (f16r as Any)._run; out.matmul_f16 = f16r } else out.matmul_f16 = 'shader-f16 nicht verfügbar'

  // 3) Dauerlast (Drosselung): GFLOPS je Sekunde über ~20 s (nur wenn der Rohtest funktioniert)
  if (f32run && !f32.error) { log('Dauerlast f32 20 s …'); try { out.sustained_f32_gflops_per_s = await f32run(20) } catch (e) { out.sustained_f32_error = err(e) } }
  if (f16run && !(f16r as Any)?.error) { log('Dauerlast f16 20 s …'); try { out.sustained_f16_gflops_per_s = await f16run(20) } catch (e) { out.sustained_f16_error = err(e) } }
  out.deviceLost = lost; out.finishedAt = new Date().toISOString()
  try { device.destroy() } catch { /* ignorieren */ }
  return out
}
