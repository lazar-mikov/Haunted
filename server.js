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

// Alexa token storage
const alexaUserSessions = new Map(); // sessionId -> accessToken



/**
 * Helper: refresh the user access token via LWA refresh_token (if available).
 * Requires you to have saved the refresh token at account linking time.
 * Expects:
 *   - alexaRefreshTokens.get(sessionID) => refresh_token
 *   - process.env.LWA_CLIENT_ID / process.env.LWA_CLIENT_SECRET set
 * Updates:
 *   - alexaUserSessions.set(sessionID, new_access_token)
 *   - alexaRefreshTokens.set(sessionID, new_refresh_token?) if returned
 */
async function refreshAlexaToken(sessionID) {
  const refreshToken = alexaRefreshTokens?.get?.(sessionID);
  if (!refreshToken) {
    throw new Error('No refresh token available');
  }


// ===================== DEBUG ENDPOINTS =====================

// Token verification endpoint



// ===================== END DEBUG ENDPOINTS =====================

  const clientId = process.env.LWA_CLIENT_ID;
  const clientSecret = process.env.LWA_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error('Missing LWA client credentials');
  }

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: String(clientId),
    client_secret: String(clientSecret)
  });

  const r = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });

  if (!r.ok) {
    const text = await r.text();
    throw new Error(`Refresh token request failed: ${r.status} - ${text}`);
  }

  const tokens = await r.json();
  if (!tokens.access_token) {
    throw new Error('No access token in refresh response');
  }

  // Persist the new tokens
  alexaUserSessions.set(sessionID, tokens.access_token);
  if (tokens.refresh_token) {
    // Sometimes LWA returns a new refresh_token; store it if present.
    alexaRefreshTokens.set(sessionID, tokens.refresh_token);
  }

  console.log('🔐 Access token refreshed for session:', sessionID);
  return tokens.access_token;
}


/** [ADDED] parse urlencoded too (IFTTT & some tools send form bodies) */
app.use(express.json());
app.use(express.urlencoded({ extended: true })); // <— ADDED

app.use(cookieSession({
  name: "sess",
  secret: process.env.SESSION_SECRET || "haunted",
  httpOnly: true,
  sameSite: "lax",
   maxAge: 24 * 60 * 60 * 1000 // 24 hours
}));

// Serve static frontend
app.use(express.static("public"));



// Detailed token debug endpoint
app.get('/api/debug/token-details', (req, res) => {
  const accessToken = alexaUserSessions.get(req.sessionID);
  
  const result = {
    sessionId: req.sessionID,
    hasAccessToken: !!accessToken,
    accessTokenLength: accessToken ? accessToken.length : 0,
    accessTokenPreview: accessToken ? `${accessToken.substring(0, 10)}...${accessToken.substring(accessToken.length - 5)}` : null,
    allSessions: Array.from(alexaUserSessions.entries()).map(([sessionId, token]) => ({
      sessionId: sessionId,
      hasToken: !!token,
      tokenLength: token ? token.length : 0,
      isCurrentSession: sessionId === req.sessionID
    })),
    totalSessions: alexaUserSessions.size
  };
  
  console.log('Token details:', result);
  res.json(result);
});

// Manual token exchange test endpoint
app.post('/api/alexa/manual-token', async (req, res) => {
  try {
    const { code } = req.body;
    
    if (!code) {
      return res.json({ success: false, message: 'No code provided' });
    }
    
    const tokenResponse = await axios.post('https://api.amazon.com/auth/o2/token', {
      grant_type: 'authorization_code',
      code: code,
      client_id: process.env.LWA_CLIENT_ID,
      client_secret: process.env.LWA_CLIENT_SECRET,
      redirect_uri: 'https://haunted-production.up.railway.app/auth/alexa/callback'
    }, {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      }
    });
    
    res.json({ 
      success: true, 
      tokens: {
        access_token: tokenResponse.data.access_token ? '***' : 'MISSING',
        refresh_token: tokenResponse.data.refresh_token ? '***' : 'MISSING',
        expires_in: tokenResponse.data.expires_in,
        token_type: tokenResponse.data.token_type
      }
    });
    
  } catch (error) {
    console.error('Manual token error:', error.response?.data || error.message);
    res.json({ 
      success: false, 
      error: error.message,
      responseData: error.response?.data 
    });
  }
});

// Simple token status endpoint
app.get('/api/alexa/status', (req, res) => {
  const accessToken = alexaUserSessions.get(req.sessionID);
  res.json({ 
    connected: !!accessToken,
    sessionId: req.sessionID,
    hasToken: !!accessToken
  });
});

// Token verification endpoint
app.get('/api/alexa/verify-token', async (req, res) => {
  try {
    const accessToken = alexaUserSessions.get(req.sessionID);
    
    if (!accessToken) {
      return res.json({ valid: false, message: 'No token found for this session' });
    }
    
    console.log('🔍 Verifying token:', accessToken.substring(0, 20) + '...');
    
    // Verify token with Amazon
    const response = await fetch(`https://api.amazon.com/auth/o2/tokeninfo?access_token=${accessToken}`);
    
    if (!response.ok) {
      return res.json({ 
        valid: false, 
        message: `Token validation failed: ${response.status}`,
        status: response.status
      });
    }
    
    const tokenInfo = await response.json();
    
    res.json({
      valid: true,
      tokenInfo: {
        client_id: tokenInfo.aud,
        expires_in: tokenInfo.expires_in,
        scope: tokenInfo.scope,
        token_type: tokenInfo.token_type
      },
      sessionId: req.sessionID,
      tokenPreview: accessToken.substring(0, 10) + '...' + accessToken.substring(accessToken.length - 5)
    });
    
  } catch (error) {
    console.error('Token verification error:', error.message);
    res.json({
      valid: false,
      message: error.message,
      error: 'Token verification failed'
    });
  }
});

// Test direct Alexa API call
app.get('/api/alexa/test-direct', async (req, res) => {
  try {
    const accessToken = alexaUserSessions.get(req.sessionID);
    
    if (!accessToken) {
      return res.json({ success: false, message: 'No access token' });
    }
    
    // Test with a simple Alexa API call
    const response = await fetch('https://api.eu.amazonalexa.com/v1/devices', {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      }
    });
    
    if (response.status === 401) {
      return res.json({ 
        success: false, 
        message: 'Token invalid or expired',
        status: 401
      });
    }
    
    const data = await response.json();
    res.json({ success: true, data: data });
    
  } catch (error) {
    res.json({ success: false, message: error.message });
  }
});


// ===================== ALEXA SMART HOME LOGIC =====================
// Store Alexa access tokens
const alexaUserTokens = new Map();

// Alexa Smart Home endpoint
app.post('/alexa/smarthome', async (req, res) => {
  console.log('Alexa Smart Home request:', JSON.stringify(req.body, null, 2));

  const { directive } = req.body;
  const authHeader = req.headers.authorization;

  // Extra helpful log (added)
  console.log('🔍 Alexa request:', {
    namespace: directive?.header?.namespace,
    name: directive?.header?.name,
    hasAuth: !!authHeader,
  });

  // ✅ Allow discovery requests without authentication (added)
  if (
    directive?.header?.namespace === 'Alexa.Discovery' &&
    directive?.header?.name === 'Discover'
  ) {
    console.log('✅ Allowing discovery request without auth');
    return handleAlexaDiscovery(directive, res);
  }

  // Require auth for all other requests (moved below discovery allowance)
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    console.log('❌ Missing auth token for non-discovery request');
    return res.status(401).json({ error: 'Missing access token' });
  }

  const accessToken = authHeader.substring(7);

  // Validate the token with Amazon (unchanged)
  try {
    const tokenInfo = await validateAlexaAccessToken(accessToken);

    if (!tokenInfo || tokenInfo.aud !== process.env.LWA_CLIENT_ID) {
      return res.status(401).json({ error: 'Invalid access token' });
    }

    // Handle different directive types (kept as-is; Discovery already handled above)
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
  console.log('🔍 /auth/alexa called:', { client_id, redirect_uri, state });

  // Store the state in session WITH SAVE CALLBACK (kept)
  req.session.authState = state;
  req.session.authRedirectUri = redirect_uri;

  // Save the session before redirecting (kept)
  req.session.save((err) => {
    if (err) {
      console.error('❌ Session save error:', err);
      return res.status(500).send('Session error');
    }

    // Redirect to Amazon's OAuth endpoint
    const amazonAuthUrl = new URL('https://www.amazon.com/ap/oa');
    amazonAuthUrl.searchParams.set('client_id', process.env.LWA_CLIENT_ID);

    // ✅ UPDATED: include Smart Home account linking scope (kept 'profile')
    // NOTE: space-separated scopes per Amazon OAuth
    amazonAuthUrl.searchParams.set('scope', 'alexa::skills:account_linking profile');

    amazonAuthUrl.searchParams.set('response_type', 'code');
    amazonAuthUrl.searchParams.set(
      'redirect_uri',
      `${process.env.RAILWAY_URL || 'https://haunted-production.up.railway.app'}/auth/alexa/callback`
    );
    amazonAuthUrl.searchParams.set('state', state);

    console.log('🔍 Redirecting to:', amazonAuthUrl.toString());
    res.redirect(amazonAuthUrl.toString());
  });
});


app.get('/auth/alexa/callback', async (req, res) => {
  // 🧭 Extra session diagnostics (added)
  console.log('🔍 Callback session ID:', req.sessionID);
  console.log('🔍 Callback session keys:', Object.keys(req.session || {}));
  console.log('🔄 Alexa callback received:', req.query);

  const { code, error, error_description } = req.query;

  // Handle errors from Amazon (kept)
  if (error) {
    console.error('❌ Amazon OAuth error:', error, error_description);
    return res.redirect('/?alexaError=1&message=' + encodeURIComponent(error));
  }

  if (!code) {
    console.error('❌ No authorization code received');
    return res.redirect('/?alexaError=1&message=No authorization code');
  }

  try {
    console.log('🔑 Exchanging code for tokens...');

    // Exchange code for access/refresh tokens
    // (use proper x-www-form-urlencoded body; headers+timeout kept)
    const form = new URLSearchParams({
      grant_type: 'authorization_code',
      code: code,
      client_id: process.env.LWA_CLIENT_ID,
      client_secret: process.env.LWA_CLIENT_SECRET,
      redirect_uri: 'https://haunted-production.up.railway.app/auth/alexa/callback'
    });

    const tokenResponse = await axios.post(
      'https://api.amazon.com/auth/o2/token',
      form.toString(),
      {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 10000
      }
    );

    const tokens = tokenResponse.data;
    console.log('✅ Token exchange successful!');

    // STORE TOKEN WITH PROPER SESSION ID (kept + augmented)
    alexaUserSessions.set(req.sessionID, tokens.access_token);
    if (tokens.refresh_token) {
      // Store refresh token so you can refresh later
      alexaRefreshTokens.set(req.sessionID, tokens.refresh_token);
      console.log('💾 Refresh token stored for session:', req.sessionID);
    }

    console.log('💾 Token stored for session:', req.sessionID);
    if (tokens.access_token) {
      console.log('📦 Token preview:', tokens.access_token.substring(0, 20) + '...');
    }
    if (tokens.expires_in) {
      console.log('⏳ Access token expires_in (s):', tokens.expires_in);
    }

    // Redirect to success page (kept)
    res.redirect('/?alexaConnected=1&success=true');

  } catch (error) {
    console.error('💥 Token exchange failed:', error.message);
    if (error.response) {
      console.error('📋 Response data:', error.response.data);
      console.error('📋 Response status:', error.response.status);
    }
    // Keep original error redirect
    res.redirect('/?alexaError=1&message=' + encodeURIComponent(error.message));
  }
});




// Simple status endpoint
// Simple status endpoint
app.get('/api/alexa/status', (req, res) => {
  const isConnected = alexaUserSessions.has(req.sessionID);
  console.log('🔍 Status check - connected:', isConnected, 'session:', req.sessionID);
  res.json({ connected: isConnected });
});


// Add this endpoint to your server.js
app.get('/api/alexa/status', (req, res) => {
  // Check if user has Alexa tokens stored
  const hasAlexaToken = alexaUserTokens.size > 0;
  res.json({ connected: hasAlexaToken });
});

// Debug endpoint to see what's stored
app.get('/api/debug/simple-tokens', (req, res) => {
  const result = {
    currentSessionId: req.sessionID,
    hasToken: alexaUserSessions.has(req.sessionID),
    totalSessions: alexaUserSessions.size,
    allSessionIds: Array.from(alexaUserSessions.keys())
  };
  console.log('📊 Debug tokens:', result);
  res.json(result);
});

app.post('/api/debug/alexa-raw', (req, res) => {
  console.log('📋 Raw Alexa request:', {
    headers: req.headers,
    body: req.body,
    timestamp: new Date().toISOString()
  });
  res.json({ received: true });
});

// Get Alexa connection URL
app.get('/api/alexa/connect-url', (req, res) => {
  const authUrl = `https://www.amazon.com/ap/oa?client_id=${process.env.LWA_CLIENT_ID}&scope=profile&response_type=code&redirect_uri=${encodeURIComponent('https://haunted-production.up.railway.app/auth/alexa/callback')}&state=connect`;
  res.json({ url: authUrl });
});

// Disconnect Alexa
app.post('/api/alexa/disconnect', (req, res) => {
  alexaUserSessions.delete(req.sessionID);
  res.json({ success: true, message: 'Alexa disconnected' });
});

// Add token refresh function


// Alexa trigger endpoint
// Alexa trigger endpoint - UPDATED to return proper JSON
// UPDATE: /api/alexa/trigger with retry + (optional) token refresh
// NOTE: Keeps your existing behavior, just wraps it with a helper and
// adds a refresh path if you have a stored refresh token.

app.post('/api/alexa/trigger', async (req, res) => {
  try {
    const { effect } = req.body;
    let accessToken = alexaUserSessions.get(req.sessionID);

    if (!accessToken) {
      return res.json({ success: false, message: 'No Alexa connection found' });
    }

    try {
      const result = await triggerAlexaEffect(accessToken, effect);
      return res.json({ success: true, ...result });
    } catch (error) {
      // If token expired/invalid, try to refresh (if you store refresh tokens)
      const msg = String(error.message || error);
      if (msg.includes('401') || msg.toLowerCase().includes('token')) {
        console.log('🔄 Token may be expired, attempting refresh...');
        try {
          // You must store refresh tokens at account link callback:
          // alexaRefreshTokens.set(req.sessionID, tokens.refresh_token);
          accessToken = await refreshAlexaToken(req.sessionID);
          const result = await triggerAlexaEffect(accessToken, effect);
          return res.json({ success: true, ...result, refreshed: true });
        } catch (refreshErr) {
          console.error('❌ Token refresh failed:', refreshErr);
          return res.json({
            success: false,
            message: 'Token expired. Please reconnect Alexa.'
          });
        }
      }
      throw error;
    }
  } catch (error) {
    console.error('Trigger error:', error.message || error);
    res.json({ success: false, message: String(error.message || error) });
  }
});

/**
 * Helper: actually perform your existing Alexa call.
 * Keeps your endpoint map and request format intact.
 */
async function triggerAlexaEffect(accessToken, effect) {
  console.log('🔌 Alexa trigger requested:', effect);

  const endpointMap = {
    blackout: 'haunted-blackout',
    flash_red: 'haunted-flash-red',
    plug_on: 'haunted-plug-on',
    reset: 'haunted-reset'
  };

  const endpointId = endpointMap[effect];
  if (!endpointId) {
    throw new Error('Invalid effect');
  }

  console.log('🚀 Triggering Alexa effect:', effect, '->', endpointId);

  const alexaResponse = await fetch('https://api.eu.amazonalexa.com/v3/events', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      event: {
        header: {
          namespace: 'Alexa.SceneController',
          name: 'Activate',
          messageId:
            (globalThis.crypto?.randomUUID?.() ??
              Math.random().toString(36).slice(2)) + Date.now().toString(36),
          payloadVersion: '3'
        },
        endpoint: { endpointId },
        payload: {}
      }
    })
  });

  if (!alexaResponse.ok) {
    const errorText = await alexaResponse.text();
    throw new Error(`Alexa API error: ${alexaResponse.status} - ${errorText}`);
  }

  let responseData = {};
  try {
    responseData = await alexaResponse.json();
  } catch {
    // Some Alexa endpoints respond with no JSON body; ignore parse errors.
  }

  console.log('✅ Alexa trigger successful for:', effect);
  return {
    message: `Triggered ${effect} via Alexa`,
    effect,
    endpointId,
    alexaResponse: responseData
  };
}




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

// Debug endpoint to check tokens
app.get('/api/debug/tokens', (req, res) => {
  res.json({
    sessionId: req.sessionID,
    hasSessionToken: alexaUserSessions.has(req.sessionID),
    totalSessions: alexaUserSessions.size,
    totalTokens: alexaTokenStore.size
  });
});

// Debug endpoint to see ALL sessions and tokens
app.get('/api/debug/all-tokens', (req, res) => {
  res.json({
    currentSessionId: req.sessionID,
    allSessions: Array.from(alexaUserSessions.entries()).map(([sessionId, token]) => ({
      sessionId,
      hasToken: !!token,
      tokenPreview: token ? `${token.substring(0, 10)}...` : null
    })),
    totalSessions: alexaUserSessions.size,
    totalTokens: alexaTokenStore.size,
    recentCallback: req.session.lastCallbackData // We'll add this next
  });
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