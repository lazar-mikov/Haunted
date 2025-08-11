// Simple page state from query

import express from "express";
import dotenv from "dotenv";
const params = new URLSearchParams(location.search);
const authed = params.get("authed") === "1";

const page1 = document.getElementById("page1");
const page2 = document.getElementById("page2");
const page3 = document.getElementById("page3");

dotenv.config();
const app = express();
app.use(express.json());

// Test endpoint for IFTTT
app.post("/ifttt-trigger", (req, res) => {
  console.log("Trigger received:", req.body);
  // For now just confirm receipt
  res.json({ success: true, message: "IFTTT trigger received" });
});

// Root endpoint to confirm the app works
app.get("/", (req, res) => {
  res.send("HUNTED Demo Server is running!");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

// If OAuth completed, show test + player
if (authed) {
  page1.style.display = "none";
  page2.style.display = "block";
  page3.style.display = "block";
}

document.getElementById("saveMakerKey").onclick = async () => {
  const makerKey = document.getElementById("makerKey").value.trim();
  if (!makerKey) return alert("Paste your Maker key from IFTTT Webhooks.");
  const r = await fetch("/api/demo/maker-key", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ makerKey })
  });
  const j = await r.json();
  if (j.ok) {
    page2.style.display = "block";
    page3.style.display = "block";
    alert("Saved. Try the test buttons.");
  } else {
    alert(j.error || "Could not save key.");
  }
};

document.getElementById("killBtn").onclick = async () => {
  await fetch("/api/kill", { method: "POST" });
  location.href = "/";
};

// Wire quick test buttons
page2.querySelectorAll("button[data-evt]").forEach(btn => {
  btn.onclick = () => fireEvent(btn.dataset.evt, { origin: "test" });
});

// ---- VIDEO TRIGGER DISPATCHER ----
const film = document.getElementById("film");
// Example schedule (seconds → event)
const schedule = [
  { t: 5,   event: "lights_flicker" },
  { t: 12,  event: "plug_fan_on" },
  { t: 22,  event: "lights_red" },
  { t: 27,  event: "whisper_sound" },
  { t: 35,  event: "plug_fan_off" }
];

const fired = new Set();
let poll;

film.addEventListener("play", () => {
  clearInterval(poll);
  poll = setInterval(() => {
    const now = Math.floor(film.currentTime);
    for (const tr of schedule) {
      if (tr.t === now && !fired.has(tr.t)) {
        fired.add(tr.t);
        fireEvent(tr.event, { origin: "video", at: now });
      }
    }
  }, 500);
});

film.addEventListener("pause", () => clearInterval(poll));
film.addEventListener("seeking", () => fired.clear());
film.addEventListener("ended", () => clearInterval(poll));

// Fire trigger to backend
async function fireEvent(event, payload) {
  try {
    const r = await fetch("/api/trigger", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event, payload })
    });
    const j = await r.json();
    if (!j.ok) throw new Error(j.error || "Trigger failed");
    console.log("Triggered:", event, payload, j.via);
  } catch (e) {
    console.error(e);
    alert("Trigger failed: " + e.message);
  }
}
