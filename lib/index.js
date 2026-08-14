/**
 * dsh-eyes — vision bridge for text-only DeepSeek models.
 *
 * Registers a wrapper LLM adapter under the provider route `deepseek-eyes`.
 * The wrapper declares image input so dsh's image admission gate admits
 * pasted images, then in `stream()` it reads each image block, asks a
 * separate multimodal model (default tongyi/qwen3.7-plus on mify's Anthropic
 * path) to describe it, replaces the image block with a text evidence block,
 * and delegates the now-text-only request to the real text adapter
 * (mify-deepseek / tongyi/deepseek-v4-pro). The durable session log keeps the
 * native image block; only the wire messages carry evidence text.
 *
 * No DEEPSEEK_API_KEY is required: both the vision call and the text
 * completion reuse the existing mify credential. No model switching: the user
 * selects deepseek-eyes/deepseek-v4-pro and pastes images directly.
 *
 * @module dsh-eyes
 */

/** Configurable provider/model/credential routing for the bridge. */
export const Config = {
  properties: {
    upstream: {
      type: 'object',
      description: 'The real text adapter and model to delegate to after images are converted.',
      properties: {
        provider: { type: 'string', default: 'mify-deepseek', description: 'Registered provider route to delegate the text-only request to.' },
        model: { type: 'string', default: 'tongyi/deepseek-v4-pro', description: 'Text model that answers the conversation.' },
      },
    },
    vision: {
      type: 'object',
      description: 'The multimodal model used to describe pasted images.',
      properties: {
        model: { type: 'string', default: 'tongyi/qwen3.7-plus', description: 'Multimodal model name on the vision endpoint.' },
        credential: { type: 'string', default: 'MIFY_DEEPSEEK_API_KEY', description: 'DSH credential reference holding the API key (an env-style name).' },
        baseURL: { type: 'string', default: 'https://api.llm.mioffice.cn/anthropic', description: 'Anthropic-compatible base URL for the vision call.' },
        prompt: { type: 'string', default: '请用简体中文详细描述这张图片的内容。', description: 'Focus prompt sent with each image.' },
      },
    },
    language: { type: 'string', default: 'zh', description: 'Evidence language hint (zh or en).' },
  },
}

export const name = 'dsh-eyes'

// All three are optional in some compositions; resolve through ctx.get so the
// plugin degrades loudly with a precise message rather than a property-proxy
// throw when a seam is absent.
export const inject = ['llm', 'credentials', 'attachments']

/** Convert a Uint8Array to a base64 string without large-string slicing issues. */
function toBase64(bytes) {
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

/** Anthropic media_type names map 1:1 to dsh ImageMediaType. */
function anthropicMediaType(mediaType) {
  return mediaType // 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
}

/**
 * Describe one image through the vision model on mify's Anthropic path.
 * Returns a free-text description; the caller wraps it as an evidence block.
 * @param {object} ctx - cordis context (for credentials + fetch).
 * @param {object} vision - resolved vision config (model, credential, baseURL, prompt).
 * @param {Uint8Array} data - verified image bytes.
 * @param {string} mediaType - canonical image media type.
 * @param {AbortSignal} [signal] - cancellation for the vision fetch.
 * @returns {Promise<string>} the description text, or a failure marker.
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
      + `store it through the DSH credentials service (the web Models page writes it)`,
    )
  }
  const payload = {
    model: vision.model,
    max_tokens: 1024,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: anthropicMediaType(mediaType), data: toBase64(data) } },
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
  // Anthropic messages response: { content: [{ type: 'text', text }, ...] }
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
 * Returns the rewritten message and whether any image was converted.
 * @param {object} ctx - cordis context.
 * @param {object} vision - resolved vision config.
 * @param {Map} cache - per-attachment-id promise cache (LRU by insertion).
 * @param {object} message - one GenerateOptions message.
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
    // Concurrency join: the same image pasted across steps is described once.
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
      // LRU eviction: keep the cache bounded.
      if (cache.size > 32) {
        const oldest = cache.keys().next().value
        cache.delete(oldest)
      }
    }
    let description
    try {
      description = await pending
    } catch (error) {
      // Inline failure: the turn is not lost; the model sees the failure marker.
      cache.delete(key)
      const reason = error instanceof Error ? error.message : String(error)
      return { type: 'text', text: `[image: vision failed — ${reason}]` }
    }
    return { type: 'text', text: `[image] ${description}` }
  }))
  return { message: { ...message, content: nextContent }, converted }
}

/**
 * The wrapper adapter. A plain object duck-typed as LlmAdapter: it supplies
 * every base-class method so registration never silently fails (the modlens
 * v3.9.0 regression was omitting providerInfo/providerRetryPolicy).
 */
function createAdapter(ctx, config) {
  const upstream = {
    provider: config.upstream?.provider ?? 'mify-deepseek',
    model: config.upstream?.model ?? 'tongyi/deepseek-v4-pro',
  }
  const vision = {
    model: config.vision?.model ?? 'tongyi/qwen3.7-plus',
    credential: config.vision?.credential ?? 'MIFY_DEEPSEEK_API_KEY',
    baseURL: config.vision?.baseURL ?? 'https://api.llm.mioffice.cn/anthropic',
    prompt: config.vision?.prompt ?? '请用简体中文详细描述这张图片的内容。',
  }
  // Per-adapter LRU: evidence cache survives across steps in one agent run.
  const cache = new Map()

  return {
    providerInfo(provider) {
      return { id: provider, name: provider === 'deepseek-eyes' ? 'DeepSeek Eyes' : provider }
    },
    providerRetryPolicy(_provider) {
      return undefined
    },
    async listModels(provider) {
      // Advertise the wrapped text model with image input declared, so the
      // admission gate and model selector treat it as image-capable.
      return [{
        provider,
        id: upstream.model,
        name: upstream.model,
        inputModalities: ['text', 'image'],
      }]
    },
    async resolveModel(provider, model, _signal) {
      return {
        provider,
        id: model,
        name: model,
        inputModalities: ['text', 'image'],
      }
    },
    async *stream(options) {
      const signal = options.signal
      // Rewrite every message that carries image blocks into text evidence.
      const messages = await Promise.all(
        (options.messages ?? []).map((m) => rewriteMessage(ctx, vision, cache, m, signal)),
      )
      const rewritten = messages.map((r) => r.message)
      // Delegate to the real text adapter with the route rewritten.
      const delegated = {
        ...options,
        provider: upstream.provider,
        model: upstream.model,
        messages: rewritten,
      }
      yield* ctx.llm.stream(delegated)
    },
  }
}

/**
 * Plugin entry. Registers the wrapper adapter and its configurable provider
 * directory entry. The disposer unregisters both.
 * @param {object} ctx - cordis context.
 * @param {object} [config] - composed config (validated shape from Config).
 * @returns {() => void} disposer.
 */
export function apply(ctx, config = {}) {
  const llm = ctx.get('llm')
  if (llm === undefined) {
    ctx.logger?.error?.('dsh-eyes: llm service unavailable; plugin not registered')
    return () => {}
  }
  const adapter = createAdapter(ctx, config)
  const registration = llm.registerAdapter(['deepseek-eyes'], adapter)
  // Make the route appear in the model selector / Models page.
  try {
    llm.registerConfigurableProviders?.([
      { provider: 'deepseek-eyes', displayName: 'DeepSeek Eyes', settingsNs: 'dsh-eyes', settingsPath: [] },
    ])
  } catch {
    // Older runtimes may not expose registerConfigurableProviders; the adapter
    // still works when the route is selected through agent-default-model.
  }
  ctx.logger?.info?.('dsh-eyes: registered deepseek-eyes (vision bridge to %s/%s)', upstreamProvider(config), upstreamModel(config))
  return () => {
    registration?.dispose?.()
  }
}

function upstreamProvider(config) {
  return config.upstream?.provider ?? 'mify-deepseek'
}
function upstreamModel(config) {
  return config.upstream?.model ?? 'tongyi/deepseek-v4-pro'
}
