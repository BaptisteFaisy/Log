const { getPool } = require("../lib/db.cjs");

function fail(res, status, message) {
  res.status(status).json({ error: message });
}

function methodNotAllowed(res, allowed) {
  res.setHeader("allow", allowed);
  fail(res, 405, `méthode non autorisée (attendu : ${allowed})`);
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asInt(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n) : fallback;
}

function asIso(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

module.exports = { getPool, fail, methodNotAllowed, isObject, asInt, asIso };
