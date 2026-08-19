require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const path    = require('path');

const adoRoutes      = require('./src/routes/ado');
const projectRoutes  = require('./src/routes/projects');
const forecastRoutes = require('./src/routes/forecasts');

const app  = express();
const PORT = process.env.PORT || 3000;

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
