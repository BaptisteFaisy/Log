const { getPool, fail, methodNotAllowed, asInt } = require("./_db");

const toReport = (row) => ({
  id: row.id,
  trace_id: row.trace_id,
  error_type: row.error_type,
  code: row.code,
  scenario: row.scenario,
  agent: row.agent,
  status: row.status,
  summary: row.summary,
  report: row.report,
  published_at: row.published_at,
  received_at: row.received_at,
});

module.exports = async function handler(req, res) {
  if (req.method !== "GET") return methodNotAllowed(res, "GET");

  try {
    const pool = getPool();
    const limit = Math.min(Math.max(asInt(req.query.limit, 50), 1), 200);
    const traceId = typeof req.query.trace_id === "string" ? req.query.trace_id.trim() : "";
    const code = typeof req.query.code === "string" ? req.query.code.trim() : "";

    const { rows } = await pool.query(
      `select id, trace_id, error_type, code, scenario, agent, status, summary, report,
              published_at, received_at
         from agent_reports
        where ($1 = '' or trace_id = $1)
          and ($2 = '' or code = $2)
        order by published_at desc, id desc
        limit $3`,
      [traceId, code, limit],
    );

    res.setHeader("cache-control", "no-store");
    return res.status(200).json({ reports: rows.map(toReport) });
  } catch (error) {
    return fail(res, 500, error.message || "erreur serveur");
  }
};
