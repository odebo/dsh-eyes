# dsh-eyes Settings Page — Design Supplement

**Date:** 2026-08-14
**Status:** Draft (awaiting approval)
**Goal:** Add a Web UI Settings card for `dsh-eyes`, like the Vision Toolkit card, so users configure the vision bridge from the UI instead of editing `settings.yaml`.

## Current state

`dsh-eyes` v1 is a host-only plugin (just `lib/index.js`). Config lives in `~/.dsh/settings.yaml` under `dsh-eyes:` and works, but there's no UI — the Settings page has no `dsh-eyes` tab. The user wants parity with the Vision Toolkit card (form fields, save/reload, credential status, test-connection).

## What to build

### 1. Host web backend (`lib/web.js` + register in `lib/index.js`)

A same-origin settings route `/_dsh/dsh-eyes/settings` (GET snapshot + POST save/health), modeled on the toolkit's `web.ts`:

- **GET** → `{ ok, value: { writable, settings: { value, revision }, credential: { ref, configured, source, writable } } }` (reads the live `dsh-eyes` settings namespace + resolves the credential ref for a configured/missing badge).
- **POST `{action:'save', value, revision}`** → validates via `Config['~standard'].validate`, writes through `ctx.settings.replace('dsh-eyes', value)` (live apply — no restart), returns the new snapshot. Stale-revision → 409 conflict.
- **POST `{action:'health', testConnection}`** → `testConnection:true` sends the configured credential to `GET {vision.baseURL}/v1/models` (or a minimal anthropic ping) to verify the vision endpoint + key work; `false` just checks local state (credential configured, adapter registered). Returns `{ checks: { credential, endpoint, adapter }, connection?: { ok, models? } }`.
- Same-origin POST guard (same `sec-fetch-site`/`origin` check as the toolkit).
- Registered via `ctx.inject(['webServer'], ...)` (correct service name — see [[dsh-webserver-service-name]]; the toolkit had the `httpServer` bug we already fixed).

### 2. Client half (`lib/client.js` + `dsh.client` in package.json)

A pre-bundled client plugin (`window.__ModuleLoader__.load` format, hand-written like `dsh-my-agents`) that registers one Settings card:

```js
ctx.slots.inject('settings.section', () => ctx.slots.register({
  name: 'settings.section', id: 'dsh-eyes', order: 31,
  label: () => 'dsh-eyes',
  inject: () => ({ controller, t }),
}, SettingsSection))
```

`SettingsSection` is a React component (hand-written `React.createElement`, no JSX/build step — matches `dsh-my-agents`) with:

- **Header**: "DSH NATIVE PLUGIN / dsh-eyes / 视觉桥接" + status badge (adapter registered / runtime).
- **视觉服务 panel** (form grid, 2-col like the toolkit):
  - Vision model (`tongyi/qwen3.7-plus`) — Input
  - Credential ref (`MIFY_DEEPSEEK_API_KEY`) — Input + "已配置/缺失" badge (from `credential.configured`)
  - 服务地址 (`https://api.llm.mioffice.cn/anthropic`) — Input
  - 描述提示词 — textarea
  - 输出语言 — select (中文/English)
- **主力模型 panel**: upstream provider (`mify-deepseek`) + model (`tongyi/deepseek-v4-pro`) — Inputs
- **Save/Reload row**: 保存并应用 / 重新加载 (calls controller.save / controller.load).
- **健康检查 panel**: 运行健康检查 / 测试连接 buttons + results grid (credential ok? endpoint reachable? adapter registered?).

`controller` = a small fetch-based client hitting `/_dsh/dsh-eyes/settings` (GET/POST), same as the toolkit's. `t` = a trivial i18n map (zh/en), defaulting to zh.

### 3. package.json additions

```json
"dsh": {
  "bundle": { "patch": "./cordis.patch.yml" },
  "client": {
    "inject": ["@deepseek-ai/dsh-client-runtime", "@deepseek-ai/dsh-client-ui-primitives"],
    "platform": "web"
  }
}
```
`exports` gains `"./client": "./lib/client.js"`.

## Data flow

```
Settings card (React) — GET /_dsh/dsh-eyes/settings
  → host reads dsh-eyes settings namespace + resolves credential ref
  → returns snapshot (current values + credential.configured)
user edits fields, clicks 保存并应用
  → POST {action:'save', value, revision}
  → host validates (schemastery), ctx.settings.replace('dsh-eyes', value)
  → applies: 'live' → adapter picks up new vision config on next request (no restart)
  → returns new snapshot
user clicks 测试连接
  → POST {action:'health', testConnection:true}
  → host fetches {baseURL}/v1/models with the credential
  → returns { checks, connection: { ok, modelCount } }
```

## Scope

- Form fields map 1:1 to the existing `dsh-eyes` Config (upstream, vision, language) — no new config keys.
- Save goes through the existing settings namespace (already `applies: 'live'`), so no host adapter changes — the bridge already re-reads config per request.
- Test-connection reuses the verified mify endpoint check (`GET /v1/models` returns 200, same as the Vision Toolkit test).
- No locale beyond zh/en defaults (matches toolkit).

## Non-goals (still)

- No per-session model picker integration (the card configures defaults; model selection is still via the `/model` selector picking `deepseek-eyes`).
- No vision-result preview / artifact cards (that's Vision Toolkit's domain).

## Risk

- Client plugin hand-bundling (`window.__ModuleLoader__.load` + `React.createElement`) is verbose but proven by `dsh-my-agents`. No build step keeps it shippable.
- The `webServer` service-name gotcha is already documented and handled.

## Verification

- After install + restart: Settings page shows a `dsh-eyes` tab with the form, current values populated, credential badge green.
- Edit vision model → 保存并应用 → paste image → confirm the new model is used (live, no restart).
- 测试连接 → green checkmarks (credential ok, endpoint reachable, adapter registered).
