# Emotion Burst

A Hermes Desktop plugin. When the model's **reasoning stream** gets emotional —
`huh`, `wait`, `hmm`, `还是不行`, `原来` — a small burst of emoji rises over the
chat, and the moment is logged so you can look back at where a run got stuck.

Desktop-only. No agent tools, no hooks, no middleware, no providers, no
environment variables, no network calls.

```
        💡  💡
      💡    💡   emoji rise from just above the composer
    💡   💡   💡
  ┌──────────────────────────────────┐
  │ 💡 原来是缓存的问题                │  ← one caption line, the matched phrase
  └──────────────────────────────────┘
```

## Why not "one word, one emoji"

Mapping `great` / `huh` / `interesting` straight to an emoji turns the chat into
wallpaper: those words are filler, they fire constantly, and within a week you
stop seeing them. This plugin maps words to **states** and rate-limits each one,
so a burst stays rare enough to carry information.

| state | emoji | triggers (extract) | cooldown |
|---|---|---|---|
| stuck | 😤 | 还是不行 · 不对 · 失败 · 报错 · 又 · again · failed · doesn't work | 9 s |
| aha | 💡 | 找到了 · 原来 · 跑通 · 通了 · aha · found it · that's it | 9 s |
| surprise | 😲 | 咦 · 奇怪 · 竟然 · 没想到 · huh · whoa · unexpected | 12 s |
| doubt | 🤔 | 但是 · 不过 · 怀疑 · 不确定 · hmm · not sure · maybe | 12 s |
| good | ✨ | 不错 · 挺好 · great · nice · clean · interesting | 15 s |

On top of the per-state cooldowns there is a global 1.6 s gap, a 60 s
same-phrase dedupe, and a freshness rule that a match must touch the newest
chunk — otherwise an old word still sitting in the lookback window fires a
second time once its cooldown expires.

Detection is regex-only. Nothing calls a model per token.

## Install

**From the catalog** (once listed):

```bash
hermes plugins install emotion-burst
```

**From source**, for development:

```bash
cp -r desktop ~/.hermes/desktop-plugins/emotion-burst-tmp   # or symlink
```

The desktop app loads `<HERMES_HOME>/desktop-plugins/<id>/plugin.js` and
hot-reloads it on save. This plugin ships as a package (`plugin.yaml` +
`desktop/plugin.js`), so the whole tree goes where Hermes expects a plugin.

The plugin is **opt-in**: it ships with `defaultEnabled: false`, so it appears
in *Settings → Plugins* turned off until you enable it.

## Surfaces

- **Chat overlay** — a `position: fixed` layer appended to `document.body` from
  `register()`. It draws only its own element; it never reads, restyles or
  clicks app markup.
- **Pet bubble** — `ctx.pet.say()`, when a pet is installed.
- **Status-bar chip** — today's hit count; click it to fire a test burst.

Command-palette rows: fire a test burst · copy the hit log · clear the hit log ·
toggle debug logging.

## Privacy and what it stores

Say this plainly, because it is a chat plugin:

- It **reads the reasoning stream** of the focused chat — the same text the app
  already shows you in the thinking block. It reads nothing else.
- It keeps the **last 500 hits in the plugin's own local storage**
  (Electron `localStorage`, key `hermes.plugin.emotion-burst.hits`): timestamp,
  session id, state, and a **64-character snippet** around the matched word.
  That snippet is model output and can contain your text.
- It makes **no network requests**. It sends nothing anywhere.
- Clearing the log is one palette command; uninstalling the plugin removes its
  storage with the app's plugin data.
- Debug logging (off by default) writes a 20-entry ring of mount/skip notes and
  **never** runs on the per-token path.

If you would rather not keep snippets, that is a reasonable feature request —
it is a storage-shape change, not a rewrite.

## Known limits

- **One session, one window.** Events for every session reach every window, so
  the plugin only bursts on the chat this window is showing
  (`focusedSessionId`). If the same session is open in two windows, both burst.
- **Focus means "the chat you interacted with"**, not "the chat under the
  cursor". If you scroll a background pane without clicking into it, a burst
  can land on the pane you are reading.
- **Word lists are a blunt instrument.** They are tuned on Chinese + English
  engineering chatter. Expect misses in other languages, and add patterns —
  they are one object at the top of `desktop/plugin.js`.

## Development

```bash
npm test     # node --test; no build step
hermes plugins validate .    # the same checks catalog CI runs
```

The tests slice the detection block out of `desktop/plugin.js` and run *that*
file under a faked clock, with `atom` / `host` stubbed — so they exercise the
shipped code instead of a copy of it.

There is no build. The file is loaded as plain ESM; UI is built with `jsx()`
calls, never JSX syntax.

## 中文说明

模型思考链里出现情绪词时，在聊天区上方飘一小把 emoji，并把命中记下来。

- 五个状态（卡住 / 通了 / 意外 / 存疑 / 不错），不是「一个词一个 emoji」——
  否则 `great`、`huh` 这种填充词会变成弹幕。
- 每个状态有独立冷却，外加 1.6 秒全局间隔、60 秒同词去重。
- 纯正则判断，不调用模型。
- 只在「这个窗口正在看的那条会话」上爆，后台会话的思考不会炸到你眼前。
- 命中日志存在本地（最近 500 条，含 64 字符上下文），不联网。
- 默认关闭，需要在「设置 → 插件」里手动打开。

## License

MIT. See [LICENSE](LICENSE).
