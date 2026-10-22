#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { ERROR_TYPES, entryFor, fingerprint, logLines } from "./lib/errors.mjs";

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  return value && !value.startsWith("--") ? value : true;
}

const requested = arg("type", null);
const count = Number(arg("count", 5));
const interval = Number(arg("interval", 0));
const json = Boolean(arg("json", false));
const watch = Boolean(arg("watch", false));
const out = arg("out", null);

const selected = requested
  ? [entryFor({ code: requested, name: requested })].filter(Boolean)
  : ERROR_TYPES;

if (selected.length === 0) {
  console.error(`type inconnu: ${requested}`);
  console.error(`types: ${ERROR_TYPES.map((entry) => entry.code).join(", ")}`);
  process.exit(2);
}

function emit(entry, index) {
  const ts = new Date().toISOString();
  const lines = json
    ? [
        JSON.stringify({
          ts,
          level: entry.level,
          service: entry.service,
          code: entry.code,
          type: entry.name,
          message: entry.message,
          stack: entry.stack,
          fingerprint: fingerprint(entry.code, entry.message, entry.stack.join("\n")),
        }),
      ]
    : logLines(entry, ts);

  const text = `${lines.join("\n")}\n`;
  if (out) appendFileSync(out, text);
  else process.stdout.write(text);

  return index + 1;
}

let index = 0;
const total = Number.isFinite(count) && count > 0 ? count : 1;

function tick() {
  const entry = selected[index % selected.length];
  index = emit(entry, index);
  if (watch || index < total) {
    setTimeout(tick, watch ? (Number.isFinite(interval) && interval > 0 ? interval : 2000) : 0);
  }
}

tick();
