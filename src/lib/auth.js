const crypto = require('crypto');
const net = require('net');

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// Loopback by default so a local run is not exposed to the network. Hosts that need to
// accept outside traffic set HOST=0.0.0.0; Render is detected via its RENDER variable.
function resolveHost(env = process.env) {
  return env.HOST || (env.RENDER ? '0.0.0.0' : '127.0.0.1');
}

// Eight 16-bit groups from an IPv6 address, or null if it cannot be parsed.
function expandIPv6(addr) {
  let a = String(addr).split('%')[0].toLowerCase();
  const v4 = a.match(/^(.*:)(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4) {
    const [o1, o2, o3, o4] = v4.slice(2).map(Number);
    a = v4[1] + ((o1 << 8) | o2).toString(16) + ':' + ((o3 << 8) | o4).toString(16);
  }
  const parts = a.split('::');
  if (parts.length > 2) return null;
  const head = parts[0] ? parts[0].split(':') : [];
  if (parts.length === 1) return head.length === 8 ? head.map(h => parseInt(h, 16)) : null;
  const tail = parts[1] ? parts[1].split(':') : [];
  const fill = 8 - head.length - tail.length;
  if (fill < 1) return null;
  const groups = [...head, ...Array(fill).fill('0'), ...tail].map(h => parseInt(h, 16));
  return groups.every(Number.isInteger) ? groups : null;
}

// The key a client is limited under. IPv4 is used as is. An IPv6 client usually controls a whole
// /64, so keying on the full address would let it rotate addresses and never reach the limit;
// those are keyed on the /64 prefix instead. IPv4-mapped IPv6 addresses count as the IPv4 address.
function clientKey(ip) {
  if (!ip) return 'unknown';
  if (!net.isIPv6(ip)) return ip;
  const g = expandIPv6(ip);
  if (!g) return ip;
  if (g.slice(0, 5).every(x => x === 0) && g[5] === 0xffff) {
    return [g[6] >> 8, g[6] & 255, g[7] >> 8, g[7] & 255].join('.');
  }
  return g.slice(0, 4).map(x => x.toString(16)).join(':') + '::/64';
}

// Counts failed logins per client address in a fixed window that starts at the first
// failure. In memory only, so it resets on restart and is per instance.
function createAttemptLimiter({ max = 10, windowMs = 15 * 60 * 1000, maxEntries = 5000, now = Date.now } = {}) {
  const hits = new Map();

  function prune(t) {
    for (const [key, entry] of hits) if (entry.resetAt <= t) hits.delete(key);
  }

  // Make room for one more address. Entries that are not locked out go first (oldest first),
  // so filling the table with one-off failures cannot push out an address that is locked out.
  function evictOne() {
    let oldest;
    for (const [key, entry] of hits) {
      if (oldest === undefined) oldest = key;
      if (entry.count < max) { hits.delete(key); return; }
    }
    hits.delete(oldest);
  }

  return {
    // Milliseconds until this address may try again, or 0 if it is not locked out.
    blockedFor(key) {
      const entry = hits.get(key);
      if (!entry) return 0;
      const t = now();
      if (entry.resetAt <= t) { hits.delete(key); return 0; }
      return entry.count >= max ? entry.resetAt - t : 0;
    },
    fail(key) {
      const t = now();
      let entry = hits.get(key);
      if (!entry || entry.resetAt <= t) {
        if (hits.size >= maxEntries) prune(t);
        if (hits.size >= maxEntries) evictOne();
        entry = { count: 0, resetAt: t + windowMs };
        hits.set(key, entry);
      }
      entry.count += 1;
    },
    succeed(key) { hits.delete(key); },
    size() { return hits.size; }
  };
}

// Shared-password gate (HTTP Basic). Fails closed with 503 if APP_PASSWORD is unset.
// Only requests that present credentials and get them wrong count as failures, so the
// browser's first credential-less request does not use up an attempt. A locked-out
// address is refused even with the right password, otherwise lockout would not slow guessing.
function createAuth({ env = process.env, limiter = createAttemptLimiter() } = {}) {
  return function auth(req, res, next) {
    const password = env.APP_PASSWORD;
    if (!password) return res.status(503).send('APP_PASSWORD is not set - refusing to serve without authentication.');

    const key = clientKey(req.ip);
    const wait = limiter.blockedFor(key);
    if (wait > 0) {
      res.set('Retry-After', String(Math.ceil(wait / 1000)));
      return res.status(429).send('Too many failed login attempts. Try again later.');
    }

    const header = req.headers.authorization;
    if (header) {
      const [scheme, encoded] = header.split(' ');
      if (scheme === 'Basic' && encoded) {
        const decoded = Buffer.from(encoded, 'base64').toString();
        const i = decoded.indexOf(':');
        const userOk = safeEqual(i < 0 ? decoded : decoded.slice(0, i), env.APP_USER || 'batchcast');
        const passOk = safeEqual(i < 0 ? '' : decoded.slice(i + 1), password);
        if (userOk && passOk) { limiter.succeed(key); return next(); }
      }
      limiter.fail(key);
    }
    res.set('WWW-Authenticate', 'Basic realm="BatchCast", charset="UTF-8"');
    res.status(401).send('Authentication required');
  };
}

// On Render the service sits behind a proxy, so req.ip is the proxy unless Express is told to
// trust it. One hop by default; set TRUST_PROXY_HOPS if the real client address is further along
// X-Forwarded-For. Off everywhere else, so a client cannot choose its own address.
function trustProxyHops(env = process.env) {
  if (!env.RENDER) return 0;
  const raw = String(env.TRUST_PROXY_HOPS ?? '').trim();
  return /^[0-5]$/.test(raw) ? Number(raw) : 1;
}

module.exports = { safeEqual, resolveHost, clientKey, createAttemptLimiter, createAuth, trustProxyHops };
