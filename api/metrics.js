const { getPool, fail, methodNotAllowed } = require("./_db");

const toRun = (row) => ({
  run_id: row.run_id,
  fingerprint: row.fingerprint,
  code: row.code,
  mode: row.mode,
  status: row.status,
  started_at: row.started_at,
  ended_at: row.ended_at,
  duration_ms: row.duration_ms,
  agent_ms: row.agent_ms,
  steps: row.steps,
  tokens: row.tokens,
  tokens_total: row.tokens_total,
  memo: { hit: row.memo_hit, path: row.memo_path, stale: false },
  agent: row.agent,
  attempt: row.attempt,
});

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
  if (req.method !== "GET") return methodNotAllowed(res, "GET");

  try {
    const pool = getPool();
    const [runs, memos] = await Promise.all([
      pool.query(
        `select run_id, fingerprint, code, mode, status, started_at, ended_at, duration_ms,
                agent_ms, steps, tokens, tokens_total, memo_hit, memo_path, agent, attempt
           from agent_runs
          order by started_at asc
          limit 500`,
      ),
      pool.query(`select * from error_resolutions order by updated_at desc limit 500`),
    ]);

    res.setHeader("cache-control", "no-store");
    return res.status(200).json({
      version: 1,
      runs: runs.rows.map(toRun),
      memos: memos.rows.map(toMemo),
    });
  } catch (error) {
    return fail(res, 500, error.message || "erreur serveur");
  }
};
