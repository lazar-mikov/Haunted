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

// === IFTTT minimal OAuth & endpoints (copy/paste this whole block) ===
(() => {
  if (!app || !app.locals) return;                 // requires your existing `app`
  if (app.locals.__iftttWired) return;             // prevent double-registration
  app.locals.__iftttWired = true;

  // In-memory stores (fine for demo; replace with Redis/DB later)
  const authCodes = new Map();   // code -> { userId, createdAt }
  const tokens    = new Map();   // accessToken -> { userId, createdAt }

  // 1) Health check
  app.get("/ifttt/v1/status", (req, res) => {
    const got =
      req.get("IFTTT-Service-Key") ||
      req.get("IFTTT-Channel-Key") ||
      req.get("ifttt-service-key") ||
      req.get("ifttt-channel-key");

    if (!got || got !== process.env.IFTTT_SERVICE_KEY) {
      return res.status(401).json({ errors: [{ message: "invalid channel key" }] });
    }
    return res.sendStatus(200); // IMPORTANT: 200 with no body
  });

  // 1b) Test setup: create a test token and sample values
  app.post("/ifttt/v1/test/setup", (req, res) => {
    const got =
      req.get("IFTTT-Service-Key") ||
      req.get("IFTTT-Channel-Key") ||
      req.get("ifttt-service-key") ||
      req.get("ifttt-channel-key");

    if (!got || got !== process.env.IFTTT_SERVICE_KEY) {
      return res.status(401).json({ errors: [{ message: "invalid channel key" }] });
    }

    // Make a test access token so /user/info and triggers can auth
    const access_token = Math.random().toString(36).slice(2) + Date.now().toString(36);
    tokens.set(access_token, { userId: "demo-user-001", createdAt: Date.now() });

    // Provide samples for ACTIONS and TRIGGERS expected by your Service schema
    return res.status(200).json({
      data: {
        accessToken: access_token,
        samples: {
          actions: {
            // Action ID must match your IFTTT Action exactly
            run_effect: { effect: "blackout" }
          },
          triggers: {
            // Trigger ID must match your IFTTT Trigger exactly
            effect_requested: { effect: "blackout" }
          }
        }
      }
    });
  });

  // 2) User info (Bearer token)
  app.get("/ifttt/v1/user/info", (req, res) => {
    const auth  = req.headers.authorization ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
    const t = token && tokens.get(token);
    if (!t) return res.status(401).json({ errors: [{ message: "invalid_token" }] });
    res.json({ data: { id: t.userId, name: "Haunted Demo User" } });
  });

  // === NEW: Action endpoint required by your Service ===
  app.post("/ifttt/v1/actions/run_effect", (req, res) => {
  // ---- Auth check (required by Endpoint Tests) ----
  const auth  = req.headers.authorization ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  const t = token && tokens.get(token);
  if (!t) {
    return res.status(401).json({ errors: [{ message: "invalid_token" }] });
  }

  // ---- Validate payload ----
  const effect = req.body?.actionFields?.effect ?? req.body?.effect;
  const allowed = new Set(["blackout", "flash_red", "plug_on", "reset"]);
  if (!allowed.has(effect)) {
    return res.status(400).json({
      errors: [{ message: "Invalid 'effect'. Use blackout, flash_red, plug_on, reset." }]
    });
  }

  // ---- Success ----
  return res.status(200).json({ data: [{ id: `run-${Date.now()}` }] });
});

  // === NEW: Trigger endpoint the tests are checking ===
  app.post("/ifttt/v1/triggers/effect_requested", (req, res) => {
    // Auth via Bearer token
    const auth  = req.headers.authorization ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
    const t = token && tokens.get(token);
    if (!t) return res.status(401).json({ errors: [{ message: "invalid_token" }] });

    // Accept either nested or flat
    const effect =
      req.body?.triggerFields?.effect ??
      req.body?.effect ??
      "";

    const allowed = new Set(["blackout", "flash_red", "plug_on", "reset"]);
    if (!allowed.has(effect)) {
      return res.status(400).json({ errors: [{ message: "Invalid 'effect' trigger field" }] });
    }

    // Optional limit (default 50, clamp 0..50)
    let limit = parseInt(req.body?.limit, 10);
    if (isNaN(limit)) limit = 50;
    if (limit < 0) limit = 0;
    if (limit > 50) limit = 50;

    const now = Math.floor(Date.now() / 1000);
    const data = Array.from({ length: limit }, (_, i) => {
      const ts = now - i * 60; // 1 minute apart, newest first
      return {
        title: `Effect requested: ${effect}`,
        effect,
        created_at: new Date(ts * 1000).toISOString(), // REQUIRED ISO8601
        meta: { id: `effect-${effect}-${ts}`, timestamp: ts } // REQUIRED meta fields
      };
    });

    return res.status(200).json({ data });
  });

  // 3) Trigger: new_thing_created — returns recent items with required fields (kept)
  app.post("/ifttt/v1/triggers/new_thing_created", (req, res) => {
    const auth  = req.headers.authorization ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
    const t = token && tokens.get(token);
    if (!t) return res.status(401).json({ errors: [{ message: "invalid_token" }] });

    const now = Math.floor(Date.now() / 1000);

    let limit = parseInt(req.body?.limit, 10);
    if (isNaN(limit)) limit = 50;
    if (limit < 0) limit = 0;
    if (limit > 50) limit = 50;

    const makeItem = (i) => {
      const ts = now - i * 60;
      return {
        title: `Test thing #${i + 1}`,
        message: "Hello from Haunted",
        created_at: new Date(ts * 1000).toISOString(),
        meta: {
          id: `demo-${ts}`,
          timestamp: ts
        }
      };
    };

    const data = Array.from({ length: limit }, (_, i) => makeItem(i));
    res.status(200).json({ data });
  });

  // 3b) Query: list_all_things — paginated, optional metadata (kept)
  app.post("/ifttt/v1/queries/list_all_things", (req, res) => {
    const auth = req.headers.authorization ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
    const t = token && tokens.get(token);
    if (!t) return res.status(401).json({ errors: [{ message: "invalid_token" }] });

    const include = Array.isArray(req.body?.include) ? req.body.include : null;

    let limit = parseInt(req.body?.limit, 10);
    if (isNaN(limit)) limit = 50;
    if (limit < 0) limit = 0;
    if (limit > 50) limit = 50;

    const decodeCursor = (c) => {
      try {
        const s = Buffer.from(String(c), "base64").toString("utf8");
        const n = parseInt(s.replace(/^offset:/, ""), 10);
        return Number.isFinite(n) && n >= 0 ? n : 0;
      } catch {
        return 0;
      }
    };
    const encodeCursor = (offset) => Buffer.from(`offset:${offset}`).toString("base64");
    const start = req.body?.cursor ? decodeCursor(req.body.cursor) : 0;

    const baseCreated = Date.now();
    const ALL = Array.from({ length: 5 }, (_, i) => {
      const ts = new Date(baseCreated - i * 60_000);
      const item = {
        id: `thing-${i + 1}`,
        name: `Haunted Thing #${i + 1}`,
        created_at: ts.toISOString(),
      };
      if (include && include.includes("metadata")) {
        item.metadata = { brightness: (i + 1) * 10, room: i % 2 ? "hall" : "attic" };
      }
      return item;
    });

    const slice = ALL.slice(start, start + limit);
    const nextOffset = start + slice.length;
    const cursor = nextOffset < ALL.length ? encodeCursor(nextOffset) : undefined;

    const body = { data: slice };
    if (cursor) body.cursor = cursor;

    return res.status(200).json(body);
  });

  // 3c) Action: create_new_thing — accepts fields, optional metadata (kept)
  app.post("/ifttt/v1/actions/create_new_thing", (req, res) => {
    const auth = req.headers.authorization ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
    const t = token && tokens.get(token);
    if (!t) return res.status(401).json({ errors: [{ message: "invalid_token" }] });

    const actionFields = req.body?.actionFields && typeof req.body.actionFields === "object"
      ? req.body.actionFields
      : {};
    const include = Array.isArray(req.body?.include) ? req.body.include : [];

    const createdAt = new Date();
    const id = `new-${createdAt.getTime()}`;

    const item = { id };
    if (include.includes("metadata")) {
      item.metadata = {
        created_at: createdAt.toISOString(),
        received_fields: Object.keys(actionFields)
      };
    }

    return res.status(200).json({ data: [item] });
  });

  // 4) OAuth authorize (demo auto-approves a fixed user)
  app.get("/oauth/authorize", (req, res) => {
    const { client_id, response_type, redirect_uri, state } = req.query;
    if (client_id !== process.env.IFTTT_CLIENT_ID)  return res.status(400).send("bad client_id");
    if (response_type !== "code")                   return res.status(400).send("response_type must be code");
    if (!redirect_uri)                              return res.status(400).send("missing redirect_uri");

    const userId = "demo-user-001";
    const code = Math.random().toString(36).slice(2) + Date.now().toString(36);
    authCodes.set(code, { userId, createdAt: Date.now() });

    const u = new URL(redirect_uri);
    u.searchParams.set("code", code);
    if (state) u.searchParams.set("state", state);
    res.redirect(u.toString());
  });

  // 5) OAuth token
  app.post("/oauth/token", express.urlencoded({ extended: true }), (req, res) => {
    const { grant_type, code, client_id, client_secret } = req.body ?? {};
    if (client_id !== process.env.IFTTT_CLIENT_ID)
      return res.status(400).json({ error: "invalid_client" });
    if (client_secret !== process.env.IFTTT_CLIENT_SECRET)
      return res.status(400).json({ error: "invalid_client_secret" });

    if (grant_type === "authorization_code") {
      const entry = authCodes.get(code);
      if (!entry) return res.status(400).json({ error: "invalid_grant" });
      authCodes.delete(code);

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
