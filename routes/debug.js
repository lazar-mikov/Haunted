import express from 'express';

export function createDebugRoutes(tokenManager) {
  const router = express.Router();

  router.get('/tokens', (req, res) => {
    const info = tokenManager.getAllTokenInfo();
    res.json({
      sessionId: req.sessionID,
      ...info
    });
  });

  router.get('/health', (req, res) => {
    res.json({ 
      status: 'ok', 
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      ...tokenManager.getAllTokenInfo()
    });
  });

  return router;
}