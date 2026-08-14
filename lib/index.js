/**
 * dsh-eyes — give a text-only model eyes, transparently.
 *
 * No wrapper provider, no model to select. The user keeps using their normal
 * text model (e.g. tongyi/deepseek-v4-pro); dsh-eyes listens on the
 * `agent/pre-step` waterfall and, when a step's claimed messages carry an
 * image block, asks a separate multimodal model (default tongyi/qwen3.7-plus
 * on mify's Anthropic path) to describe it and replaces the image block with
 * a text evidence block. The rewritten messages are what the agent loop
 * appends to the session, so the model only ever sees text and the
 * model-visible ⟺ logged invariant holds.
 *
 * For pastes to reach pre-step at all, the text model's route must declare
 * image input. That is a pi-ai config fact (`defaultInput: [text, image]` on
 * the provider), documented in the README — dsh-eyes does not rewrite another
 * plugin's config. Reuses the existing mify credential; no DEEPSEEK_API_KEY.
 *
 * @module dsh-eyes
 */

import z from '@deepseek-ai/schemastery'
import { DshEyesWebBackend, installDshEyesWeb } from './web.js'

/**
 * The bridge config — the "视觉服务" surface. Only the vision half is
 * configurable: which multimodal model describes pasted images (model), where
 * its Anthropic-compatible endpoint is (baseURL), and which credential holds
 * the API key (credential — the key value lives in 设置 → 模型). The text
 * model is whatever the user selected in the session.
 */
export const Config = z.object({
  vision: z.object({
    model: z.string().default('tongyi/qwen3.7-plus'),
    credential: z.string().default('MIFY_DEEPSEEK_API_KEY'),
    baseURL: z.string().default('https://api.llm.mioffice.cn/anthropic'),
  }),
})

export const name = 'dsh-eyes'

// credentials + attachments are resolved through ctx.get (optional seams); the
// settings seam is required to register the dsh-eyes namespace. llm is gone —
// the bridge no longer registers an adapter.
export const inject = ['credentials', 'attachments', 'settings']

/** Convert a Uint8Array to a base64 string without large-string slicing issues. */
function toBase64(bytes) {
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

/**
 * Describe one image through the vision model on mify's Anthropic path.
 * Returns a free-text description; the caller wraps it as an evidence block.
 */
async function describeImage(ctx, vision, data, mediaType, signal) {
  const credentials = ctx.get('credentials')
  if (credentials === undefined) {
    throw new Error('dsh-eyes: credentials service is unavailable; cannot resolve the vision API key')
  }
  const resolved = await credentials.resolve(vision.credential)
  if (resolved === undefined) {
    throw new Error(
      `dsh-eyes: credential "${vision.credential}" is not configured; `
      + 'store it through the DSH credentials service (the web Models page writes it)',
    )
  }
  const payload = {
    model: vision.model,
    max_tokens: 1024,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mediaType, data: toBase64(data) } },
        { type: 'text', text: vision.prompt },
      ],
    }],
  }
  const response = await fetch(`${vision.baseURL.replace(/\/+$/, '')}/v1/messages`, {
    method: 'POST',
    headers: {
      'x-api-key': resolved.value,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload),
    signal,
  })
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(`dsh-eyes: vision call to ${vision.model} failed (HTTP ${response.status}): ${body.slice(0, 200)}`)
  }
  const json = await response.json()
  const text = Array.isArray(json.content)
    ? json.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n')
    : ''
  if (text.length === 0) {
    throw new Error(`dsh-eyes: vision model ${vision.model} returned an empty description`)
  }
  return text
}

/**
 * Walk one message's content blocks, converting image blocks to text evidence.
 * @param {object} ctx - cordis context.
 * @param {object} vision - resolved vision config.
 * @param {Map} cache - per-attachment-id promise cache (LRU by insertion).
 * @param {object} message - one user message.
 * @param {AbortSignal} [signal] - cancellation.
 * @returns {Promise<{message: object, converted: boolean}>}
 */
async function rewriteMessage(ctx, vision, cache, message, signal) {
  if (!Array.isArray(message.content)) return { message, converted: false }
  let converted = false
  const nextContent = await Promise.all(message.content.map(async (block) => {
    if (block.type !== 'image') return block
    converted = true
    const ref = block.attachment
    if (ref === undefined) {
      return { type: 'text', text: '[image: attachment reference missing]' }
    }
    const key = ref.attachmentId ?? ref
    let pending = cache.get(key)
    if (pending === undefined) {
      pending = (async () => {
        const attachments = ctx.get('attachments')
        if (attachments === undefined) {
          throw new Error('dsh-eyes: attachments service is unavailable; cannot read image bytes')
        }
        const stored = await attachments.readImage(ref, signal)
        return describeImage(ctx, vision, stored.data, stored.ref.mediaType, signal)
      })()
      cache.set(key, pending)
      if (cache.size > 32) {
        const oldest = cache.keys().next().value
        cache.delete(oldest)
      }
    }
    let description
    try {
      description = await pending
    } catch (error) {
      cache.delete(key)
      const reason = error instanceof Error ? error.message : String(error)
      return { type: 'text', text: `[image: vision failed — ${reason}]` }
    }
    return { type: 'text', text: `[image] ${description}` }
  }))
  return { message: { ...message, content: nextContent }, converted }
}

/**
 * Plugin entry. Registers the dsh-eyes settings namespace and mounts the
 * pre-step vision bridge. No adapter registration — the user's own model
 * stays selected and the bridge rewrites images to text before the model sees
 * them.
 * @param {object} ctx - cordis context.
 * @param {object} [config] - composed config (validated shape from Config).
 * @returns {() => void} disposer.
 */
export function apply(ctx, config = {}) {
  // Resolved vision config; updated live by the settings namespace watcher.
  let vision = {
    model: config.vision?.model ?? 'tongyi/qwen3.7-plus',
    credential: config.vision?.credential ?? 'MIFY_DEEPSEEK_API_KEY',
    baseURL: config.vision?.baseURL ?? 'https://api.llm.mioffice.cn/anthropic',
    prompt: '请用简体中文详细描述这张图片的内容。',
  }
  // Per-plugin LRU: the same image pasted across steps is described once.
  const cache = new Map()

  // Register the dsh-eyes settings namespace so the Web Settings card can
  // read/write the bridge config through ctx.settings (live, no restart).
  const settings = ctx.get('settings')
  if (settings !== undefined) {
    try {
      const handle = settings.register('dsh-eyes', Config, { base: config, applies: 'live' })
      handle?.watch?.((next) => {
        vision = {
          ...vision,
          ...(next?.vision ?? {}),
        }
      })
    } catch (error) {
      ctx.logger?.warn?.('dsh-eyes: settings namespace not registered: %s', error instanceof Error ? error.message : String(error))
    }
  }

  // The bridge: rewrite image blocks to text evidence at the pre-step
  // waterfall, before the agent loop appends the messages to the session and
  // the model sees them. The rewritten messages are what gets logged, so the
  // model-visible ⟺ logged invariant holds without any adapter wrapper.
  const detach = ctx.on('agent/pre-step', async ({ messages, signal }, next) => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    let converted = false
    const rewritten = await Promise.all(messages.map(async (message) => {
      const result = await rewriteMessage(ctx, vision, cache, message, signal)
      if (result.converted) converted = true
      return result.message
    }))
    if (!converted) return decision
    return { kind: 'enter', messages: rewritten }
  })

  ctx.logger?.info?.('dsh-eyes: vision bridge active (vision model %s)', vision.model)

  // Web Settings backend: snapshot/save/health route + bridge-active flag.
  try {
    const backend = new DshEyesWebBackend(ctx)
    backend.adapterRegistered = true
    installDshEyesWeb(ctx, backend)
  } catch (error) {
    ctx.logger?.warn?.('dsh-eyes: web settings route not installed: %s', error instanceof Error ? error.message : String(error))
  }

  return () => {
    detach?.()
  }
}
