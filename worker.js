/**
 * Dreamframe worker: serves the static studio and proxies image generation.
 *
 * Two engines, switchable from the UI:
 *   1. pollinations: free, keyless text-to-image (called server-side, because
 *      the provider rejects browser origins with a Turnstile challenge).
 *   2. openai: any OpenAI-compatible /images/generations endpoint, configured
 *      with env.OPENAI_API_KEY (plus optional OPENAI_BASE_URL / OPENAI_IMAGE_MODELS).
 *      The key stays server-side and never reaches the browser.
 */

const FREE_MODELS = [
  { id: "flux", label: "Flux (free)" },
  { id: "", label: "Auto (free)" },
];

const GEMINI_MODELS = [
  { id: "gemini-nano-banana-2.1", label: "Nano Banana 2.1 (recommended)" },
  { id: "gemini-3.1-flash-image", label: "Nano Banana 2" },
  { id: "gemini-3.1-flash-lite-image", label: "Nano Banana 2 Lite" },
  { id: "gemini-2.5-flash-image", label: "Nano Banana (legacy)" },
];
const DEFAULT_GEMINI_MODEL = "gemini-nano-banana-2.1";

const DEFAULT_OPENAI_MODELS = ["gpt-image-1", "dall-e-3"];

const GENERATION_TIMEOUT_MS = 120_000;

// Set once Google reports this project has no image quota (limit: 0), so the
// engine can be hidden instead of failing in front of a user.
let geminiRuntimeBlocked = false;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/config" && request.method === "GET") {
      return json(buildConfig(env));
    }

    if (url.pathname === "/api/generate" && request.method === "POST") {
      return handleGenerate(request, env);
    }

    if (url.pathname.startsWith("/api/")) {
      return json({ error: "Not found" }, 404);
    }

    return env.ASSETS.fetch(request);
  },
};

function buildConfig(env) {
  const openaiModels = (env.OPENAI_IMAGE_MODELS || DEFAULT_OPENAI_MODELS.join(","))
    .split(",")
    .map((m) => m.trim())
    .filter(Boolean)
    .map((id) => ({ id, label: id }));

  const geminiModels = env.GEMINI_IMAGE_MODELS
    ? env.GEMINI_IMAGE_MODELS.split(",").map((m) => m.trim()).filter(Boolean).map((id) => ({ id, label: id }))
    : GEMINI_MODELS;

  const providers = [
    { id: "pollinations", label: "Free (Pollinations, no key)", requiresKey: false, available: true },
    {
      id: "gemini",
      label: "Gemini (Google)",
      requiresKey: true,
      available: Boolean(env.GEMINI_API_KEY) && !geminiRuntimeBlocked && !env.GEMINI_IMAGE_QUOTA_BLOCKED,
      disabledReason: !env.GEMINI_API_KEY
        ? "Set GEMINI_API_KEY on this deployment"
        : "Image quota is not enabled for this Google project yet",
    },
    {
      id: "openai",
      label: "OpenAI-compatible",
      requiresKey: true,
      available: Boolean(env.OPENAI_API_KEY),
      disabledReason: "Set OPENAI_API_KEY on this deployment",
    },
  ];

  return {
    // Always open on the free engine so the app works with no billing at all.
    // Key engines stay selectable from the dropdown when a key is configured.
    defaultProvider: "pollinations",
    providers,
    models: {
      pollinations: FREE_MODELS,
      gemini: geminiModels,
      openai: openaiModels,
    },
  };
}

async function handleGenerate(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const { provider = "pollinations", prompt, model = "", width, height, seed, aspect } = body || {};

  if (typeof prompt !== "string" || !prompt.trim()) {
    return json({ error: "A prompt is required." }, 400);
  }
  if (prompt.length > 4000) {
    return json({ error: "Prompt is too long (max 4000 characters)." }, 400);
  }

  const w = clampInt(width, 256, 1536, 1024);
  const h = clampInt(height, 256, 1536, 1024);
  const s = seed === undefined || seed === null || seed === ""
    ? Math.floor(Math.random() * 1_000_000_000)
    : clampInt(seed, 0, 2_147_483_647, 0);

  if (provider === "gemini") {
    if (!env.GEMINI_API_KEY) {
      return json({
        error: "No Gemini key configured. Set GEMINI_API_KEY for this deployment, or switch the engine to the free option.",
      }, 503);
    }
    return generateGemini({ prompt: prompt.trim(), model, aspect }, env);
  }

  if (provider === "openai") {
    if (!env.OPENAI_API_KEY) {
      return json({
        error: "No API key configured. Set OPENAI_API_KEY for this deployment, or switch the engine to the free option.",
      }, 503);
    }
    return generateOpenAI({ prompt: prompt.trim(), model, width: w, height: h }, env);
  }

  if (provider !== "pollinations") {
    return json({ error: `Unknown engine "${provider}".` }, 400);
  }

  return generateFree({ prompt: prompt.trim(), model, width: w, height: h, seed: s });
}

/* ------------------------------ free engine ------------------------------ */

async function generateFree({ prompt, model, width, height, seed }) {
  const url = new URL(`https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}`);
  url.searchParams.set("width", String(width));
  url.searchParams.set("height", String(height));
  url.searchParams.set("seed", String(seed));
  url.searchParams.set("nologo", "true");
  url.searchParams.set("referrer", "dreamframe");
  // Server-side prompt expansion: better detail for the same user wording.
  url.searchParams.set("enhance", "true");
  if (model) url.searchParams.set("model", model);

  // The free tier is rate limited per IP (about one image per 45s), the classic
  // API reports temporary capacity limits, and connections occasionally drop.
  // All three say how long to wait (or are safe to retry), so retry a bounded
  // number of times after the advertised delay instead of failing the UI.
  let failure = null;
  // Rate limits are handed back to the client immediately (with the wait time)
  // so the UI can show a countdown instead of a silent stall or an error.
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) {
      await sleep(failure.retryAfterMs);
    }

    let res;
    try {
      res = await fetch(url.toString(), {
        signal: AbortSignal.timeout(GENERATION_TIMEOUT_MS),
        headers: { "User-Agent": "dreamframe/1.0" },
      });
    } catch (err) {
      failure = {
        message: `Free engine unreachable: ${describe(err)}`,
        status: 502,
        retryAfterMs: 15_000,
        retryable: true,
      };
      continue;
    }

    if (res.ok) {
      const blob = await res.blob();
      return new Response(blob, {
        headers: {
          "Content-Type": res.headers.get("content-type") || "image/jpeg",
          "Cache-Control": "no-store",
          "X-Seed": String(seed),
        },
      });
    }

    failure = await parseFreeError(res);
    if (!failure.retryable) break;
  }

  return json(
    {
      error: failure.message,
      retryAfterSeconds: Math.max(1, Math.ceil(failure.retryAfterMs / 1000)),
    },
    failure.status,
  );
}

async function parseFreeError(res) {
  let data = null;
  try {
    data = await res.json();
  } catch { /* non-JSON error body */ }

  const err = data?.error;
  const code = typeof err === "object" ? err?.code : undefined;
  const message =
    (typeof err === "object" && err?.message) ||
    (typeof err === "string" ? err : null) ||
    data?.message ||
    `Free engine returned HTTP ${res.status}`;

  const fromHeader = Number(res.headers.get("Retry-After"));
  const fromMessage = Number(/retry after (\d+)\s*s/i.exec(message)?.[1]);
  const retryAfterMs = Math.min((fromHeader || fromMessage || 45) * 1000, 60_000);

  const rateLimited = code === "FREE_LIMIT" || /free limit/i.test(message);
  const overloaded = code === "SERVICE_UNAVAILABLE" || res.status === 503;

  return {
    message: rateLimited
      ? `${message} (the free tier allows one image at a time per address).`
      : message,
    status: rateLimited ? 429 : overloaded ? 503 : 502,
    retryAfterMs,
    // Only transient outages are retried here; rate limits go straight back to
    // the client so it can show the wait and retry visibly.
    retryable: overloaded,
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* -------------------------------- gemini --------------------------------- */

async function generateGemini({ prompt, model, aspect }, env) {
  const chosenModel = model || DEFAULT_GEMINI_MODEL;
  // Gemini takes no size parameters, so the requested frame is passed as a
  // composition instruction instead of being silently ignored.
  const text = aspect
    ? `${prompt}. Frame the composition for a ${aspect} aspect ratio, rendered in high detail with clean composition and sharp focus.`
    : `${prompt}. Render in high detail with clean composition and sharp focus.`;
  const url = `https://generativelanguage.googleapis.com/v1/models/${encodeURIComponent(chosenModel)}:generateContent`;
  const payload = JSON.stringify({ contents: [{ parts: [{ text }] }] });

  let failure = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) {
      await sleep(failure.retryAfterMs);
    }

    let res;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": env.GEMINI_API_KEY,
        },
        body: payload,
        signal: AbortSignal.timeout(GENERATION_TIMEOUT_MS),
      });
    } catch (err) {
      failure = { message: `Gemini unreachable: ${describe(err)}`, status: 502, retryAfterMs: 15_000, retryable: true };
      continue;
    }

    if (res.ok) {
      const data = await res.json().catch(() => ({}));
      const parts = data?.candidates?.[0]?.content?.parts || [];
      const imagePart = parts.find((p) => p.inlineData?.data);
      if (!imagePart) {
        const feedback = data?.promptFeedback?.blockReason;
        const textBack = parts.map((p) => p.text).filter(Boolean).join(" ").slice(0, 200);
        const detail = feedback || textBack || "no image part in the response";
        return json({ error: `Gemini returned no image: ${detail}` }, 502);
      }
      const bytes = Uint8Array.from(atob(imagePart.inlineData.data), (c) => c.charCodeAt(0));
      return imageResponse(new Blob([bytes], { type: imagePart.inlineData.mimeType || "image/png" }));
    }

    const data = await res.json().catch(() => null);
    const rawMessage = data?.error?.message || `Gemini returned HTTP ${res.status}`;
    const rateLimited = res.status === 429 || /rate limit|resource exhausted|quota/i.test(rawMessage);
    // "limit: 0" means this project has no image quota at all, which no retry
    // can fix; report it once in plain language instead of Google's long list.
    const hardQuotaBlock = /limit: 0|check your plan and billing/i.test(rawMessage);
    if (hardQuotaBlock) geminiRuntimeBlocked = true;
    const retryAfterMs = hardQuotaBlock
      ? 0
      : Math.min((Number(res.headers.get("Retry-After")) || 20) * 1000, 30_000);
    failure = {
      message: hardQuotaBlock
        ? "Gemini image models have no quota on this project's free tier. Enable billing for the Gemini API in Google Cloud, or use a key whose project has image access. The free engine in the dropdown works in the meantime."
        : rawMessage.length > 400
          ? `${rawMessage.slice(0, 400)}...`
          : rawMessage,
      status: rateLimited ? 429 : res.status === 403 || res.status === 401 ? res.status : 502,
      retryAfterMs,
      retryable: (rateLimited && !hardQuotaBlock) || res.status === 503,
    };
    if (!failure.retryable) break;
  }

  return json(
    {
      error: failure.message,
      retryAfterSeconds: Math.max(1, Math.ceil(failure.retryAfterMs / 1000)),
      quotaBlocked: geminiRuntimeBlocked,
    },
    failure.status,
  );
}

/* --------------------------- openai-compatible --------------------------- */

async function generateOpenAI({ prompt, model, width, height }, env) {
  const base = (env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
  const chosenModel = model || DEFAULT_OPENAI_MODELS[0];

  const payload = {
    model: chosenModel,
    prompt,
    n: 1,
    size: pickSize(chosenModel, width, height),
    response_format: chosenModel.startsWith("dall-e") ? "b64_json" : undefined,
  };
  if (payload.response_format === undefined) delete payload.response_format;

  let res;
  try {
    res = await fetch(`${base}/images/generations`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(GENERATION_TIMEOUT_MS),
    });
  } catch (err) {
    return json({ error: `Image API unreachable: ${describe(err)}` }, 502);
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = data?.error?.message || JSON.stringify(data).slice(0, 300);
    return json({ error: `Image API returned ${res.status}: ${detail}` }, 502);
  }

  const item = data?.data?.[0];
  if (item?.b64_json) {
    const bytes = Uint8Array.from(atob(item.b64_json), (c) => c.charCodeAt(0));
    return imageResponse(new Blob([bytes], { type: "image/png" }));
  }
  if (item?.url) {
    const img = await fetch(item.url, { signal: AbortSignal.timeout(60_000) });
    if (!img.ok) return json({ error: `Could not download the generated image (${img.status}).` }, 502);
    return imageResponse(await img.blob());
  }
  return json({ error: "Image API returned no image data." }, 502);
}

function pickSize(model, width, height) {
  const orientation = width === height ? "square" : width > height ? "landscape" : "portrait";
  if (model.startsWith("dall-e-2")) {
    return orientation === "square" ? "1024x1024" : orientation === "landscape" ? "512x512" : "512x512";
  }
  if (model.startsWith("dall-e-3")) {
    return orientation === "landscape" ? "1792x1024" : orientation === "portrait" ? "1024x1792" : "1024x1024";
  }
  return orientation === "landscape" ? "1536x1024" : orientation === "portrait" ? "1024x1536" : "1024x1024";
}

/* -------------------------------- helpers -------------------------------- */

function imageResponse(blob) {
  return new Response(blob, {
    headers: {
      "Content-Type": blob.type || "image/png",
      "Cache-Control": "no-store",
    },
  });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(value, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function describe(err) {
  if (err?.name === "TimeoutError" || err?.name === "AbortError") return "timed out";
  return err?.message || String(err);
}
