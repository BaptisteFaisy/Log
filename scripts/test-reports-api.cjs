const reports = require("../api/reports");

function fakeRes() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(k, v) {
      this.headers[k] = v;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

(async () => {
  const res = fakeRes();
  await reports({ method: "GET", query: { limit: "5" } }, res);
  console.log("GET /api/reports", res.statusCode, `reports=${res.body.reports.length}`);
  console.log(JSON.stringify(res.body.reports.slice(0, 2), null, 2));
})().catch((error) => {
  console.error("FAIL", error.message);
  process.exit(1);
});
