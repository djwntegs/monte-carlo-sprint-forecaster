const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { createApp, start } = require('../server');
const { createAttemptLimiter, resolveHost, trustProxyHops } = require('../src/lib/auth');

const servers = [];
afterEach(() => { while (servers.length) servers.pop().close(); });

async function boot(env, limiterOpts) {
  const limiter = createAttemptLimiter(limiterOpts);
  const server = await new Promise(r => { const s = createApp(env, { limiter }).listen(0, '127.0.0.1', () => r(s)); });
  servers.push(server);
  return { base: `http://127.0.0.1:${server.address().port}`, limiter };
}

const basic = (u, p) => ({ Authorization: 'Basic ' + Buffer.from(`${u}:${p}`).toString('base64') });
const status = async (base, path = '/', headers = {}) => (await fetch(base + path, { headers })).status;
const ENV = { APP_PASSWORD: 'correct-horse' };

test('unset APP_PASSWORD: every path returns 503, even with credentials', async () => {
  const { base } = await boot({});
  for (const path of ['/', '/index.html', '/api/projects', '/api/ado/iterations']) {
    assert.equal(await status(base, path), 503, path);
    assert.equal(await status(base, path, basic('batchcast', '')), 503, path);
  }
  const empty = await boot({ APP_PASSWORD: '' });
  assert.equal(await status(empty.base), 503);
});

test('401 for no header, wrong user, wrong password, non-Basic scheme and malformed values', async () => {
  const { base } = await boot(ENV);
  const bad = {
    'no header': {},
    'wrong password': basic('batchcast', 'nope'),
    'wrong user': basic('admin', 'correct-horse'),
    'empty password': basic('batchcast', ''),
    'bearer scheme': { Authorization: 'Bearer correct-horse' },
    'no colon': { Authorization: 'Basic ' + Buffer.from('batchcast').toString('base64') },
    'basic with no value': { Authorization: 'Basic' },
    'garbage': { Authorization: 'Basic !!!not-base64!!!' },
  };
  for (const [name, headers] of Object.entries(bad)) assert.equal(await status(base, '/', headers), 401, name);
  const res = await fetch(base + '/');
  assert.match(res.headers.get('www-authenticate'), /^Basic realm="BatchCast"/);
});

test('the gate covers static files and the API, not just the page', async () => {
  const { base } = await boot(ENV);
  for (const path of ['/', '/index.html', '/api/projects', '/api/forecasts', '/api/ado/iterations', '/api/ado/info', '/nonexistent']) {
    assert.equal(await status(base, path), 401, path);
  }
});

test('correct credentials pass: default user, APP_USER override, and a password containing a colon', async () => {
  const a = await boot(ENV);
  assert.equal(await status(a.base, '/', basic('batchcast', 'correct-horse')), 200);
  const b = await boot({ APP_PASSWORD: 'p:w:d', APP_USER: 'team' });
  assert.equal(await status(b.base, '/', basic('team', 'p:w:d')), 200);
  assert.equal(await status(b.base, '/', basic('batchcast', 'p:w:d')), 401);
});

test('lockout: the 10th wrong attempt is still 401, the 11th is 429 with Retry-After, and the right password is then refused', async () => {
  const { base } = await boot(ENV);
  for (let i = 0; i < 10; i++) assert.equal(await status(base, '/', basic('batchcast', 'wrong' + i)), 401, 'attempt ' + (i + 1));
  const locked = await fetch(base + '/', { headers: basic('batchcast', 'wrong') });
  assert.equal(locked.status, 429);
  assert.ok(Number(locked.headers.get('retry-after')) > 0);
  assert.equal(await status(base, '/', basic('batchcast', 'correct-horse')), 429);
  assert.equal(await status(base, '/api/projects', basic('batchcast', 'correct-horse')), 429);
});

test('requests with no credentials do not count towards lockout', async () => {
  const { base } = await boot(ENV);
  for (let i = 0; i < 30; i++) assert.equal(await status(base), 401);
  assert.equal(await status(base, '/', basic('batchcast', 'correct-horse')), 200);
});

test('a successful login resets the failure count', async () => {
  const { base } = await boot(ENV);
  for (let i = 0; i < 9; i++) await status(base, '/', basic('batchcast', 'wrong'));
  assert.equal(await status(base, '/', basic('batchcast', 'correct-horse')), 200);
  for (let i = 0; i < 9; i++) assert.equal(await status(base, '/', basic('batchcast', 'wrong')), 401);
  assert.equal(await status(base, '/', basic('batchcast', 'correct-horse')), 200);
});

test('lockout expires when the window passes', async () => {
  let t = 1_000_000;
  const { base } = await boot(ENV, { now: () => t });
  for (let i = 0; i < 10; i++) await status(base, '/', basic('batchcast', 'wrong'));
  assert.equal(await status(base, '/', basic('batchcast', 'correct-horse')), 429);
  t += 15 * 60 * 1000 - 1;
  assert.equal(await status(base, '/', basic('batchcast', 'correct-horse')), 429);
  t += 2;
  assert.equal(await status(base, '/', basic('batchcast', 'correct-horse')), 200);
});

test('limiter keeps its table bounded and prunes expired entries', () => {
  let t = 0;
  const l = createAttemptLimiter({ maxEntries: 3, windowMs: 1000, now: () => t });
  ['a', 'b', 'c', 'd', 'e'].forEach(k => l.fail(k));
  assert.equal(l.size(), 3);
  t = 5000;
  l.fail('f');
  assert.equal(l.size(), 1);
});

test('on Render the client address comes from X-Forwarded-For and a forged leading entry is ignored', async () => {
  const { base } = await boot({ ...ENV, RENDER: 'true' });
  const from = (xff, pw = 'wrong') => status(base, '/', { 'X-Forwarded-For': xff, ...basic('batchcast', pw) });
  for (let i = 0; i < 10; i++) await from('203.0.113.7');
  assert.equal(await from('203.0.113.7'), 429, 'the failing client is locked out');
  assert.equal(await from('198.51.100.9', 'correct-horse'), 200, 'a different client is unaffected');
  assert.equal(await from('1.2.3.4, 203.0.113.7', 'correct-horse'), 429, 'forging an extra leading address does not escape the lockout');
});

test('off Render, X-Forwarded-For is ignored so a client cannot pick its own address', async () => {
  const { base } = await boot(ENV);
  for (let i = 0; i < 10; i++) await status(base, '/', { 'X-Forwarded-For': `10.0.0.${i}`, ...basic('batchcast', 'wrong') });
  assert.equal(await status(base, '/', { 'X-Forwarded-For': '10.9.9.9', ...basic('batchcast', 'correct-horse') }), 429);
});

test('trustProxyHops: off outside Render, one hop on Render, overridable 0 to 5, junk falls back to 1', () => {
  assert.equal(trustProxyHops({}), 0);
  assert.equal(trustProxyHops({ TRUST_PROXY_HOPS: '2' }), 0);
  assert.equal(trustProxyHops({ RENDER: 'true' }), 1);
  assert.equal(trustProxyHops({ RENDER: 'true', TRUST_PROXY_HOPS: '2' }), 2);
  assert.equal(trustProxyHops({ RENDER: 'true', TRUST_PROXY_HOPS: '0' }), 0);
  for (const junk of ['', 'abc', '-1', '6', '1.5', ' ']) assert.equal(trustProxyHops({ RENDER: 'true', TRUST_PROXY_HOPS: junk }), 1, JSON.stringify(junk));
});

test('resolveHost: loopback by default, 0.0.0.0 on Render, HOST wins over both', () => {
  assert.equal(resolveHost({}), '127.0.0.1');
  assert.equal(resolveHost({ RENDER: 'true' }), '0.0.0.0');
  assert.equal(resolveHost({ HOST: '0.0.0.0' }), '0.0.0.0');
  assert.equal(resolveHost({ HOST: '127.0.0.2', RENDER: 'true' }), '127.0.0.2');
  assert.equal(resolveHost({ HOST: '' }), '127.0.0.1');
});

test('start() really binds to the resolved address', async () => {
  const bind = env => new Promise(r => { const s = start({ ...ENV, PORT: '0', ...env }); servers.push(s); s.on('listening', () => r(s.address().address)); });
  assert.equal(await bind({}), '127.0.0.1');
  assert.equal(await bind({ RENDER: 'true' }), '0.0.0.0');
  assert.equal(await bind({ HOST: '0.0.0.0' }), '0.0.0.0');
});
