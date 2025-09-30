import axios from 'axios';
import crypto from 'crypto';
import { ALEXA_REGION } from '../config/constants.js';

export async function sendAlexaChangeReport(endpointId, newState, accessToken) {
  try {
    console.log(`Sending change report for ${endpointId}: ${newState}`);
    
    const event = {
      event: {
        header: {
          namespace: "Alexa",
          name: "ChangeReport",
          messageId: crypto.randomUUID(),
          payloadVersion: "3"
        },
        endpoint: {
          scope: { type: "BearerToken", token: accessToken },
          endpointId: endpointId
        },
        payload: {
          change: {
            cause: { type: "PHYSICAL_INTERACTION" },
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

    await axios.post(ALEXA_REGION, event, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      timeout: 5000
    });

    console.log(`Change report sent successfully for ${endpointId}`);
    return { success: true };
  } catch (error) {
    console.error(`Failed to send change report for ${endpointId}:`, error.response?.data || error.message);
    throw error;
  }
}