import { SENSOR_CONFIG } from '../config/constants.js';

export function handleAlexaDiscovery(directive, res) {
  console.log('Discovery request received');
  
  if (directive.header.name !== 'Discover') {
    return res.status(400).json({ error: 'Unknown directive' });
  }

  try {
    const virtualEndpoints = Object.entries(SENSOR_CONFIG).map(([effect, config]) => ({
      endpointId: config.endpointId,
      manufacturerName: "Haunted House",
      friendlyName: config.friendlyName,
      description: config.description,
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
    }));

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

    console.log(`Prepared ${virtualEndpoints.length} virtual contact sensors`);
    res.json(response);
  } catch (error) {
    console.error('Discovery failed:', error);
    res.status(500).json({ error: 'Discovery failed', message: error.message });
  }
}