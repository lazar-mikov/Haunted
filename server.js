import express from "express";
import axios from "axios";
import session from "express-session";
import dotenv from "dotenv";
import crypto from "crypto";
import path from "path";
import { fileURLToPath } from "url";
import dgram from "dgram";
import { networkInterfaces } from "os";

dotenv.config();

const app = express();

// Token storage
let tokens = new Map();
let authCodes = new Map();
const alexaUserSessions = new Map();
const alexaRefreshTokens = new Map();

// Store device states for contact sensors
const deviceStates = new Map();

// LIGHT CONTROL STORAGE
const discoveredLights = new Map(); // userId -> lights array
const userLightSessions = new Map(); // sessionId -> lights

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

// ===================== LIGHT DISCOVERY & CONTROL =====================

// Get local network info
function getLocalNetworkPrefix() {
  const interfaces = networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        const ip = iface.address;
        const parts = ip.split('.');
        return `${parts[0]}.${parts[1]}.${parts[2]}`;
      }
    }
  }
  return '192.168.1'; // fallback
}

// TAPO DISCOVERY (Local Network - FAST)
async function discoverTapoLights() {
  console.log('🔍 Discovering Tapo lights...');
  const networkPrefix = getLocalNetworkPrefix();
  const tapoDevices = [];
  const promises = [];

  // Scan IP range in parallel for speed
  for (let i = 1; i < 255; i++) {
    const ip = `${networkPrefix}.${i}`;
    promises.push(checkIfTapoDevice(ip));
  }

  // Wait for all scans (max 3 seconds)
  const results = await Promise.allSettled(promises);
  
  results.forEach((result, index) => {
    if (result.status === 'fulfilled' && result.value) {
      tapoDevices.push(result.value);
    }
  });

  console.log(`✅ Found ${tapoDevices.length} Tapo devices`);
  return tapoDevices;
}

async function checkIfTapoDevice(ip) {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 500); // 500ms timeout per device
    
    const response = await fetch(`http://${ip}:80/`, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Tapo-Scanner' }
    });
    
    clearTimeout(timeoutId);
    
    // Check if response indicates Tapo device
    const text = await response.text();
    if (text.includes('tapo') || text.includes('TP-LINK') || response.headers.get('server')?.includes('TP-LINK')) {
      return {
        type: 'tapo',
        ip: ip,
        name: `Tapo Light (${ip})`,
        id: `tapo_${ip.replace(/\./g, '_')}`
      };
    }
  } catch (error) {
    // Device not responsive or not Tapo
  }
  return null;
}

// TAPO CONTROL
// Note: Tapo devices use encrypted communication. This is a simplified version.
// For production, consider using tp-link-tapo-connect library
async function controlTapoLight(device, effect) {
  try {
    const commands = {
      blackout: { device_on: false },
      flash_red: { 
        device_on: true,
        hue: 0,
        saturation: 100,
        brightness: 100,
        color_temp: 0
      },
      reset: {
        device_on: true,
        hue: 200,
        saturation: 20,
        brightness: 80,
        color_temp: 2700
      }
    };

    const command = commands[effect] || commands.reset;
    
    // Note: Real Tapo control requires encrypted communication
    // This is a placeholder - implement proper Tapo protocol or use library
    const response = await fetch(`http://${device.ip}/app`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        method: 'set_device_info',
        params: command
      }),
      timeout: 2000
    });

    return response.ok;
  } catch (error) {
    console.error(`Failed to control Tapo device ${device.ip}:`, error.message);
    return false;
  }
}

// TUYA DISCOVERY (Cloud API - requires user token)
async function discoverTuyaLights(accessToken) {
  try {
    console.log('🔍 Discovering Tuya lights...');
    
    const timestamp = Date.now().toString();
    // Note: Proper Tuya API requires HMAC-SHA256 signing
    // This is simplified - implement proper signing for production
    
    const response = await axios.get('https://openapi.tuyaus.com/v1.0/users/me/devices', {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        't': timestamp,
        'sign_method': 'HMAC-SHA256'
      },
      timeout: 5000
    });

    const devices = response.data.result || [];
    const lights = devices.filter(device => 
      device.category === 'dj' || // lights
      device.category === 'dd' || // light strips  
      device.product_name.toLowerCase().includes('light') ||
      device.product_name.toLowerCase().includes('bulb')
    );

    console.log(`✅ Found ${lights.length} Tuya lights`);
    return lights.map(device => ({
      type: 'tuya',
      id: device.id,
      name: device.name || device.product_name,
      category: device.category,
      online: device.online
    }));
  } catch (error) {
    console.error('Failed to discover Tuya lights:', error.message);
    return [];
  }
}

// TUYA CONTROL
async function controlTuyaLight(device, effect, accessToken) {
  try {
    const commands = {
      blackout: [{ code: 'switch_led', value: false }],
      flash_red: [
        { code: 'switch_led', value: true },
        { code: 'work_mode', value: 'colour' },
        { code: 'colour_data', value: { h: 0, s: 255, v: 255 } }
      ],
      reset: [
        { code: 'switch_led', value: true },
        { code: 'work_mode', value: 'white' },
        { code: 'bright_value', value: 500 }
      ]
    };

    const command = commands[effect] || commands.reset;
    
    const timestamp = Date.now().toString();
    const response = await axios.post(
      `https://openapi.tuyaus.com/v1.0/devices/${device.id}/commands`,
      { commands: command },
      {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          't': timestamp,
          'sign_method': 'HMAC-SHA256'
        },
        timeout: 3000
      }
    );

    return response.data.success;
  } catch (error) {
    console.error(`Failed to control Tuya device ${device.id}:`, error.message);
    return false;
  }
}

// UNIFIED LIGHT CONTROL
async function triggerLightEffect(sessionId, effect) {
  try {
    console.log(`🎭 Triggering light effect: ${effect} for session: ${sessionId}`);
    
    const userLights = userLightSessions.get(sessionId) || [];
    if (userLights.length === 0) {
      return { success: false, message: 'No lights configured for this session' };
    }

    const results = [];
    
    // Control all lights in parallel for speed
    const promises = userLights.map(async (light) => {
      if (light.type === 'tapo') {
        return await controlTapoLight(light, effect);
      } else if (light.type === 'tuya') {
        const tuyaToken = alexaUserSessions.get('tuya_token'); // Store this from user auth
        return await controlTuyaLight(light, effect, tuyaToken);
      }
      return false;
    });

    const lightResults = await Promise.all(promises);
    const successCount = lightResults.filter(r => r).length;

    console.log(`✅ Successfully controlled ${successCount}/${userLights.length} lights`);
    
    return {
      success: successCount > 0,
      message: `Controlled ${successCount}/${userLights.length} lights`,
      effect: effect,
      lightsTriggered: successCount
    };
  } catch (error) {
    console.error(`❌ Failed to trigger light effect ${effect}:`, error.message);
    return { success: false, message: error.message };
  }
}

// ===================== NEW LIGHT CONTROL ENDPOINTS =====================

// Fast discovery endpoint
app.post('/api/lights/discover', async (req, res) => {
  try {
    const sessionId = req.sessionID;
    console.log(`🚀 Starting fast light discovery for session: ${sessionId}`);
    
    // Run discoveries in parallel for maximum speed
    const [tapoLights, tuyaLights] = await Promise.all([
      discoverTapoLights(),
      // Tuya discovery only if user provides token
      req.body.tuyaToken ? discoverTuyaLights(req.body.tuyaToken) : Promise.resolve([])
    ]);

    const allLights = [...tapoLights, ...tuyaLights];
    
    // Store lights for this session
    userLightSessions.set(sessionId, allLights);
    
    console.log(`✅ Discovery complete: ${allLights.length} lights found`);
    
    res.json({
      success: true,
      lightsFound: allLights.length,
      lights: allLights,
      sessionId: sessionId,
      discoveryTime: new Date().toISOString()
    });
  } catch (error) {
    console.error('Light discovery failed:', error);
    res.status(500).json({
      success: false,
      message: 'Light discovery failed',
      error: error.message
    });
  }
});

// Test lights endpoint
app.post('/api/lights/test', async (req, res) => {
  try {
    const sessionId = req.sessionID;
    const result = await triggerLightEffect(sessionId, 'reset');
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Main trigger endpoint for film effects
app.post('/api/lights/trigger', async (req, res) => {
  try {
    const { effect } = req.body;
    const sessionId = req.sessionID;
    
    if (!effect) {
      return res.status(400).json({ success: false, message: 'Effect parameter required' });
    }

    const result = await triggerLightEffect(sessionId, effect);
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Get user's configured lights
app.get('/api/lights/status', (req, res) => {
  const sessionId = req.sessionID;
  const userLights = userLightSessions.get(sessionId) || [];
  
  res.json({
    sessionId: sessionId,
    lightsConfigured: userLights.length,
    lights: userLights,
    ready: userLights.length > 0
  });
});

// ===================== EXISTING ALEXA CODE (UNCHANGED) =====================

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

// Trigger contact sensor for Alexa
async function triggerContactSensor(sensorId, effect) {
  try {
    console.log(`🎭 Triggering contact sensor: ${sensorId} for effect: ${effect}`);
    
    // Change sensor state to DETECTED
    deviceStates.set(sensorId, "DETECTED");
    console.log(`✅ Sensor ${sensorId} state changed to DETECTED`);
    
    // Reset sensor state after a short delay
    setTimeout(async () => {
      try {
        deviceStates.set(sensorId, "NOT_DETECTED");
        console.log(`🔄 Reset sensor: ${sensorId} to NOT_DETECTED`);
      } catch (error) {
        console.error(`❌ Failed to reset sensor ${sensorId}:`, error.message);
      }
    }, 2000);
    
    return { success: true, message: `Triggered ${effect} - sensor state changed` };
  } catch (error) {
    console.error(`❌ Failed to trigger sensor ${sensorId}:`, error.message);
    return { success: false, message: error.message };
  }
}

// ===================== UNIFIED TRIGGER ENDPOINT =====================
// Controls BOTH lights and Alexa sensors
app.post('/api/trigger-direct', async (req, res) => {
  try {
    const { effect } = req.body;
    const sessionId = req.sessionID;
    console.log(`🎬 Film trigger: ${effect}`);
    
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

    // Trigger both systems in parallel
    const [sensorResult, lightResult] = await Promise.all([
      triggerContactSensor(sensorId, effect),
      triggerLightEffect(sessionId, effect)
    ]);

    res.json({
      success: sensorResult.success || lightResult.success,
      sensor: sensorResult,
      lights: lightResult,
      effect: effect,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Trigger failed:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Trigger specific sensor endpoint
app.post('/api/trigger-sensor', async (req, res) => {
  const { sensorId, effect } = req.body;
  console.log(`🎭 Triggering sensor: ${sensorId} for effect: ${effect}`);
  
  const result = await triggerContactSensor(sensorId, effect || 'manual');
  res.json(result);
});

// Get sensor states endpoint
app.get('/api/sensor-states', (req, res) => {
  const states = Object.fromEntries(deviceStates.entries());
  res.json({ states });
});

// ===================== ALEXA DISCOVERY & STATE HANDLERS =====================

async function handleAlexaDiscovery(directive, res) {
  console.log('🎯 Discovery request received:', JSON.stringify(directive, null, 2));
  
  if (directive.header.name === 'Discover') {
    try {
      console.log('🔍 Starting device discovery...');
      
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

// ===================== ALEXA ROUTES =====================

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

// ===================== ALEXA AUTHENTICATION =====================

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

// ===================== DEBUG ENDPOINTS =====================

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

// ===================== ADDITIONAL ROUTES =====================

// Watch page helper
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

// ===================== SERVER STARTUP =====================

const PORT = process.env.PORT || 3000;

const server = app.listen(PORT, () => {
  console.log(`🚀 Haunted House server running on port ${PORT}`);
  console.log(`💡 Light control system initialized`);
  console.log(`📱 Contact sensors ready for triggering`);
}).on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`❌ Port ${PORT} is already in use.`);
    process.exit(1);
  } else {
    console.error(`❌ Server startup error:`, err);
    process.exit(1);
  }
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n🛑 Shutting down gracefully...');
  server.close(() => {
    console.log('✅ Server closed');
    process.exit(0);
  });
});

process.on('SIGTERM', () => {
  console.log('\n🛑 Shutting down gracefully...');
  server.close(() => {
    console.log('✅ Server closed');
    process.exit(0);
  });
});