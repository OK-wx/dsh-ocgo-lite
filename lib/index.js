// dsh-ocgo-lite — Host half
// OpenCode Go 用量常驻条的数据后端。零外部依赖：
//   · 配额余量  ← 全局 fetch → https://opencode.ai/zen/go/v1/usage (Bearer auth.json key)
//   · token/金额 ← DSH 会话事件统计(sessionQuery assistant/message usage,过滤 opencode-go provider)
//                 金额按官方定价表(per 1M tokens)估算;token 为真实计量。
// 暴露 webServer 路由 /ocgo-lite/api（client 取数）与模型工具 opencode_go_usage。
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const USAGE_URL = 'https://opencode.ai/zen/go/v1/usage'
const FETCH_TIMEOUT_MS = 15000
const GO_PROVIDER = 'opencode-go'

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
// 并发 24 扫描 + 结果缓存 10 分钟(全量扫描开销大,换会话/轮询时基本命中缓存)
let dshCache = null
async function collectDshStats(sq) {
  if (dshCache && Date.now() - dshCache.at < 10 * 60 * 1000) return dshCache.data
  const stats = { sessions: 0, cost: 0, costKnown: 0, tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 } }
  try {
    const sessions = await sq.listSessions()
    // 并发 24 读会话
    const snaps = []
    let idx = 0
    async function worker() {
      while (idx < sessions.length) {
        const i = idx++
        const rec = sessions[i]
        try { snaps[i] = await sq.readSession(rec.header.id) } catch { snaps[i] = null }
      }
    }
    await Promise.all(Array.from({ length: Math.min(24, sessions.length) }, () => worker()))
    const prevCr = new Map()
    const byModel = new Map()
    let counted = 0
    for (let k = 0; k < sessions.length; k++) {
      const snap = snaps[k]
      if (!snap || !snap.events) continue
      const sid = sessions[k].header.id
      for (const ev of snap.events) {
        if (ev.type !== 'assistant/message') continue
        const u = ev.data && ev.data.usage
        if (!u) continue
        const msg = ev.data && ev.data.message
        const src = msg && msg.source
        if (!src || src.provider !== GO_PROVIDER) continue
        const crRaw = u.cacheReadTokens || 0
        const prev = prevCr.get(sid)
        const crDelta = prev == null ? crRaw : Math.max(0, crRaw - prev)
        prevCr.set(sid, crRaw)
        const ti = u.inputTokens || 0
        const to = u.outputTokens || 0
        const tr = u.reasoningTokens || 0
        const cw = u.cacheWriteTokens || 0
        stats.tokens.input += ti
        stats.tokens.output += to
        stats.tokens.reasoning += tr
        stats.tokens.cacheRead += crDelta
        stats.tokens.cacheWrite += cw
        const c = costOf((src && src.model) || 'unknown', ti, to, tr, crDelta, cw)
        if (c != null) { stats.cost += c; stats.costKnown++ }
        // 按模型分组聚合
        const mKey = normModel((src && src.model) || 'unknown')
        let m = byModel.get(mKey)
        if (!m) {
          m = { model: mKey, requests: 0, tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }, cost: 0 }
          byModel.set(mKey, m)
        }
        m.requests++
        m.tokens.input += ti
        m.tokens.output += to
        m.tokens.reasoning += tr
        m.tokens.cacheRead += crDelta
        m.tokens.cacheWrite += cw
        if (c != null) m.cost += c
      }
      if (prevCr.has(sid)) counted++
    }
    stats.sessions = counted
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
    dshCache = { at: Date.now(), data: stats }
  } catch (e) {
    stats.error = 'SESSION:' + String((e && e.message) || e)
  }
  return stats
}

async function collect(ctx) {
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
  const sq = ctx.get('sessionQuery')
  if (!sq) { out.error = 'NO_SESSION_QUERY'; return out }
  const stats = await collectDshStats(sq)
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
          const data = await collect(ctx)
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
