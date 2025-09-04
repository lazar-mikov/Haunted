import express from "express";
import axios from "axios";
import cookieSession from "cookie-session";
import dotenv from "dotenv";
import crypto from "crypto";
import path from "path";
import { fileURLToPath } from "url";

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

/** ---------- Serve /watch and auto-sync session token if missing ---------- */
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.get("/watch", (req, res, next) => {
  try {
    if (!req.session.ifttt?.access_token) {
      const tokens = app.locals?.iftttTokens;
      if (tokens && typeof tokens.forUser === "function") {
        const latest = tokens.forUser("demo-user-001");
        if (latest) {
          req.session.ifttt = { access_token: latest.access_token };
        }
      }
    }
    const filePath = path.join(__dirname, "public", "watch.html");
    return res.sendFile(filePath, err => {
      if (err) {
        res
          .status(200)
          .type("html")
          .send(`<h1>Haunted Demo</h1><p>Create <code>public/watch.html</code> with a button that POSTs to <code>/api/trigger</code>.</p>`);
      }
    });
  } catch (e) {
    next(e);
  }
});

/** ---------- One-button IFTTT Connect redirect ---------- */
app.get("/connect", (req, res) => {
  const connectUrl = process.env.IFTTT_CONNECT_URL;
  if (!connectUrl) return res.status(500).send("IFTTT_CONNECT_URL is not set");
  const u = new URL(connectUrl);
  u.searchParams.set("state", "/watch?autoplay=1");
  res.redirect(u.toString());
});

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

/** ---------- FIXED Trigger endpoint ---------- */
app.post("/api/trigger", async (req, res) => {
  // If express.json already parsed the body
  if (req.body && typeof req.body === "object" && Object.keys(req.body).length) {
    return handleTrigger(req, res, req.body);
  }

  // Fallback: manual read
  const chunks = [];
  req.on("data", c => chunks.push(c));
  req.on("end", async () => {
    try {
      const parsed = JSON.parse(Buffer.concat(chunks).toString() || "{}");
      await handleTrigger(req, res, parsed);
    } catch (e) {
      console.error("Trigger parse error:", e?.response?.data || e.message);
      res.status(400).json({ ok: false, error: "bad json" });
    }
  });
});

// DEV helper: copy latest IFTTT token into this browser session, then go to /watch
app.get("/dev/prime-session", (req, res) => {
  try {
    const store = app.locals?.iftttTokens;
    const latest = store && typeof store.forUser === "function" ? store.forUser("demo-user-001") : null;
    if (!latest) {
      return res
        .status(400)
        .type("text")
        .send("No IFTTT token found yet. Complete /connect first, then retry this URL.");
    }
    req.session.ifttt = { access_token: latest.access_token };
    res.redirect("/watch?autoplay=1");
  } catch (e) {
    console.error(e);
    res.status(500).type("text").send("prime-session error");
  }
});


async function handleTrigger(req, res, body) {
  try {
    const { event, payload } = body;
    if (!event) return res.status(400).json({ ok: false, error: "missing event" });

    // OPTION A: IFTTT Connect
    if (process.env.IFTTT_CONNECT_ACTION_URL && req.session.ifttt?.access_token) {
      const allowed = new Set(["blackout", "flash_red", "plug_on", "reset"]);
      if (!allowed.has(event)) {
        return res.status(400).json({ ok: false, error: "invalid event" });
      }
      try {
        await axios.post(
          process.env.IFTTT_CONNECT_ACTION_URL,
          { actionFields: { effect: event } },
          {
            headers: {
              Authorization: `Bearer ${req.session.ifttt.access_token}`,
              "Content-Type": "application/json"
            },
            timeout: 5000
          }
        );
        return res.json({ ok: true, via: "ifttt-connect" });
      } catch (e) {
        console.error("IFTTT Connect error:", e?.response?.data || e.message);
        return res.status(502).json({ ok: false, via: "ifttt-connect", error: "Connect action failed" });
      }
    }

    // OPTION B: Webhooks fallback
    if (!req.session.makerKey) {
      return res.status(400).json({ ok: false, error: "No Maker key (demo mode). Paste it on Page 1." });
    }
    const url = `https://maker.ifttt.com/trigger/${encodeURIComponent(event)}/json/with/key/${req.session.makerKey}`;
    await axios.post(url, payload || {}, { timeout: 4000 });
    return res.json({ ok: true, via: "webhooks" });
  } catch (e) {
    console.error("Trigger error:", e?.response?.data || e.message);
    return res.status(500).json({ ok: false, error: "Trigger failed" });
  }
}



/** ---------- Kill switch ---------- */
app.post("/api/kill", (req, res) => {
  req.session = null;
  res.json({ ok: true });
});

// === IFTTT minimal OAuth & endpoints (unchanged) ===
(() => {
  if (!app || !app.locals) return;
  if (app.locals.__iftttWired) return;
  app.locals.__iftttWired = true;

  const authCodes = new Map();
  const tokens    = new Map();

  app.locals.iftttTokens = {
    forUser(userId) {
      let latest = null;
      for (const [access_token, info] of tokens.entries()) {
        if (info.userId === userId) {
          if (!latest || info.createdAt > latest.createdAt) {
            latest = { access_token, createdAt: info.createdAt };
          }
        }
      }
      return latest;
    }
  };

  // ... [keep all your /ifttt/v1/* and /oauth/* routes here as before] ...
  // (no changes needed inside them)
})();

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Haunted demo running at http://localhost:${port}`));
