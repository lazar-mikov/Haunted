export function handleAlexaStateReport(directive, deviceStates, res) {
  try {
    const endpointId = directive.endpoint.endpointId;
    console.log(`State report requested for: ${endpointId}`);
    
    if (!endpointId.includes('haunted-') || !endpointId.includes('-sensor')) {
      return res.status(400).json({ error: 'Unknown endpoint' });
    }

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
    
    res.json(response);
  } catch (error) {
    console.error('State report error:', error);
    res.status(500).json({ error: 'INTERNAL_ERROR', message: error.message });
  }
}