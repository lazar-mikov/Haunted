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

// ——— define cue times ———
const schedule = [
  { t: 5,  event: "blackout" },  // 5 seconds: Blackout
   { t: 8,  event: "flash_red" },
  { t: 12, event: "blackout" }   // 12 seconds: Blackout
];

// ——— convert to ms + normalize to the enum effects ———
const cues = schedule.map(c => {
  return { t: c.t * 1000, effect: c.event, fired: false, src: "video_cue" };
});

// ——— fire a cue slightly EARLY to account for cloud/Alexa latency ———
const EARLY_MS = 1200;

async function fireEffect(effect, extraPayload) {
  try {
    const r = await fetch("/api/trigger", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ effect, payload: extraPayload || {} })
    });
    const j = await r.json();
    if (!j.ok) throw new Error(j.error || "Trigger failed");
    if (statusBox) statusBox.textContent = `effect: ${effect} → ${j.via}`;
    console.log("Triggered:", effect, j.via, j);
  } catch (e) {
    if (statusBox) statusBox.textContent = `effect: ${effect} → ERROR`;
    console.error(e);
    alert("Trigger failed: " + e.message);
  }
}

// Expose a manual tester in console
window.fx = (name) => fireEffect(name, { origin: "manual" });

// ——— high-precision scheduler using requestAnimationFrame ———
if (film) {
  let rafId = null;

  function tick() {
    const nowMs = film.currentTime * 1000;
    for (const c of cues) {
      if (!c.fired && nowMs >= (c.t - EARLY_MS)) {
        c.fired = true;
        fireEffect(c.effect, { 
          origin: "video", 
          at_ms: Math.round(nowMs), 
          cue_time: c.t / 1000,
          src: c.src 
        });
        console.log(`🎬 Triggered ${c.effect} at ${c.t/1000}s (video time: ${nowMs/1000}s)`);
      }
    }
    rafId = requestAnimationFrame(tick);
  }

  film.addEventListener("play", () => {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(tick);
    console.log("Video started - cue system active");
  });

  film.addEventListener("pause", () => {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = null;
  });

  film.addEventListener("seeking", () => {
    const nowMs = film.currentTime * 1000;
    for (const c of cues) {
      c.fired = nowMs >= (c.t - EARLY_MS);
    }
  });

  film.addEventListener("ended", () => {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = null;
    // Reset cues for replay
    for (const c of cues) c.fired = false;
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