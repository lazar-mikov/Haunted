import express from 'express';
import { SENSOR_CONFIG } from '../config/constants.js';
import { sendAlexaChangeReport } from '../handlers/alexaChangeReport.js';
import { triggerIFTTT } from '../services/ifttt.js';

export function createTriggerRoutes(tokenManager, deviceStates) {
  const router = express.Router();

  async function triggerContactSensor(sensorId, effect) {
    const accessToken = await tokenManager.getEventGatewayToken();
    
    if (!accessToken) {
      console.warn('No Event Gateway token available');
      return { success: false, message: 'No Event Gateway token' };
    }

    try {
      deviceStates.set(sensorId, "DETECTED");
      await sendAlexaChangeReport(sensorId, "DETECTED", accessToken);
      
      setTimeout(async () => {
        try {
          deviceStates.set(sensorId, "NOT_DETECTED");
          await sendAlexaChangeReport(sensorId, "NOT_DETECTED", accessToken);
        } catch (error) {
          console.error(`Failed to reset sensor ${sensorId}:`, error.message);
        }
      }, 2000);
      
      return { success: true, message: `Triggered ${effect}` };
    } catch (error) {
      return { success: false, message: error.message };
    }
  }

  router.post('/trigger-direct', async (req, res) => {
    const { effect } = req.body;
    
    const config = SENSOR_CONFIG[effect];
    if (!config) {
      return res.status(400).json({ 
        success: false, 
        message: `Unknown effect: ${effect}` 
      });
    }

    const [sensorResult, iftttResult] = await Promise.all([
      triggerContactSensor(config.endpointId, effect),
      triggerIFTTT(effect)
    ]);

    res.json({
      success: sensorResult.success || iftttResult.success,
      sensor: sensorResult,
      ifttt: iftttResult,
      effect: effect,
      timestamp: new Date().toISOString()
    });
  });

  router.get('/sensor-states', (req, res) => {
    const states = Object.fromEntries(deviceStates.entries());
    res.json({ states });
  });

  return router;
}