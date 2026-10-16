// Frees an alias so its owner's app can register again (for an install that
// lost its token). Deletes only the PROFILE item; answers and scores stay.
// The owner's app re-registers the next time it starts.
//
//   node reset-alias.mjs <alias>
import { DynamoDBClient, DeleteItemCommand } from "@aws-sdk/client-dynamodb";
import { fromIni } from "@aws-sdk/credential-providers";

const alias = (process.argv[2] || "").toLowerCase();
if (!/^[a-z][a-z0-9]{1,19}$/.test(alias)) throw new Error("usage: node reset-alias.mjs <alias>");
const ddb = new DynamoDBClient({ region: "us-west-2", credentials: fromIni({ profile: process.env.AWS_PROFILE || "lueka-dev" }) });
const res = await ddb.send(new DeleteItemCommand({
  TableName: "ee-connections-leaderboard",
  Key: { pk: { S: `USER#${alias}` }, sk: { S: "PROFILE" } },
  ReturnValues: "ALL_OLD"
}));
console.log(res.Attributes ? `Reset ${alias} (was registered ${res.Attributes.createdAt?.S}); scores kept.` : `${alias} wasn't registered; nothing to do.`);
