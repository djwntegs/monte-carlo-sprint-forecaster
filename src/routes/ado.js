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
      hasChildren: !!(node.children && node.children.length),
      startDate:   node.attributes?.startDate   || null,
      finishDate:  node.attributes?.finishDate  || null
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

// GET /api/ado/batchprogress?iterationPath=Team30%5CBatch+1&type=Batch+Task
// Returns remaining, completed, total and % complete for a type within a batch
router.get('/batchprogress', async (req, res) => {
  const { iterationPath, type } = req.query;
  if (!iterationPath) return res.status(400).json({ error: 'iterationPath is required' });

  try {
    const { org, project } = getAdoConfig();
    const iterFilter = ` AND [Iteration Path] UNDER '${iterationPath}'`;
    const typeFilter  = type ? ` AND [Work Item Type] = '${type}'` : '';
    const url     = `${adoBase(org)}/${project}/_apis/wit/wiql?api-version=7.1`;
    const headers = { Authorization: adoAuthHeader(), 'Content-Type': 'application/json' };

    const [remRes, doneRes] = await Promise.all([
      fetch(url, { method: 'POST', headers, body: JSON.stringify({
        query: `SELECT [Id] FROM WorkItems WHERE [State] NOT IN ('Closed','Done','Removed')${iterFilter}${typeFilter}`
      })}),
      fetch(url, { method: 'POST', headers, body: JSON.stringify({
        query: `SELECT [Id] FROM WorkItems WHERE [State] IN ('Closed','Done','Resolved','Completed')${iterFilter}${typeFilter}`
      })})
    ]);

    if (!remRes.ok)  return res.status(remRes.status).json({ error: await remRes.text() });
    if (!doneRes.ok) return res.status(doneRes.status).json({ error: await doneRes.text() });

    const remaining  = (await remRes.json()).workItems.length;
    const completed  = (await doneRes.json()).workItems.length;
    const total      = remaining + completed;
    const pct        = total > 0 ? Math.round((completed / total) * 100) : 0;

    res.json({ remaining, completed, total, pct });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/ado/states?type=Batch+Task
// Returns state names for a given work item type
router.get('/states', async (req, res) => {
  const { type } = req.query;
  if (!type) return res.status(400).json({ error: 'type is required' });
  try {
    const { org, project } = getAdoConfig();
    const url = `${adoBase(org)}/${project}/_apis/wit/workitemtypes/${encodeURIComponent(type)}/states?api-version=7.1`;
    const response = await fetch(url, { headers: { Authorization: adoAuthHeader() } });
    if (!response.ok) return res.status(response.status).json({ error: await response.text() });
    const data = await response.json();
    res.json((data.value || []).map(s => s.name));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/ado/batchitems?iterationPath=Team30%5CBatch+1&type=Batch+Task
// Returns all non-removed work items in a batch with id, title, type, state
router.get('/batchitems', async (req, res) => {
  const { iterationPath, type } = req.query;
  if (!iterationPath) return res.status(400).json({ error: 'iterationPath is required' });

  try {
    const { org, project } = getAdoConfig();
    const typeFilter = type ? ` AND [Work Item Type] = '${type}'` : '';
    const headers    = { Authorization: adoAuthHeader(), 'Content-Type': 'application/json' };
    const wiqlUrl    = `${adoBase(org)}/${project}/_apis/wit/wiql?api-version=7.1`;

    const wiqlRes = await fetch(wiqlUrl, {
      method: 'POST', headers,
      body: JSON.stringify({
        query: `SELECT [Id] FROM WorkItems WHERE [Iteration Path] UNDER '${iterationPath}' AND [State] <> 'Removed'${typeFilter}`
      })
    });
    if (!wiqlRes.ok) return res.status(wiqlRes.status).json({ error: await wiqlRes.text() });

    const ids = (await wiqlRes.json()).workItems.map(w => w.id);
    if (!ids.length) return res.json([]);

    // Fetch details in batches of 200 (ADO limit)
    const items = [];
    for (let i = 0; i < ids.length; i += 200) {
      const batch     = ids.slice(i, i + 200);
      const detailUrl = `${adoBase(org)}/${project}/_apis/wit/workitems?ids=${batch.join(',')}&fields=System.Id,System.Title,System.WorkItemType,System.State&api-version=7.1`;
      const detailRes = await fetch(detailUrl, { headers: { Authorization: adoAuthHeader() } });
      if (!detailRes.ok) return res.status(detailRes.status).json({ error: await detailRes.text() });
      const detail = await detailRes.json();
      items.push(...(detail.value || []).map(w => ({
        id:    w.id,
        title: w.fields['System.Title'],
        type:  w.fields['System.WorkItemType'],
        state: w.fields['System.State']
      })));
    }

    res.json(items);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/ado/throughput?weeks=12&type=Bug&startDate=2024-01-01&doneState=Dev+Environment&detail=true
router.get('/throughput', async (req, res) => {
  const { weeks = 12, type, startDate, doneState, detail } = req.query;

  try {
    const { org, project } = getAdoConfig();
    const typeFilter = type ? ` and WorkItemType eq '${type}'` : '';

    let url;

    if (doneState) {
      let dateFilter = '';
      if (startDate) {
        const sk = startDate.replace(/-/g, '');
        dateFilter = ` and ChangedDateSK ge ${sk}`;
      }

      if (detail === 'true') {
        url = `${analyticsBase(org)}/${project}/_odata/v3.0/WorkItemRevisions?` +
          `$apply=filter(State eq '${doneState}'${typeFilter}${dateFilter})` +
          `/groupby((WorkItemId),aggregate(ChangedDateSK with min as CompletedDateSK))` +
          `&$orderby=CompletedDateSK asc`;
      } else {
        url = `${analyticsBase(org)}/${project}/_odata/v3.0/WorkItemRevisions?` +
          `$apply=filter(State eq '${doneState}'${typeFilter}${dateFilter})` +
          `/groupby((WorkItemId),aggregate(ChangedDateSK with min as CompletedDateSK))` +
          `/groupby((CompletedDateSK),aggregate($count as Count))` +
          `&$orderby=CompletedDateSK asc`;
      }
    } else {
      // Default: use ADO's built-in StateCategory = Completed
      let dateFilter = '';
      let topClause  = `&$orderby=CompletedDateSK desc&$top=${weeks * 7}`;
      if (startDate) {
        const sk = startDate.replace(/-/g, '');
        dateFilter = ` and CompletedDateSK ge ${sk}`;
        topClause  = `&$orderby=CompletedDateSK asc`;
      }
      url = `${analyticsBase(org)}/${project}/_odata/v3.0/WorkItemSnapshot?` +
        `$apply=filter(StateCategory eq 'Completed'${typeFilter}${dateFilter})` +
        `/groupby((CompletedDateSK),aggregate($count as Count))` +
        topClause;
    }

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
  const { areaPath, type, iterationPath, doneStates } = req.query;

  try {
    const { org, project } = getAdoConfig();
    const areaFilter      = areaPath      ? ` AND [Area Path] UNDER '${areaPath}'`          : '';
    const typeFilter      = type          ? ` AND [Work Item Type] = '${type}'`              : '';
    const iterationFilter = iterationPath ? ` AND [Iteration Path] UNDER '${iterationPath}'` : '';

    // Always exclude ADO built-in closed states plus any team-specific done states
    const builtIn   = ['Closed', 'Done', 'Removed'];
    const custom    = doneStates ? doneStates.split(',').map(s => s.trim()).filter(Boolean) : [];
    const allClosed = [...new Set([...builtIn, ...custom])];
    const stateList = allClosed.map(s => `'${s.replace(/'/g, '')}'`).join(',');

    const wiql = {
      query: `SELECT [Id] FROM WorkItems WHERE [State] NOT IN (${stateList})${iterationFilter}${areaFilter}${typeFilter}`
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
