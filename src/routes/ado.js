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

// GET /api/ado/info
// Returns the locked org and project name so the frontend can display it
router.get('/info', (req, res) => {
  try {
    const { org, project } = getAdoConfig();
    res.json({ org, project });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/ado/throughput?weeks=12&type=Bug
// Returns completed item counts grouped by week for the locked project
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

// GET /api/ado/backlog?areaPath=MyTeam&type=Bug
// Returns count of open work items for the locked project
router.get('/backlog', async (req, res) => {
  const { areaPath, type } = req.query;

  try {
    const { org, project } = getAdoConfig();
    const areaFilter = areaPath ? ` AND [Area Path] UNDER '${areaPath}'` : '';
    const typeFilter  = type    ? ` AND [Work Item Type] = '${type}'`    : '';

    const wiql = {
      query: `SELECT [Id] FROM WorkItems WHERE [State] NOT IN ('Closed','Done','Removed')${areaFilter}${typeFilter}`
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
