import express from "express";
import axios from "axios";
import cookieSession from "cookie-session";
import dotenv from "dotenv";
dotenv.config();

const app = express();
app.use(express.json());
app.use(cookieSession({
  name: "sess",
  secret: process.env.SESSION_SECRET || "haunted",
  httpOnly: true,
  sameSite: "lax"
}));

// Serve static frontend
app.use(express.static("public"));

/** ---------- OAuth (IFTTT Connect shell for future) ---------- */
app.get("/auth/ifttt/start", (req, res) => {
  const state = Math.random().toString(36).slice(2);
  req.session.state = state;
  const url = `${process.env.IFTTT_AUTH_URL
    }?client_id=${encodeURIComponent(process.env.IFTTT_CLIENT_ID)
    }&redirect_uri=${encodeURIComponent(process.env.IFTTT_REDIRECT_URI)
    }&response_type=code&scope=${encodeURIComponent("triggers:write")
    }&state=${state}`;
  res.redirect(url);
});

app.get("/auth/ifttt/callback", async (req, res) => {
  const { code, state } = req.query;
  if (!code || state !== req.session.state) return res.status(400).send("Invalid state");
  try {
    const tokenResp = await axios.post(process.env.IFTTT_TOKEN_URL, {
      grant_type: "authorization_code",
      code,
      redirect_uri: process.env.IFTTT_REDIRECT_URI,
      client_id: process.env.IFTTT_CLIENT_ID,
      client_secret: process.env.IFTTT_CLIENT_SECRET
    }, { headers: { "Content-Type": "application/json" } });

    req.session.ifttt = {
      access_token: tokenResp.data.access_token,
      refresh_token: tokenResp.data.refresh_token,
      expires_in: tokenResp.data.expires_in
    };
    res.redirect("/?authed=1");
  } catch (e) {
    console.error("OAuth error:", e?.response?.data || e.message);
    res.status(500).send("OAuth error");
  }
});

/** ---------- Demo helpers (IFTTT Webhooks) ---------- */
app.post("/api/demo/maker-key", (req, res) => {
  const chunks = [];
  req.on("data", c => chunks.push(c));
  req.on("end", () => {
    try {
      const { makerKey } = JSON.parse(Buffer.concat(chunks).toString());
      if (!makerKey) return res.status(400).json({ ok: false, error: "makerKey required" });
      req.session.makerKey = makerKey.trim();
      res.json({ ok: true });
    } catch {
      res.status(400).json({ ok: false, error: "bad json" });
    }
  });
});

/** ---------- Trigger endpoint (called by the video dispatcher) ---------- */
app.post("/api/trigger", async (req, res) => {
  const chunks = [];
  req.on("data", c => chunks.push(c));
  req.on("end", async () => {
    try {
      const { event, payload } = JSON.parse(Buffer.concat(chunks).toString());
      if (!event) return res.status(400).json({ ok: false, error: "missing event" });

      // OPTION A (future): use IFTTT Connect access_token here
      if (process.env.IFTTT_CONNECT_ACTION_URL && req.session.ifttt?.access_token) {
        await axios.post(process.env.IFTTT_CONNECT_ACTION_URL, { event, payload }, {
          headers: { Authorization: `Bearer ${req.session.ifttt.access_token}` },
          timeout: 5000
        });
        return res.json({ ok: true, via: "ifttt-connect" });
      }

      // OPTION B (now): classic IFTTT Webhooks (fastest to demo)
      if (!req.session.makerKey) {
        return res.status(400).json({ ok: false, error: "No Maker key (demo mode). Paste it on Page 1." });
      }
      const url = `https://maker.ifttt.com/trigger/${encodeURIComponent(event)}/json/with/key/${req.session.makerKey}`;
      await axios.post(url, payload || {}, { timeout: 4000 });

      res.json({ ok: true, via: "webhooks" });
    } catch (e) {
      console.error("Trigger error:", e?.response?.data || e.message);
      res.status(500).json({ ok: false, error: "Trigger failed" });
    }
  });
});

/** ---------- Kill switch ---------- */
app.post("/api/kill", (req, res) => {
  req.session = null;
  res.json({ ok: true });
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Haunted demo running at http://localhost:${port}`));
