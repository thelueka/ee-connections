// Local stand-in for the leaderboard Lambda, for testing the app without AWS.
// Runs the real handler logic (leaderboard.mjs) against an in-memory store and
// grades answers with the local data/questions.json. Data is lost on exit.
//
//   node backend/leaderboard/local-server.mjs [port]
import http from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createHandler, hashToken, weekStart } from "./leaderboard.mjs";

const PORT = Number(process.argv[2]) || 8787;
const questionsPath = fileURLToPath(new URL("../../data/questions.json", import.meta.url));
const answerKey = new Map(JSON.parse(readFileSync(questionsPath, "utf-8")).map((q) => [q.id, q.answer]));

const mem = { profiles: new Map(), days: new Set(), qs: new Set(), boards: new Map() };

function bump(boardKey, alias, correct, n = 1) {
  if (!mem.boards.has(boardKey)) mem.boards.set(boardKey, new Map());
  const board = mem.boards.get(boardKey);
  const row = board.get(alias) || { alias, correct: 0, answered: 0 };
  row.correct += correct;
  row.answered += n;
  board.set(alias, row);
}

const store = {
  async getProfile(alias) {
    return mem.profiles.get(alias) || null;
  },
  async createProfile(alias, tokenHash) {
    if (mem.profiles.has(alias)) return false;
    mem.profiles.set(alias, { tokenHash });
    return true;
  },
  async recordAnswer({ alias, date, week, questionId, correct }) {
    const day = `${alias}|${date}`;
    const q = `${alias}|${questionId}`;
    if (mem.days.has(day) || mem.qs.has(q)) return false;
    mem.days.add(day);
    mem.qs.add(q);
    bump(`WEEK#${week}`, alias, correct ? 1 : 0);
    bump("ALLTIME", alias, correct ? 1 : 0);
    return true;
  },
  async listWeek(week) {
    return [...(mem.boards.get(`WEEK#${week}`) || new Map()).values()];
  },
  async listAllTime() {
    return [...(mem.boards.get("ALLTIME") || new Map()).values()];
  }
};

// A few fake players so the board isn't empty. Their profiles get random
// tokens nobody knows, so nothing can post as them.
const now = new Date();
const thisWeek = weekStart(now.toISOString().slice(0, 10));
for (const [alias, weekCorrect, weekAnswered, allCorrect, allAnswered] of [
  ["miles", 4, 4, 31, 35],
  ["akhil", 3, 4, 28, 36],
  ["jacob", 3, 3, 19, 22],
  ["payton", 1, 3, 12, 20]
]) {
  mem.profiles.set(alias, { tokenHash: hashToken(Math.random().toString(36)) });
  bump(`WEEK#${thisWeek}`, alias, weekCorrect, weekAnswered);
  bump("ALLTIME", alias, allCorrect, allAnswered);
}

const handler = createHandler({
  store,
  getAnswerKey: async (id) => (answerKey.has(id) ? answerKey.get(id) : null)
});

http
  .createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 4096) req.destroy();
    });
    req.on("end", async () => {
      const url = new URL(req.url, `http://localhost:${PORT}`);
      const result = await handler({
        requestContext: { http: { method: req.method } },
        rawPath: url.pathname,
        queryStringParameters: Object.fromEntries(url.searchParams),
        body
      });
      console.log(`${req.method} ${url.pathname} -> ${result.statusCode} ${result.body.slice(0, 120)}`);
      res.writeHead(result.statusCode, result.headers);
      res.end(result.body);
    });
  })
  .listen(PORT, "127.0.0.1", () => {
    console.log(`Local leaderboard on http://127.0.0.1:${PORT} (in-memory, ${answerKey.size} questions)`);
  });
