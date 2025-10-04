import express from "express";
import session from "express-session";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

import { TokenManager } from './services/tokenManager.js';
import { SENSOR_CONFIG } from './config/constants.js';
import { createAlexaRoutes } from './routes/alexa.js';
import { createTriggerRoutes } from './routes/triggers.js';
import { createDebugRoutes } from './routes/debug.js';

dotenv.config();

const app = express();
const tokenManager = new TokenManager();
const deviceStates = new Map();

// Initialize sensor states
Object.values(SENSOR_CONFIG).forEach(config => {
  deviceStates.set(config.endpointId, "NOT_DETECTED");
});

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || "haunted",
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: "lax", maxAge: 24 * 60 * 60 * 1000 }
}));
app.use(express.static("public"));

// Routes
app.use('/alexa', createAlexaRoutes(tokenManager, deviceStates));
app.use('/api', createTriggerRoutes(tokenManager, deviceStates));
app.use('/api/debug', createDebugRoutes(tokenManager));

// Watch page
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.get("/watch", (req, res) => {
  const filePath = path.join(__dirname, "public", "watch.html");
  res.sendFile(filePath, err => {
    if (err) {
      res.status(200).type("html").send(`<h1>Haunted Demo</h1>`);
    }
  });
});

// Error handling
process.on('uncaughtException', (error) => {
  console.error('UNCAUGHT EXCEPTION:', error);
});

process.on('unhandledRejection', (reason) => {
  console.error('UNHANDLED REJECTION:', reason);
});

// Server startup
const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
  console.log(`Haunted House server running on port ${PORT}`);
  console.log(`Contact sensors ready`);
}).on('error', (err) => {
  console.error(`Server error:`, err);
  process.exit(1);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('Shutting down...');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});