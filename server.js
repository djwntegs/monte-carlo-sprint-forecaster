require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const path    = require('path');
const crypto  = require('crypto');

const adoRoutes      = require('./src/routes/ado');
const projectRoutes  = require('./src/routes/projects');
const forecastRoutes = require('./src/routes/forecasts');

const app  = express();
const PORT = process.env.PORT || 3000;

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// Shared-password gate over everything, including /api. Fails closed if unset.
app.use((req, res, next) => {
  const password = process.env.APP_PASSWORD;
  if (!password) return res.status(503).send('APP_PASSWORD is not set - refusing to serve without authentication.');

  const [scheme, encoded] = (req.headers.authorization || '').split(' ');
  if (scheme === 'Basic' && encoded) {
    const decoded = Buffer.from(encoded, 'base64').toString();
    const i = decoded.indexOf(':');
    const userOk = safeEqual(i < 0 ? decoded : decoded.slice(0, i), process.env.APP_USER || 'batchcast');
    const passOk = safeEqual(i < 0 ? '' : decoded.slice(i + 1), password);
    if (userOk && passOk) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="BatchCast", charset="UTF-8"');
  res.status(401).send('Authentication required');
});

app.use(cors());
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

app.listen(PORT, () => {
  console.log(`Monte Carlo Forecaster running on port ${PORT}`);
});
