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

const VOICE_MONKEY_API = 'https://api.voicemonkey.io/v1/monkey';


// ===================== LIGHT DISCOVERY & CONTROL ===================== Voice Monkey

// Add this endpoint to create/verify your shared monkeys exist
app.get('/api/setup-shared-monkeys', async (req, res) => {
  try {
    // These are YOUR monkeys that ALL users will trigger
    const sharedMonkeys = [
      { name: 'haunted_shared_blackout', text: 'Blackout trigger' },
      { name: 'haunted_shared_flash', text: 'Flash red trigger' },
      { name: 'haunted_shared_reset', text: 'Reset lights trigger' }
    ];
    
    // Create them in your Voice Monkey account (one-time setup)
    for (const monkey of sharedMonkeys) {
      await axios.post(`${VOICE_MONKEY_API}/create`, {
        access_token: process.env.VOICE_MONKEY_TOKEN,
        device_name: monkey.name,
        default_text: monkey.text
      });
    }
    
    res.json({ success: true, monkeys: sharedMonkeys });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});


// Generate pre-filled Alexa routine links
app.get('/api/generate-routine-links', (req, res) => {
  const sessionId = req.sessionID;
  
  // Store that this user is using Voice Monkey
  req.session.triggerMethod = 'voicemonkey';
  
  // Generate deeplinks that open Alexa app with routines pre-filled
  const routines = {
    blackout: {
      name: 'Haunted Blackout',
      url: `alexa://routines/create?trigger=${encodeURIComponent('When Voice Monkey speaks')}&device=${encodeURIComponent('haunted_shared_blackout')}&action=${encodeURIComponent('Turn off all lights')}`,
      fallbackUrl: 'https://alexa.amazon.com/spa/index.html#routines/add'
    },
    flash: {
      name: 'Haunted Flash',
      url: `alexa://routines/create?trigger=${encodeURIComponent('When Voice Monkey speaks')}&device=${encodeURIComponent('haunted_shared_flash')}&action=${encodeURIComponent('Set lights to red')}`,
      fallbackUrl: 'https://alexa.amazon.com/spa/index.html#routines/add'
    },
    reset: {
      name: 'Haunted Reset',
      url: `alexa://routines/create?trigger=${encodeURIComponent('When Voice Monkey speaks')}&device=${encodeURIComponent('haunted_shared_reset')}&action=${encodeURIComponent('Turn on lights')}`,
      fallbackUrl: 'https://alexa.amazon.com/spa/index.html#routines/add'
    }
  };
  
  res.json({
    routines,
    instructions: 'Click each link to create routine in Alexa app'
  });
});

// ===================== LIGHT DISCOVERY & CONTROL =====================
// Replace everything from this line until "EXISTING ALEXA CODE (UNCHANGED)"

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

// WORKING TAPO DISCOVERY - Uses UDP which actually works
async function discoverTapoLights() {
  return new Promise((resolve) => {
    console.log('🔍 Discovering Tapo lights via UDP...');
    const devices = new Map();
    const socket = dgram.createSocket('udp4');
    
    // The actual discovery packet Tapo/Kasa devices respond to
    const DISCOVERY_MSG = Buffer.from([
      0xd0, 0xf2, 0x81, 0xf8, 0x8b, 0xff, 0x9a, 0xf7,
      0xd5, 0xef, 0x94, 0xb6, 0xd1, 0xb4, 0xc0, 0x9f,
      0xec, 0x95, 0xe6, 0x8f, 0xe1, 0x87, 0xe8, 0xca,
      0xf0, 0x8b, 0xf6, 0x8b, 0xf6
    ]);
    
    socket.on('message', (msg, rinfo) => {
      try {
        // Decrypt response (XOR with 0xAB)
        let decrypted = '';
        for (let i = 0; i < msg.length; i++) {
          decrypted += String.fromCharCode(msg[i] ^ 0xAB);
        }
        
        // Check if it's a Tapo/Kasa light
        if (decrypted.includes('system') || decrypted.includes('on_off') ||
            decrypted.includes('L5') || decrypted.includes('KL')) {
          
          if (!devices.has(rinfo.address)) {
            const device = {
              type: 'tapo',
              ip: rinfo.address,
              name: `Smart Light (${rinfo.address})`,
              id: `tapo_${rinfo.address.replace(/\./g, '_')}`
            };
            devices.set(rinfo.address, device);
            console.log(`✅ Found light at ${rinfo.address}`);
          }
        }
      } catch (e) {
        // Not a Tapo device
      }
    });

    socket.on('error', (err) => {
      console.error('Discovery error:', err);
      socket.close();
      resolve(Array.from(devices.values()));
    });

    // Send discovery broadcast
    socket.bind(() => {
      socket.setBroadcast(true);
      const networkPrefix = getLocalNetworkPrefix();
      
      // Broadcast to network
      ['255.255.255.255', `${networkPrefix}.255`].forEach(addr => {
        [9999, 20002].forEach(port => {
          socket.send(DISCOVERY_MSG, port, addr);
        });
      });
    });

    // Wait 2.5 seconds for responses
    setTimeout(() => {
      socket.close();
      const foundDevices = Array.from(devices.values());
      console.log(`✅ Found ${foundDevices.length} Tapo devices`);
      resolve(foundDevices);
    }, 2500);
  });
}

// TAPO CONTROL - Basic UDP control
async function controlTapoLight(device, effect) {
  return new Promise((resolve) => {
    try {
      const socket = dgram.createSocket('udp4');
      
      let command = {};
      if (effect === 'blackout') {
        command = { "system": { "set_relay_state": { "state": 0 } } };
      } else if (effect === 'flash_red' || effect === 'flash-red') {
        command = {
          "smartlife.iot.smartbulb.lightingservice": {
            "transition_light_state": {
              "on_off": 1,
              "hue": 0,
              "saturation": 100,
              "brightness": 100
            }
          }
        };
      } else {
        command = { "system": { "set_relay_state": { "state": 1 } } };
      }
      
      // Encrypt command (XOR with 0xAB)
      const jsonStr = JSON.stringify(command);
      const encrypted = Buffer.alloc(jsonStr.length);
      for (let i = 0; i < jsonStr.length; i++) {
        encrypted[i] = jsonStr.charCodeAt(i) ^ 0xAB;
      }
      
      socket.send(encrypted, 9999, device.ip, (err) => {
        socket.close();
        if (!err) {
          console.log(`💡 Sent ${effect} to ${device.ip}`);
        }
        resolve(!err);
      });
      
      // Timeout after 500ms
      setTimeout(() => {
        socket.close();
        resolve(true);
      }, 500);
    } catch (error) {
      console.error(`Failed to control Tapo device ${device.ip}:`, error.message);
      resolve(false);
    }
  });
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
      'flash-red': [
        { code: 'switch_led', value: true },
        { code: 'work_mode', value: 'colour' },
        { code: 'colour_data', value: { h: 0, s: 255, v: 255 } }
      ],
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

// Add instant discovery endpoint for app.js
app.post('/api/lights/instant-discover', async (req, res) => {
  try {
    const sessionId = req.sessionID;
    console.log(`🚀 Instant light discovery for session: ${sessionId}`);
    
    const tapoLights = await discoverTapoLights();
    
    // Store lights for this session
    userLightSessions.set(sessionId, tapoLights);
    
    res.json({
      success: tapoLights.length > 0,
      lightsFound: tapoLights.length,
      lights: tapoLights,
      discoveryTime: '2-3 seconds'
    });
  } catch (error) {
    console.error('Instant discovery failed:', error);
    res.json({
      success: false,
      lightsFound: 0,
      lights: [],
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
// Keep everything after this line exactly as it is
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

       // Voice Monkey mapping
    const effectToMonkey = {
      'blackout': 'haunted_shared_blackout',
      'flash-red': 'haunted_shared_flash',
      'reset': 'haunted_shared_reset'
    };
    
    const results = [];
    
    // Try Voice Monkey if user has set it up
    if (req.session.triggerMethod === 'voicemonkey') {
      try {
        const monkeyDevice = effectToMonkey[effect];
        const voiceMonkeyResponse = await axios.post(
          'https://api.voicemonkey.io/v1/monkey/trigger',
          {
            access_token: process.env.VOICE_MONKEY_TOKEN,
            device: monkeyDevice,
            text: `Triggering ${effect} effect`
          }
        );
        results.push({ method: 'voicemonkey', success: true });
      } catch (error) {
        console.error('Voice Monkey trigger failed:', error);
      }
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

// Add this temporary endpoint to test your lights right now
app.post('/api/test-ifttt-lights', async (req, res) => {
  const { effect } = req.body;
  
  // Get your IFTTT webhook key from https://ifttt.com/maker_webhooks
  const IFTTT_WEBHOOK_KEY = 'bdcBvFR0muTPnCVqQKDlqY'; // Replace with your actual key
  
  try {
    const response = await fetch(`https://maker.ifttt.com/trigger/haunted_${effect}/with/key/${IFTTT_WEBHOOK_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        value1: effect,
        value2: 'test_trigger',
        value3: new Date().toISOString()
      })
    });
    
    if (response.ok) {
      res.json({ success: true, effect: effect, message: 'IFTTT webhook triggered' });
    } else {
      throw new Error('IFTTT webhook failed');
    }
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

//=============== IFTTT

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

/// Replace your existing debug endpoints with these:

// Debug endpoint to check tokens
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

// Debug endpoint to see ALL sessions and tokens
app.get('/api/debug/all-tokens', (req, res) => {
  try {
    res.json({
      currentSessionId: req.sessionID,
      allAccessTokens: Object.fromEntries(alexaUserSessions.entries()),
      allRefreshTokens: Object.fromEntries(alexaRefreshTokens.entries()),
      totalSessions: alexaUserSessions.size,
      totalRefreshTokens: alexaRefreshTokens.size
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Simple endpoint to just get your main token
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
  try {
    const effect = (body.effect || body.event || "").trim();
    if (!effect) return res.status(400).json({ ok: false, error: "missing effect" });

    const allowed = new Set(["blackout", "flash_red", "plug_on", "reset"]);
    if (!allowed.has(effect)) {
      return res.status(400).json({ ok: false, error: "invalid effect" });
    }

    // Actually trigger your IFTTT service endpoint
    try {
      await axios.post(
        `https://haunted-production.up.railway.app/ifttt/v1/triggers/effect_requested`,
        { 
          triggerFields: { effect },
          user: { timezone: "Europe/Berlin" },
          limit: 1
        },
        {
          headers: {
            "IFTTT-Service-Key": process.env.IFTTT_SERVICE_KEY,
            "Content-Type": "application/json"
          },
          timeout: 5000
        }
      );
      return res.json({ ok: true, via: "ifttt-service-trigger" });
    } catch (e) {
      console.error("IFTTT trigger error:", e?.response?.data || e.message);
      return res.status(500).json({ ok: false, error: "IFTTT trigger failed" });
    }
    
  } catch (e) {
    console.error("Trigger error:", e.message);
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
  // ADD THIS LOGGING
  console.log("=== TRIGGER ENDPOINT CALLED ===");
  console.log("Headers:", req.headers);
  console.log("Authorization:", req.headers.authorization);
  console.log("Body:", req.body);
  console.log("================================");

  // Auth via Bearer token OR Service Key
  const auth = req.headers.authorization ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  const t = token && tokens.get(token);
  
  const svcKey = req.get("IFTTT-Service-Key") || req.get("ifttt-service-key");
  
  // ALLOW EITHER TOKEN OR SERVICE KEY
  if (!t && (!svcKey || svcKey !== process.env.IFTTT_SERVICE_KEY)) {
    console.log("AUTH FAILED - Token:", token?.substring(0, 8), "ServiceKey:", svcKey?.substring(0, 8));
    return res.status(401).json({ errors: [{ message: "invalid_token_or_service_key" }] });
  }

  console.log("AUTH SUCCESS - Using:", t ? "Bearer Token" : "Service Key");

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




//===================Debug IFTTT =====================

// Add this to your server
// Add this debug endpoint
app.get("/debug/tokens", (req, res) => {
  const allTokens = [];
  for (const [token, info] of tokens.entries()) {
    allTokens.push({
      token: token.substring(0, 8) + "...", // Don't expose full token
      userId: info.userId,
      createdAt: new Date(info.createdAt).toISOString()
    });
  }
  res.json({
    totalTokens: tokens.size,
    tokens: allTokens,
    serviceKey: process.env.IFTTT_SERVICE_KEY ? "SET" : "NOT SET"
  });
});

// Add this as a separate route, not inside handleTrigger
app.get("/dev/set-token", (req, res) => {
  req.session.ifttt = { access_token: "test-token-for-demo" };
  res.send("Token set! Now test your effects.");
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