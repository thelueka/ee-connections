// End-to-end check of a deployed leaderboard endpoint using a throwaway alias,
// then deletes exactly the items that alias created.
//
//   node smoke-test.mjs https://xxxx.execute-api.us-west-2.amazonaws.com/prod
import { DynamoDBClient, DeleteItemCommand } from "@aws-sdk/client-dynamodb";
import { fromIni } from "@aws-sdk/credential-providers";
import { readFileSync } from "node:fs";

const BASE = (process.argv[2] || "").replace(/\/+$/, "");
if (!BASE) throw new Error("usage: node smoke-test.mjs <base-url>");
const ALIAS = "zzsmoketest";
const pad = (n) => String(n).padStart(2, "0");
const d = new Date();
const today = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const questions = JSON.parse(readFileSync(new URL("../../data/questions.json", import.meta.url), "utf-8"));
const [q1, q2] = questions;

let failures = 0;
const check = (label, cond, detail) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
  if (!cond) failures++;
};
const call = async (method, path, body) => {
  const res = await fetch(BASE + path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body && JSON.stringify(body)
  });
  let data = {};
  try { data = await res.json(); } catch { /* not JSON */ }
  return { status: res.status, data };
};

const reg = await call("POST", "/register", { alias: ALIAS });
check("register", reg.status === 200 && reg.data.token, `HTTP ${reg.status}`);
check("register again is rejected", (await call("POST", "/register", { alias: ALIAS })).status === 409);
const ans = await call("POST", "/answer", { alias: ALIAS, token: reg.data.token, questionId: q1.id, selectedIndex: q1.answer, date: today });
check("answer is graded correct", ans.status === 200 && ans.data.correct === true, `HTTP ${ans.status}`);
const dup = await call("POST", "/answer", { alias: ALIAS, token: reg.data.token, questionId: q2.id, selectedIndex: 0, date: today });
check("second answer same day is rejected", dup.status === 409, `HTTP ${dup.status}`);
const bad = await call("POST", "/answer", { alias: ALIAS, token: "wrong", questionId: q2.id, selectedIndex: 0, date: today });
check("bad token is rejected", bad.status === 403, `HTTP ${bad.status}`);
const lb = await call("GET", `/leaderboard?alias=${ALIAS}&date=${today}`);
check("leaderboard shows the answer", lb.status === 200 && lb.data.weekly?.me?.correct === 1, `HTTP ${lb.status}`);
check("unknown route is blocked", (await call("GET", "/admin")).status === 403);

const ddb = new DynamoDBClient({ region: "us-west-2", credentials: fromIni({ profile: process.env.AWS_PROFILE || "lueka-dev" }) });
for (const [pk, sk] of [
  [`USER#${ALIAS}`, "PROFILE"], [`USER#${ALIAS}`, `DAY#${today}`], [`USER#${ALIAS}`, `Q#${q1.id}`],
  [`WEEK#${lb.data.week}`, ALIAS], ["ALLTIME", ALIAS]
]) {
  await ddb.send(new DeleteItemCommand({ TableName: "ee-connections-leaderboard", Key: { pk: { S: pk }, sk: { S: sk } } }));
}
const after = await call("GET", `/leaderboard?alias=${ALIAS}&date=${today}`);
check("cleanup removed the test player", !after.data.weekly?.me && !after.data.allTime?.me);

console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
process.exitCode = failures ? 1 : 0;
