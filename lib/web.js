/**
 * dsh-eyes — Web Settings backend.
 *
 * Same-origin Settings/health route at `/_dsh/dsh-eyes/settings`: GET returns
 * a snapshot of the dsh-eyes settings namespace plus the configured/missing
 * state of the vision credential; POST saves a new config through the live
 * settings namespace, or runs a health/connection check against the vision
 * endpoint. Modeled on the dsh-vision-toolkit web backend, trimmed to the
 * bridge's smaller surface (no runtime manager, no artifacts).
 *
 * @module dsh-eyes/web
 */

import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { SettingsConflictError } from '@deepseek-ai/dsh-settings'
import { Config } from './index.js'

/** Exact route used by the browser Settings card. */
export const SETTINGS_ROUTE = '/_dsh/dsh-eyes/settings'
export const DSH_EYES_SETTINGS_NAMESPACE = 'dsh-eyes'

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function descriptorOf(ctx) {
  const descriptor = ctx.settings.describe().find((row) => row.ns === DSH_EYES_SETTINGS_NAMESPACE)
  if (descriptor === undefined) throw new Error('dsh-eyes Settings namespace is not registered')
  return descriptor
}

function responseJson(res, status, body) {
  const bytes = Buffer.from(JSON.stringify(body))
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Content-Length', String(bytes.length))
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'")
  res.writeHead(status)
  res.end(bytes)
}

function requestError(res, status, code, message) {
  responseJson(res, status, { ok: false, error: { code, message } })
}

function sameOriginPost(req) {
  const fetchSite = req.headers['sec-fetch-site']
  if (fetchSite === 'cross-site') return false
  const origin = req.headers.origin
  if (origin === undefined) return fetchSite === 'same-origin' || fetchSite === 'same-site' || fetchSite === 'none'
  const host = req.headers.host
  if (host === undefined) return false
  try {
    const parsed = new URL(origin)
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.host === host
  } catch {
    return false
  }
}

async function readJson(req, maxBytes = 64 * 1024) {
  const contentType = req.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase()
  if (contentType !== 'application/json') throw new TypeError('Content-Type must be application/json')
  const chunks = []
  let bytes = 0
  for await (const chunk of req) {
    const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += part.length
    if (bytes > maxBytes) throw new RangeError(`request body exceeds ${maxBytes} bytes`)
    chunks.push(part)
  }
  if (chunks.length === 0) throw new TypeError('request body is empty')
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function parseRequest(value) {
  if (!isRecord(value) || typeof value.action !== 'string') throw new TypeError('request action is required')
  if (value.action === 'health') {
    if (typeof value.testConnection !== 'boolean') throw new TypeError('health.testConnection must be boolean')
    return { action: 'health', testConnection: value.testConnection }
  }
  if (value.action === 'save') {
    if (!Number.isSafeInteger(value.expectedRevision) || value.expectedRevision < 0) {
      throw new TypeError('save.expectedRevision must be a non-negative integer')
    }
    if (!isRecord(value.value)) throw new TypeError('save.value must be an object')
    return { action: 'save', expectedRevision: value.expectedRevision, value: value.value }
  }
  throw new TypeError(`unsupported action: ${value.action}`)
}

function publicMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

/** Resolve the configured vision credential's visibility facts (no secret value). */
async function credentialInfo(ctx, refName) {
  const credentials = ctx.get('credentials')
  if (credentials === undefined) return { configured: false, writable: false }
  try {
    const info = await credentials.describe(credentialRef(refName))
    return {
      configured: info.configured,
      ...(info.source === undefined ? {} : { source: info.source }),
      writable: info.writable,
    }
  } catch {
    return { configured: false, writable: false }
  }
}

/**
 * The dsh-eyes Web backend: snapshot/save/health over the settings namespace.
 */
export class DshEyesWebBackend {
  /** Whether the pre-step vision bridge is currently active. */
  adapterRegistered = false

  constructor(ctx) {
    this.ctx = ctx
  }

  /** Build the current settings + credential snapshot without secrets. */
  async snapshot() {
    const descriptor = descriptorOf(this.ctx)
    const value = descriptor.value
    const vision = isRecord(value?.vision) ? value.vision : {}
    const refName = typeof vision.credential === 'string' ? vision.credential : 'MIFY_DEEPSEEK_API_KEY'
    const credential = await credentialInfo(this.ctx, refName)
    return {
      schemaVersion: 1,
      writable: this.ctx.settings.writable,
      settings: { value, revision: descriptor.revision, applies: 'live' },
      credential: {
        ref: refName,
        configured: credential.configured,
        ...(credential.source === undefined ? {} : { source: credential.source }),
        writable: credential.writable,
      },
      adapterRegistered: this.adapterRegistered,
    }
  }

  /** Validate and persist a new config through the live settings namespace. */
  async save(request) {
    if (!this.ctx.settings.writable) throw new Error('settings provider is read-only')
    // Validate before persisting: a bad config must not reach the adapter.
    const result = Config['~standard'].validate(request.value)
    if (result.issues) throw new Error(`invalid config: ${JSON.stringify(result.issues).slice(0, 200)}`)
    await this.ctx.settings.replace(DSH_EYES_SETTINGS_NAMESPACE, request.value, request.expectedRevision)
    return this.snapshot()
  }

  /** Local health + optional live vision test: send a real image to the
   * configured vision model and report whether it can describe it. This is
   * what makes the Settings page useful — it verifies the chosen model can
   * actually see images, not just that the endpoint answers. */
  async health(request, req) {
    const descriptor = descriptorOf(this.ctx)
    const value = descriptor.value
    const vision = isRecord(value?.vision) ? value.vision : {}
    const refName = typeof vision.credential === 'string' ? vision.credential : 'MIFY_DEEPSEEK_API_KEY'
    const model = typeof vision.model === 'string' && vision.model.length > 0 ? vision.model : 'tongyi/qwen3.7-plus'
    const base = (typeof vision.baseURL === 'string' && vision.baseURL.length > 0 ? vision.baseURL : 'https://api.llm.mioffice.cn/anthropic').replace(/\/+$/, '')
    const credential = await credentialInfo(this.ctx, refName)
    const checks = {
      credential: {
        status: credential.configured ? 'ok' : 'error',
        detail: credential.configured ? `configured (source: ${credential.source ?? 'env'})` : `credential "${refName}" is not set`,
      },
      adapter: {
        status: this.adapterRegistered ? 'ok' : 'error',
        detail: this.adapterRegistered ? 'vision bridge active' : 'bridge inactive',
      },
    }
    let connection
    if (request.testConnection) {
      if (!credential.configured) {
        checks.vision = { status: 'error', detail: 'skipped: credential missing' }
        connection = { ok: false, detail: 'credential missing' }
      } else {
        const controller = new AbortController()
        const abort = () => { controller.abort() }
        req.once('aborted', abort)
        req.socket.once('close', abort)
        try {
          const credentials = this.ctx.get('credentials')
          const resolved = await credentials?.resolve(credentialRef(refName))
          // A real 200x200 green PNG — large enough that vision gateways accept
          // it (tiny 1x1/8x8 images are rejected as "illegal format"). Built
          // inline so the test has no external file dependency.
          const TINY_PNG = Buffer.from(
            'iVBORw0KGgoAAAANSUhEUgAAAMgAAADICAIAAAAiOjnJAAACGElEQVR4nO3UMQ3AMBAEQce4jCQ4A9AkfotIMwCuWt1zvnfBtD2+CMKi4rFICIuEsEgIi4SwSAiLhLBICIuEsEgIi4SwSAiLhLBICIuEsEgIi4SwSAiLhLBICIuEsEgIi4SwSAiLhLBICIuEsEgIi4SwSAiLhLBICIuEsEgIi4SwSAiLhLBICIuEsEgIi4SwSAiLhLBICIuEsEgIi4SwSAiLhLBICIuEsEgIi4SwSAiLhLBICIuEsEgIi4SwSAiLhLBICIuEsEgIi4SwSAiLhLBICIuEsEgIi4SwSAiLhLBICIuEsEgIi4SwSAiLhLBICIuEsEgIi4SwSAiLhLBICIuEsEgIi4SwSAiLhLBICIuEsEgIi4SwSAiLhLBICIuEsEgIi4SwSAiLhLBICIuEsEgIi4SwSAiLhLBICIuEsEgIi4SwSAiLhLBICIuEsEgIi4SwSAiLhLBICIuEsEgIi4SwSAiLhLBICIuEsEgIi4SwSAiLhLBICIuEsEgIi4SwSAiLhLBICIuEsEgIi4SwSAiLhLBICIuEsEgIi4SwSAiLhLBICIuEsEgIi4SwSAiLhLBICIuEsEgIi4SwSAiLhLBICIuEsEgIi4SwSAiLhLBICIuEsEgIi4SwSAiLhLBICIuEsEgIi4SwSAiLhLBICIuEsEgIi4SwSAiLhLBICIuEsEgIi4SwWIULH3gC2s9c7LQAAAAASUVORK5CYII=',
            'base64',
          )
          const res = await fetch(`${base}/v1/messages`, {
            method: 'POST',
            headers: {
              'x-api-key': resolved?.value ?? '',
              'anthropic-version': '2023-06-01',
              'content-type': 'application/json',
            },
            body: JSON.stringify({
              model,
              max_tokens: 60,
              messages: [{
                role: 'user',
                content: [
                  { type: 'image', source: { type: 'base64', media_type: 'image/png', data: TINY_PNG.toString('base64') } },
                  { type: 'text', text: 'What color? Reply in one word.' },
                ],
              }],
            }),
            signal: controller.signal,
          })
          if (res.ok) {
            const json = await res.json().catch(() => ({}))
            const text = Array.isArray(json.content)
              ? json.content.filter((b) => b.type === 'text').map((b) => b.text).join(' ').slice(0, 60)
              : ''
            if (text) {
              checks.vision = { status: 'ok', detail: `${model}: "${text}"` }
              connection = { ok: true, detail: text }
            } else {
              checks.vision = { status: 'warning', detail: `${model}: responded but no text (may still work)` }
              connection = { ok: true, detail: 'no text in response' }
            }
          } else {
            const body = await res.text().catch(() => '')
            checks.vision = { status: 'error', detail: `${model}: HTTP ${res.status} ${body.slice(0, 80)}` }
            connection = { ok: false, detail: `HTTP ${res.status}` }
          }
        } catch (error) {
          checks.vision = { status: 'error', detail: `${model}: ${publicMessage(error)}` }
          connection = { ok: false, detail: publicMessage(error) }
        } finally {
          req.off('aborted', abort)
          req.socket.off('close', abort)
        }
      }
    }
    return { checks, ...(connection === undefined ? {} : { connection }) }
  }

  /** Dispatch one Settings route request. */
  async handle(req, res) {
    if (req.method === 'GET') {
      try {
        responseJson(res, 200, { ok: true, value: await this.snapshot() })
      } catch (error) {
        this.ctx.logger?.warn?.('dsh-eyes Settings snapshot failed: %s', publicMessage(error))
        requestError(res, 503, 'settings-unavailable', 'dsh-eyes Settings are unavailable')
      }
      return
    }
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'GET, POST')
      requestError(res, 405, 'method-not-allowed', 'Use GET or POST')
      return
    }
    if (!sameOriginPost(req)) {
      requestError(res, 403, 'origin-rejected', 'The request must originate from this DSH Web application')
      return
    }
    let parsed
    try {
      parsed = parseRequest(await readJson(req))
    } catch (error) {
      requestError(res, error instanceof RangeError ? 413 : 400, 'invalid-request', publicMessage(error))
      return
    }
    try {
      if (parsed.action === 'health') {
        responseJson(res, 200, { ok: true, value: await this.health(parsed, req) })
      } else {
        responseJson(res, 200, { ok: true, value: await this.save(parsed) })
      }
    } catch (error) {
      const conflict = error instanceof SettingsConflictError
      const code = conflict ? 'settings-conflict' : parsed.action === 'health' ? 'health-failed' : 'settings-rejected'
      const status = conflict ? 409 : parsed.action === 'health' ? 503 : 400
      this.ctx.logger?.warn?.('dsh-eyes Web action=%s failed: %s', parsed.action, publicMessage(error))
      requestError(res, status, code, publicMessage(error))
    }
  }
}

/**
 * Attach the Settings route to the webserver when one is present.
 * Uses the `webServer` service name (NOT `httpServer` — see the service-name
 * note; the toolkit had that bug).
 * @param ctx - cordis context owning route effects.
 * @param backend - the Settings/health backend.
 */
export function installDshEyesWeb(ctx, backend) {
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => {
      const dispose = webCtx.webServer.register({
        kind: 'exact',
        path: SETTINGS_ROUTE,
        handler: (req, res) => backend.handle(req, res),
      })
      return () => { dispose() }
    }, 'dsh-eyes: Web route')
  })
}
