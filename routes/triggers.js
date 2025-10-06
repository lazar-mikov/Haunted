import express from 'express';
import { SENSOR_CONFIG } from '../config/constants.js';
import { sendAlexaChangeReport } from '../handlers/alexaChangeReport.js';
import { triggerIFTTT } from '../services/ifttt.js';

export function createTriggerRoutes(tokenManager, deviceStates) {
  const router = express.Router();

  async function triggerContactSensor(sensorId, effect) {
    // Get ALL user tokens
    const allTokens = await tokenManager.getAllEventGatewayTokens();
    
    if (allTokens.length === 0) {
      console.warn('No Event Gateway tokens available');
      return { success: false, message: 'No users linked' };
    }

    try {
      console.log(`Broadcasting ${effect} to ${allTokens.length} users`);
      
      // Send change reports to ALL users in parallel
      const reportPromises = allTokens.map(async (token, index) => {
        try {
          console.log(`  User ${index + 1}: Triggering...`);
          
          deviceStates.set(sensorId, "DETECTED");
          await sendAlexaChangeReport(sensorId, "DETECTED", token, tokenManager);
          
          setTimeout(async () => {
            try {
              deviceStates.set(sensorId, "NOT_DETECTED");
              await sendAlexaChangeReport(sensorId, "NOT_DETECTED", token, tokenManager);
            } catch (error) {
              console.error(`  User ${index + 1}: Failed to reset:`, error.message);
            }
          }, 2000);
          
          console.log(`  User ${index + 1}: Success`);
          return { success: true };
        } catch (error) {
          console.error(`  User ${index + 1}: Failed:`, error.message);
          return { success: false, error: error.message };
        }
      });

      const results = await Promise.all(reportPromises);
      const successCount = results.filter(r => r.success).length;

      console.log(`Triggered for ${successCount}/${allTokens.length} users`);

      return { 
        success: successCount > 0, 
        message: `Triggered ${effect} for ${successCount}/${allTokens.length} users`,
        usersTriggered: successCount,
        totalUsers: allTokens.length
      };
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