const express   = require('express');
const { createClient } = require('@supabase/supabase-js');
const router    = express.Router();

const SUPABASE_CONFIGURED = !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY);

router.use((req, res, next) => {
  if (!SUPABASE_CONFIGURED) return res.status(503).json({ error: 'Supabase not configured — set SUPABASE_URL and SUPABASE_SERVICE_KEY in .env' });
  next();
});

function db() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
}

// GET /api/forecasts?project_id=xxx — all forecasts for a project
router.get('/', async (req, res) => {
  const { project_id } = req.query;
  if (!project_id) return res.status(400).json({ error: 'project_id is required' });

  const { data, error } = await db()
    .from('forecasts')
    .select('*')
    .eq('project_id', project_id)
    .order('run_date', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// GET /api/forecasts/baseline?project_id=xxx — the pinned baseline forecast
router.get('/baseline', async (req, res) => {
  const { project_id } = req.query;
  if (!project_id) return res.status(400).json({ error: 'project_id is required' });

  const { data, error } = await db()
    .from('forecasts')
    .select('*')
    .eq('project_id', project_id)
    .eq('is_baseline', true)
    .single();

  if (error) return res.status(404).json({ error: 'No baseline set for this project' });
  res.json(data);
});

// POST /api/forecasts — save a forecast run
router.post('/', async (req, res) => {
  const { project_id, backlog_size, period_label, sim_count, throughput_data, results, notes } = req.body;
  if (!project_id || !results) return res.status(400).json({ error: 'project_id and results are required' });

  const { data, error } = await db().from('forecasts').insert([{
    project_id,
    run_date:        new Date().toISOString(),
    backlog_size,
    period_label:    period_label || 'Sprint',
    sim_count:       sim_count || 10000,
    throughput_data: throughput_data || [],
    results,
    is_baseline:     false,
    notes:           notes || null
  }]).select().single();

  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

// PUT /api/forecasts/:id/baseline — pin this forecast as the baseline
// Clears any existing baseline for the same project first
router.put('/:id/baseline', async (req, res) => {
  const supabase = db();

  // Get the forecast to find its project_id
  const { data: forecast, error: fetchErr } = await supabase
    .from('forecasts').select('project_id').eq('id', req.params.id).single();
  if (fetchErr) return res.status(404).json({ error: 'Forecast not found' });

  // Clear existing baseline for this project
  await supabase.from('forecasts')
    .update({ is_baseline: false })
    .eq('project_id', forecast.project_id);

  // Set new baseline
  const { data, error } = await supabase.from('forecasts')
    .update({ is_baseline: true })
    .eq('id', req.params.id)
    .select().single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// DELETE /api/forecasts/:id
router.delete('/:id', async (req, res) => {
  const { error } = await db().from('forecasts').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.status(204).send();
});

module.exports = router;
