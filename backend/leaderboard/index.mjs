// Lambda entry point: DynamoDB-backed store + answer key fetched from the
// published questions.json. The Node.js 22 Lambda runtime bundles AWS SDK v3,
// so this function needs no node_modules.
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand
} from "@aws-sdk/lib-dynamodb";
import { createHandler } from "./leaderboard.mjs";

const TABLE = process.env.TABLE_NAME;
const QUESTIONS_URL =
  process.env.QUESTIONS_URL ||
  "https://raw.githubusercontent.com/thelueka/ee-connections/main/data/questions.json";
const ANSWER_KEY_TTL_MS = 5 * 60 * 1000;
const MIN_REFRESH_MS = 60 * 1000;

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

// Table layout (pk / sk, both strings):
//   USER#<alias> / PROFILE      tokenHash, createdAt
//   USER#<alias> / DAY#<date>   one answer per local calendar day
//   USER#<alias> / Q#<id>       each question counts once per person
//   WEEK#<monday> / <alias>     correct, answered (weekly board)
//   ALLTIME / <alias>           correct, answered (all-time board)
const store = {
  async getProfile(alias) {
    const res = await ddb.send(
      new GetCommand({ TableName: TABLE, Key: { pk: `USER#${alias}`, sk: "PROFILE" } })
    );
    return res.Item || null;
  },

  async createProfile(alias, tokenHash, createdAt) {
    try {
      await ddb.send(
        new PutCommand({
          TableName: TABLE,
          Item: { pk: `USER#${alias}`, sk: "PROFILE", tokenHash, createdAt },
          ConditionExpression: "attribute_not_exists(pk)"
        })
      );
      return true;
    } catch (err) {
      if (err.name === "ConditionalCheckFailedException") return false;
      throw err;
    }
  },

  async recordAnswer({ alias, date, week, questionId, selected, correct, at }) {
    const user = `USER#${alias}`;
    const inc = {
      UpdateExpression: "ADD correct :c, answered :one",
      ExpressionAttributeValues: { ":c": correct ? 1 : 0, ":one": 1 }
    };
    try {
      await ddb.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: TABLE,
                Item: { pk: user, sk: `DAY#${date}`, questionId, selected, correct, at },
                ConditionExpression: "attribute_not_exists(pk)"
              }
            },
            {
              Put: {
                TableName: TABLE,
                Item: { pk: user, sk: `Q#${questionId}`, date, correct },
                ConditionExpression: "attribute_not_exists(pk)"
              }
            },
            { Update: { TableName: TABLE, Key: { pk: `WEEK#${week}`, sk: alias }, ...inc } },
            { Update: { TableName: TABLE, Key: { pk: "ALLTIME", sk: alias }, ...inc } }
          ]
        })
      );
      return true;
    } catch (err) {
      if (err.name === "TransactionCanceledException") {
        const reasons = err.CancellationReasons || [];
        if (reasons.some((r) => r.Code === "ConditionalCheckFailed")) return false;
      }
      throw err;
    }
  },

  listWeek(week) {
    return queryBoard(`WEEK#${week}`);
  },

  listAllTime() {
    return queryBoard("ALLTIME");
  }
};

async function queryBoard(pk) {
  const rows = [];
  let ExclusiveStartKey;
  do {
    const res = await ddb.send(
      new QueryCommand({
        TableName: TABLE,
        KeyConditionExpression: "pk = :pk",
        ExpressionAttributeValues: { ":pk": pk },
        ExclusiveStartKey
      })
    );
    for (const item of res.Items || []) {
      rows.push({ alias: item.sk, correct: item.correct || 0, answered: item.answered || 0 });
    }
    ExclusiveStartKey = res.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return rows;
}

// Answer key cache. Grading happens here so the client can't simply claim it
// was right; the client only sends which option was picked.
let answerKey = new Map();
let fetchedAt = 0;

async function refreshAnswerKey() {
  const res = await fetch(QUESTIONS_URL, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`questions fetch failed: HTTP ${res.status}`);
  const questions = await res.json();
  answerKey = new Map(questions.map((q) => [q.id, q.answer]));
  fetchedAt = Date.now();
}

async function getAnswerKey(questionId) {
  const age = Date.now() - fetchedAt;
  // Refresh when stale, or when a question we don't know shows up (newly
  // published), but never more than once a minute.
  if (age > ANSWER_KEY_TTL_MS || (!answerKey.has(questionId) && age > MIN_REFRESH_MS)) {
    await refreshAnswerKey();
  }
  return answerKey.has(questionId) ? answerKey.get(questionId) : null;
}

export const handler = createHandler({ store, getAnswerKey });
