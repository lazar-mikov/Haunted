import express from 'express';
import { handleAlexaDiscovery } from '../handlers/alexaDiscovery.js';
import { handleAlexaStateReport } from '../handlers/alexaStateReport.js';
import { handleAcceptGrant } from '../handlers/alexaGrant.js';

export function createAlexaRoutes(tokenManager, deviceStates) {
  const router = express.Router();

  router.post('/smarthome', async (req, res) => {
    console.log('Alexa Smart Home request');
    const { directive } = req.body;

    if (directive?.header?.namespace === 'Alexa.Discovery') {
      return handleAlexaDiscovery(directive, res);
    }

    if (directive?.header?.namespace === 'Alexa' && directive?.header?.name === 'ReportState') {
      return handleAlexaStateReport(directive, deviceStates, res);
    }

    res.status(400).json({ error: 'UNSUPPORTED_OPERATION' });
  });

  router.post('/handle-grant', async (req, res) => {
    try {
      const response = await handleAcceptGrant(req.body.directive, tokenManager);
      res.json(response);
    } catch (error) {
      console.error('Grant failed:', error.message);
      res.status(500).json({ 
        event: {
          header: {
            namespace: "Alexa.Authorization",
            name: "ErrorResponse",
            messageId: req.body?.directive?.header?.messageId || 'error',
            payloadVersion: "3"
          },
          payload: {
            type: "ACCEPT_GRANT_FAILED",
            message: "Token exchange failed"
          }
        }
      });
    }
  });

  return router;
}