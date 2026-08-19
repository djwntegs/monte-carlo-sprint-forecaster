const express   = require('express');
const { createClient } = require('@supabase/supabase-js');
const router    = express.Router();

function db() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
}

// GET /api/projects — list all projects
router.get('/', async (req, res) => {
  const { data, error } = await db().from('projects').select('*').order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// GET /api/projects/:id — single project
router.get('/:id', async (req, res) => {
  const { data, error } = await db().from('projects').select('*').eq('id', req.params.id).single();
  if (error) return res.status(404).json({ error: 'Project not found' });
  res.json(data);
});

// POST /api/projects — create project
router.post('/', async (req, res) => {
  const { name, ado_org, ado_project, period_label, category_allocations } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });

  const { data, error } = await db().from('projects').insert([{
    name,
    ado_org:              ado_org || null,
    ado_project:          ado_project || null,
    period_label:         period_label || 'Sprint',
    category_allocations: category_allocations || [{ name: 'Feature Work', pct: 100, color: '#6366F1' }]
  }]).select().single();

  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

// PUT /api/projects/:id — update project
router.put('/:id', async (req, res) => {
  const { name, ado_org, ado_project, period_label, category_allocations } = req.body;

  const { data, error } = await db().from('projects').update({
    name, ado_org, ado_project, period_label, category_allocations
  }).eq('id', req.params.id).select().single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// DELETE /api/projects/:id
router.delete('/:id', async (req, res) => {
  const { error } = await db().from('projects').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.status(204).send();
});

module.exports = router;
