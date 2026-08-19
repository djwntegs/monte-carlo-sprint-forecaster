const express = require('express');
const fetch   = require('node-fetch');
const router  = express.Router();

function adoAuthHeader() {
  const pat = process.env.ADO_PAT;
  const encoded = Buffer.from(`:${pat}`).toString('base64');
  return `Basic ${encoded}`;
}

// GET /api/ado/throughput?org=myorg&project=myproject&weeks=12&type=Bug
// Returns completed item counts grouped by week
router.get('/throughput', async (req, res) => {
  const { org, project, weeks = 12, type } = req.query;
  if (!org || !project) return res.status(400).json({ error: 'org and project are required' });

  try {
    const typeFilter = type ? ` and WorkItemType eq '${type}'` : '';
    const url = `https://analytics.dev.azure.com/${org}/${project}/_odata/v3.0/WorkItemSnapshot?` +
      `$apply=filter(StateCategory eq 'Completed'${typeFilter})` +
      `/groupby((CompletedDateSK),aggregate($count as Count))` +
      `&$orderby=CompletedDateSK desc&$top=${weeks * 7}`;

    const response = await fetch(url, {
      headers: { Authorization: adoAuthHeader() }
    });

    if (!response.ok) {
      const text = await response.text();
      return res.status(response.status).json({ error: text });
    }

    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/ado/backlog?org=myorg&project=myproject&areaPath=MyTeam&type=Bug
// Returns count of open (not completed) work items
router.get('/backlog', async (req, res) => {
  const { org, project, areaPath, type } = req.query;
  if (!org || !project) return res.status(400).json({ error: 'org and project are required' });

  try {
    const areaFilter  = areaPath ? ` AND [Area Path] UNDER '${areaPath}'` : '';
    const typeFilter  = type     ? ` AND [Work Item Type] = '${type}'`    : '';

    const wiql = {
      query: `SELECT [Id] FROM WorkItems WHERE [State] NOT IN ('Closed','Done','Removed')${areaFilter}${typeFilter}`
    };

    const url = `https://dev.azure.com/${org}/${project}/_apis/wit/wiql?api-version=7.1`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: adoAuthHeader(),
        'Content-Type': 'application/json'
      },
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

// GET /api/ado/projects?org=myorg
// Lists all ADO projects in the org the PAT has access to
router.get('/projects', async (req, res) => {
  const { org } = req.query;
  if (!org) return res.status(400).json({ error: 'org is required' });

  try {
    const url = `https://dev.azure.com/${org}/_apis/projects?api-version=7.1`;
    const response = await fetch(url, {
      headers: { Authorization: adoAuthHeader() }
    });

    if (!response.ok) {
      const text = await response.text();
      return res.status(response.status).json({ error: text });
    }

    const data = await response.json();
    res.json(data.value.map(p => ({ id: p.id, name: p.name })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
