# Dreamframe: AI image generation platform

Turn text prompts into images, tune style, aspect ratio, model and seed, and keep
a gallery of everything you make. Built as a static studio plus a small
Cloudflare Worker proxy.

## Features

- **Prompt studio**: prompt box with a character count, 8 style presets, 5 aspect
  ratios (1:1, 4:5, 3:2, 16:9, 9:16), model picker, optional seed (the same seed
  and prompt reproduce the same image), `Ctrl/Cmd+Enter` to generate.
- **Engines, switchable in the UI**:
  - **Free (Pollinations)**: keyless text-to-image. Called server-side because
    the provider rejects browser origins with a Turnstile challenge. This is the
    default engine, so the app works with no key and no billing.
  - **Gemini (Google)**: image models (`gemini-nano-banana-2.1`, Nano Banana 2,
    2 Lite, legacy) through `:generateContent`, authenticated with
    `GEMINI_API_KEY`. The requested frame is passed as a composition instruction
    because Gemini takes no size parameters.
  - **OpenAI-compatible**: any `/images/generations` endpoint using
    `OPENAI_API_KEY`. Available only when that key is set.

  Keys stay in the Worker and never reach the browser.
- **Local gallery**: every generation is stored in IndexedDB (image blob plus
  prompt metadata). Click to reopen, favorite, download, delete, filter by
  favorites. No account, no server database.
- **Result viewer**: loading state with a live timer and cancel, error state with
  the upstream reason, download, copy prompt, and a one-click variation (same
  prompt, fresh seed).
- **Rate-limit aware**: the free tier allows roughly one image per 45 seconds per
  address and occasionally reports transient outages. The Worker parses those
  structured errors, waits for the advertised delay, and retries a bounded number
  of times before surfacing a readable error.

## Project layout

```
worker.js        Worker: serves the static app, /api/config and /api/generate
public/
  index.html     Studio markup (controls, viewer states, gallery)
  styles.css     Theme and layout
  app.js         Generation flow, engine switch, IndexedDB gallery
wrangler.jsonc   Local dev and asset configuration
package.json     npm run dev -> wrangler dev
```

## Run it

```bash
npm install
npm run dev          # http://127.0.0.1:8790
```

The free engine works immediately with no configuration.

### Optional: key-based engines

Create a `.dev.vars` file locally (or set secrets in your deployment):

```
GEMINI_API_KEY=...                        # enables the Gemini engine
OPENAI_API_KEY=sk-...                     # enables the OpenAI-compatible engine
OPENAI_BASE_URL=https://api.openai.com/v1 # optional, any compatible endpoint
GEMINI_IMAGE_MODELS=...                   # optional, comma-separated model ids
OPENAI_IMAGE_MODELS=gpt-image-1,dall-e-3  # optional, comma-separated
```

Configured key engines appear in the engine dropdown; engines without a key are
shown as disabled with a reason. The free engine stays the default so the app
works regardless of billing. If Google reports that your project has no image
quota (`limit: 0` on the free tier), enable billing for the Gemini API in Google
Cloud or use a key whose project has image access. `.dev.vars` is git-ignored.

## API

| Route | Method | Purpose |
| --- | --- | --- |
| `/api/config` | GET | Which engines are available, model lists, default engine |
| `/api/generate` | POST | `{ provider, prompt, model, width, height, aspect, seed }` returns image bytes |

`provider` is one of `pollinations`, `gemini`, `openai`.

Errors come back as `{ "error": "...", "retryAfterSeconds": n }`.

## Quality and limits

- The free tier caps output at 589,824 pixels (1024x576) and downscales larger
  requests, so each aspect preset requests exactly that budget: 768x768 (1:1),
  685x860 (4:5), 940x627 (3:2), 1024x576 (16:9), 576x1024 (9:16). Nothing is
  rendered smaller than the tier allows.
- Free engine requests send `enhance=true` so the provider expands short prompts
  into detailed ones. Gemini receives an explicit high-detail composition
  instruction because it takes no size parameters.
- **No dead-end errors**: rate limits are handed back to the Worker with a wait
  time, and the UI counts down and retries automatically (up to 6 attempts) while
  showing progress. Cancel stays available the whole time. The error state only
  appears if every attempt fails.
- A key engine whose project has no image quota is **disabled in the engine
  dropdown with the reason**, and if it is ever hit at runtime the UI hides it
  and continues the same generation on the free engine instead of erroring.
  `GEMINI_IMAGE_QUOTA_BLOCKED=1` in `.dev.vars` sets that state manually; remove
  it once billing is enabled for the Gemini API.
- "Use an example prompt" fills the prompt box so generation is always possible.
- Gallery data lives in this browser only; clearing site data clears it.
