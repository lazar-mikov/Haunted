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
  { t: 5,  event: "haunted-off" },   // Lights off (blackout)
  { t: 8,  event: "haunted-on" },    // Lights back on
  { t: 12, event: "flash-red" },     // Red flash effect
  { t: 15, event: "haunted-on" }     // Lights on again
];

// ——— convert to ms ———
const cues = schedule.map(c => {
  return { t: c.t * 1000, effect: c.event, fired: false };
});

// ——— fire slightly early for latency ———
const EARLY_MS = 1200;

async function fireEffect(effect) {
  try {
    console.log(`🎬 Firing effect: ${effect}`);
    
    const response = await fetch("/api/trigger-direct", {
      method: "POST", 
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ effect })
    });
    
    const data = await response.json();
    
    if (data.success) {
      if (statusBox) statusBox.textContent = `✅ ${effect} triggered`;
      console.log("✅ Effect triggered:", data);
    } else {
      if (statusBox) statusBox.textContent = `❌ ${effect} failed`;
      console.error("❌ Effect failed:", data);
    }
    
  } catch (e) {
    if (statusBox) statusBox.textContent = `❌ ${effect} error`;
    console.error("❌ Effect error:", e);
  }
}

// Console test function
window.testEffect = async (effect = "haunted-off") => {
  console.log(`Testing ${effect} effect...`);
  await fireEffect(effect);
};

// ——— high-precision scheduler using requestAnimationFrame ———
if (film) {
  let rafId = null;

  function tick() {
    const nowMs = film.currentTime * 1000;
    for (const c of cues) {
      if (!c.fired && nowMs >= (c.t - EARLY_MS)) {
        c.fired = true;
        fireEffect(c.effect);
        console.log(`🎬 Triggered ${c.effect} at ${c.t/1000}s (actual: ${nowMs/1000}s)`);
      }
    }
    rafId = requestAnimationFrame(tick);
  }

  film.addEventListener("play", () => {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(tick);
    console.log("▶️ Video started - cue system active");
  });

  film.addEventListener("pause", () => {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = null;
    console.log("⏸️ Video paused - cue system paused");
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
    for (const c of cues) c.fired = false;
    console.log("⏹️ Video ended - cues reset");
  });
}

// ——— UI buttons ———
if (unmuteBtn && film) {
  unmuteBtn.onclick = () => { 
    film.muted = false; 
    film.volume = 1.0; 
  };
}

if (restartBtn && film) {
  restartBtn.onclick = () => {
    for (const c of cues) c.fired = false;
    film.currentTime = 0;
    film.play().catch(()=>{});
  };
}