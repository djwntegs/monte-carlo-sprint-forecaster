class BadRequest extends Error {
  constructor(message) { super(message); this.status = 400; }
}

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

// One optional query parameter as a single, bounded string with no control characters.
function optStr(value, name, max = 200) {
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string') throw new BadRequest(`${name} must be a single value`);
  if (value.length > max) throw new BadRequest(`${name} is too long`);
  if (CONTROL_CHARS.test(value)) throw new BadRequest(`${name} contains invalid characters`);
  return value;
}

function reqStr(value, name, max) {
  const v = optStr(value, name, max);
  if (v === undefined) throw new BadRequest(`${name} is required`);
  return v;
}

function optDate(value, name) {
  const v = optStr(value, name, 10);
  if (v !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new BadRequest(`${name} must be YYYY-MM-DD`);
  return v;
}

function intInRange(value, name, min, max, fallback) {
  const v = optStr(value, name, 6);
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new BadRequest(`${name} must be a whole number from ${min} to ${max}`);
  return n;
}

// WIQL and OData both escape a single quote inside a string literal by doubling it.
const quote = v => v.replace(/'/g, "''");

// For literals placed in an OData URL: escape quotes, then percent-encode so characters
// such as & and # cannot end the $apply parameter and add options of their own.
const odataLit = v => encodeURIComponent(quote(v));

function fail(res, err) {
  res.status(err.status || 500).json({ error: err.message });
}

module.exports = { BadRequest, optStr, reqStr, optDate, intInRange, quote, odataLit, fail };
