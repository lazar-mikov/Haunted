import axios from 'axios';

export async function sendAlexaChangeReport(endpointId, detectionState, accessToken, tokenManager) {
  const payload = {
    event: {
      header: {
        namespace: "Alexa",
        name: "ChangeReport",
        messageId: `msg-${Date.now()}`,
        payloadVersion: "3"
      },
      endpoint: {
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
            value: detectionState,
            timeOfSample: new Date().toISOString(),
            uncertaintyInMilliseconds: 0
          }]
        }
      }
    }
  };

  const url = 'https://api.eu.amazonalexa.com/v3/events';
  
  try {
    console.log(`Sending change report for ${endpointId}: ${detectionState}`);
    
    const response = await axios.post(url, payload, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      timeout: 10000
    });
    
    console.log(`Change report sent successfully for ${endpointId}`);
    return response.data;
  } catch (error) {
    // Token expired - try to refresh
    if (error.response?.status === 401 && tokenManager) {
      console.log('Access token expired, attempting refresh...');
      
      const newToken = await tokenManager.refreshAccessToken(accessToken);
      
      if (newToken) {
        console.log('Token refreshed, retrying change report...');
        // Retry with new token
        const retryResponse = await axios.post(url, payload, {
          headers: {
            'Authorization': `Bearer ${newToken}`,
            'Content-Type': 'application/json'
          },
          timeout: 10000
        });
        
        console.log(`Change report sent successfully after token refresh for ${endpointId}`);
        return retryResponse.data;
      }
    }
    
    console.error(`Failed to send change report for ${endpointId}:`, error.response?.data || error.message);
    throw error;
  }
}