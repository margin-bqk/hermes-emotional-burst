/**
 * Emotion Burst — Hermes Desktop plugin
 * ---------------------------------------------------------------------------
 * When the model's reasoning stream contains an emotion word, pop a small
 * burst of emoji over the chat. A thin skin over the gateway's `reasoning.delta`
 * event.
 *
 * Three surfaces:
 *   1. Chat overlay    — a fixed layer appended to document.body (no app markup
 *                        is read or restyled; the layer is ours alone)
 *   2. Pet bubble      — ctx.pet.say(), the official door
 *   3. Status-bar chip — today's hit count; click to fire a test burst
 *
 * Design notes:
 *   - Words map to STATES, not one word to one emoji. "great" / "huh" are
 *     high-frequency filler; word-for-word mapping becomes wallpaper you stop
 *     seeing within a week. Five states with per-state cooldowns stay sparse
 *     enough to carry information.
 *   - `reasoning.delta` is per token. Buffer, cap the lookback, gate on a
 *     per-state cooldown + a global gap, or one thinking block fires dozens.
 *   - Regex only. No model call per delta.
 *   - Hits are logged (time / session / state / context snippet) so the emoji
 *     has a payoff beyond the animation.
 *
 * Plain ESM, loaded uncompiled: build UI with jsx() calls, never JSX syntax.
 * Only @hermes/plugin-sdk, react and react/jsx-runtime resolve here.
 */

import {
  COMPOSER_AREAS,
  PALETTE_AREA,
  STATUSBAR_AREAS,
  atom,
  host,
  usePluginI18n,
  useValue
} from '@hermes/plugin-sdk'
import { useEffect, useRef } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'

const ID = 'emotion-burst'
const VERSION = '0.1.0'
const STYLE_ID = 'emotion-burst-style'
const LAYER_ID = 'emotion-burst-layer'

const MAX_LOG = 500
const GLOBAL_GAP_MS = 1600
/**
 * Chars of carry-over so a word split across deltas still matches. Must cover
 * the longest needle ("doesn't work", 12 chars) — with a 1-char-per-delta
 * stream, a 9-char window can never assemble an 11-char word.
 */
const LOOKBACK = 16
/** The same needle can't re-fire inside this window (stale-word guard). */
const DEDUPE_MS = 60000
const BURST_MS = 2100
const PERSIST_DEBOUNCE_MS = 1500

// ── Lexicon: state → emoji, cooldown, pattern ───────────────────────────────
// ORDER is priority: "stuck" before "aha" so "still not … huh" doesn't read as
// a win. Patterns allow whitespace inside CJK words because deltas split them.
const STATE_DEFS = {
  stuck: {
    emoji: '😤',
    cooldown: 9000,
    re: /(还\s*是\s*不\s*行|不\s*对|失\s*败|报\s*错|卡\s*住|断\s*了|再\s*试|又\s*来|\b(?:again|failed|error|broken|stuck|still not|doesn'?t work)\b)/i
  },
  aha: {
    emoji: '💡',
    cooldown: 9000,
    re: /(找\s*到\s*了|原\s*来|跑\s*通|对\s*上\s*了|通\s*了|成\s*了|\b(?:aha|found it|that'?s it|there it is|got it)\b)/i
  },
  surprise: {
    emoji: '😲',
    cooldown: 12000,
    re: /(咦|奇\s*怪|竟\s*然|居\s*然|没\s*想\s*到|等\s*一\s*下|\b(?:huh|whoa|wait,? what|unexpected|surpris\w+)\b)/i
  },
  doubt: {
    emoji: '🤔',
    cooldown: 12000,
    re: /(但\s*是|不\s*过|可\s*是|怀\s*疑|不\s*确\s*定|待\s*验\s*证|存\s*疑|\b(?:hmm+|not sure|unverified|i doubt|maybe)\b)/i
  },
  good: {
    emoji: '✨',
    cooldown: 15000,
    re: /(不\s*错|挺\s*好|\b(?:great|nice|clean|smooth|interesting)\b)/i
  }
}
const ORDER = ['stuck', 'aha', 'surprise', 'doubt', 'good']

// Compiled once — building a RegExp per state per token is the hot path.
const STATES = ORDER.map(key => ({
  key,
  emoji: STATE_DEFS[key].emoji,
  cooldown: STATE_DEFS[key].cooldown,
  scan: new RegExp(STATE_DEFS[key].re.source, 'gi')
}))

// ── Reactive state ──────────────────────────────────────────────────────────
const $burst = atom(null) // { id, state, snippet, test }
const $chat = atom(null) // { left, right, top } — measured by the composer probe
const $stats = atom({ today: 0, total: 0, lastState: '', lastAt: 0, day: '' })

// ── Module state (reset with every reload) ──────────────────────────────────
let ctx = null
let tr = key => key
let buf = ''
let sid = ''
let burstSeq = 0
let lastBurstAt = 0
const lastFired = new Map()
const lastNeedle = new Map()
let hits = []
let layerEl = null
let unsubscribe = null
let persistTimer = null
let debugOn = false

const dayKey = (d = Date.now()) => {
  const x = d instanceof Date ? d : new Date(d)
  const p = n => String(n).padStart(2, '0')
  return `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())}`
}

const clean = (s, limit = 80) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, limit)

/** Debug trail — off unless `debug` is set, and never on a per-event path. */
function debugNote(note) {
  if (!debugOn) return
  try {
    const prev = ctx?.storage?.get('debug-log', [])
    const list = Array.isArray(prev) ? prev.slice(-19) : []
    list.push({ ...note, at: Date.now() })
    ctx.storage.set('debug-log', list)
  } catch (e) {
    /* debugging must never take the plugin down */
  }
}

function recount() {
  const today = dayKey()
  const real = hits.filter(h => !h.test)
  const last = real.length ? real[real.length - 1] : null
  const prev = $stats.get()
  $stats.set({
    today: real.filter(h => h.day === today).length,
    total: real.length,
    lastState: last ? last.state : prev.lastState,
    lastAt: last ? last.t : prev.lastAt,
    day: today
  })
}

/** Whole-array write, debounced — a burst shouldn't rewrite storage 10x/sec. */
function schedulePersist() {
  if (!ctx?.storage) return
  if (persistTimer) return
  persistTimer = setTimeout(() => {
    persistTimer = null
    writePersist()
  }, PERSIST_DEBOUNCE_MS)
}

function writePersist() {
  try {
    ctx?.storage?.set('hits', hits.slice(-MAX_LOG))
  } catch (e) {
    /* memory-only log is a fine degradation */
  }
}

/** Context around a match, for the caption and the log. */
function sniff(text, index, length) {
  const start = Math.max(0, index - 22)
  const end = Math.min(text.length, index + length + 22)
  return clean(text.slice(start, end), 64)
}

function fire(stateKey, snippet, test) {
  const state = STATES.find(s => s.key === stateKey)
  if (!state) return
  const at = Date.now()
  lastBurstAt = at
  burstSeq += 1
  const entry = {
    t: at,
    day: dayKey(at),
    // focusedSessionId is the chat the user is actually looking at;
    // activeSessionId only tracks the primary workspace tab.
    sid: sid || host.state.focusedSessionId?.get?.() || host.state.activeSessionId?.get?.() || '',
    state: state.key,
    snippet: clean(snippet, 64),
    test: Boolean(test)
  }

  $burst.set({ id: burstSeq, state: state.key, snippet: entry.snippet, test: entry.test, sid: entry.sid })

  try {
    const label = entry.snippet || tr(`state.${state.key}`)
    ctx?.pet?.say(`${state.emoji} ${label}`.slice(0, 60), { id: 'emotion', ttlMs: 6000 })
  } catch (e) {
    /* no pet installed — the overlay still carries it */
  }

  if (!test) {
    hits.push(entry)
    if (hits.length > MAX_LOG) hits = hits.slice(-MAX_LOG)
    recount()
    schedulePersist()
  }
  debugNote({ stage: 'fire', state: state.key, test: Boolean(test) })
}

/**
 * Feed one streamed delta.
 *
 * Three guards, each earned by a real false positive:
 *   - freshness: the match must touch the new chunk, else an old word re-fires
 *     once its cooldown expires (the text is still inside the lookback).
 *   - rightmost: left-most match picks the OLDER word ("…不对。还是不行" reads
 *     as "不对"); the newest hit is the one the model just wrote.
 *   - needle dedupe: the same phrase can't re-fire for a minute.
 */
function ingest(text) {
  if (typeof text !== 'string' || !text) return
  const windowText = (buf.length > LOOKBACK ? buf.slice(-LOOKBACK) : buf) + text
  buf = (buf + text).slice(-600)

  const now = Date.now()
  if (now - lastBurstAt < GLOBAL_GAP_MS) return

  for (let i = 0; i < STATES.length; i += 1) {
    const st = STATES[i]
    if (now - (lastFired.get(st.key) || 0) < st.cooldown) continue

    st.scan.lastIndex = 0
    let m = null
    let scan
    while ((scan = st.scan.exec(windowText)) !== null) {
      m = scan
      if (scan[0].length === 0) st.scan.lastIndex += 1
      if (st.scan.lastIndex > windowText.length) break
    }
    if (!m) continue

    const freshFrom = windowText.length - text.length
    const endsFresh = m.index + m[0].length > freshFrom
    const startsFresh = m.index >= freshFrom
    if (!endsFresh && !startsFresh) continue

    const needle = m[0].toLowerCase()
    const prev = lastNeedle.get(st.key)
    if (prev && prev.needle === needle && now - prev.at < DEDUPE_MS) continue

    lastNeedle.set(st.key, { needle, at: now })
    lastFired.set(st.key, now)
    fire(st.key, sniff(windowText, m.index, m[0].length))
    return
  }
}

/**
 * Only burst on the chat this window is showing. Events for every session reach
 * every window; without this a background session's thinking pops over whatever
 * you are reading. No focused session → stay silent: better to miss one than to
 * land it on the wrong chat.
 */
function isFocused(eventSid) {
  if (!eventSid) return false
  const state = host.state
  const focused = state.focusedSessionId?.get?.() || state.activeSessionId?.get?.()
  if (!focused) {
    debugNote({ stage: 'skip', why: 'no-focus' })
    return false
  }
  const ok = String(eventSid) === String(focused)
  if (!ok) debugNote({ stage: 'skip', why: 'other-session' })
  return ok
}

function fireTest() {
  const st = STATES[Math.floor(Math.random() * STATES.length)]
  fire(st.key, `${tr('palette.testCaption')} · ${tr(`state.${st.key}`)}`, true)
}

// ── Styles: injected once, removed on dispose ───────────────────────────────
function ensureStyle() {
  if (typeof document === 'undefined' || !document.head) return
  if (document.getElementById(STYLE_ID)) return
  const el = document.createElement('style')
  el.id = STYLE_ID
  el.textContent = `
@keyframes emotion-burst-rise {
  0%   { opacity: 0; transform: translate(0, 0) scale(0.35) rotate(0deg); }
  14%  { opacity: 1; }
  70%  { opacity: 1; }
  100% { opacity: 0; transform: translate(var(--eb-dx, 0px), var(--eb-dy, -160px)) scale(var(--eb-s, 1)) rotate(var(--eb-r, 0deg)); }
}
@keyframes emotion-burst-caption {
  0%   { opacity: 0; transform: translate(-50%, 6px); }
  12%  { opacity: 1; transform: translate(-50%, 0); }
  75%  { opacity: 1; }
  100% { opacity: 0; transform: translate(-50%, -6px); }
}
.eb-particle {
  position: absolute;
  left: 50%;
  top: 100%;
  font-size: 22px;
  line-height: 1;
  will-change: transform, opacity;
  animation: emotion-burst-rise var(--eb-dur, 1.7s) cubic-bezier(0.2, 0.7, 0.3, 1) forwards;
  animation-delay: var(--eb-delay, 0ms);
  filter: drop-shadow(0 1px 2px rgb(0 0 0 / 0.16));
}
.eb-caption {
  position: absolute;
  left: 50%;
  bottom: -4px;
  max-width: 92%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  padding: 3px 9px;
  border-radius: 999px;
  font-size: 11px;
  line-height: 1.35;
  color: var(--ui-text-secondary, #888);
  background: color-mix(in srgb, var(--ui-bg-elevated, #fff) 88%, transparent);
  border: 1px solid var(--ui-stroke-secondary, rgb(0 0 0 / 0.12));
  backdrop-filter: blur(6px);
  animation: emotion-burst-caption var(--eb-dur, 1.7s) ease-out forwards;
  animation-delay: var(--eb-delay, 0ms);
}
`
  document.head.appendChild(el)
}

// ── Overlay layer ───────────────────────────────────────────────────────────
// Appended to document.body from register(), not registered as a React slot:
// on the host this was built against, a `titleBar.center` contribution loaded
// without error but never mounted, so the layer never existed. A body child is
// also free of ancestor transforms and outranks every app layer.
function ensureLayer() {
  if (typeof document === 'undefined' || !document.body) return null
  ensureStyle()
  if (layerEl && layerEl.isConnected) return layerEl
  layerEl = document.getElementById(LAYER_ID)
  if (!layerEl) {
    layerEl = document.createElement('div')
    layerEl.id = LAYER_ID
    layerEl.setAttribute('aria-hidden', 'true')
    layerEl.style.cssText =
      'position:fixed;inset:0;pointer-events:none;z-index:2147483000;overflow:hidden'
    document.body.appendChild(layerEl)
  }
  return layerEl
}

/** Where the burst rises from: the measured chat column, else window-centred. */
function laneBox() {
  const vw = typeof window !== 'undefined' ? window.innerWidth : 1200
  const vh = typeof window !== 'undefined' ? window.innerHeight : 800
  const chat = $chat.get()
  if (chat && chat.right - chat.left > 120) {
    // The probe can span a neighbouring pane (measured 1722px for an 843px
    // column), so clamp — otherwise particles drift off the chat.
    const raw = chat.right - chat.left
    return {
      left: Math.round(chat.left),
      width: Math.round(Math.min(Math.max(raw, 240), 900)),
      top: Math.round(Math.max(40, chat.top - 140))
    }
  }
  const width = Math.round(Math.min(780, Math.max(320, vw * 0.46)))
  return { left: Math.round((vw - width) / 2), width, top: Math.round(Math.max(80, vh - 260)) }
}

function spawnBurst(burst) {
  const root = ensureLayer()
  if (!root) return
  const state = STATES.find(s => s.key === burst.state) || STATES[STATES.length - 1]
  const box = laneBox()

  const lane = document.createElement('div')
  lane.style.cssText =
    'position:absolute;pointer-events:none;height:140px;' +
    `left:${box.left}px;top:${box.top}px;width:${box.width}px`

  const count = 8 + Math.floor(Math.random() * 4)
  for (let i = 0; i < count; i += 1) {
    const s = document.createElement('span')
    s.className = 'eb-particle'
    s.textContent = state.emoji
    s.style.setProperty('--eb-dx', `${Math.round((Math.random() - 0.5) * 300)}px`)
    s.style.setProperty('--eb-dy', `${-Math.round(110 + Math.random() * 170)}px`)
    s.style.setProperty('--eb-s', (0.65 + Math.random() * 0.75).toFixed(2))
    s.style.setProperty('--eb-r', `${Math.round((Math.random() - 0.5) * 140)}deg`)
    s.style.setProperty('--eb-dur', `${Math.round(1300 + Math.random() * 550)}ms`)
    s.style.setProperty('--eb-delay', `${Math.round(Math.random() * 190)}ms`)
    lane.appendChild(s)
  }

  const caption = document.createElement('span')
  caption.className = 'eb-caption'
  caption.textContent = `${state.emoji} ${burst.snippet || tr(`state.${state.key}`)}`
  caption.style.setProperty('--eb-dur', `${BURST_MS - 200}ms`)
  lane.appendChild(caption)

  root.appendChild(lane)
  setTimeout(() => {
    try {
      lane.remove()
    } catch (e) {
      /* host swapped out from under us */
    }
  }, BURST_MS + 150)

  debugNote({ stage: 'burst', id: burst.id, state: state.key, box })
}

function mountLayer() {
  try {
    const root = ensureLayer()
    if (!root) return
    const sub = $burst.subscribe(b => {
      if (b) spawnBurst(b)
    })
    unsubscribe = typeof sub === 'function' ? sub : null
    debugNote({ stage: 'mounted', win: [window.innerWidth, window.innerHeight] })
  } catch (e) {
    debugNote({ stage: 'mount-error', msg: String((e && e.message) || e) })
  }
}

// ── Composer probe: reports the chat column's left/right/bottom ─────────────
function ChatProbe() {
  const ref = useRef(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = () => {
      const r = el.getBoundingClientRect()
      if (r.width < 40) return
      const prev = $chat.get()
      if (
        prev &&
        Math.abs(prev.left - r.left) < 1 &&
        Math.abs(prev.right - r.right) < 1 &&
        Math.abs(prev.top - r.top) < 1
      ) {
        return
      }
      $chat.set({ left: r.left, right: r.right, top: r.top })
    }
    measure()
    let ro = null
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(measure)
      ro.observe(el)
    }
    window.addEventListener('resize', measure)
    // Sash drags resize the composer, which ResizeObserver catches; this slower
    // timer only covers layout shifts it can't see (pane swaps, doc panel).
    const timer = setInterval(measure, 4000)
    return () => {
      if (ro) ro.disconnect()
      window.removeEventListener('resize', measure)
      clearInterval(timer)
    }
  }, [])

  return jsx('div', {
    ref,
    'aria-hidden': true,
    style: { height: 0, width: '100%', pointerEvents: 'none' }
  })
}

// ── Status-bar chip ─────────────────────────────────────────────────────────
function StatusChip() {
  const t = usePluginI18n(ID)
  const s = useValue($stats)
  const state = STATES.find(x => x.key === s.lastState)
  const fresh = s.lastAt && Date.now() - s.lastAt < 45000
  return jsxs('div', {
    onClick: fireTest,
    title: t('chip.title', s.today, s.total),
    style: {
      display: 'flex',
      alignItems: 'center',
      gap: 4,
      padding: '0 6px',
      fontSize: 11,
      lineHeight: 1,
      height: 18,
      borderRadius: 4,
      cursor: 'pointer',
      userSelect: 'none',
      color: 'var(--ui-text-secondary)',
      opacity: s.today > 0 || fresh ? 1 : 0.55
    },
    children: [
      jsx('span', { style: { fontSize: 11 }, children: fresh && state ? state.emoji : '·' }),
      jsx('span', { children: String(s.today) })
    ]
  })
}

// ── Register ────────────────────────────────────────────────────────────────
const MESSAGES = {
  en: {
    'state.stuck': 'stuck',
    'state.aha': 'got it',
    'state.surprise': 'unexpected',
    'state.doubt': 'unsure',
    'state.good': 'nice',
    'chip.title': (today, total) =>
      `Emotion Burst — ${today} today, ${total} total. Click to fire a test burst.`,
    'palette.test': 'Emotion Burst: fire a test burst',
    'palette.testCaption': 'test',
    'palette.export': 'Emotion Burst: copy the hit log',
    'palette.exportDone': count => `Emotion Burst: ${count} hits copied`,
    'palette.exportFailed': 'Emotion Burst: copy failed',
    'palette.clear': 'Emotion Burst: clear the hit log',
    'palette.cleared': 'Emotion Burst: hit log cleared',
    'palette.debugOn': 'Emotion Burst: turn debug logging on',
    'palette.debugOff': 'Emotion Burst: turn debug logging off'
  },
  zh: {
    'state.stuck': '卡住',
    'state.aha': '通了',
    'state.surprise': '意外',
    'state.doubt': '存疑',
    'state.good': '不错',
    'chip.title': (today, total) => `Emotion Burst — 今日 ${today} 次，累计 ${total} 次。点击试爆一次。`,
    'palette.test': 'Emotion Burst：试爆一次',
    'palette.testCaption': '手动测试',
    'palette.export': 'Emotion Burst：复制命中日志',
    'palette.exportDone': count => `Emotion Burst：${count} 条日志已复制`,
    'palette.exportFailed': 'Emotion Burst：复制失败',
    'palette.clear': 'Emotion Burst：清空命中日志',
    'palette.cleared': 'Emotion Burst：命中日志已清空',
    'palette.debugOn': 'Emotion Burst：打开调试日志',
    'palette.debugOff': 'Emotion Burst：关闭调试日志'
  }
}

function register(context) {
  ctx = context
  tr = key => {
    try {
      return ctx.i18n.t(key) || key
    } catch (e) {
      return key
    }
  }

  try {
    ctx.i18n.register(MESSAGES)
  } catch (e) {
    /* older host without plugin i18n */
  }

  try {
    // One write per load: lets a bug report answer "which build is actually
    // running?" without turning on debug logging.
    ctx.storage.set('last-load', { at: Date.now(), v: VERSION })
  } catch (e) {
    /* storage optional */
  }

  try {
    debugOn = Boolean(ctx.storage.get('debug', false))
    const saved = ctx.storage.get('hits', [])
    if (Array.isArray(saved)) hits = saved.slice(-MAX_LOG)
  } catch (e) {
    hits = []
  }
  recount()

  const onDelta = event => {
    if (!event || event.replayed) return
    if (!isFocused(event.session_id)) return
    sid = event.session_id || sid
    ingest(event.payload?.text)
  }
  ctx.onEvent('reasoning.delta', onDelta)
  ctx.onEvent('thinking.delta', onDelta)

  ctx.onEvent('message.start', event => {
    buf = ''
    sid = event?.session_id || ''
    lastBurstAt = 0
  })

  mountLayer()

  ctx.register({
    id: 'probe',
    area: COMPOSER_AREAS.underside,
    render: () => jsx(ChatProbe, {})
  })

  ctx.register({
    id: 'chip',
    area: STATUSBAR_AREAS.right,
    order: 60,
    render: () => jsx(StatusChip, {})
  })

  ctx.register({
    id: 'test',
    area: PALETTE_AREA,
    data: {
      id: 'emotion-burst.test',
      label: tr('palette.test'),
      keywords: ['emotion', 'emoji', 'burst', 'test', '情绪'],
      run: fireTest
    }
  })

  ctx.register({
    id: 'export',
    area: PALETTE_AREA,
    data: {
      id: 'emotion-burst.export',
      label: tr('palette.export'),
      keywords: ['emotion', 'log', 'export', '日志'],
      run: async () => {
        const body = JSON.stringify(
          { exportedAt: new Date().toISOString(), count: hits.length, hits },
          null,
          2
        )
        let ok = false
        try {
          // writeClipboard resolves false when the shell can't; don't claim success.
          ok = await ctx.os.writeClipboard(body)
        } catch (e) {
          ok = false
        }
        host.notify(
          ok
            ? { kind: 'success', message: tr('palette.exportDone', hits.length) }
            : { kind: 'error', message: tr('palette.exportFailed') }
        )
      }
    }
  })

  ctx.register({
    id: 'clear',
    area: PALETTE_AREA,
    data: {
      id: 'emotion-burst.clear',
      label: tr('palette.clear'),
      keywords: ['emotion', 'clear', 'reset', '清空'],
      run: () => {
        hits = []
        $chat.set(null)
        recount()
        writePersist()
        host.notify({ kind: 'success', message: tr('palette.cleared') })
      }
    }
  })

  ctx.register({
    id: 'debug',
    area: PALETTE_AREA,
    data: {
      id: 'emotion-burst.debug',
      label: tr('palette.debugOn'),
      keywords: ['emotion', 'debug', '调试'],
      run: () => {
        debugOn = !debugOn
        try {
          ctx.storage.set('debug', debugOn)
        } catch (e) {
          /* in-memory only */
        }
        host.notify({ kind: 'info', message: tr(debugOn ? 'palette.debugOn' : 'palette.debugOff') })
      }
    }
  })

  if (typeof ctx.onDispose === 'function') {
    ctx.onDispose(() => {
      try {
        if (unsubscribe) unsubscribe()
      } catch (e) {
        /* already gone */
      }
      if (persistTimer) {
        clearTimeout(persistTimer)
        persistTimer = null
        writePersist()
      }
      try {
        if (layerEl) layerEl.remove()
      } catch (e) {
        /* already detached */
      }
      layerEl = null
      try {
        document.getElementById(STYLE_ID)?.remove()
      } catch (e) {
        /* no document (cold unload) */
      }
    })
  }
}

export default {
  id: ID,
  name: 'Emotion Burst',
  description: 'Pops a small emoji burst over the chat when the reasoning stream gets emotional.',
  // Opt-in: an effect that covers the chat should be the user's choice.
  defaultEnabled: false,
  register
}
