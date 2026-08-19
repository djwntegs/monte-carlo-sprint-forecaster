const express = require('express');
const fetch   = require('node-fetch');
const router  = express.Router();

// Locked to the ADO org/project set in environment variables
function getAdoConfig() {
  const org     = process.env.ADO_ORG;
  const project = process.env.ADO_PROJECT;
  if (!org || !project) throw new Error('ADO_ORG and ADO_PROJECT must be set in environment variables');
  return { org, project };
}

function adoAuthHeader() {
  const pat = process.env.ADO_PAT;
  const encoded = Buffer.from(`:${pat}`).toString('base64');
  return `Basic ${encoded}`;
}

function adoBase(org)       { return `https://dev.azure.com/${org}`; }
function analyticsBase(org) { return `https://analytics.dev.azure.com/${org}`; }

// Classification node path (\Team30\Iteration\Batch 1) → WIQL iteration path (Team30\Batch 1)
function toWiqlIterationPath(nodePath) {
  return nodePath
    .replace(/^\\/, '')             // strip leading backslash
    .replace(/\\Iteration\\/, '\\') // remove \Iteration\ structural segment
    .replace(/\\Iteration$/, '');   // remove trailing \Iteration if at root
}

// Recursively flatten the classification node tree into a list
function flattenIterations(node, depth, results) {
  if (depth > 0) {
    results.push({
      id:          node.id,
      name:        node.name,
      path:        node.path,
      wiqlPath:    toWiqlIterationPath(node.path),
      hasChildren: !!(node.children && node.children.length)
    });
  }
  if (node.children) {
    node.children.forEach(child => flattenIterations(child, depth + 1, results));
  }
}

// GET /api/ado/info
router.get('/info', (req, res) => {
  try {
    const { org, project } = getAdoConfig();
    res.json({ org, project });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/ado/workitemtypes
// Returns the work item type names defined in the locked project
router.get('/workitemtypes', async (req, res) => {
  try {
    const { org, project } = getAdoConfig();
    const url = `${adoBase(org)}/${project}/_apis/wit/workitemtypes?api-version=7.1`;

    const response = await fetch(url, { headers: { Authorization: adoAuthHeader() } });
    if (!response.ok) {
      const text = await response.text();
      return res.status(response.status).json({ error: text });
    }

    const data  = await response.json();
    const types = (data.value || [])
      .map(t => ({ name: t.name, icon: t.icon?.url || null }))
      .sort((a, b) => a.name.localeCompare(b.name));

    res.json(types);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/ado/iterations
// Returns a flat list of all iteration paths (Batches) for the locked project
router.get('/iterations', async (req, res) => {
  try {
    const { org, project } = getAdoConfig();
    const url = `${adoBase(org)}/${project}/_apis/wit/classificationnodes/Iterations?$depth=10&api-version=7.1`;

    const response = await fetch(url, { headers: { Authorization: adoAuthHeader() } });
    if (!response.ok) {
      const text = await response.text();
      return res.status(response.status).json({ error: text });
    }

    const data    = await response.json();
    const results = [];
    flattenIterations(data, 0, results);
    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/ado/throughput?weeks=12&type=Bug
router.get('/throughput', async (req, res) => {
  const { weeks = 12, type } = req.query;

  try {
    const { org, project } = getAdoConfig();
    const typeFilter = type ? ` and WorkItemType eq '${type}'` : '';
    const url = `${analyticsBase(org)}/${project}/_odata/v3.0/WorkItemSnapshot?` +
      `$apply=filter(StateCategory eq 'Completed'${typeFilter})` +
      `/groupby((CompletedDateSK),aggregate($count as Count))` +
      `&$orderby=CompletedDateSK desc&$top=${weeks * 7}`;

    const response = await fetch(url, { headers: { Authorization: adoAuthHeader() } });
    if (!response.ok) {
      const text = await response.text();
      return res.status(response.status).json({ error: text });
    }

    res.json(await response.json());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/ado/backlog?type=Bug&iterationPath=Team30%5CBatch+2
// Returns count of open work items, optionally scoped to an iteration (Batch)
router.get('/backlog', async (req, res) => {
  const { areaPath, type, iterationPath } = req.query;

  try {
    const { org, project } = getAdoConfig();
    const areaFilter      = areaPath      ? ` AND [Area Path] UNDER '${areaPath}'`             : '';
    const typeFilter      = type          ? ` AND [Work Item Type] = '${type}'`                 : '';
    const iterationFilter = iterationPath ? ` AND [Iteration Path] UNDER '${iterationPath}'`    : '';

    const wiql = {
      query: `SELECT [Id] FROM WorkItems WHERE [State] NOT IN ('Closed','Done','Removed')${iterationFilter}${areaFilter}${typeFilter}`
    };

    const url = `${adoBase(org)}/${project}/_apis/wit/wiql?api-version=7.1`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { Authorization: adoAuthHeader(), 'Content-Type': 'application/json' },
      body: JSON.stringify(wiql)
    });

    if (!response.ok) {
      const text = await response.text();
      return res.status(response.status).json({ error: text });
    }

    const data = await response.json();
    res.json({ count: data.workItems.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
