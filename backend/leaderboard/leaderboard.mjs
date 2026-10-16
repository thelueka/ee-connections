// Core leaderboard logic, independent of AWS so it can be exercised with an
// in-memory store. index.mjs wires it to DynamoDB and the Lambda Function URL.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const ALIAS_RE = /^[a-z][a-z0-9]{1,19}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_BODY_BYTES = 2048;
const TOP_N = 10;

export class HttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

export function hashToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

function tokensMatch(token, storedHash) {
  if (typeof token !== "string" || typeof storedHash !== "string") return false;
  const a = Buffer.from(hashToken(token), "hex");
  const b = Buffer.from(storedHash, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

export function normalizeAlias(alias) {
  if (typeof alias !== "string") throw new HttpError(400, "alias is required");
  const a = alias.trim().toLowerCase();
  if (!ALIAS_RE.test(a)) throw new HttpError(400, "alias must be 2-20 lowercase letters/digits");
  return a;
}

function parseDate(dateStr) {
  if (typeof dateStr !== "string" || !DATE_RE.test(dateStr)) {
    throw new HttpError(400, "date must be YYYY-MM-DD");
  }
  const d = new Date(`${dateStr}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== dateStr) {
    throw new HttpError(400, "date is not a valid calendar date");
  }
  return d;
}

// The client sends its *local* calendar date. Every real time zone is within
// one day of UTC, so anything further out is a clock problem or tampering.
export function validateClientDate(dateStr, now) {
  const d = parseDate(dateStr);
  const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const diffDays = Math.round((d.getTime() - todayUtc) / 86400000);
  if (Math.abs(diffDays) > 1) throw new HttpError(400, "date is too far from server time");
  return dateStr;
}

// Weeks run Monday-Sunday and are keyed by the Monday's date.
export function weekStart(dateStr) {
  const d = parseDate(dateStr);
  const dow = (d.getUTCDay() + 6) % 7; // Monday = 0
  d.setUTCDate(d.getUTCDate() - dow);
  return d.toISOString().slice(0, 10);
}

// Standard competition ranking (1, 2, 2, 4). Ties on correct answers are broken
// by fewer attempts (higher accuracy), then alphabetically for display only.
export function rank(rows) {
  const sorted = [...rows].sort(
    (x, y) => y.correct - x.correct || x.answered - y.answered || x.alias.localeCompare(y.alias)
  );
  let lastKey = null;
  let lastRank = 0;
  return sorted.map((r, i) => {
    const key = `${r.correct}|${r.answered}`;
    if (key !== lastKey) {
      lastRank = i + 1;
      lastKey = key;
    }
    return { rank: lastRank, alias: r.alias, correct: r.correct, answered: r.answered };
  });
}

function board(rows, alias) {
  const ranked = rank(rows);
  return {
    top: ranked.slice(0, TOP_N),
    me: ranked.find((r) => r.alias === alias) || null,
    players: ranked.length
  };
}

function parseBody(event) {
  let raw = event.body || "";
  if (event.isBase64Encoded) raw = Buffer.from(raw, "base64").toString("utf-8");
  if (Buffer.byteLength(raw) > MAX_BODY_BYTES) throw new HttpError(413, "request too large");
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    throw new HttpError(400, "body must be JSON");
  }
}

async function authenticate(store, alias, token) {
  const profile = await store.getProfile(alias);
  if (!profile || !tokensMatch(token, profile.tokenHash)) {
    throw new HttpError(403, "unknown alias or bad token");
  }
}

/**
 * store: { getProfile, createProfile, recordAnswer, listWeek, listAllTime }
 * getAnswerKey(questionId): resolves to the correct option index, or null.
 */
export function createHandler({ store, getAnswerKey, now = () => new Date() }) {
  async function register(body) {
    const alias = normalizeAlias(body.alias);
    const token = randomBytes(32).toString("hex");
    const created = await store.createProfile(alias, hashToken(token), now().toISOString());
    // First install to claim an alias owns it. A reinstall that lost its token
    // needs the PROFILE item deleted by an admin (see deploy.md).
    if (!created) throw new HttpError(409, "alias already registered");
    return { alias, token };
  }

  async function answer(body) {
    const alias = normalizeAlias(body.alias);
    await authenticate(store, alias, body.token);

    const questionId = body.questionId;
    const selected = body.selectedIndex;
    if (!Number.isInteger(questionId) || questionId < 1) throw new HttpError(400, "bad questionId");
    if (!Number.isInteger(selected) || selected < 0 || selected > 3) {
      throw new HttpError(400, "bad selectedIndex");
    }
    const date = validateClientDate(body.date, now());

    const correctIndex = await getAnswerKey(questionId);
    if (correctIndex === null || correctIndex === undefined) {
      throw new HttpError(400, "unknown questionId");
    }
    const correct = selected === correctIndex;

    const ok = await store.recordAnswer({
      alias,
      date,
      week: weekStart(date),
      questionId,
      selected,
      correct,
      at: now().toISOString()
    });
    if (!ok) throw new HttpError(409, "already answered today or already answered this question");
    return { correct, week: weekStart(date) };
  }

  async function leaderboard(query) {
    const alias = normalizeAlias(query.alias);
    const date = validateClientDate(query.date, now());
    const week = weekStart(date);
    const [weekRows, allRows] = await Promise.all([store.listWeek(week), store.listAllTime()]);
    return { week, weekly: board(weekRows, alias), allTime: board(allRows, alias) };
  }

  return async function handler(event) {
    try {
      const method = event.requestContext?.http?.method || event.httpMethod || "GET";
      const path = event.rawPath || event.path || "/";
      let result;
      if (method === "POST" && path === "/register") result = await register(parseBody(event));
      else if (method === "POST" && path === "/answer") result = await answer(parseBody(event));
      else if (method === "GET" && path === "/leaderboard") {
        result = await leaderboard(event.queryStringParameters || {});
      } else throw new HttpError(404, "not found");
      return json(200, result);
    } catch (err) {
      if (err instanceof HttpError) return json(err.statusCode, { error: err.message });
      console.error(err);
      return json(500, { error: "internal error" });
    }
  };
}

function json(statusCode, body) {
  return { statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}
