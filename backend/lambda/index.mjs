import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";

const bedrock = new BedrockRuntimeClient({ region: "us-west-2" });
const s3 = new S3Client({ region: "us-west-2" });

const BUCKET = process.env.QUESTIONS_BUCKET;
const QUESTIONS_KEY = "questions.json";
const MODEL_ID = "anthropic.claude-3-sonnet-20240229-v1:0";

const CATEGORIES = [
  "circuit_analysis",
  "semiconductor_physics",
  "digital_logic",
  "signals_and_systems",
  "power_electronics",
  "electromagnetics",
  "control_systems",
  "aerospace",
  "digital_signal_processing",
  "optical_communications"
];

async function getExistingQuestions() {
  try {
    const response = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: QUESTIONS_KEY }));
    const body = await response.Body.transformToString();
    return JSON.parse(body);
  } catch (err) {
    if (err.name === "NoSuchKey") return [];
    throw err;
  }
}

async function generateQuestions(sourceText, numQuestions = 10) {
  const prompt = `You are an electrical engineering professor creating multiple-choice trivia questions based on the following technical content. Generate exactly ${numQuestions} questions.

Requirements:
- Each question must have exactly 4 options with only one correct answer
- Questions should test understanding, not just recall
- Include a clear, educational explanation for each answer
- Assign each question a category from this list: ${CATEGORIES.join(", ")}
- Return ONLY a valid JSON array, no other text

Format each question exactly like this:
{
  "category": "category_name",
  "question": "Question text?",
  "options": ["Option A", "Option B", "Option C", "Option D"],
  "answer": 0,
  "explanation": "Explanation of why the answer is correct."
}

Source content:
${sourceText}

Return ONLY the JSON array of ${numQuestions} questions:`;

  const response = await bedrock.send(new InvokeModelCommand({
    modelId: MODEL_ID,
    contentType: "application/json",
    accept: "application/json",
    body: JSON.stringify({
      anthropic_version: "bedrock-2023-05-31",
      max_tokens: 4096,
      messages: [{ role: "user", content: prompt }]
    })
  }));

  const result = JSON.parse(new TextDecoder().decode(response.body));
  const text = result.content[0].text;

  // Extract JSON array from response
  const jsonMatch = text.match(/\[[\s\S]*\]/);
  if (!jsonMatch) throw new Error("Failed to parse questions from LLM response");

  return JSON.parse(jsonMatch[0]);
}

export async function handler(event) {
  try {
    const { sourceText, numQuestions = 10 } = JSON.parse(event.body || "{}");

    if (!sourceText || sourceText.trim().length < 50) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "sourceText is required (minimum 50 characters)" })
      };
    }

    // Generate new questions from the provided text
    const newQuestions = await generateQuestions(sourceText, numQuestions);

    // Fetch existing questions from S3
    const existing = await getExistingQuestions();

    // Assign IDs to new questions (continue from the highest existing ID)
    const maxId = existing.reduce((max, q) => Math.max(max, q.id), 0);
    const numbered = newQuestions.map((q, i) => ({ ...q, id: maxId + i + 1 }));

    // Merge and upload
    const merged = [...existing, ...numbered];
    await s3.send(new PutObjectCommand({
      Bucket: BUCKET,
      Key: QUESTIONS_KEY,
      Body: JSON.stringify(merged, null, 2),
      ContentType: "application/json"
    }));

    return {
      statusCode: 200,
      body: JSON.stringify({
        message: `Added ${numbered.length} questions. Total: ${merged.length}`,
        newQuestions: numbered
      })
    };
  } catch (err) {
    console.error(err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message })
    };
  }
}
