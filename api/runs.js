const { getPool, fail, methodNotAllowed, isObject, asInt, asIso } = require("./_db");

const MODES = new Set(["cold", "warm", "warm_degraded"]);
const STATUSES = new Set(["resolved", "failed", "abandoned"]);

function normalize(body) {
  if (!isObject(body)) return { error: "corps JSON attendu" };
  const runId = typeof body.run_id === "string" ? body.run_id.trim() : "";
  const fingerprint = typeof body.fingerprint === "string" ? body.fingerprint.trim() : "";
  const code = typeof body.code === "string" ? body.code.trim() : "";
  if (!runId || runId.length > 80) return { error: "run_id invalide" };
  if (!fingerprint || fingerprint.length > 64) return { error: "fingerprint invalide" };
  if (!code || code.length > 80) return { error: "code invalide" };
  if (!MODES.has(body.mode)) return { error: "mode invalide" };
  if (!STATUSES.has(body.status)) return { error: "status invalide" };

  const startedAt = asIso(body.started_at);
  if (!startedAt) return { error: "started_at invalide" };

  const steps = Array.isArray(body.steps)
    ? body.steps
        .filter((s) => isObject(s) && typeof s.name === "string")
        .slice(0, 32)
        .map((s) => ({ name: s.name.slice(0, 40), duration_ms: asInt(s.duration_ms) }))
    : [];

  const tokens = isObject(body.tokens) ? body.tokens : {};
  const memo = isObject(body.memo) ? body.memo : {};

  return {
    run: {
      run_id: runId,
      fingerprint,
      code,
      mode: body.mode,
      status: body.status,
      started_at: startedAt,
      ended_at: asIso(body.ended_at),
      duration_ms: asInt(body.duration_ms),
      agent_ms: asInt(body.agent_ms),
      steps: JSON.stringify(steps),
      tokens: JSON.stringify({
        input: asInt(tokens.input),
        output: asInt(tokens.output),
        cache_read: asInt(tokens.cache_read),
        cache_write: asInt(tokens.cache_write),
        estimated: Boolean(tokens.estimated),
      }),
      tokens_total: asInt(body.tokens_total),
      memo_hit: Boolean(memo.hit),
      memo_path: typeof memo.path === "string" ? memo.path.slice(0, 200) : null,
      agent: typeof body.agent === "string" ? body.agent.slice(0, 120) : null,
      attempt: Math.max(1, asInt(body.attempt, 1)),
    },
  };
}

module.exports = async function handler(req, res) {
  try {
    const pool = getPool();

    if (req.method === "POST") {
      const parsed = normalize(req.body);
      if (parsed.error) return fail(res, 400, parsed.error);
      const r = parsed.run;
      await pool.query(
        `insert into agent_runs
           (run_id, fingerprint, code, mode, status, started_at, ended_at, duration_ms,
            agent_ms, steps, tokens, tokens_total, memo_hit, memo_path, agent, attempt)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12,$13,$14,$15,$16)
         on conflict (run_id) do nothing`,
        [
          r.run_id, r.fingerprint, r.code, r.mode, r.status, r.started_at, r.ended_at,
          r.duration_ms, r.agent_ms, r.steps, r.tokens, r.tokens_total, r.memo_hit,
          r.memo_path, r.agent, r.attempt,
        ],
      );
      return res.status(201).json({ ok: true, run_id: r.run_id });
    }

    if (req.method === "GET") {
      const limit = Math.min(Math.max(asInt(req.query.limit, 200), 1), 500);
      const { rows } = await pool.query(
        `select run_id, fingerprint, code, mode, status, started_at, ended_at, duration_ms,
                agent_ms, steps, tokens, tokens_total, memo_hit, memo_path, agent, attempt
           from agent_runs
          order by started_at desc
          limit $1`,
        [limit],
      );
      return res.status(200).json({
        runs: rows.map((row) => ({
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
        })),
      });
    }

    return methodNotAllowed(res, "GET, POST");
  } catch (error) {
    return fail(res, 500, error.message || "erreur serveur");
  }
};
