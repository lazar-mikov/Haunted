import express from "express";
import axios from "axios";
import cookieSession from "cookie-session";
import dotenv from "dotenv";
import crypto from "crypto";



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


// === IFTTT minimal OAuth & endpoints (safe to paste once) ===
// Place this after you have: import express from "express"; const app = express();

(() => {
  if (!app || !app.locals) return;                 // requires your existing `app`
  if (app.locals.__iftttWired) return;             // prevent double-registration
  app.locals.__iftttWired = true;

  // In-memory stores (fine for demo; replace with Redis/DB later)
  const authCodes = new Map();   // code -> { userId, createdAt }
  const tokens    = new Map();   // accessToken -> { userId, createdAt }

  // 1) Health check (IFTTT pings this)
  app.get("/ifttt/v1/status", (req, res) => {
    const got =
      req.get("IFTTT-Service-Key") ||
      req.get("IFTTT-Channel-Key") ||
      req.get("ifttt-service-key") ||
      req.get("ifttt-channel-key");

    if (!got || got !== process.env.IFTTT_SERVICE_KEY) {
      return res.status(401).json({ errors: [{ message: "invalid channel key" }] });
    }
    return res.status(200).json({});
  });

  // 1b) Test setup (IFTTT calls this during Endpoint tests)
  app.post("/ifttt/v1/test/setup", (req, res) => {
    const got =
      req.get("IFTTT-Service-Key") ||
      req.get("IFTTT-Channel-Key") ||
      req.get("ifttt-service-key") ||
      req.get("ifttt-channel-key");

    if (!got || got !== process.env.IFTTT_SERVICE_KEY) {
      return res.status(401).json({ errors: [{ message: "invalid channel key" }] });
    }

    // Create a test access token for the demo user so /user/info will pass
    const access_token = Math.random().toString(36).slice(2) + Date.now().toString(36);
    tokens.set(access_token, { userId: "demo-user-001", createdAt: Date.now() });

    // Minimal valid payload for IFTTT Endpoint tests
    return res.status(200).json({
      data: {
        accessToken: access_token,
        samples: {
          actions: {},
          triggers: {}
        }
      }
    });
  });

  // 2) Who is the current user? (needs Bearer token)
  app.get("/ifttt/v1/user/info", (req, res) => {
    const auth  = req.headers.authorization ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
    const t = token && tokens.get(token);
    if (!t) return res.status(401).json({ errors: [{ message: "invalid_token" }] });
    res.json({ data: { id: t.userId, name: "Haunted Demo User" } });
  });

  // 3) OAuth authorize (IFTTT sends user here; we return a ?code=...)
  app.get("/oauth/authorize", (req, res) => {
    const { client_id, response_type, redirect_uri, state } = req.query;
    if (client_id !== process.env.IFTTT_CLIENT_ID)  return res.status(400).send("bad client_id");
    if (response_type !== "code")                   return res.status(400).send("response_type must be code");
    if (!redirect_uri)                              return res.status(400).send("missing redirect_uri");

    // Demo: auto-approve a fixed user. Replace with real login/consent later.
    const userId = "demo-user-001";
    const code = Math.random().toString(36).slice(2) + Date.now().toString(36);
    authCodes.set(code, { userId, createdAt: Date.now() });

    const u = new URL(redirect_uri);
    u.searchParams.set("code", code);
    if (state) u.searchParams.set("state", state);
    res.redirect(u.toString());
  });

  // 4) OAuth token (IFTTT exchanges code -> access_token)
  app.post("/oauth/token", express.urlencoded({ extended: true }), (req, res) => {
    const { grant_type, code, client_id, client_secret } = req.body ?? {};

    if (client_id !== process.env.IFTTT_CLIENT_ID)
      return res.status(400).json({ error: "invalid_client" });
    if (client_secret !== process.env.IFTTT_CLIENT_SECRET)
      return res.status(400).json({ error: "invalid_client_secret" });

    if (grant_type === "authorization_code") {
      const entry = authCodes.get(code);
      if (!entry) return res.status(400).json({ error: "invalid_grant" });
      authCodes.delete(code); // one-time use

      const access_token = Math.random().toString(36).slice(2) + Date.now().toString(36);
      tokens.set(access_token, { userId: entry.userId, createdAt: Date.now() });

      return res.json({ token_type: "bearer", access_token, expires_in: 31536000 });
    }

    return res.status(400).json({ error: "unsupported_grant_type" });
  });

  // (Optional) quick dev helper to inspect the returned code
  app.get("/dev/callback", (req, res) => {
    res.type("text").send(`code=${req.query.code || ""}\nstate=${req.query.state || ""}`);
  });
})();



const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Haunted demo running at http://localhost:${port}`));

