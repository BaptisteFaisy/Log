const { getPool, fail, methodNotAllowed, isObject, asInt } = require("./_db");

function normalize(body) {
  if (!isObject(body)) return { error: "corps JSON attendu" };
  const fingerprint = typeof body.fingerprint === "string" ? body.fingerprint.trim() : "";
  const code = typeof body.code === "string" ? body.code.trim() : "";
  if (!fingerprint || fingerprint.length > 64) return { error: "fingerprint invalide" };
  if (!code || code.length > 80) return { error: "code invalide" };

  const files = Array.isArray(body.files)
    ? body.files.filter((f) => typeof f === "string").slice(0, 40).map((f) => f.slice(0, 200))
    : [];

  const text = (value, max) => (typeof value === "string" ? value.slice(0, max) : null);

  return {
    memo: {
      fingerprint,
      code,
      path: `db://error_resolutions/${fingerprint}`,
      cause: text(body.cause, 2000),
      fix: text(body.fix, 4000),
      files,
      verification: text(body.verification, 2000),
      tokens_used: asInt(body.tokens_used),
      duration_ms: asInt(body.duration_ms),
      agent: text(body.agent, 120),
      runs: Math.max(1, asInt(body.runs, 1)),
    },
  };
}

const toMemo = (row) => ({
  fingerprint: row.fingerprint,
  code: row.code,
  path: `db://error_resolutions/${row.fingerprint}`,
  cause: row.cause,
  fix: row.fix,
  files: row.files,
  verification: row.verification,
  tokens_used: row.tokens_used,
  duration_ms: row.duration_ms,
  agent: row.agent,
  runs: row.runs,
  updated_at: row.updated_at,
});

module.exports = async function handler(req, res) {
  try {
    const pool = getPool();

    if (req.method === "POST") {
      const parsed = normalize(req.body);
      if (parsed.error) return fail(res, 400, parsed.error);
      const m = parsed.memo;
      const { rows } = await pool.query(
        `insert into error_resolutions
           (fingerprint, code, cause, fix, files, verification, tokens_used, duration_ms,
            agent, runs, updated_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now())
         on conflict (fingerprint) do update set
           code = excluded.code,
           cause = coalesce(excluded.cause, error_resolutions.cause),
           fix = coalesce(excluded.fix, error_resolutions.fix),
           files = case when cardinality(excluded.files) > 0
                        then excluded.files else error_resolutions.files end,
           verification = coalesce(excluded.verification, error_resolutions.verification),
           tokens_used = excluded.tokens_used,
           duration_ms = excluded.duration_ms,
           agent = excluded.agent,
           runs = error_resolutions.runs + 1,
           updated_at = now()
         returning fingerprint, code, cause, fix, files, verification, tokens_used,
                   duration_ms, agent, runs, updated_at`,
        [m.fingerprint, m.code, m.cause, m.fix, m.files, m.verification, m.tokens_used,
         m.duration_ms, m.agent, m.runs],
      );
      return res.status(201).json({ ok: true, memo: toMemo(rows[0]) });
    }

    if (req.method === "GET") {
      const fingerprint = typeof req.query.fingerprint === "string" ? req.query.fingerprint : "";
      const { rows } = await pool.query(
        fingerprint
          ? `select * from error_resolutions where fingerprint = $1`
          : `select * from error_resolutions order by updated_at desc limit 500`,
        fingerprint ? [fingerprint] : [],
      );
      return res.status(200).json({ memos: rows.map(toMemo) });
    }

    return methodNotAllowed(res, "GET, POST");
  } catch (error) {
    return fail(res, 500, error.message || "erreur serveur");
  }
};
