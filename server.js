require('dotenv').config();
const express = require('express');
const path    = require('path');

const { createAuth, createAttemptLimiter, resolveHost, trustProxyHops } = require('./src/lib/auth');
const adoRoutes      = require('./src/routes/ado');
const projectRoutes  = require('./src/routes/projects');
const forecastRoutes = require('./src/routes/forecasts');

function createApp(env = process.env, { limiter = createAttemptLimiter() } = {}) {
  const app = express();
  app.set('trust proxy', trustProxyHops(env));

  // Everything below, pages and /api alike, sits behind this gate.
  app.use(createAuth({ env, limiter }));

  app.use(express.json());

  // Static frontend
  app.use(express.static(path.join(__dirname, 'public')));

  // API routes
  app.use('/api/ado',       adoRoutes);
  app.use('/api/projects',  projectRoutes);
  app.use('/api/forecasts', forecastRoutes);

  // Fallback to index.html for any unmatched route
  app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  });

  return app;
}

function start(env = process.env) {
  const host = resolveHost(env);
  const port = env.PORT || 3000;
  const app  = createApp(env);
  return app.listen(port, host, () => {
    console.log(`Monte Carlo Forecaster running on ${host}:${port}`);
  });
}

if (require.main === module) start();

module.exports = { createApp, start };
