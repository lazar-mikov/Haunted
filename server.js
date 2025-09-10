import express from "express";
import axios from "axios";
import cookieSession from "cookie-session";
import dotenv from "dotenv";
import crypto from "crypto";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();

const app = express();

// [FIX] Define tokens Map at the top level so it's accessible everywhere
let tokens = new Map();
let authCodes = new Map();

/** [ADDED] parse urlencoded too (IFTTT & some tools send form bodies) */
app.use(express.json());
app.use(express.urlencoded({ extended: true })); // <— ADDED

app.use(cookieSession({
  name: "sess",
  secret: process.env.SESSION_SECRET || "haunted",
  httpOnly: true,
  sameSite: "lax"
}));

// Serve static frontend
app.use(express.static("public"));

// ===================== ALEXA SMART HOME LOGIC =====================
// Store Alexa access tokens
const alexaUserTokens = new Map();

// Alexa Smart Home endpoint
app.post('/alexa/smarthome', async (req, res) => {
  console.log('Alexa Smart Home request:', JSON.stringify(req.body, null, 2));
  
  const { directive } = req.body;
  const authHeader = req.headers.authorization;
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing access token' });
  }
  
  const accessToken = authHeader.substring(7);
  
  
  // Validate the token with Amazon
  try {
    const tokenInfo = await validateAlexaAccessToken(accessToken);
    
    if (!tokenInfo || tokenInfo.aud !== process.env.LWA_CLIENT_ID) {
      return res.status(401).json({ error: 'Invalid access token' });
    }
    
    // Handle different directive types
    switch (directive.header.namespace) {
      case 'Alexa.Discovery':
        return handleAlexaDiscovery(directive, res);
      case 'Alexa.PowerController':
        return handleAlexaPowerControl(directive, res);
      default:
        return res.status(400).json({ error: 'UNSUPPORTED_OPERATION' });
    }
    
  } catch (error) {
    console.error('Alexa token validation failed:', error);
    return res.status(401).json({ error: 'Token validation failed' });
  }
});

// Alexa discovery handler
function handleAlexaDiscovery(directive, res) {
  if (directive.header.name === 'Discover') {
    const endpoints = [
      {
        endpointId: "haunted-blackout",
        manufacturerName: "Haunted House",
        friendlyName: "Blackout Effect",
        description: "Complete darkness effect",
        displayCategories: ["SWITCH"],
        capabilities: [
          {
            type: "AlexaInterface",
            interface: "Alexa.PowerController",
            version: "3",
            properties: {
              supported: [{ name: "powerState" }],
              proactivelyReported: true,
              retrievable: true
            }
          }
        ]
      },
      {
        endpointId: "haunted-flash-red",
        manufacturerName: "Haunted House", 
        friendlyName: "Red Flash Effect",
        description: "Sudden red flash effect",
        displayCategories: ["SWITCH"],
        capabilities: [
          {
            type: "AlexaInterface",
            interface: "Alexa.PowerController", 
            version: "3",
            properties: {
              supported: [{ name: "powerState" }],
              proactivelyReported: true,
              retrievable: true
            }
          }
        ]
      },
      {
        endpointId: "haunted-plug-on",
        manufacturerName: "Haunted House", 
        friendlyName: "Plug On Effect",
        description: "Trigger plug on effect",
        displayCategories: ["SWITCH"],
        capabilities: [
          {
            type: "AlexaInterface",
            interface: "Alexa.PowerController", 
            version: "3",
            properties: {
              supported: [{ name: "powerState" }],
              proactivelyReported: true,
              retrievable: true
            }
          }
        ]
      },
      {
        endpointId: "haunted-reset",
        manufacturerName: "Haunted House", 
        friendlyName: "Reset Effect",
        description: "Reset all effects",
        displayCategories: ["SWITCH"],
        capabilities: [
          {
            type: "AlexaInterface",
            interface: "Alexa.PowerController", 
            version: "3",
            properties: {
              supported: [{ name: "powerState" }],
              proactivelyReported: true,
              retrievable: true
            }
          }
        ]
      }
    ];
    
    res.json({
      event: {
        header: {
          namespace: "Alexa.Discovery",
          name: "Discover.Response",
          messageId: directive.header.messageId,
          payloadVersion: "3"
        },
        payload: { endpoints }
      }
    });
  }
}

// Alexa power control handler
function handleAlexaPowerControl(directive, res) {
  const { endpointId, name } = directive.header;
  const effect = endpointId.replace('haunted-', '');
  
  // Trigger your existing effect system
  if (name === 'TurnOn') {
    // Call your existing API endpoint
    axios.post(`http://localhost:${process.env.PORT || 3000}/api/trigger`, {
      effect: effect
    }, {
      timeout: 3000
    }).catch(error => {
      console.log('Effect triggered via Alexa, but internal call failed:', error.message);
    });
  }
  
  // Response to Alexa
  res.json({
    event: {
      header: {
        namespace: "Alexa",
        name: "Response",
        messageId: directive.header.messageId,
        payloadVersion: "3",
        correlationToken: directive.header.correlationToken
      },
      endpoint: directive.endpoint,
      payload: {}
    },
    context: {
      properties: [{
        namespace: "Alexa.PowerController",
        name: "powerState",
        value: name === 'TurnOn' ? "ON" : "OFF",
        timeOfSample: new Date().toISOString(),
        uncertaintyInMilliseconds: 500
      }]
    }
  });
}

// Validate Alexa access token with Amazon
async function validateAlexaAccessToken(token) {
  try {
    const response = await fetch(`https://api.amazon.com/auth/o2/tokeninfo?access_token=${token}`);
    return response.json();
  } catch (error) {
    console.error('Token validation error:', error);
    return null;
  }
}

// Alexa OAuth endpoints
app.get('/auth/alexa', (req, res) => {
  const { client_id, redirect_uri, state } = req.query;
  
  // Store the state for verification later
  req.session.authState = state;
  req.session.authRedirectUri = redirect_uri;
  
  // Redirect to Amazon's OAuth endpoint
  const amazonAuthUrl = new URL('https://www.amazon.com/ap/oa');
  amazonAuthUrl.searchParams.set('client_id', process.env.LWA_CLIENT_ID);
  amazonAuthUrl.searchParams.set('scope', 'profile');
  amazonAuthUrl.searchParams.set('response_type', 'code');
  amazonAuthUrl.searchParams.set('redirect_uri', `${process.env.RAILWAY_URL || 'https://haunted-production.up.railway.app'}/auth/alexa/callback`);
  amazonAuthUrl.searchParams.set('state', state);
  
  res.redirect(amazonAuthUrl.toString());
});

app.get('/auth/alexa/callback', async (req, res) => {
  const { code, state } = req.query;
  
  // Verify state matches what we stored
  if (state !== req.session.authState) {
    return res.status(400).send('Invalid state parameter');
  }
  
  try {
    // Exchange authorization code for tokens
    const tokenResponse = await axios.post('https://api.amazon.com/auth/o2/token', {
      grant_type: 'authorization_code',
      code: code,
      client_id: process.env.LWA_CLIENT_ID,
      client_secret: process.env.LWA_CLIENT_SECRET,
      redirect_uri: `${process.env.RAILWAY_URL || 'https://haunted-production.up.railway.app'}/auth/alexa/callback`
    }, {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      }
    });
    
    const tokens = tokenResponse.data;
    
    // Store the access token
    alexaUserTokens.set(tokens.access_token, {
      created_at: Date.now(),
      expires_in: tokens.expires_in
    });
    
    // Redirect back to Alexa with the code
    const redirectUri = req.session.authRedirectUri;
    res.redirect(`${redirectUri}?code=${code}&state=${state}`);
    
  } catch (error) {
    console.error('Alexa token exchange failed:', error.response?.data || error.message);
    res.status(500).send('Authentication failed');
  }
});

// ===================== END ALEXA LOGIC =====================

/** ---------- [ADDED] Optional /watch page helper (serves watch.html if present) ---------- */
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.get("/watch", (req, res) => {
  const filePath = path.join(__dirname, "public", "watch.html");
  res.sendFile(filePath, err => {
    if (err) {
      res
        .status(200)
        .type("html")
        .send(`<h1>Haunted Demo</h1><p>Create <code>public/watch.html</code> with a button that POSTs to <code>/api/trigger</code>.<br/>You're at: ${req.originalUrl}</p>`);
    }
  });
});

/** ---------- One-button IFTTT Connect redirect ---------- */
// Set IFTTT_CONNECT_URL in env (e.g. https://ift.tt/XXXXX)
// This sends the viewer to Connect and returns them to /watch?autoplay=1
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

    // [FIXED] ALSO store token in the tokens Map for IFTTT endpoints validation
    tokens.set(tokenResp.data.access_token, { 
      userId: "demo-user-001", 
      createdAt: Date.now() 
    });
    console.log("Token stored in both session and tokens Map");

    res.redirect("/?authed=1");
  } catch (e) {
    console.error("OAuth error:", e?.response?.data || e.message);
    res.status(500).send("OAuth error");
  }
});

/** ---------- [ADDED] Dev helpers: inspect/prime tokens ---------- */
// shows whether the server has any token and whether your session already has one
app.get("/dev/debug-tokens", (req, res) => {
  try {
    const store = app.locals?.iftttTokens;
    let latest = null;
    if (store && typeof store.forUser === "function") {
      latest = store.forUser("demo-user-001");
    }
    res.json({
      hasSessionToken: !!(req.session?.ifttt?.access_token),
      latestDemoToken: latest || null
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "debug failed" });
  }
});

// copies the latest server token into THIS browser session, then goes to /watch
app.get("/dev/prime-session", (req, res) => {
  try {
    const store = app.locals?.iftttTokens;
    const latest = store && typeof store.forUser === "function"
      ? store.forUser("demo-user-001")
      : null;

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

/** ---------- [ADDED] Debug endpoint to check token status ---------- */
app.get("/api/debug/token", (req, res) => {
  res.json({
    hasSessionToken: !!req.session?.ifttt?.access_token,
    sessionToken: req.session?.ifttt?.access_token ? "***" : null,
    tokensMapSize: tokens.size
  });
});

/** ---------- Demo helpers (IFTTT Webhooks) ---------- */
/** ---------- Demo helpers (IFTTT Webhooks) ---------- */
app.post("/api/demo/maker-key", (req, res) => {
  try {
    const { makerKey } = req.body;
    if (!makerKey) return res.status(400).json({ ok: false, error: "makerKey required" });
    req.session.makerKey = makerKey.trim();
    res.json({ ok: true });
  } catch (error) {
    res.status(400).json({ ok: false, error: "bad json" });
  }
});

/** ---------- [CHANGED] Trigger endpoint: accept 'effect' OR 'event' ---------- */
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

async function handleTrigger(req, res, body) {
  // TEMPORARY: Force webhooks until IFTTT service is live
  req.session.ifttt = null;
  
  try {
    /** [CHANGED] allow 'effect' or 'event' */
    const effect = (body.effect || body.event || "").trim();
    if (!effect) return res.status(400).json({ ok: false, error: "missing effect" });

    // OPTION A: IFTTT Connect (preferred) - WILL BE SKIPPED FOR NOW
    if (process.env.IFTTT_CONNECT_ACTION_URL && req.session.ifttt?.access_token) {
      const allowed = new Set(["blackout", "flash_red", "plug_on", "reset"]);
      if (!allowed.has(effect)) {
        return res.status(400).json({ ok: false, error: "invalid effect" });
      }
      try {
        await axios.post(
          process.env.IFTTT_CONNECT_ACTION_URL,
          { actionFields: { effect } },
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

    // OPTION B: Webhooks fallback (demo) - THIS WILL RUN NOW
    if (!req.session.makerKey) {
      return res.status(400).json({ ok: false, error: "No Maker key (demo mode). Paste it on Page 1." });
    }
    const url = `https://maker.ifttt.com/trigger/${encodeURIComponent(effect)}/json/with/key/${req.session.makerKey}`;
    await axios.post(url, body.payload || {}, { timeout: 4000 });
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

// === IFTTT minimal OAuth & endpoints (copy/paste block) ===
(() => {
  if (!app || !app.locals) return;                 // requires your existing `app`
  if (app.locals.__iftttWired) return;             // prevent double-registration
  app.locals.__iftttWired = true;

  /** ---------- [ADDED] expose token store for dev routes ---------- */
  app.locals.iftttTokens = {
    // return latest token for a given userId (by createdAt)
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

  // === Action endpoint required by your Service ===
  app.post("/ifttt/v1/actions/run_effect", (req, res) => {
    /** [CHANGED] Auth: accept Bearer (normal) OR Service-Key (for local testing) */
    const auth  = req.headers.authorization ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
    const t = token && tokens.get(token);

    const svcKey =
      req.get("IFTTT-Service-Key") ||
      req.get("IFTTT-Channel-Key") ||
      req.get("ifttt-service-key") ||
      req.get("ifttt-channel-key");

    if (!t && (!svcKey || svcKey !== process.env.IFTTT_SERVICE_KEY)) {
      return res.status(401).json({ errors: [{ message: "invalid_token_or_service_key" }] });
    }

    // ---- Validate payload ----
    const effect = req.body?.actionFields?.effect ?? req.body?.effect;
    const allowed = new Set(["blackout", "flash_red", "plug_on", "reset"]);
    if (!allowed.has(effect)) {
      return res.status(400).json({
        errors: [{ message: "Invalid 'effect'. Use blackout, flash_red, plug_on, reset." }]
      });
    }

    // ---- Success: MUST match IFTTT action response schema ----
    return res.status(200).json({ data: [{ id: `run-${Date.now()}` }] });
  });

  // === Trigger endpoint the tests are checking ===
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

    const baseCreated = Date.now();
    const makeItem = (i) => {
      const ts = new Date(baseCreated - i * 60_000);
      const item = {
        title: `Test thing #${i + 1}`,
        message: "Hello from Haunted",
        created_at: ts.toISOString(),
        meta: {
          id: `demo-${ts.getTime()}`,
          timestamp: Math.floor(ts.getTime() / 1000)
        }
      };
      return item;
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
    console.log("[oauth/authorize] received", { client_id, response_type, redirect_uri, state });

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
    console.log("[oauth/token] called", {
      grant_type,
      hasCode: !!code,
      client_id_ok: client_id === process.env.IFTTT_CLIENT_ID,
      client_secret_ok: client_secret === process.env.IFTTT_CLIENT_SECRET
    });

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

      console.log("[oauth/token] issuing access_token for user", entry.userId);

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