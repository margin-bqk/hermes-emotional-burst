/**
 * Detection tests.
 *
 * The plugin is a single ESM file loaded uncompiled by the desktop app, and it
 * imports bare specifiers that only resolve inside that app. So instead of
 * duplicating the logic here, these tests slice the detection block out of
 * desktop/plugin.js and run *that* — with `atom` / `host` stubbed and the clock
 * faked. If the shipped file changes, the tests change with it.
 *
 * Run: npm test   (or: node --test test/)
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const SRC_PATH = path.join(here, '..', 'desktop', 'plugin.js')
const SRC = fs.readFileSync(SRC_PATH, 'utf8')

const START = SRC.indexOf('const ID = ')
const END = SRC.indexOf('// ── Styles:')
if (START < 0 || END < 0) {
  throw new Error('slice markers missing from desktop/plugin.js — update this test')
}

const prelude = `
let __clock = 1750000000000;
Date.now = () => __clock;
const atom = v => ({
  get: () => v,
  set: n => { v = n },
  subscribe: () => () => {}
});
const host = { state: { focusedSessionId: { get: () => 'sess-a' }, activeSessionId: { get: () => 'sess-a' } } };
`

const epilogue = `
globalThis.__detect = {
  ingest,
  hits: () => hits,
  reset: () => {
    hits = []; buf = ''; lastBurstAt = 0; sid = '';
    lastFired.clear(); lastNeedle.clear();
  },
  tick: ms => { __clock += ms },
  states: STATES.map(s => s.key)
};
`

let api
try {
  await import(
    'data:text/javascript;base64,' + Buffer.from(prelude + SRC.slice(START, END) + epilogue).toString('base64')
  )
  api = globalThis.__detect
} catch (err) {
  throw new Error(`detection block failed to load: ${err.message}`)
}

/** Feed one delta per character, 40 ms apart — the shape a real stream has. */
function stream(chars, stepMs = 40) {
  for (const c of chars) {
    api.ingest(c)
    api.tick(stepMs)
  }
}

function fresh() {
  api.reset()
  api.tick(60000)
}

const states = () => api.hits().map(h => h.state)

test('states are in the declared priority order', () => {
  assert.deepEqual(api.states, ['stuck', 'aha', 'surprise', 'doubt', 'good'])
})

test('detects a plain English cue', () => {
  fresh()
  stream('Hmm, that is odd'.split(''))
  assert.deepEqual(states(), ['doubt'])
  assert.match(api.hits()[0].snippet, /Hmm/)
})

test('a match always carries a non-empty context snippet', () => {
  fresh()
  stream('the report says '.split(''))
  stream(['不', '对'])
  const [hit] = api.hits()
  assert.ok(hit, 'expected a hit')
  assert.notEqual(hit.snippet, '', 'snippet must not be empty')
})

test('catches a Chinese cue split across deltas', () => {
  fresh()
  stream('还是不行'.split(''))
  assert.deepEqual(states(), ['stuck'])
  assert.match(api.hits()[0].snippet, /还是不行/)
})

test('catches an English cue split mid-word', () => {
  fresh()
  // The token boundary lands inside "interesting" — the lookback has to carry it.
  stream('that is intere'.split(''))
  assert.deepEqual(states(), [])
  stream(['s', 't', 'i', 'n', 'g'])
  assert.deepEqual(states(), ['good'])
})

test('prefers the newest match in the window, not the oldest', () => {
  fresh()
  stream('不对。'.split(''))
  api.tick(10000) // let the cooldown pass
  stream('还是不行'.split(''))
  const hits = api.hits()
  assert.equal(hits.length, 2)
  assert.equal(hits[1].state, 'stuck')
  assert.match(hits[1].snippet, /还是不行/)
})

test('a stale word does not re-fire once its cooldown expires', () => {
  fresh()
  stream('不对'.split(''))
  assert.equal(api.hits().length, 1)
  api.tick(9500) // past cooldown, and the word is still inside the lookback
  stream('。'.split(''))
  assert.equal(api.hits().length, 1, 'old word must not burst twice')
})

test('the same phrase is deduped for a minute', () => {
  fresh()
  stream('不对'.split(''))
  api.tick(9000)
  stream(' 不对'.split(''))
  assert.equal(api.hits().length, 1, 'same needle inside the dedupe window')
})

test('a global gap collapses two states fired close together', () => {
  fresh()
  stream('咦'.split(''))
  assert.equal(api.hits().length, 1)
  stream('，还是不行'.split(''), 100) // well inside GLOBAL_GAP_MS
  assert.equal(api.hits().length, 1, 'second state must wait for the global gap')
})

test('a new turn resets the buffer', () => {
  fresh()
  api.ingest('不对')
  // simulate message.start by clearing through reset() only for buffer state
  api.reset()
  stream('great'.split(''))
  assert.deepEqual(states(), ['good'])
})
