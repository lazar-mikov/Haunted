// ——— basic UI hooks ———
const film = document.getElementById("film");
const statusBox = document.getElementById("status");
const unmuteBtn = document.getElementById("unmute");
const restartBtn = document.getElementById("restart");

// Add this near the top with your other variable declarations
let lightsConfigured = false;

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
  { t: 8,  event: "blackon" }, // 8 seconds: Red Flash
  { t: 12, event: "blackout" }   // 12 seconds: Blackout
];

// ——— convert to ms + normalize to the enum effects ———
const cues = schedule.map(c => {
  return { t: c.t * 1000, effect: c.event, fired: false, src: "video_cue" };
});

// ——— fire a cue slightly EARLY to account for cloud/Alexa latency ———
const EARLY_MS = 1200;

// Setup lights function - FIXED and moved outside fireEffect
async function setupLights() {
  try {
    const lightStatusElement = document.getElementById('light-status');
    if (lightStatusElement) {
      lightStatusElement.textContent = 'FINDING LIGHTS...';
      lightStatusElement.style.color = '#FFA500';
    }
    
    // Use the instant discovery endpoint
    const response = await fetch('/api/lights/instant-discover', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include'
    });
    const data = await response.json();
    
    if (data.success && data.lightsFound > 0) {
      lightsConfigured = true;
      if (lightStatusElement) {
        lightStatusElement.textContent = `${data.lightsFound} LIGHTS READY`;
        lightStatusElement.style.color = '#4CAF50';
      }
      console.log(`✅ Found ${data.lightsFound} lights!`, data.lights);
      
      // Auto-test the lights with a quick flash
      setTimeout(() => {
        fetch('/api/lights/test', {
          method: 'POST',
          credentials: 'include'
        });
      }, 500);
    } else {
      lightsConfigured = false;
      if (lightStatusElement) {
        lightStatusElement.textContent = 'NO LIGHTS FOUND';
        lightStatusElement.style.color = '#888';
      }
      console.log('No lights found on network');
    }
  } catch (error) {
    console.error('Error setting up lights:', error);
    lightsConfigured = false;
    const lightStatusElement = document.getElementById('light-status');
    if (lightStatusElement) {
      lightStatusElement.textContent = 'LIGHT CONNECTION ERROR';
      lightStatusElement.style.color = '#FF0000';
    }
  }
}

async function fireEffect(effect, extraPayload) {
  try {
    console.log(`🎬 Firing effect: ${effect}`);
    
    // Call your backend which has the working IFTTT connections
    const response = await fetch("/api/trigger", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ effect, payload: extraPayload || {} })
    });
    
    const data = await response.json();
    
    if (data.ok) {
      if (statusBox) statusBox.textContent = `effect: ${effect} → ${data.via}`;
      console.log("Effect triggered successfully:", effect, data);
    } else {
      throw new Error(data.error || "Effect failed");
    }
    
  } catch (e) {
    if (statusBox) statusBox.textContent = `effect: ${effect} → ERROR`;
    console.error("Effect error:", e);
  }
}

// Quick test functions for console
window.testEffect = async (effect = "blackout") => {
  console.log(`Testing ${effect} effect...`);
  await fireEffect(effect, { origin: "manual_test" });
};

window.lightStatus = async () => {
  try {
    const response = await fetch('/api/lights/status', { credentials: 'include' });
    const data = await response.json();
    console.log("Light status:", data);
    return data;
  } catch (error) {
    console.error("Failed to get light status:", error);
  }
};

// Check if user has Alexa connected
async function checkAlexaConnection() {
  try {
    const response = await fetch("/api/alexa/status", {
      credentials: "include"
    });
    const data = await response.json();
    window.hasAlexaConnected = data.connected;
    return data.connected;
  } catch (error) {
    console.log("No Alexa connection detected");
    window.hasAlexaConnected = false;
    return false;
  }
}

// Alexa connection management
async function connectAlexa() {
  try {
    const response = await fetch('/api/alexa/connect');
    const data = await response.json();
    window.location.href = data.url;
  } catch (error) {
    console.error('Failed to get Alexa connection URL:', error);
    alert('Failed to connect to Alexa: ' + error.message);
  }
}

async function disconnectAlexa() {
  try {
    const response = await fetch('/api/alexa/disconnect', {
      method: 'POST',
      credentials: 'include'
    });
    const data = await response.json();
    window.hasAlexaConnected = false;
    updateAlexaStatus();
    alert('Alexa disconnected successfully');
  } catch (error) {
    console.error('Failed to disconnect Alexa:', error);
  }
}

function updateAlexaStatus() {
  const statusElement = document.getElementById('alexa-status');
  if (statusElement) {
    statusElement.textContent = window.hasAlexaConnected ? 'ALEXA CONNECTED' : 'ALEXA NOT CONNECTED';
    statusElement.style.color = window.hasAlexaConnected ? '#4CAF50' : '#888';
    
    // Add reconnect button if not connected
    if (!window.hasAlexaConnected && !document.getElementById('alexa-reconnect')) {
      const reconnectBtn = document.createElement('button');
      reconnectBtn.id = 'alexa-reconnect';
      reconnectBtn.textContent = 'Connect Alexa';
      reconnectBtn.style.marginLeft = '10px';
      reconnectBtn.style.padding = '2px 8px';
      reconnectBtn.style.fontSize = '12px';
      reconnectBtn.onclick = connectAlexa;
      statusElement.parentNode.appendChild(reconnectBtn);
    }
    
    // Remove reconnect button if connected
    if (window.hasAlexaConnected) {
      const reconnectBtn = document.getElementById('alexa-reconnect');
      if (reconnectBtn) {
        reconnectBtn.remove();
      }
    }
  }
}

// Update the status check interval
setInterval(async () => {
  await checkAlexaConnection();
  updateAlexaStatus();
}, 5000);

// Expose functions to global scope
window.connectAlexa = connectAlexa;
window.disconnectAlexa = disconnectAlexa;
window.checkAlexaConnection = checkAlexaConnection;
window.updateAlexaStatus = updateAlexaStatus;
window.setupLights = setupLights;

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

// ——— Check connections when page loads ———
document.addEventListener('DOMContentLoaded', () => {
  checkAlexaConnection().then(updateAlexaStatus);
  
  // Auto-setup lights when page loads
  setupLights();
  
  // Add Alexa status indicator to UI
  if (statusBox) {
    const alexaStatus = document.createElement('span');
    alexaStatus.id = 'alexa-status';
    alexaStatus.style.marginLeft = '10px';
    alexaStatus.style.color = '#888';
    alexaStatus.textContent = 'Checking Alexa...';
    statusBox.parentNode.appendChild(alexaStatus);
    
    // Add light status indicator
    const lightStatus = document.createElement('span');
    lightStatus.id = 'light-status';
    lightStatus.style.marginLeft = '10px';
    lightStatus.style.color = '#888';
    lightStatus.textContent = 'FINDING LIGHTS...';
    statusBox.parentNode.appendChild(lightStatus);
  }
});

// ——— Alexa test function ———
window.testAlexa = async (effect = "blackout") => {
  try {
    const response = await fetch("/api/alexa/trigger", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ effect, origin: "manual_test" })
    });
    const data = await response.json();
    console.log("Alexa test result:", data);
    alert(`Alexa test: ${data.success ? 'SUCCESS' : 'FAILED'}\n${data.message || ''}`);
    return data;
  } catch (error) {
    console.error("Alexa test error:", error);
    alert("Alexa test failed: " + error.message);
  }
};