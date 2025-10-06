


// ——— autoplay if we arrived from /connect?state=/watch?autoplay=1 ———
const params = new URLSearchParams(location.search);
const shouldAutoplay = params.get("autoplay") === "1";
if (shouldAutoplay && mainVideo) {
  mainVideo.addEventListener("loadedmetadata", async () => {
    try { await mainVideo.play(); } catch {}
  });
}

// ——— define cue times ———
const schedule = [
  // Flicker sequence at 5 seconds (cleaned up duplicates)
 // First flicker at 8s (3 times)
  { t: 8.0, event: "haunted-on" },
  { t: 8.5, event: "haunted-off" },
  { t: 9.5, event: "haunted-on" },
  { t: 10.0, event: "haunted-off" },
  { t: 11.0, event: "haunted-on" },
  { t: 11.5, event: "haunted-off" },
  
  // Second flicker at 36s (1 slow flicker)
  { t: 36.0, event: "haunted-on" },
  { t: 37.0, event: "haunted-off" },
  
  // Third flicker at 1:16 (76s) - 4 times
  { t: 76.0, event: "haunted-on" },
  { t: 76.5, event: "haunted-off" },
  { t: 77.5, event: "haunted-on" },
  { t: 78.0, event: "haunted-off" },
  { t: 79.0, event: "haunted-on" },
  { t: 79.5, event: "haunted-off" },
  { t: 80.5, event: "haunted-on" },
  { t: 81.0, event: "haunted-off" },
  
  // Fourth flicker at 1:30 (90s) - on 2s, off, on 2s
  { t: 90.0, event: "haunted-on" },
  { t: 92.0, event: "haunted-off" },
  { t: 92.5, event: "haunted-on" },
  { t: 94.5, event: "haunted-off" },
  
  // At 3:23 (203s) - lights on, then red
  { t: 203.0, event: "haunted-on" },
  { t: 205.5, event: "flash-red" },
  
  // At 4:22 (262s) - 5 slow flashes
  { t: 262.0, event: "haunted-on" },
  { t: 263.0, event: "haunted-off" },
  { t: 264.0, event: "haunted-on" },
  { t: 265.0, event: "haunted-off" },
  { t: 266.0, event: "haunted-on" },
  { t: 267.0, event: "haunted-off" },
  { t: 268.0, event: "haunted-on" },
  { t: 269.0, event: "haunted-off" },
  { t: 270.0, event: "haunted-on" },
  { t: 271.0, event: "haunted-off" }
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
    console.log(`⏰ Time: ${new Date().toISOString()}`);
    
    const response = await fetch("/api/trigger-direct", {
      method: "POST", 
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ effect })
    });
    
    console.log(`📡 Response status: ${response.status}`);
    const data = await response.json();
    console.log(`📦 Response data:`, data);
    
    if (data.success) {
      console.log(`✅ Effect triggered successfully:`, data);
    } else {
      console.error(`❌ Effect failed:`, data);
    }
    
  } catch (e) {
    console.error(`❌ Effect error for ${effect}:`, e);
    console.error(`❌ Error stack:`, e.stack);
  }
}

// Console test function
window.testEffect = async (effect = "haunted-off") => {
  console.log(`🧪 Testing ${effect} effect...`);
  await fireEffect(effect);
};

// ——— high-precision scheduler using requestAnimationFrame ———
if (mainVideo) {
  let rafId = null;

  function tick() {
    const nowMs = mainVideo.currentTime * 1000;
    for (const c of cues) {
      if (!c.fired && nowMs >= (c.t - EARLY_MS)) {
        c.fired = true;
        console.log(`⚡ CUE FIRED: ${c.effect} at ${c.t/1000}s (actual video time: ${nowMs/1000}s)`);
        fireEffect(c.effect);
      }
    }
    rafId = requestAnimationFrame(tick);
  }

  mainVideo.addEventListener("play", () => {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(tick);
    console.log("▶️ Video started - cue system active");
    console.log(`📋 Total cues loaded: ${cues.length}`);
    console.log(`📋 Cue schedule:`, cues.map(c => `${c.t/1000}s: ${c.effect}`));
  });

  mainVideo.addEventListener("pause", () => {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = null;
    console.log("⏸️ Video paused - cue system paused");
  });

  mainVideo.addEventListener("seeking", () => {
    const nowMs = mainVideo.currentTime * 1000;
    console.log(`⏩ Seeking to ${nowMs/1000}s`);
    for (const c of cues) {
      c.fired = nowMs >= (c.t - EARLY_MS);
    }
    console.log(`🔄 Cues reset based on seek position`);
  });

  mainVideo.addEventListener("ended", () => {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = null;
    for (const c of cues) c.fired = false;
    console.log("⏹️ Video ended - all cues reset");
  });

  console.log("✅ Video element found and cue system initialized");
} else {
  console.error("❌ mainVideo element not found!");
}

// ——— UI buttons ———
if (unmuteBtn && mainVideo) {
  unmuteBtn.onclick = () => { 
    mainVideo.muted = false; 
    mainVideo.volume = 1.0;
    console.log("🔊 Video unmuted");
  };
  console.log("✅ Unmute button initialized");
} else {
  console.error("❌ Unmute button or video not found");
}

if (restartBtn && mainVideo) {
  restartBtn.onclick = () => {
    for (const c of cues) c.fired = false;
    mainVideo.currentTime = 0;
    mainVideo.play().catch(()=>{});
    console.log("↻ Video restarted - all cues reset");
  };
  console.log("✅ Restart button initialized");
} else {
  console.error("❌ Restart button or video not found");
}

console.log("🎃 Haunted app.js loaded successfully");