// Simple page state from query

// public/app.js — runs in the browser

// ——— basic UI hooks ———
const film = document.getElementById("film");
const statusBox = document.getElementById("status");
const unmuteBtn = document.getElementById("unmute");
const restartBtn = document.getElementById("restart");

// ——— autoplay if we arrived from /connect?state=/watch?autoplay=1 ———
const params = new URLSearchParams(location.search);
const shouldAutoplay = params.get("autoplay") === "1";
if (shouldAutoplay && film) {
  film.addEventListener("loadedmetadata", async () => {
    try { await film.play(); } catch {}
  });
}

// ——— map YOUR labels -> IFTTT Action enum values ———
// Your service Action supports: blackout | flash_red | plug_on | reset
const EFFECT_MAP = {
  lights_flicker: "blackout",
  lights_red:     "flash_red",
  plug_fan_on:    "plug_on",
  plug_fan_off:   "reset",
  whisper_sound:  "flash_red" // or delete this line if you don't want a cue here
};

// ——— define cue times ———
// Option A: use your earlier seconds-based schedule:
const schedule = [
  { t: 5,  event: "lights_flicker" },
  { t: 12, event: "plug_fan_on"    },
  { t: 22, event: "lights_red"     },
  { t: 27, event: "whisper_sound"  },
  { t: 35, event: "plug_fan_off"   }
];

// If you prefer the other list, replace the above with:
// const schedule = [
//   { t: 15, effect: "blackout"  },
//   { t: 22.5, effect: "flash_red" },
//   { t: 36, effect: "plug_on"   },
//   { t: 45, effect: "reset"     }
// ];


// ——— convert to ms + normalize to the enum effects ———
const cues = schedule.map(c => {
  const effect = c.effect || EFFECT_MAP[c.event];
  return effect ? { t: c.t * 1000, effect, fired: false, src: c.event || effect } : null;
}).filter(Boolean);

// ——— fire a cue slightly EARLY to account for cloud/Alexa latency ———
const EARLY_MS = 1200; // start here; tweak during dress rehearsal

async function fireEffect(effect, extraPayload) {
  try {
    const r = await fetch("/api/trigger", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event: effect, payload: extraPayload || {} })
    });
    const j = await r.json();
    if (!j.ok) throw new Error(j.error || "Trigger failed");
    if (statusBox) statusBox.textContent = `effect: ${effect} → ${j.via}`;
    console.log("Triggered:", effect, j.via);
  } catch (e) {
    if (statusBox) statusBox.textContent = `effect: ${effect} → ERROR`;
    console.error(e);
    alert("Trigger failed: " + e.message);
  }
}

// ——— high-precision scheduler using requestAnimationFrame ———
if (film) {
  let rafId = null;

  function tick() {
    const nowMs = film.currentTime * 1000;
    for (const c of cues) {
      if (!c.fired && nowMs >= (c.t - EARLY_MS)) {
        c.fired = true;
        fireEffect(c.effect, { origin: "video", at_ms: Math.round(nowMs), src: c.src });
      }
    }
    rafId = requestAnimationFrame(tick);
  }

  film.addEventListener("play", () => {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(tick);
  });

  film.addEventListener("pause", () => {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = null;
  });

  film.addEventListener("seeking", () => {
    const nowMs = film.currentTime * 1000;
    // Allow re-firing for cues still in the future after seek
    for (const c of cues) c.fired = nowMs >= (c.t - EARLY_MS);
  });

  film.addEventListener("ended", () => {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = null;
  });
}

// ——— small UI niceties ———
if (unmuteBtn && film) {
  unmuteBtn.onclick = () => { film.muted = false; film.volume = 1.0; };
}
if (restartBtn && film) {
  restartBtn.onclick = () => {
    for (const c of cues) c.fired = false;
    film.currentTime = 0;
    film.play().catch(()=>{});
  };
}
