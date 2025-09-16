import express from "express";
import axios from "axios";
import session from "express-session";
import dotenv from "dotenv";
import crypto from "crypto";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();

const app = express();

// Token storage
let tokens = new Map();
let authCodes = new Map();
const alexaUserSessions = new Map();
const alexaRefreshTokens = new Map();

// Store device states for contact sensors
const deviceStates = new Map();

// Initialize contact sensor states
const initializeContactSensors = () => {
  deviceStates.set("haunted-blackout-sensor", "NOT_DETECTED");
  deviceStates.set("haunted-flash-red-sensor", "NOT_DETECTED");
  deviceStates.set("haunted-plug-on-sensor", "NOT_DETECTED");
  deviceStates.set("haunted-reset-sensor", "NOT_DETECTED");
};

initializeContactSensors();

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || "haunted",
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    maxAge: 24 * 60 * 60 * 1000
  }
}));
app.use(express.static("public"));

// ===================== ALEXA EVENT GATEWAY =====================
async function sendAlexaChangeReport(endpointId, newState, accessToken) {
  try {
    console.log(`📤 Sending change report for ${endpointId}: ${newState}`);
    
    const event = {
      event: {
        header: {
          namespace: "Alexa",
          name: "ChangeReport",
          messageId: crypto.randomUUID(),
          payloadVersion: "3"
        },
        endpoint: {
          scope: {
            type: "BearerToken",
            token: accessToken
          },
          endpointId: endpointId
        },
        payload: {
          change: {
            cause: {
              type: "PHYSICAL_INTERACTION"
            },
            properties: [{
              namespace: "Alexa.ContactSensor",
              name: "detectionState",
              value: newState,
              timeOfSample: new Date().toISOString(),
              uncertaintyInMilliseconds: 0
            }]
          }
        }
      }
    };

    const response = await axios.post('https://api.amazonalexa.com/v1/events', event, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      timeout: 5000
    });

    console.log(`✅ Change report sent successfully for ${endpointId}`);
    return response.data;
  } catch (error) {
    console.error(`❌ Failed to send change report for ${endpointId}:`, error.response?.data || error.message);
    throw error;
  }
}

// ===================== EFFECT TRIGGERING =====================
// This function triggers contact sensor state changes
async function triggerContactSensor(sensorId, effect) {
  try {
    console.log(`🎭 Triggering contact sensor: ${sensorId} for effect: ${effect}`);
    
    const storageKey = 'alexa_main_tokens';
    const accessToken = alexaUserSessions.get(storageKey);
    
    if (!accessToken) {
      console.warn('⚠️ No access token available for sending change reports');
      return { success: false, message: 'No Alexa connection' };
    }
    
    // Change sensor state to DETECTED
    deviceStates.set(sensorId, "DETECTED");
    
    // Send change report to Alexa
    await sendAlexaChangeReport(sensorId, "DETECTED", accessToken);
    
    // Reset sensor state after a short delay
    setTimeout(async () => {
      try {
        deviceStates.set(sensorId, "NOT_DETECTED");
        await sendAlexaChangeReport(sensorId, "NOT_DETECTED", accessToken);
        console.log(`🔄 Reset sensor: ${sensorId}`);
      } catch (error) {
        console.error(`❌ Failed to reset sensor ${sensorId}:`, error.message);
      }
    }, 2000); // Reset after 2 seconds
    
    return { success: true, message: `Triggered ${effect}` };
  } catch (error) {
    console.error(`❌ Failed to trigger sensor ${sensorId}:`, error.message);
    return { success: false, message: error.message };
  }
}

// ===================== ALEXA HANDLERS =====================
async function handleAlexaDiscovery(directive, res) {
  console.log('🎯 Discovery request received:', JSON.stringify(directive, null, 2));
  
  if (directive.header.name === 'Discover') {
    try {
      console.log('🔍 Starting device discovery...');
      
      // Updated to contact sensors instead of switches
      const virtualEndpoints = [
        {
          endpointId: "haunted-blackout-sensor",
          manufacturerName: "Haunted House",
          friendlyName: "Blackout Trigger",
          description: "Contact sensor for blackout effect - use in routines",
          displayCategories: ["CONTACT_SENSOR"],
          capabilities: [
            {
              type: "AlexaInterface",
              interface: "Alexa.ContactSensor",
              version: "3",
              properties: {
                supported: [{ name: "detectionState" }],
                proactivelyReported: true,
                retrievable: true
              }
            },
            {
              type: "AlexaInterface",
              interface: "Alexa.EndpointHealth",
              version: "3",
              properties: {
                supported: [{ name: "connectivity" }],
                proactivelyReported: true,
                retrievable: true
              }
            },
            {
              type: "AlexaInterface",
              interface: "Alexa",
              version: "3"
            }
          ]
        },
        {
          endpointId: "haunted-flash-red-sensor",
          manufacturerName: "Haunted House", 
          friendlyName: "Red Flash Trigger",
          description: "Contact sensor for red flash effect - use in routines",
          displayCategories: ["CONTACT_SENSOR"],
          capabilities: [
            {
              type: "AlexaInterface",
              interface: "Alexa.ContactSensor",
              version: "3",
              properties: {
                supported: [{ name: "detectionState" }],
                proactivelyReported: true,
                retrievable: true
              }
            },
            {
              type: "AlexaInterface",
              interface: "Alexa.EndpointHealth",
              version: "3",
              properties: {
                supported: [{ name: "connectivity" }],
                proactivelyReported: true,
                retrievable: true
              }
            },
            {
              type: "AlexaInterface",
              interface: "Alexa",
              version: "3"
            }
          ]
        },
        {
          endpointId: "haunted-plug-on-sensor",
          manufacturerName: "Haunted House", 
          friendlyName: "Plug On Trigger",
          description: "Contact sensor for plug on effect - use in routines",
          displayCategories: ["CONTACT_SENSOR"],
          capabilities: [
            {
              type: "AlexaInterface",
              interface: "Alexa.ContactSensor",
              version: "3",
              properties: {
                supported: [{ name: "detectionState" }],
                proactivelyReported: true,
                retrievable: true
              }
            },
            {
              type: "AlexaInterface",
              interface: "Alexa.EndpointHealth",
              version: "3",
              properties: {
                supported: [{ name: "connectivity" }],
                proactivelyReported: true,
                retrievable: true
              }
            },
            {
              type: "AlexaInterface",
              interface: "Alexa",
              version: "3"
            }
          ]
        },
        {
          endpointId: "haunted-reset-sensor",
          manufacturerName: "Haunted House", 
          friendlyName: "Reset Trigger",
          description: "Contact sensor for reset effect - use in routines",
          displayCategories: ["CONTACT_SENSOR"],
          capabilities: [
            {
              type: "AlexaInterface",
              interface: "Alexa.ContactSensor",
              version: "3",
              properties: {
                supported: [{ name: "detectionState" }],
                proactivelyReported: true,
                retrievable: true
              }
            },
            {
              type: "AlexaInterface",
              interface: "Alexa.EndpointHealth",
              version: "3",
              properties: {
                supported: [{ name: "connectivity" }],
                proactivelyReported: true,
                retrievable: true
              }
            },
            {
              type: "AlexaInterface",
              interface: "Alexa",
              version: "3"
            }
          ]
        }
      ];

      console.log(`📋 Prepared ${virtualEndpoints.length} virtual contact sensors`);
      
      const response = {
        event: {
          header: {
            namespace: "Alexa.Discovery",
            name: "Discover.Response",
            messageId: directive.header.messageId,
            payloadVersion: "3"
          },
          payload: { endpoints: virtualEndpoints }
        }
      };

      console.log('📤 Sending discovery response:', JSON.stringify(response, null, 2));
      res.json(response);
      
    } catch (error) {
      console.error('❌ Discovery failed:', error);
      res.status(500).json({ 
        error: 'Discovery failed',
        message: error.message,
        stack: error.stack 
      });
    }
  } else {
    console.warn('⚠️ Received unknown directive:', directive.header.name);
    res.status(400).json({ error: 'Unknown directive' });
  }
}

// Updated handler for contact sensor state reports
async function handleAlexaStateReport(directive, res) {
  try {
    const endpointId = directive.endpoint.endpointId;
    console.log(`📊 State report requested for: ${endpointId}`);
    
    if (endpointId.includes('haunted-') && endpointId.includes('-sensor')) {
      const currentState = deviceStates.get(endpointId) || "NOT_DETECTED";
      
      const response = {
        event: {
          header: {
            namespace: "Alexa",
            name: "StateReport",
            messageId: directive.header.messageId,
            payloadVersion: "3",
            correlationToken: directive.header.correlationToken
          },
          endpoint: directive.endpoint,
          payload: {}
        },
        context: {
          properties: [
            {
              namespace: "Alexa.ContactSensor",
              name: "detectionState",
              value: currentState,
              timeOfSample: new Date().toISOString(),
              uncertaintyInMilliseconds: 0
            },
            {
              namespace: "Alexa.EndpointHealth",
              name: "connectivity",
              value: { value: "OK" },
              timeOfSample: new Date().toISOString(),
              uncertaintyInMilliseconds: 0
            }
          ]
        }
      };
      
      return res.json(response);
    } else {
      return res.status(400).json({ error: 'Unknown endpoint' });
    }
  } catch (error) {
    console.error('Error in handleAlexaStateReport:', error);
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: error.message });
  }
}

// ===================== ROUTES =====================
app.post('/alexa/smarthome', async (req, res) => {
  console.log('Alexa Smart Home request:', JSON.stringify(req.body, null, 2));
  const { directive } = req.body;
  const authHeader = req.headers.authorization;

  // Handle discovery without auth token
  if (directive?.header?.namespace === 'Alexa.Discovery' && directive?.header?.name === 'Discover') {
    return handleAlexaDiscovery(directive, res);
  }

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing access token' });
  }

  const accessToken = authHeader.substring(7);
  try {
    const tokenInfo = await validateAlexaAccessToken(accessToken);
    if (!tokenInfo || tokenInfo.aud !== process.env.LWA_CLIENT_ID) {
      return res.status(401).json({ error: 'Invalid access token' });
    }

    switch (directive.header.namespace) {
      case 'Alexa.Discovery':
        return handleAlexaDiscovery(directive, res);
      case 'Alexa':
        if (directive.header.name === 'ReportState') {
          return handleAlexaStateReport(directive, res);
        }
        break;
      default:
        return res.status(400).json({ error: 'UNSUPPORTED_OPERATION' });
    }
  } catch (error) {
    console.error('Alexa token validation failed:', error);
    return res.status(401).json({ error: 'Token validation failed' });
  }
});

// Updated trigger endpoint to use contact sensors
app.post('/api/trigger-direct', async (req, res) => {
  const { effect } = req.body;
  console.log('🎭 Direct effect trigger:', effect);
  
  // Map effects to sensor IDs
  const effectToSensor = {
    'blackout': 'haunted-blackout-sensor',
    'flash-red': 'haunted-flash-red-sensor', 
    'plug-on': 'haunted-plug-on-sensor',
    'reset': 'haunted-reset-sensor'
  };
  
  const sensorId = effectToSensor[effect];
  if (!sensorId) {
    return res.status(400).json({ 
      success: false, 
      message: `Unknown effect: ${effect}` 
    });
  }
  
  const result = await triggerContactSensor(sensorId, effect);
  res.json(result);
});

// New endpoint to trigger specific sensor
app.post('/api/trigger-sensor', async (req, res) => {
  const { sensorId, effect } = req.body;
  console.log(`🎭 Triggering sensor: ${sensorId} for effect: ${effect}`);
  
  const result = await triggerContactSensor(sensorId, effect || 'manual');
  res.json(result);
});

// Endpoint to get sensor states
app.get('/api/sensor-states', (req, res) => {
  const states = Object.fromEntries(deviceStates.entries());
  res.json({ states });
});

// ===================== ALEXA CONNECTION STATUS =====================
app.get('/api/alexa/status', (req, res) => {
  try {
    const storageKey = 'alexa_main_tokens';
    const accessToken = alexaUserSessions.get(storageKey);
    const refreshToken = alexaRefreshTokens.get(storageKey);
    
    const isConnected = !!(accessToken && refreshToken);
    
    res.json({
      connected: isConnected,
      hasAccessToken: !!accessToken,
      hasRefreshToken: !!refreshToken
    });
  } catch (error) {
    console.error('Error checking Alexa status:', error);
    res.status(500).json({ 
      connected: false,
      error: 'Failed to check connection status'
    });
  }
});

// ===================== AUTHENTICATION (FIXED SCOPES) =====================
async function refreshAlexaToken() {
  try {
    const storageKey = 'alexa_main_tokens';
    const refreshToken = alexaRefreshTokens.get(storageKey);
    if (!refreshToken) throw new Error('No refresh token available');
    
    console.log('🔄 Refreshing Alexa token...');
    const response = await axios.post('https://api.amazon.com/auth/o2/token', {
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: process.env.LWA_CLIENT_ID,
      client_secret: process.env.LWA_CLIENT_SECRET
    }, { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    
    const newTokens = response.data;
    alexaUserSessions.set(storageKey, newTokens.access_token);
    if (newTokens.refresh_token) alexaRefreshTokens.set(storageKey, newTokens.refresh_token);
    console.log('✅ Token refreshed successfully');
    return newTokens.access_token;
  } catch (error) {
    console.error('❌ Token refresh failed:', error.message);
    throw error;
  }
}

async function validateAlexaAccessToken(token) {
  try {
    const response = await fetch(`https://api.amazon.com/auth/o2/tokeninfo?access_token=${token}`);
    return response.json();
  } catch (error) {
    console.error('Token validation error:', error);
    return null;
  }
}

app.get('/auth/alexa', (req, res) => {
  const { client_id, redirect_uri, state } = req.query;
  console.log('🔍 /auth/alexa called:', { client_id, redirect_uri, state });
  req.session.authState = state;
  req.session.authRedirectUri = redirect_uri;
  
  // Fixed scopes - ONLY use profile for now
  const scopes = 'profile';
  
  const amazonAuthUrl = new URL('https://www.amazon.com/ap/oa');
  amazonAuthUrl.searchParams.set('client_id', client_id);
  amazonAuthUrl.searchParams.set('scope', scopes);
  amazonAuthUrl.searchParams.set('response_type', 'code');
  amazonAuthUrl.searchParams.set('redirect_uri', `${process.env.RAILWAY_URL || 'https://haunted-production.up.railway.app'}/auth/alexa/callback`);
  amazonAuthUrl.searchParams.set('state', state);
  
  console.log('🔍 Redirecting to:', amazonAuthUrl.toString());
  res.redirect(amazonAuthUrl.toString());
});

app.get('/auth/alexa/callback', async (req, res) => {
  console.log('🔍 Callback session ID:', req.sessionID);
  try {
    const { code, state } = req.query;
    console.log('🔑 Exchanging code for tokens...');
    const tokenResponse = await axios.post('https://api.amazon.com/auth/o2/token', {
      grant_type: 'authorization_code',
      code: code,
      client_id: process.env.LWA_CLIENT_ID,
      client_secret: process.env.LWA_CLIENT_SECRET,
      redirect_uri: `${process.env.RAILWAY_URL || 'https://haunted-production.up.railway.app'}/auth/alexa/callback`
    }, { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 10000 });
    
    const tokens = tokenResponse.data;
    console.log('✅ Token exchange successful!');
    const storageKey = 'alexa_main_tokens';
    alexaUserSessions.set(storageKey, tokens.access_token);
    alexaRefreshTokens.set(storageKey, tokens.refresh_token);
    console.log('✅ Tokens stored with fixed key');
    
    res.redirect('/?alexaConnected=1');
  } catch (error) {
    console.error('💥 Token exchange failed:', error.message);
    res.redirect('/?alexaError=1&message=' + encodeURIComponent(error.message));
  }
});

// Grant handler for smart home skills
app.post('/api/alexa/handle-grant', async (req, res) => {
  try {
    const { directive } = req.body;
    console.log('🔐 Handling AcceptGrant directive:', JSON.stringify(directive, null, 2));
    
    if (directive?.header?.name === 'AcceptGrant') {
      const grantCode = directive.payload.grant.code;
      const granteeToken = directive.payload.grantee.token;
      
      console.log('🔑 Exchanging grant code for event gateway access...');
      
      const tokenResponse = await axios.post('https://api.amazon.com/auth/o2/token', {
        grant_type: 'authorization_code',
        code: grantCode,
        client_id: process.env.LWA_CLIENT_ID,
        client_secret: process.env.LWA_CLIENT_SECRET
      }, { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
      
      const tokens = tokenResponse.data;
      console.log('✅ Grant exchange successful');
      
      // Store event gateway tokens
      const storageKey = `alexa_event_${granteeToken}`;
      alexaUserSessions.set(storageKey, tokens.access_token);
      alexaRefreshTokens.set(storageKey, tokens.refresh_token);
      
      // Also store as main tokens for backwards compatibility
      alexaUserSessions.set('alexa_main_tokens', tokens.access_token);
      alexaRefreshTokens.set('alexa_main_tokens', tokens.refresh_token);
      
      const response = {
        event: {
          header: {
            namespace: "Alexa.Authorization",
            name: "AcceptGrant.Response",
            messageId: directive.header.messageId,
            payloadVersion: "3"
          },
          payload: {}
        }
      };
      
      res.json(response);
    } else {
      res.status(400).json({ error: 'Invalid directive' });
    }
  } catch (error) {
    console.error('Grant handling failed:', error.message);
    res.status(500).json({ 
      event: {
        header: {
          namespace: "Alexa",
          name: "ErrorResponse",
          messageId: crypto.randomUUID(),
          payloadVersion: "3"
        },
        payload: {
          type: "INTERNAL_ERROR",
          message: error.message
        }
      }
    });
  }
});

// Debug endpoints
app.get('/api/debug/tokens', (req, res) => {
  try {
    const storageKey = 'alexa_main_tokens';
    const accessToken = alexaUserSessions.get(storageKey);
    const refreshToken = alexaRefreshTokens.get(storageKey);
    
    res.json({
      sessionId: req.sessionID,
      hasAccessToken: !!accessToken,
      hasRefreshToken: !!refreshToken,
      accessToken: accessToken || 'Not found',
      refreshToken: refreshToken || 'Not found',
      totalSessions: alexaUserSessions.size,
      totalRefreshTokens: alexaRefreshTokens.size
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/my-token', (req, res) => {
  try {
    const storageKey = 'alexa_main_tokens';
    const accessToken = alexaUserSessions.get(storageKey);
    
    if (accessToken) {
      res.json({
        success: true,
        accessToken: accessToken,
        tokenLength: accessToken.length
      });
    } else {
      res.json({
        success: false,
        message: 'No access token found'
      });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Test endpoints
app.get('/debug/discovery', (req, res) => {
  console.log('🔍 Debug discovery endpoint called');
  
  const testResponse = {
    event: {
      header: {
        namespace: "Alexa.Discovery",
        name: "Discover.Response",
        messageId: "debug-message-123",
        payloadVersion: "3"
      },
      payload: {
        endpoints: [
          {
            endpointId: "test-blackout-sensor",
            manufacturerName: "Haunted House",
            friendlyName: "Test Blackout Sensor",
            description: "Test contact sensor for discovery debugging",
            displayCategories: ["CONTACT_SENSOR"],
            capabilities: [
              {
                type: "AlexaInterface",
                interface: "Alexa.ContactSensor",
                version: "3",
                properties: {
                  supported: [{ name: "detectionState" }],
                  proactivelyReported: true,
                  retrievable: true
                }
              }
            ]
          }
        ]
      }
    }
  };
  
  console.log('📤 Sending test discovery response');
  res.json(testResponse);
});

// Optional /watch page helper
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.get("/watch", (req, res) => {
  const filePath = path.join(__dirname, "public", "watch.html");
  res.sendFile(filePath, err => {
    if (err) {
      res
        .status(200)
        .type("html")
        .send(`<h1>Haunted Demo</h1><p>Create <code>public/watch.html</code> with a button that POSTs to <code>/api/trigger-direct</code>.<br/>You're at: ${req.originalUrl}</p>`);
    }
  });
});

// ===================== COMMENTED OUT IFTTT CODE =====================
/*
// IFTTT Connect redirect
app.get("/connect", (req, res) => {
  const connectUrl = process.env.IFTTT_CONNECT_URL;
  if (!connectUrl) return res.status(500).send("IFTTT_CONNECT_URL is not set");
  const u = new URL(connectUrl);
  u.searchParams.set("state", "/watch?autoplay=1");
  res.redirect(u.toString());
});

// IFTTT OAuth endpoints
app.get("/auth/ifttt/start", (req, res) => {
  // OAuth start logic
});

app.get("/auth/ifttt/callback", async (req, res) => {
  // OAuth callback logic
});

// IFTTT trigger endpoint
app.post("/api/trigger", async (req, res) => {
  // IFTTT trigger logic
});

// IFTTT service endpoints
app.get("/ifttt/v1/status", (req, res) => {
  // IFTTT status endpoint
});

// Additional IFTTT endpoints...
*/

const PORT = process.env.PORT || 3000;

// Add error handling for server startup
const server = app.listen(PORT, () => {
  console.log(`🚀 Haunted House server running on port ${PORT}`);
  console.log(`📱 Contact sensors initialized and ready for triggering`);
}).on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`❌ Port ${PORT} is already in use. Trying to stop existing process...`);
    
    // Try to use a different port if Railway's PORT is in use
    const fallbackPort = PORT + 1;
    console.log(`🔄 Attempting to start on port ${fallbackPort}...`);
    
    app.listen(fallbackPort, () => {
      console.log(`🚀 Haunted House server running on fallback port ${fallbackPort}`);
      console.log(`📱 Contact sensors initialized and ready for triggering`);
    }).on('error', (fallbackErr) => {
      console.error(`❌ Failed to start server on any port:`, fallbackErr);
      process.exit(1);
    });
  } else {
    console.error(`❌ Server startup error:`, err);
    process.exit(1);
  }
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n🛑 Received SIGINT. Shutting down gracefully...');
  server.close(() => {
    console.log('✅ Server closed');
    process.exit(0);
  });
});

process.on('SIGTERM', () => {
  console.log('\n🛑 Received SIGTERM. Shutting down gracefully...');
  server.close(() => {
    console.log('✅ Server closed');
    process.exit(0);
  });
});