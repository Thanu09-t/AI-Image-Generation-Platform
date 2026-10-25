/**
 * Dreamframe: AI Image Studio
 * Frontend: prompt controls, generation flow, result viewer, local gallery.
 * Images are produced by the worker proxy (/api/generate); history lives in IndexedDB.
 */

const $ = (sel) => document.querySelector(sel);

const ASPECTS = {
  // The free tier caps output at 589,824 pixels (1024x576) and downscales larger
  // requests, so each ratio requests exactly that budget for full sharpness.
  "1:1": [768, 768],
  "4:5": [685, 860],
  "3:2": [940, 627],
  "16:9": [1024, 576],
  "9:16": [576, 1024],
};

const EXAMPLE_PROMPTS = [
  "A ceramic mug of black coffee on a walnut desk beside an open notebook, morning window light, shallow depth of field",
  "Portrait of a fisherman mending a net on a harbour wall, weathered hands, overcast northern light",
  "A glass greenhouse at dusk with warm lamps inside, rain on the panes, quiet garden around it",
  "Street food stall at night, steam rising from the grill, neon reflections on wet pavement",
  "An old library reading room with tall windows, dust in the sunbeams, worn leather chairs",
  "Minimal product shot of a wristwatch on smooth stone, soft studio light, crisp reflections",
];

let geminiRuntimeBlocked = localStorage.getItem("dreamframe.geminiUnavailable") === "1";

const ICON_ATTRS = 'viewBox="0 0 24 24" width="15" height="15" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';
const TRASH_ICON = `<svg ${ICON_ATTRS} fill="none"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/></svg>`;
function starIcon(filled) {
  const fill = filled ? 'currentColor' : 'none';
  return `<svg ${ICON_ATTRS} fill="${fill}"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>`;
}

const state = {
  config: null,
  provider: "pollinations",
  aspect: "1:1",
  filter: "all",
  records: [],
  current: null,
  controller: null,
  tick: null,
  tickStart: 0,
  resultUrl: null,
};

/* ------------------------------- local store ------------------------------ *//* IndexedDB, with an in-memory fallback (e.g. private browsing). */

const store = (() => {
  const DB_NAME = "dreamframe";
  const STORE = "generations";
  const memory = new Map();
  let dbPromise = null;
  let useMemory = false;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      if (!("indexedDB" in window)) return reject(new Error("no-indexeddb"));
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: "id" });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }).catch((err) => {
      useMemory = true;
      throw err;
    });
    return dbPromise;
  }

  async function withStore(mode, fn) {
    if (useMemory) return null;
    const db = await open().catch(() => null);
    if (!db) return null;
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const result = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(result?.result ?? null);
      tx.onerror = () => reject(tx.error);
    });
  }

  return {
    async all() {
      if (useMemory) return [...memory.values()];
      try {
        const rows = await withStore("readonly", (s) => s.getAll());
        if (rows) return rows;
      } catch { /* fall through to memory */ }
      useMemory = true;
      return [...memory.values()];
    },
    async put(rec) {
      memory.set(rec.id, rec);
      try { await withStore("readwrite", (s) => s.put(rec)); } catch { /* memory already holds it */ }
    },
    async patch(id, patch) {
      const rec = memory.get(id);
      if (rec) Object.assign(rec, patch);
      try {
        await withStore("readwrite", (s) => s.put({ ...rec, ...patch }));
      } catch { /* ignore */ }
    },
    async remove(id) {
      memory.delete(id);
      try { await withStore("readwrite", (s) => s.delete(id)); } catch { /* ignore */ }
    },
  };
})();

/* --------------------------------- config --------------------------------- */

async function loadConfig() {
  try {
    const res = await fetch("/api/config");
    state.config = await res.json();
  } catch {
    state.config = {
      defaultProvider: "pollinations",
      providers: [{ id: "pollinations", label: "Free (Pollinations, no key)", requiresKey: false, available: true }],
      models: { pollinations: [{ id: "flux", label: "Flux (free)" }], gemini: [], openai: [] },
    };
  }

  if (geminiRuntimeBlocked) {
    const gemini = state.config.providers.find((p) => p.id === "gemini");
    if (gemini) {
      gemini.available = false;
      gemini.disabledReason = "Image quota is not enabled for this Google project yet";
    }
  }

  const select = $("#provider");
  select.innerHTML = "";
  for (const p of state.config.providers) {
    const opt = document.createElement("option");
    opt.value = p.id;
    opt.textContent = !p.available && p.requiresKey
      ? `${p.label} (${p.disabledReason || "key required"})`
      : p.label;
    opt.disabled = !p.available;
    select.appendChild(opt);
  }

  state.provider = state.config.defaultProvider;
  select.value = state.provider;
  populateModels();
  updateBadge();
  updateEngineNotes();
}

function activeProvider() {
  return state.config.providers.find((p) => p.id === state.provider);
}

function updateEngineNotes() {
  const provider = activeProvider();
  const keyed = Boolean(provider?.requiresKey);
  $("#provider-note").textContent = keyed
    ? "Key stays on the server; the browser never sees it."
    : "Runs through the platform proxy, so no key ever reaches the browser.";
  $("#quota-note").textContent = keyed
    ? "Each image uses the API key configured on this deployment."
    : "Free tier allows one image at a time per address, so a second request waits a few seconds.";
}

function populateModels() {
  const select = $("#model");
  const models = state.config.models[state.provider] || [];
  select.innerHTML = "";
  for (const m of models) {
    const opt = document.createElement("option");
    opt.value = m.id;
    opt.textContent = m.label;
    select.appendChild(opt);
  }
  if (!models.length) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "default";
    select.appendChild(opt);
  }
}

function updateBadge() {
  const badge = $("#provider-badge");
  const text = $("#provider-badge-text");
  const provider = activeProvider();
  badge.classList.remove("is-live", "is-key", "is-off");
  if (!provider) {
    badge.classList.add("is-off");
    text.textContent = "No engine available";
  } else if (provider.requiresKey && provider.available) {
    badge.classList.add("is-key");
    text.textContent = `${provider.label} active`;
  } else if (provider.requiresKey) {
    badge.classList.add("is-off");
    text.textContent = `${provider.label} key missing`;
  } else {
    badge.classList.add("is-live");
    text.textContent = "Free engine: Pollinations";
  }
}

/* ------------------------------ viewer states ------------------------------ */

function showState(name) {
  for (const id of ["empty", "loading", "error", "result"]) {
    $(`#viewer-${id}`).hidden = id !== name;
  }
}

function startTicker() {
  state.tickStart = Date.now();
  $("#loading-text").textContent = "Generating, 0s";
  state.tick = setInterval(() => {
    const secs = Math.round((Date.now() - state.tickStart) / 1000);
    $("#loading-text").textContent = `Generating, ${secs}s`;
  }, 1000);
}

function stopTicker() {
  if (state.tick) clearInterval(state.tick);
  state.tick = null;
  setLoadingNote("");
}

function setLoadingNote(text) {
  const el = $("#loading-note");
  if (el) el.textContent = text;
}

function cancellableSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      const err = new Error("cancelled");
      err.name = "AbortError";
      reject(err);
    };
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

// Countdown shown while waiting out a provider limit, so the user sees
// progress instead of an error.
async function waitToRetry(seconds, attempt, maxAttempts, signal) {
  const total = Math.max(1, Math.min(Math.ceil(seconds), 90));
  for (let left = total; left > 0; left--) {
    setLoadingNote(`Provider busy, retrying automatically in ${left}s (attempt ${attempt} of ${maxAttempts})`);
    await cancellableSleep(1000, signal);
  }
  setLoadingNote(`Retrying now (attempt ${attempt} of ${maxAttempts})`);
}

// A key engine with no quota is hidden rather than left to fail in front of the
// user; the generation continues on the free engine instead.
function markProviderUnavailable(id) {
  const provider = state.config.providers.find((p) => p.id === id);
  if (provider) provider.available = false;
  if (id === "gemini") {
    localStorage.setItem("dreamframe.geminiUnavailable", "1");
    geminiRuntimeBlocked = true;
  }
  const select = $("#provider");
  const opt = [...select.options].find((o) => o.value === id);
  if (opt) {
    opt.disabled = true;
    opt.textContent = provider?.disabledReason ? `${provider.label} (${provider.disabledReason})` : `${provider.label} (unavailable)`;
  }
}

function toast(message, isError = false) {
  const el = $("#toast");
  el.textContent = message;
  el.classList.toggle("is-error", isError);
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.hidden = true; }, 3600);
}

/* ------------------------------- generation ------------------------------- */

function collectOptions(overrides = {}) {
  const basePrompt = $("#prompt").value.trim();
  const styleSuffix = document.querySelector(".chip.is-active")?.dataset.style || "";
  const styleLabel = document.querySelector(".chip.is-active")?.dataset.label || "None";
  const [width, height] = ASPECTS[state.aspect];
  const seedRaw = $("#seed").value.trim();

  return {
    basePrompt,
    prompt: styleSuffix ? `${basePrompt}, ${styleSuffix}` : basePrompt,
    styleLabel,
    provider: state.provider,
    model: $("#model").value,
    width,
    height,
    aspect: state.aspect,
    seed: seedRaw === "" ? null : Number.parseInt(seedRaw, 10),
    ...overrides,
  };
}

async function generate(opts) {
  // Validate the typed prompt itself: a style suffix alone must not count.
  if (!opts.basePrompt) {
    toast("Write a prompt first.", true);
    $("#prompt").focus();
    return;
  }

  state.controller = new AbortController();
  const signal = state.controller.signal;
  startTicker();
  showState("loading");
  $("#generate").disabled = true;

  const started = performance.now();
  const MAX_ATTEMPTS = 6;
  let attempt = 0;
  let fellBackToFree = false;
  let lastError = "";

  try {
    while (attempt < MAX_ATTEMPTS) {
      attempt += 1;
      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: opts.provider,
          prompt: opts.prompt,
          model: opts.model,
          width: opts.width,
          height: opts.height,
          aspect: opts.aspect,
          seed: opts.seed ?? undefined,
        }),
        signal,
      });

      if (res.ok) {
        const blob = await res.blob();
        let actualWidth = opts.width;
        let actualHeight = opts.height;
        try {
          const bmp = await createImageBitmap(blob);
          actualWidth = bmp.width;
          actualHeight = bmp.height;
          bmp.close?.();
        } catch { /* fall back to the requested size */ }

        const record = {
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          createdAt: Date.now(),
          basePrompt: opts.basePrompt,
          prompt: opts.prompt,
          styleLabel: opts.styleLabel,
          provider: opts.provider,
          model: opts.model || "default",
          width: opts.width,
          height: opts.height,
          actualWidth,
          actualHeight,
          seed: opts.seed ?? (Number(res.headers.get("X-Seed")) || null),
          durationMs: Math.round(performance.now() - started),
          favorite: false,
          blob,
        };

        await store.put(record);
        state.records.unshift(record);
        renderGallery();
        showRecord(record);
        toast("Image generated");
        return;
      }

      const data = await res.json().catch(() => ({}));
      lastError = data.error || `Server responded with ${res.status}`;
      const retryAfter = Number(data.retryAfterSeconds) || 0;

      // Key engine has no image quota: hide it and continue on the free engine.
      if (data.quotaBlocked && opts.provider !== "pollinations" && !fellBackToFree) {
        fellBackToFree = true;
        markProviderUnavailable(opts.provider);
        state.provider = "pollinations";
        $("#provider").value = "pollinations";
        populateModels();
        updateBadge();
        updateEngineNotes();
        opts = { ...opts, provider: "pollinations", model: $("#model").value };
        toast("That key engine has no image quota yet, so this image is being generated on the free engine.");
        attempt = 0;
        continue;
      }

      const transient = (res.status === 429 || res.status === 503) && retryAfter > 0;
      if (attempt < MAX_ATTEMPTS) {
        await waitToRetry(transient ? retryAfter : Math.min(10 + attempt * 5, 30), attempt + 1, MAX_ATTEMPTS, signal);
        continue;
      }
      break;
    }

    $("#error-text").textContent = `${lastError} The limit should clear shortly; press Try again.`;
    showState("error");
    toast("Temporary limit reached. Try again shortly.", true);
  } catch (err) {
    if (err.name === "AbortError") {
      showState(state.current ? "result" : "empty");
      toast("Generation cancelled");
    } else {
      $("#error-text").textContent = err.message;
      showState("error");
      toast(err.message, true);
    }
  } finally {
    stopTicker();
    state.controller = null;
    $("#generate").disabled = false;
  }
}

function cancelGeneration() {
  state.controller?.abort();
}

/* --------------------------------- viewer --------------------------------- */

function showRecord(record) {
  state.current = record;
  if (state.resultUrl) URL.revokeObjectURL(state.resultUrl);
  state.resultUrl = URL.createObjectURL(record.blob);

  const img = $("#result-img");
  img.src = state.resultUrl;
  img.alt = record.prompt;

  $("#result-prompt").textContent = record.prompt;

  const meta = $("#result-meta");
  meta.innerHTML = "";
  const engine = record.provider === "pollinations" ? "free engine" : "key engine";
  const chips = [record.model, `${record.actualWidth || record.width}x${record.actualHeight || record.height}`];
  if (record.provider !== "openai") {
    chips.push(`seed ${record.seed ?? "random"}`);
  }
  chips.push(record.styleLabel, engine);
  if (record.durationMs) chips.push(`${(record.durationMs / 1000).toFixed(1)}s`);
  for (const chip of chips) {
    const span = document.createElement("span");
    span.textContent = chip;
    meta.appendChild(span);
  }

  const dl = $("#act-download");
  dl.href = state.resultUrl;
  dl.download = `dreamframe-${record.seed ?? record.id}.jpg`;

  showState("result");
  document.querySelectorAll(".card").forEach((c) => {
    c.classList.toggle("is-current", c.dataset.id === record.id);
  });
}

/* -------------------------------- gallery --------------------------------- */

function renderGallery() {
  const grid = $("#gallery-grid");
  grid.innerHTML = "";

  const list = state.filter === "favorites"
    ? state.records.filter((r) => r.favorite)
    : state.records;

  $("#gallery-count").textContent = String(state.records.length);
  $("#gallery-empty").classList.toggle("hidden", list.length > 0);
  $("#gallery-empty").querySelector("p").textContent = state.filter === "favorites" && !list.length
    ? "Nothing marked as a favorite yet. Use the star on a card to keep it here."
    : "Images you generate are saved here in this browser.";

  for (const rec of list) {
    grid.appendChild(cardFor(rec));
  }
}

function cardFor(rec) {
  const card = document.createElement("article");
  card.className = "card";
  card.dataset.id = rec.id;
  if (state.current?.id === rec.id) card.classList.add("is-current");

  const img = document.createElement("img");
  img.src = URL.createObjectURL(rec.blob);
  img.alt = rec.prompt;
  img.loading = "lazy";
  img.onload = () => URL.revokeObjectURL(img.src);
  card.appendChild(img);

  const caption = document.createElement("div");
  caption.className = "card-prompt";
  caption.textContent = rec.prompt;
  card.appendChild(caption);

  const actions = document.createElement("div");
  actions.className = "card-actions";

  const fav = document.createElement("button");
  fav.type = "button";
  fav.innerHTML = starIcon(rec.favorite);
  fav.title = rec.favorite ? "Remove from favorites" : "Add to favorites";
  fav.setAttribute("aria-label", fav.title);
  fav.classList.toggle("is-fav", rec.favorite);
  fav.addEventListener("click", async (e) => {
    e.stopPropagation();
    rec.favorite = !rec.favorite;
    fav.innerHTML = starIcon(rec.favorite);
    await store.patch(rec.id, { favorite: rec.favorite });
    renderGallery();
  });

  const del = document.createElement("button");
  del.type = "button";
  del.innerHTML = TRASH_ICON;
  del.title = "Delete from gallery";
  del.setAttribute("aria-label", "Delete from gallery");
  del.addEventListener("click", async (e) => {
    e.stopPropagation();
    await store.remove(rec.id);
    state.records = state.records.filter((r) => r.id !== rec.id);
    if (state.current?.id === rec.id) {
      state.current = null;
      showState("empty");
    }
    renderGallery();
    toast("Removed from gallery");
  });

  actions.append(fav, del);
  card.appendChild(actions);

  card.addEventListener("click", () => showRecord(rec));
  return card;
}

/* ---------------------------------- wiring -------------------------------- */

function randomSeed() {
  $("#seed").value = String(Math.floor(Math.random() * 900_000_000) + 100_000_000);
}

function wireEvents() {
  const promptEl = $("#prompt");
  promptEl.addEventListener("input", () => {
    $("#char-count").textContent = String(promptEl.value.length);
  });

  $("#style-chips").addEventListener("click", (e) => {
    const chip = e.target.closest(".chip");
    if (!chip) return;
    document.querySelectorAll(".chip").forEach((c) => c.classList.remove("is-active"));
    chip.classList.add("is-active");
  });

  $("#aspect-group").addEventListener("click", (e) => {
    const seg = e.target.closest(".seg");
    if (!seg) return;
    document.querySelectorAll(".seg").forEach((s) => s.classList.remove("is-active"));
    seg.classList.add("is-active");
    state.aspect = seg.dataset.ratio;
  });

  $("#provider").addEventListener("change", (e) => {
    state.provider = e.target.value;
    populateModels();
    updateBadge();
    updateEngineNotes();
  });

  $("#seed-roll").addEventListener("click", randomSeed);

  $("#example")?.addEventListener("click", () => {
    const current = $("#prompt").value.trim();
    let pick = EXAMPLE_PROMPTS[Math.floor(Math.random() * EXAMPLE_PROMPTS.length)];
    if (pick === current) {
      pick = EXAMPLE_PROMPTS[(EXAMPLE_PROMPTS.indexOf(pick) + 1) % EXAMPLE_PROMPTS.length];
    }
    $("#prompt").value = pick;
    $("#char-count").textContent = String(pick.length);
    $("#prompt").focus();
  });

  $("#generate").addEventListener("click", () => generate(collectOptions()));
  $("#cancel").addEventListener("click", cancelGeneration);
  $("#retry").addEventListener("click", () => generate(collectOptions()));

  $("#act-variation").addEventListener("click", () => {
    const cur = state.current;
    if (!cur) return;
    generate(collectOptions({
      basePrompt: cur.basePrompt || cur.prompt,
      prompt: cur.prompt,
      styleLabel: cur.styleLabel,
      provider: cur.provider,
      model: cur.model === "default" ? "" : cur.model,
      width: cur.width,
      height: cur.height,
      seed: null,
    }));
  });

  $("#act-copy").addEventListener("click", async () => {
    if (!state.current) return;
    try {
      await navigator.clipboard.writeText(state.current.prompt);
      toast("Prompt copied");
    } catch {
      toast("Could not copy (clipboard blocked)", true);
    }
  });

  document.querySelector(".tabs").addEventListener("click", (e) => {
    const tab = e.target.closest(".tab");
    if (!tab) return;
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("is-active"));
    tab.classList.add("is-active");
    state.filter = tab.dataset.filter;
    renderGallery();
  });

  promptEl.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") generate(collectOptions());
  });
}

/* ---------------------------------- init ---------------------------------- */

async function init() {
  wireEvents();
  await loadConfig();
  state.records = (await store.all()).sort((a, b) => b.createdAt - a.createdAt);
  renderGallery();
}

init();
