// dsh-ocgo-lite — Host half
// OpenCode Go 用量常驻条的数据后端。零外部依赖：
//   · 配额余量  ← 全局 fetch → https://opencode.ai/zen/go/v1/usage (Bearer auth.json key)
//   · token/金额 ← DSH 会话事件统计(sessionQuery assistant/message usage,过滤 opencode-go provider)
//                 金额按官方定价表(per 1M tokens)估算;token 为真实计量。
// 暴露 webServer 路由 /ocgo-lite/api（client 取数）与模型工具 opencode_go_usage。
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { zstdDecompress } from 'node:zlib'

const USAGE_URL = 'https://opencode.ai/zen/go/v1/usage'
const FETCH_TIMEOUT_MS = 15000
const GO_PROVIDER = 'opencode-go'
// 内存保护:live 扫描的文件数/大小/并行度上限(大会话全量解压会打爆内存)
// 注意:zstd 对 JSONL 压缩比可达 10~50 倍,8MB 压缩文件解压后可能达数百 MB
// 内存保护:单文件压缩 ≤ MAX_SCAN_FILE_BYTES、解压文本 ≤ MAX_SCAN_TEXT_BYTES、
// 并发 ≤ SCAN_CONCURRENCY(逐文件处理,峰值内存 ≈ 2 个文件)。
// 注意:不按数量截断会话——"全部"范围必须覆盖所有会话,否则总量会缺。
const MAX_SCAN_FILE_BYTES = 64 * 1024 * 1024
const MAX_SCAN_TEXT_BYTES = 128 * 1024 * 1024
const SCAN_CONCURRENCY = 2

// 官方定价(opencode.ai/docs/go, per 1M tokens; 2026-08 官方表格,运行时会被官方页面抓取覆盖)
let PRICING = {
  'deepseek-v4-flash': { in: 0.14, out: 0.28, cr: 0.0028, cw: 0 },
  'deepseek-v4-pro': { in: 0.435, out: 0.87, cr: 0.003625, cw: 0 },
  'gpt-5.6-luna': { in: 0.2, out: 1.2, cr: 0.02, cw: 0.25 },
  'glm-5.3': { in: 1.4, out: 4.4, cr: 0.26, cw: 0 },
  'glm-5.2': { in: 1.4, out: 4.4, cr: 0.26, cw: 0 },
  'glm-5.1': { in: 1.4, out: 4.4, cr: 0.26, cw: 0 },
  'kimi-k3': { in: 3.0, out: 15.0, cr: 0.3, cw: 0 },
  'kimi-k2.7-code': { in: 0.95, out: 4.0, cr: 0.19, cw: 0 },
  'kimi-k2.6': { in: 0.95, out: 4.0, cr: 0.16, cw: 0 },
  'minimax-m3': { in: 0.3, out: 1.2, cr: 0.06, cw: 0 },
  'minimax-m2.7': { in: 0.3, out: 1.2, cr: 0.06, cw: 0.375 },
  'minimax-m2.5': { in: 0.3, out: 1.2, cr: 0.06, cw: 0.375 },
  'qwen3.8-max': { in: 2.0, out: 6.0, cr: 0.25, cw: 2.5 },
  'qwen3.7-max': { in: 2.5, out: 7.5, cr: 0.5, cw: 3.125 },
  'qwen3.7-plus': { in: 0.4, out: 1.6, cr: 0.04, cw: 0.5 },
  'qwen3.6-plus': { in: 0.5, out: 3.0, cr: 0.05, cw: 0.625 },
  'grok-4.5': { in: 2.0, out: 6.0, cr: 0.3, cw: 0 },
  'hy3': { in: 0.14, out: 0.58, cr: 0.035, cw: 0 },
  'deepseek-v3.2': { in: 0.28, out: 0.42, cr: 0.028, cw: 0 },
  'deepseek-chat': { in: 0.14, out: 0.28, cr: 0.0028, cw: 0 },
  'deepseek-reasoner': { in: 0.14, out: 0.28, cr: 0.0028, cw: 0 },
  'gpt-5-nano': { in: 0.05, out: 0.4, cr: 0.005, cw: 0 },
  'qwen3-coder-flash': { in: 0.195, out: 0.975, cr: 0.039, cw: 0 },
  'gemini-2.5-flash': { in: 0.3, out: 2.5, cr: 0.03, cw: 0 },
}

export const name = 'dsh-ocgo-lite'
export const inject = ['webServer']

function homeDir() {
  return process.env.USERPROFILE || process.env.HOME || ''
}

function findDataDir() {
  const home = homeDir()
  if (!home) return null
  const d = join(home, '.local', 'share', 'opencode')
  if (process.env.OPENCODE_DATA_DIR && existsSync(process.env.OPENCODE_DATA_DIR)) return process.env.OPENCODE_DATA_DIR
  return existsSync(d) ? d : null
}

function readApiKey(dataDir) {
  try {
    const p = join(dataDir, 'auth.json')
    if (!existsSync(p)) return null
    const j = JSON.parse(readFileSync(p, 'utf8'))
    return j['opencode-go']?.key || j['opencode']?.key || null
  } catch { return null }
}

// 配额 API:官方 Bearer 接口,返回 rolling/weekly/monthly 窗口占比与重置时间
async function fetchQuota(key) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(USAGE_URL, {
      headers: { Authorization: 'Bearer ' + key, Accept: 'application/json' },
      signal: controller.signal,
    })
    if (!res.ok) return { error: 'HTTP_' + res.status }
    const body = await res.json()
    const u = (body && body.usage) || body || {}
    const pick = (w) => (w && typeof w === 'object'
      ? { percent: typeof w.percent === 'number' ? w.percent : null, resetsAt: typeof w.resetsAt === 'string' ? w.resetsAt : null, status: typeof w.status === 'string' ? w.status : null }
      : null)
    return {
      rolling: pick(u.rolling), weekly: pick(u.weekly), monthly: pick(u.monthly), error: null,
    }
  } catch (e) {
    return { error: 'NETWORK:' + String((e && e.message) || e) }
  } finally {
    clearTimeout(timer)
  }
}

const normModel = (m) => String(m || '').replace(/^(deepseek-ai|opencode-go|openai|anthropic|google|mistral|cohere)\//, '')
const r4 = (n) => Math.round(n * 10000) / 10000

// ── 定价动态更新:内置表为 base,定期抓官方页面(https://opencode.ai/docs/go)解析覆盖,
//    官方更新价格后自动跟随;抓取失败静默用内置表 ──
const PRICING_DOC_URL = 'https://opencode.ai/docs/go'
let pricingLastFetch = 0
let pricingFetchedAt = null // ISO 时间,用于返回给前端展示

async function fetchOfficialPricing() {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 15000)
    const res = await fetch(PRICING_DOC_URL, { signal: controller.signal })
    clearTimeout(timer)
    if (!res.ok) return false
    const html = await res.text()
    // 官方表格行形如: <tr> | Model | $0.14 | $0.28 | $0.0028 | - | $60 |
    // 解析:模型名(去标签) + 后随的美元价格列
    const rows = html.match(/<tr[^>]*>([\s\S]*?)<\/tr>/g) || []
    let found = 0
    for (const row of rows) {
      // 页面有请求数估算表(无 $)和定价表(有 $);只解析定价表行
      if (!/\$[0-9]/.test(row)) continue
      if (/requests per/i.test(row)) continue
      const cells = [...row.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map((m) =>
        m[1].replace(/<[^>]+>/g, '').trim())
      if (cells.length < 4) continue
      // 官方页面为显示名(如 "DeepSeek V4 Flash" / "GPT 5.6 Luna (≤ 272K tokens)"),
      // 规范化为内置键形式:小写 + 空格转连字符 + 去掉括号变体
      const name = String(cells[0])
        .replace(/\([^)]*\)/g, '')
        .trim()
        .toLowerCase()
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '')
      if (!name || name === 'model') continue
      // 去掉 \$ 符号再解析(parseFloat('$2.00') 会失败)
      const priceIn = parseFloat(String(cells[1]).replace(/[^0-9.]/g, ''))
      const priceOut = parseFloat(String(cells[2]).replace(/[^0-9.]/g, ''))
      const priceCr = parseFloat(String(cells[3]).replace(/[^0-9.]/g, ''))
      if (isNaN(priceIn) || isNaN(priceOut)) continue
      const existing = PRICING[name]
      if (!existing) continue // 只覆盖已知模型,不引入未知
      PRICING[name] = {
        in: priceIn,
        out: priceOut,
        cr: isNaN(priceCr) ? existing.cr : priceCr,
        cw: existing.cw,
      }
      found++
    }
    if (found > 0) {
      pricingLastFetch = Date.now()
      pricingFetchedAt = new Date().toISOString()
      return true
    }
    return false
  } catch { return false }
}

// 按模型估算单次调用金额(USD);未知模型返回 null
function costOf(model, ti, to, tr, cr, cw) {
  const p = PRICING[normModel(model)]
  if (!p) return null
  return r4(((ti || 0) * p.in + (to || 0) * p.out + (cr || 0) * p.cr + (cw || 0) * p.cw) / 1e6)
}

// DSH 会话统计:扫 assistant/message 事件里的 usage(真实计量),只算 opencode-go provider。
// 缓存读按会话相邻增量(DSH 事件里是累计上下文快照,直接求和会虚高)。
// 并发 24 扫描 + 结果缓存 5 分钟(全量扫描开销大,换会话/轮询时基本命中缓存);
// 加 in-flight 锁避免 30s 轮询在扫描期间触发多份重复全量扫描。
let dshCache = null
let scanPromise = null

// 单会话聚合状态(缓存读按会话内相邻增量;byModel 为该会话内模型明细)
function newSessionAgg(sid) {
  return {
    sessionId: sid,
    requests: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    cost: 0,
    costKnown: 0,
    byModel: new Map(),
  }
}

// 聚合一条 assistant/message 事件(provider 过滤 + 缓存读增量 + 按模型)
function foldUsageEvent(agg, ev, state) {
  const u = ev.data && ev.data.usage
  if (!u) return
  const msg = ev.data && ev.data.message
  const src = msg && msg.source
  if (!src || src.provider !== GO_PROVIDER) return
  const crRaw = u.cacheReadTokens || 0
  const crDelta = state.prevCr == null ? crRaw : Math.max(0, crRaw - state.prevCr)
  state.prevCr = crRaw
  const ti = u.inputTokens || 0
  const to = u.outputTokens || 0
  const tr = u.reasoningTokens || 0
  const cw = u.cacheWriteTokens || 0
  agg.requests++
  agg.tokens.input += ti
  agg.tokens.output += to
  agg.tokens.reasoning += tr
  agg.tokens.cacheRead += crDelta
  agg.tokens.cacheWrite += cw
  const mKey = normModel((src && src.model) || 'unknown')
  let m = agg.byModel.get(mKey)
  if (!m) {
    m = { model: mKey, requests: 0, tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }, cost: 0 }
    agg.byModel.set(mKey, m)
  }
  m.requests++
  m.tokens.input += ti
  m.tokens.output += to
  m.tokens.reasoning += tr
  m.tokens.cacheRead += crDelta
  m.tokens.cacheWrite += cw
  const c = costOf((src && src.model) || 'unknown', ti, to, tr, crDelta, cw)
  if (c != null) { agg.cost += c; agg.costKnown++; m.cost += c }
}

// 帧级流式扫描会话日志文件:逐帧解压、逐行解析、即时聚合,单帧即弃。
// 内存峰值 = 压缩 Buffer(≤64MB) + 单帧解压文本(几 KB) + 单行,不再累积
// 全文/事件数组——这是相对全文解压版(峰值可达数百 MB)的关键改进。
// 坏帧/坏行跳过;行缓冲 carry 处理跨帧的半行。
async function scanSessionFile(filePath, sid) {
  const agg = newSessionAgg(sid)
  const state = { prevCr: null }
  try {
    const buf = await readFile(filePath)
    const frames = scanZstdFrames(buf)
    let carry = ''
    for (const f of frames) {
      let text
      try {
        const out = await zstdDecompressAsync(buf.subarray(f.start, f.end))
        text = out.toString('utf8')
      } catch { break } // 坏帧:后续帧不再可信,停止
      const lines = (carry + text).split('\n')
      carry = lines.pop() || ''
      for (const line of lines) {
        if (!line) continue
        try {
          const ev = JSON.parse(line)
          if (ev && ev.type === 'assistant/message' && ev.data) foldUsageEvent(agg, ev, state)
        } catch { /* 跳过坏行 */ }
      }
    }
  } catch { /* 文件读取失败:返回空聚合 */ }
  return agg
}

// 会话 id 存在两种格式(裸 uuid / session- 前缀),判同
function sameSession(a, b) {
  return a === b || a === 'session-' + b || a === b.replace(/^session-/, '')
}

// 从 per-session 聚合列表重算全局:token 合计/金额/按模型(含定价)
function aggregateSessions(list) {
  const stats = {
    sessions: 0,
    cost: 0,
    costKnown: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    bySession: [],
    byModel: [],
  }
  const byModel = new Map()
  stats.bySession = list.map((s) => {
    const sms = Array.from(s.byModel.values())
      .map((m) => {
        const p = PRICING[m.model]
        return {
          ...m,
          cost: r4(m.cost),
          price: p ? { in: p.in, out: p.out, cr: p.cr, cw: p.cw } : null,
        }
      })
      .sort((a, b) => b.cost - a.cost)
    return { sessionId: s.sessionId, requests: s.requests, tokens: s.tokens, cost: r4(s.cost), costKnown: s.costKnown, byModel: sms, mtime: s.mtime || 0 }
  })
  for (const s of stats.bySession) {
    stats.sessions++
    stats.cost += s.cost
    stats.costKnown += s.costKnown || 0
    stats.tokens.input += s.tokens.input
    stats.tokens.output += s.tokens.output
    stats.tokens.reasoning += s.tokens.reasoning
    stats.tokens.cacheRead += s.tokens.cacheRead
    stats.tokens.cacheWrite += s.tokens.cacheWrite
    for (const m of s.byModel) {
      let gm = byModel.get(m.model)
      if (!gm) {
        gm = { model: m.model, requests: 0, tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }, cost: 0 }
        byModel.set(m.model, gm)
      }
      gm.requests += m.requests
      gm.tokens.input += m.tokens.input
      gm.tokens.output += m.tokens.output
      gm.tokens.reasoning += m.tokens.reasoning
      gm.tokens.cacheRead += m.tokens.cacheRead
      gm.tokens.cacheWrite += m.tokens.cacheWrite
      gm.cost += m.cost
    }
  }
  stats.cost = r4(stats.cost)
  stats.byModel = Array.from(byModel.values())
    .map((m) => {
      const p = PRICING[m.model]
      return {
        ...m,
        cost: r4(m.cost),
        // 该模型的定价(每百万 tokens),未知模型为 null
        price: p ? { in: p.in, out: p.out, cr: p.cr, cw: p.cw } : null,
      }
    })
    .sort((a, b) => b.cost - a.cost)
  return stats
}

// 全量基线(带 5 分钟缓存 + in-flight 锁)
// 内存保护:改为**文件直读**全量扫描(不用 sessionQuery readSession 把整个会话
// 事件载入内存做重放校验)——逐文件解压解析、聚合后释放,并发 2,峰值内存 ≈ 2 个文件;
// 覆盖所有会话文件,保证"全部"范围总量完整。
async function collectDshStats(sq) {
  if (dshCache && Date.now() - dshCache.at < 5 * 60 * 1000) return dshCache.data
  if (scanPromise) return scanPromise
  const run = (async () => {
    const stats = { error: null }
    try {
      const files = findAllSessionLogs()
      const list = []
      let idx = 0
      async function worker() {
        while (idx < files.length) {
          const i = idx++
          const t = files[i]
          try {
            const agg = await scanSessionFile(t.filePath, t.sessionId)
            agg.mtime = t.mtime || 0 // 供客户端"最近对话"范围选取
            fileMtimes.set(t.filePath, t.mtime) // 共享增量状态:基线后 live 直接走增量
            if (agg.requests > 0) list.push(agg)
          } catch { /* 单文件失败跳过 */ }
        }
      }
      await Promise.all(Array.from({ length: Math.min(SCAN_CONCURRENCY, files.length) }, () => worker()))
      Object.assign(stats, aggregateSessions(list))
      dshCache = { at: Date.now(), data: stats }
    } catch (e) {
      stats.error = 'SESSION:' + String((e && e.message) || e)
    }
    return stats
  })()
  scanPromise = run
  try { return await run } finally { scanPromise = null }
}

// 实时通道:并行直读会话日志文件(多帧 zstd 解压 + JSONL 行解析),
// 替换缓存中对应条目后重聚合全局 → 全部范围下每个会话/模型都实时。
// 内存保护:最多 MAX_SCAN_FILES 个最近活跃文件,单文件 ≤ MAX_SCAN_FILE_BYTES,
// 解压文本 ≤ MAX_SCAN_TEXT_BYTES,并发 ≤ SCAN_CONCURRENCY(见 findAllSessionLogs)。
// 增量优化:fileMtimes 记录每个文件上次读取的 mtime,只有变化的文件才重读
// (活跃会话),未变化的直接用缓存条目——常规轮询通常只解压 1~2 个文件。
const fileMtimes = new Map()
async function liveSessionStats(sq, sessionId) {
  let base = null
  if (dshCache) {
    base = dshCache.data
    // 缓存过期:后台异步触发全量刷新(不等待),本次仍用旧基线 + 实时会话,保证秒回
    if (Date.now() - dshCache.at >= 5 * 60 * 1000) void collectDshStats(sq)
  } else {
    base = await collectDshStats(sq) // 冷启动首次仍需全量基线
  }
  if (base.error) return base
  try {
    const files = findAllSessionLogs()
    // 增量:只重读 mtime 变化的文件;先记录本次 mtime(无论成败,避免坏文件反复读)
    const changed = files.filter((t) => fileMtimes.get(t.filePath) !== t.mtime)
    for (const t of changed) fileMtimes.set(t.filePath, t.mtime)
    if (!changed.length) return base // 无变化:直接返回缓存
    // 内存保护:限制并行解压数量,避免多会话文件同时载入内存
    const results = new Array(changed.length)
    let fi = 0
    async function scanWorker() {
      while (fi < changed.length) {
        const i = fi++
        const t = changed[i]
        try {
          const agg = await scanSessionFile(t.filePath, t.sessionId)
          agg.mtime = t.mtime || 0 // 供客户端"最近对话"范围选取
          results[i] = agg.requests > 0 ? agg : null
        } catch { results[i] = null }
      }
    }
    await Promise.all(Array.from({ length: Math.min(SCAN_CONCURRENCY, changed.length) }, () => scanWorker()))
    const aggs = results.filter(Boolean)
    if (!aggs.length) return base
    const list = base.bySession.filter((b) => !aggs.some((a) => sameSession(b.sessionId, a.sessionId)))
    list.push(...aggs)
    const merged = aggregateSessions(list)
    merged.live = true
    merged.liveAt = Date.now()
    return merged
  } catch { return base } // live 失败降级为缓存数据
}

// 枚举 ~/.dsh/sessions/<workspace>/<session-<uuid>|uuid>/ 下全部会话日志文件
// 内存保护:跳过超大文件(压缩 > MAX_SCAN_FILE_BYTES);不按数量截断——
// "全部"范围需要完整总量,内存安全由并发上限与逐文件释放保证。
function findAllSessionLogs() {
  const home = homeDir()
  if (!home) return []
  const root = join(home, '.dsh', 'sessions')
  if (!existsSync(root)) return []
  const out = []
  const seen = new Set()
  let ws
  try { ws = readdirSync(root) } catch { return [] }
  for (const w of ws) {
    let st
    try { st = statSync(join(root, w)) } catch { continue }
    if (!st.isDirectory()) continue
    let subs
    try { subs = readdirSync(join(root, w)) } catch { continue }
    for (const s of subs) {
      if (!/^session-/.test(s) && !/^[0-9a-f-]{36}$/i.test(s)) continue
      if (seen.has(s)) continue
      const dir = join(root, w, s)
      let f = join(dir, 'session.jsonl.zstd')
      if (!existsSync(f)) { f = join(dir, 'session.jsonl'); if (!existsSync(f)) continue }
      let fs
      try { fs = statSync(f) } catch { continue }
      if (fs.size > MAX_SCAN_FILE_BYTES) continue
      seen.add(s)
      out.push({ sessionId: s, filePath: f, mtime: fs.mtimeMs })
    }
  }
  return out
}

// —— 会话文件直读:多帧 zstd + JSONL ——
// DSH 会话日志 = 多个独立 zstd 帧(header 帧 + 事件批次帧,带 checksum)拼接,
// 每帧解码后为 JSONL 文本。这里用 node:zlib 内置 zstd 逐帧解码(零依赖)。
const ZSTD_MAGIC = 0xfd2fb528

// 扫描完整 zstd 帧边界;正在写入的最后一帧(不完整)会被跳过
function scanZstdFrames(buffer) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) break
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) break
    offset += 4
    if (offset === buffer.length) break
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 24) !== 0) break
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 32) !== 0
    const checksum = (descriptor & 4) !== 0
    const dictionaryFlag = descriptor & 3
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) break
    offset += remainingHeaderBytes
    let ok = true
    for (;;) {
      if (buffer.length - offset < 3) { ok = false; break }
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = blockHeader >>> 1 & 3
      const blockSize = blockHeader >>> 3
      if (blockType === 3) { ok = false; break }
      const payloadBytes = blockType === 1 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) { ok = false; break }
      offset += payloadBytes
      if (lastBlock) break
    }
    if (!ok) break
    if (checksum) {
      if (buffer.length - offset < 4) break
      offset += 4
    }
    frames.push({ start, end: offset })
  }
  return frames
}

// 异步 zstd 解压(node:zlib 内置,零依赖);scanSessionFile 逐帧调用,单帧即弃
const zstdDecompressAsync = promisify(zstdDecompress)

async function collect(ctx, liveId) {
  const out = { ok: false, error: null, quota: null, quotaError: null, stats: null, meta: {}, account: null }
  // 定价动态更新:每 24h 抓一次官方页面,官方改价后自动跟随(失败静默用内置表)
  if (!pricingLastFetch || Date.now() - pricingLastFetch > 24 * 60 * 60 * 1000) {
    await fetchOfficialPricing()
  }
  if (pricingFetchedAt) out.meta.pricingUpdatedAt = pricingFetchedAt

  const dataDir = findDataDir()
  if (!dataDir) { out.error = 'NO_OPENCODE'; return out }
  out.meta.dataDir = dataDir

  const key = readApiKey(dataDir)
  if (!key) { out.error = 'NO_KEY'; return out }
  // key 掩码:仅用于展示状态,明文走 /ocgo-lite/key 专用端点
  out.account = {
    keyMask: key.length > 10 ? key.slice(0, 6) + '…' + key.slice(-4) : 'sk-…',
  }

  // 配额:失败降级(quota=null + quotaError),不阻断 DSH 统计
  const quota = await fetchQuota(key)
  if (quota.error) out.quotaError = quota.error
  else out.quota = quota

  // DSH 会话统计:token 真实计量 + 金额按官方定价估算
  // liveId:实时通道(只重读该会话文件),用于"本次会话"范围的实时更新
  const sq = ctx.get('sessionQuery')
  if (!sq) { out.error = 'NO_SESSION_QUERY'; return out }
  const stats = liveId ? await liveSessionStats(sq, liveId) : await collectDshStats(sq)
  if (stats.error) { out.error = stats.error; return out }
  out.stats = stats
  out.ok = true
  return out
}

export function apply(ctx) {
  // 启动时抓一次官方定价(官方改价后自动跟随;失败静默用内置表)
  void fetchOfficialPricing()
  // 模型工具:对话里随时可查(可选能力;dsh-tools 可解析时才注册,零硬依赖)
  try {
    const tool = {
      name: 'opencode_go_usage',
      description: '查询 OpenCode Go 套餐的余量(5小时滚动/每周/每月窗口占比与重置时间)、DSH 会话累计消耗的 token 数量(输入/输出/推理/缓存)与消费金额(USD,按官方定价估算)。',
      parameters: {},
      output: {
        schema: { type: 'object', properties: {}, additionalProperties: true },
        render: (args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      execute: async () => collect(ctx),
    }
    void (async () => {
      try {
        const { defineTool } = await import('@deepseek-ai/dsh-tools')
        const tools = ctx.get('tools')
        if (tools && typeof tools.register === 'function') {
          ctx.effect(() => tools.register(defineTool(tool)), 'ocgo-lite: tool')
        }
      } catch { /* dsh-tools 不可解析时跳过工具注册 */ }
    })()
  } catch { /* ignore */ }

  // HTTP 路由:client 同源 fetch
  if (ctx.webServer && typeof ctx.webServer.register === 'function') {
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: '/ocgo-lite/api',
      handler: async (req, res) => {
        try {
          // ?live=<sessionId>:实时通道,本次会话统计跳过缓存(单文件重读,秒级)
          let liveId = null
          try {
            const u = new URL(req.url || '/', 'http://localhost')
            liveId = u.searchParams.get('live') || null
          } catch { /* ignore */ }
          const data = await collect(ctx, liveId)
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify(data))
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: String((e && e.message) || e) }))
        }
      },
    }), 'ocgo-lite: route')

    // 复制 API Key 专用端点:仅本机同源访问,返回完整 key 供剪贴板
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: '/ocgo-lite/key',
      handler: async (req, res) => {
        try {
          const dataDir = findDataDir()
          const key = dataDir ? readApiKey(dataDir) : null
          if (!key) {
            res.writeHead(404, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ ok: false, error: 'NO_KEY' }))
            return
          }
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ ok: true, key }))
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: String((e && e.message) || e) }))
        }
      },
    }), 'ocgo-lite: key route')
  }

  ctx.logger?.info?.('[' + name + '] started (/ocgo-lite/api)')
}
