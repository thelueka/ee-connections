#!/usr/bin/env node
/**
 * Helper script to feed wiki/text content to the question generator Lambda.
 *
 * Usage:
 *   node feed-questions.mjs <path-to-text-file>
 *   node feed-questions.mjs --text "paste content here"
 *   echo "content" | node feed-questions.mjs --stdin
 */

import { readFileSync } from "fs";

// UPDATE THIS after deploying the Lambda
const LAMBDA_URL = process.env.LAMBDA_URL || "https://YOUR_LAMBDA_URL.lambda-url.us-west-2.on.aws/";

async function main() {
  let sourceText = "";
  const args = process.argv.slice(2);

  if (args[0] === "--text") {
    sourceText = args.slice(1).join(" ");
  } else if (args[0] === "--stdin") {
    sourceText = readFileSync(0, "utf-8"); // read from stdin
  } else if (args[0]) {
    sourceText = readFileSync(args[0], "utf-8");
  } else {
    console.error("Usage:");
    console.error("  node feed-questions.mjs <file.txt>");
    console.error("  node feed-questions.mjs --text \"content here\"");
    console.error("  echo \"content\" | node feed-questions.mjs --stdin");
    process.exit(1);
  }

  console.log(`Sending ${sourceText.length} characters to question generator...`);

  const response = await fetch(LAMBDA_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sourceText, numQuestions: 10 })
  });

  const result = await response.json();

  if (!response.ok) {
    console.error("Error:", result.error);
    process.exit(1);
  }

  console.log(result.message);
  console.log("\nNew questions generated:");
  result.newQuestions.forEach(q => {
    console.log(`  [${q.id}] (${q.category}) ${q.question}`);
  });
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
