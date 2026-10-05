const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

process.env.ADO_ORG = 'org';
process.env.ADO_PROJECT = 'proj';
process.env.ADO_PAT = 'test-pat';

// Replace node-fetch before the router loads so we can see exactly what would be sent to ADO.
const calls = [];
const fetchPath = require.resolve('node-fetch');
require.cache[fetchPath] = {
  id: fetchPath, filename: fetchPath, loaded: true,
  exports: async (url, opts = {}) => {
    calls.push({ url: String(url), body: opts.body ? JSON.parse(opts.body) : undefined });
    return { ok: true, status: 200, json: async () => ({ value: [], workItems: [] }), text: async () => '' };
  }
};

const router = require('../src/routes/ado');
const { optStr, quote, odataLit } = require('../src/lib/query');

let server, base;
before(async () => {
  const app = express();
  app.use('/api/ado', router);
  await new Promise(r => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}/api/ado`;
});
after(() => server.close());
beforeEach(() => { calls.length = 0; });

const get = (path, params) => fetch(`${base}${path}?${new URLSearchParams(params)}`);
const applyOf = url => new URL(url).searchParams.get('$apply');
const paramNames = url => [...new URL(url).searchParams.keys()];

test('helpers: quote doubles single quotes, odataLit also percent-encodes', () => {
  assert.equal(quote("a'b"), "a''b");
  assert.equal(odataLit("a'b&c#d"), "a''b%26c%23d");
});

test('helpers: optStr accepts normal values and rejects arrays, objects, control characters and long input', () => {
  assert.equal(optStr('Batch Task', 'x'), 'Batch Task');
  assert.equal(optStr('Team30\\Batch 2', 'x'), 'Team30\\Batch 2');
  assert.equal(optStr('', 'x'), undefined);
  assert.equal(optStr(undefined, 'x'), undefined);
  assert.throws(() => optStr(['a', 'b'], 'x'), { status: 400 });
  assert.throws(() => optStr({ a: 'b' }, 'x'), { status: 400 });
  assert.throws(() => optStr('a' + String.fromCharCode(0) + 'b', 'x'), { status: 400 });
  assert.throws(() => optStr('a' + String.fromCharCode(10) + 'b', 'x'), { status: 400 });
  assert.throws(() => optStr('a'.repeat(201), 'x'), { status: 400 });
});

test('throughput: normal request builds the expected OData filter (regression)', async () => {
  const res = await get('/throughput', {
    doneState: 'Dev Environment', type: 'Batch Task', startDate: '2026-09-02',
    iterationPath: 'Team30\\Otto Batch 2', detail: 'true'
  });
  assert.equal(res.status, 200);
  assert.equal(calls.length, 1);
  assert.deepEqual(paramNames(calls[0].url), ['$apply', '$orderby']);
  assert.equal(
    applyOf(calls[0].url),
    "filter(State eq 'Dev Environment' and WorkItemType eq 'Batch Task'" +
    " and (Iteration/IterationPath eq 'Team30\\Otto Batch 2' or startswith(Iteration/IterationPath, 'Team30\\Otto Batch 2\\'))" +
    " and ChangedDateSK ge 20260902)" +
    "/groupby((WorkItemId),aggregate(ChangedDateSK with min as CompletedDateSK))"
  );
});

test('throughput: quotes and & # in doneState/type/iterationPath cannot break out of the literal or add URL options', async () => {
  const evil = "x' or 1 eq 1 or State eq 'y&$top=1&$filter=true#frag";
  const res = await get('/throughput', { doneState: evil, type: evil, iterationPath: evil });
  assert.equal(res.status, 200);
  const url = calls[0].url;
  assert.deepEqual(paramNames(url), ['$apply', '$orderby']);
  const escaped = quote(evil);
  assert.ok(applyOf(url).includes(`State eq '${escaped}'`));
  assert.ok(applyOf(url).includes(`WorkItemType eq '${escaped}'`));
  assert.ok(applyOf(url).includes(`Iteration/IterationPath eq '${escaped}'`));
});

test('throughput: startDate and weeks that are not plain values are rejected without calling ADO', async () => {
  for (const params of [
    { doneState: 'Done', startDate: '2026-09-02 or 1 eq 1' },
    { doneState: 'Done', startDate: '20260902' },
    { weeks: 'abc' }, { weeks: '0' }, { weeks: '9999' }, { weeks: '1;2' },
  ]) {
    const res = await get('/throughput', params);
    assert.equal(res.status, 400, JSON.stringify(params));
  }
  assert.equal(calls.length, 0);
});

test('throughput: default (no doneState) branch still builds a bounded $top', async () => {
  const res = await get('/throughput', { weeks: '4' });
  assert.equal(res.status, 200);
  assert.ok(calls[0].url.includes('%24top=28') || calls[0].url.includes('$top=28'));
});

test('WIQL routes: quotes in iterationPath/type/areaPath are doubled', async () => {
  const evil = "a' OR [System.State] <> 'x";
  for (const path of ['/batchprogress', '/batchitems', '/backlog']) {
    calls.length = 0;
    const res = await get(path, { iterationPath: evil, type: evil, areaPath: evil });
    assert.equal(res.status, 200, path);
    const queries = calls.filter(c => c.body).map(c => c.body.query);
    assert.ok(queries.length >= 1, path);
    for (const q of queries) {
      assert.ok(q.includes(`UNDER '${quote(evil)}'`), `${path}: ${q}`);
      assert.ok(q.includes(`'${quote(evil)}'`), `${path}: ${q}`);
      assert.ok(!q.includes("'a' OR [System.State] <> 'x'"), `${path} has an unescaped breakout: ${q}`);
    }
  }
});

test('backlog: custom done states keep their apostrophes (escaped, not stripped)', async () => {
  const res = await get('/backlog', { iterationPath: 'Team30\\B', doneStates: "Won't Fix, Dev Environment" });
  assert.equal(res.status, 200);
  assert.ok(calls[0].body.query.includes("'Won''t Fix'"));
  assert.ok(calls[0].body.query.includes("'Dev Environment'"));
});

test('missing or repeated parameters return 400 and never reach ADO', async () => {
  assert.equal((await get('/batchprogress', {})).status, 400);
  assert.equal((await get('/batchitems', {})).status, 400);
  assert.equal((await get('/states', {})).status, 400);
  const repeated = await fetch(`${base}/batchprogress?iterationPath=a&iterationPath=b`);
  assert.equal(repeated.status, 400);
  assert.equal(calls.length, 0);
});
