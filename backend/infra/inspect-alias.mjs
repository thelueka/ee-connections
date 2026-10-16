// Read-only: shows what the leaderboard table holds for one alias, and (if run
// on that person's machine) what their local progress.json says. Never prints tokens.
//
//   node inspect-alias.mjs <alias>
import { DynamoDBClient, QueryCommand, GetItemCommand } from "@aws-sdk/client-dynamodb";
import { fromIni } from "@aws-sdk/credential-providers";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const alias = (process.argv[2] || "").toLowerCase();
if (!alias) throw new Error("usage: node inspect-alias.mjs <alias>");
const ddb = new DynamoDBClient({ region: "us-west-2", credentials: fromIni({ profile: process.env.AWS_PROFILE || "lueka-dev" }) });
const TableName = "ee-connections-leaderboard";

const items = await ddb.send(new QueryCommand({
  TableName, KeyConditionExpression: "pk = :pk", ExpressionAttributeValues: { ":pk": { S: `USER#${alias}` } }
}));
console.log(`Table items for USER#${alias}:`);
for (const it of items.Items || []) {
  const sk = it.sk.S;
  const extra = sk === "PROFILE" ? `createdAt=${it.createdAt?.S}` : `correct=${it.correct?.BOOL} date=${it.date?.S ?? ""} q=${it.questionId?.N ?? ""}`;
  console.log(`  ${sk}  ${extra}`);
}
const all = await ddb.send(new GetItemCommand({ TableName, Key: { pk: { S: "ALLTIME" }, sk: { S: alias } } }));
console.log("All-time row:", all.Item ? `correct=${all.Item.correct?.N} answered=${all.Item.answered?.N}` : "none");

const progressPath = join(process.env.APPDATA || "", "ee-connections", "progress.json");
if (existsSync(progressPath)) {
  const p = JSON.parse(readFileSync(progressPath, "utf-8"));
  const lb = p.leaderboard || {};
  console.log("\nLocal progress.json leaderboard entry:", JSON.stringify({
    server: lb.server, alias: lb.alias, hasToken: Boolean(lb.token), error: lb.error
  }));
  console.log("Queued answers waiting to sync:", (p.pendingSync || []).length);
}
