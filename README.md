# dsh-eyes

**Vision bridge for text-only DeepSeek models in DeepSeek Harness (dsh).**

Paste images into the dsh Web UI dialog; `dsh-eyes` silently converts each image to a text description using a separate multimodal model, then hands the text to your preferred text-only DeepSeek model — **no model switching, no separate DeepSeek API key**.

## How it works

`dsh-eyes` registers a wrapper LLM provider route `deepseek-eyes` that declares image input, so dsh's image admission gate admits pasted images. At request time the wrapper:

1. Reads each pasted image's bytes via the dsh attachment service.
2. Asks a multimodal model (default `tongyi/qwen3.7-plus` on mify's Anthropic path) to describe it.
3. Replaces the image block with a `[image] <description>` text evidence block.
4. Delegates the now-text-only request to the real text adapter (`mify-deepseek` / `tongyi/deepseek-v4-pro`).

The durable session log keeps the native image block (the UI shows your thumbnail); only the wire messages carry evidence text.

## Usage

1. In the dsh Web UI, select the model **`deepseek-eyes` → `deepseek-v4-pro`** (or set `agent-default-model` to `{ provider: deepseek-eyes, model: tongyi/deepseek-v4-pro }`).
2. Paste an image into the dialog and send.
3. The text model answers with image understanding — no manual model switching.

## Configuration

Defaults are baked in and work with the mify internal endpoint + existing `MIFY_DEEPSEEK_API_KEY`. Override in `~/.dsh/settings.yaml`:

```yaml
dsh-eyes:
  upstream:
    provider: mify-deepseek            # text adapter to delegate to
    model: tongyi/deepseek-v4-pro      # text model that answers
  vision:
    model: tongyi/qwen3.7-plus         # multimodal model for descriptions
    credential: MIFY_DEEPSEEK_API_KEY  # DSH credential ref (not the value)
    baseURL: https://api.llm.mioffice.cn/anthropic
    prompt: 请用简体中文详细描述这张图片的内容。
  language: zh
```

## Notes

- Reuses the existing mify credential; no new API key required.
- Per-attachment evidence cache: the same image pasted across steps is described once.
- Vision failures are reported inline (`[image: vision failed — <reason>]`) without aborting the turn.
- For pixel-level UI analysis, coordinate grounding, or screenshot diff, use the `dsh-vision-toolkit` plugin instead — `dsh-eyes` is for conversational "what's in this image".
- Very small images (e.g. 1×1 / 2×2 pixels) may be rejected by the vision gateway; use real screenshots and photos.

## Install (local link)

Linked into the dsh web profile via `~/.dsh/profiles/web/package.json`:

```json
"dependencies": { "dsh-eyes": "link:/Users/zhuqichen/MySpace/dsh-eyes" },
"dsh": { "profile": { "bundles": [ ..., "dsh-eyes" ] } }
```

Then `cd ~/.dsh/profiles/web && pnpm install --no-frozen-lockfile` and restart `dsh web`.

License: MIT
