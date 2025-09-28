import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import rateLimit from "express-rate-limit";
import fetch from "node-fetch";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static("public"));

// Rate limiter
const limiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10,
});
app.use(limiter);

// Only using one known working model
const WORKING_MODEL = "google/gemma-2-9b-it";

// Helper function: call AI
async function callAI(prompt, maxTokens = 1000) {
  if (!process.env.OPENROUTER_API_KEY) {
    throw new Error("API key not configured");
  }

  console.log("Sending prompt to AI:", prompt.substring(0, 100) + "...");

  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: WORKING_MODEL,
      messages: [{ role: "user", content: prompt }],
      max_tokens: maxTokens,
      temperature: 0.7,
      top_p: 0.9,
      stream: false,
    }),
  });

  const data = await response.json();

  if (!response.ok) {
    const errMsg = data?.error?.message || data?.error || response.statusText || "Unknown API error";
    throw new Error(`API Error (${response.status}): ${errMsg}`);
  }

  if (!data.choices || !data.choices[0]?.message?.content) {
    throw new Error("No response from AI");
  }

  return data.choices[0].message.content;
}

// Parse quiz JSON safely
function parseQuizResponse(rawResponse, requestedCount) {
  let cleaned = rawResponse.trim();

  if (cleaned.includes('```')) {
    cleaned = cleaned.replace(/```json\s*|\s*```/g, '').trim();
  }

  const arrayStart = cleaned.indexOf('[');
  const arrayEnd = cleaned.lastIndexOf(']') + 1;

  if (arrayStart === -1 || arrayEnd <= arrayStart) {
    throw new Error("No valid JSON array found in response");
  }

  cleaned = cleaned.substring(arrayStart, arrayEnd);

  try {
    const quizData = JSON.parse(cleaned);
    if (!Array.isArray(quizData)) throw new Error("Response is not an array");
    return quizData;
  } catch (jsonErr) {
    throw new Error("Failed to parse quiz JSON: " + jsonErr.message);
  }
}

// Homepage route
app.get("/", (req, res) => {
  res.send("AI Study Tutor API is running! Use /api/summarize or /api/generateQuiz.");
});

// Summarize endpoint
app.post("/api/summarize", async (req, res) => {
  try {
    const { content, length = 'medium' } = req.body;

    if (!content) return res.status(400).json({ error: "No content provided" });

    const truncatedContent = content.length > 2500 ? content.substring(0, 2500) + "..." : content;

    const lengthInstructions = {
      'short': 'max 80 words',
      'medium': 'max 150 words',
      'long': 'max 250 words'
    };

    const rawSummary = await callAI(
      `Summarize this text (${lengthInstructions[length] || 'max 150 words'}). Use simple language for students:\n\n${truncatedContent}`,
      Math.min(400, parseInt(lengthInstructions[length]?.match(/\d+/)?.[0] || 150) * 2)
    );

    const summary = rawSummary.trim()
      .replace(/^(Here's|Here is|This is|The following is)\s+(a\s+)?(summary|text|content)[^:]*:\s*/i, '')
      .replace(/^Summary:\s*/i, '')
      .trim();

    res.json({ summary });
  } catch (err) {
    console.error("Error generating summary:", err);
    res.status(500).json({ error: "Failed to summarize", details: err.message });
  }
});

// Quiz endpoint
app.post("/api/generateQuiz", async (req, res) => {
  try {
    const { summary, content, count = 5, difficulty = 'medium' } = req.body;
    const sourceText = content || summary;

    if (!sourceText) return res.status(400).json({ error: "No content or summary provided" });

    const requestedCount = Math.min(parseInt(count), 20);
    const truncatedText = sourceText.length > 2000 ? sourceText.substring(0, 2000) + "..." : sourceText;

    const difficultyMap = {
      'easy': 'simple concepts',
      'medium': 'standard difficulty',
      'hard': 'complex concepts'
    };

    const prompt = `Create ${requestedCount} multiple-choice questions (${difficultyMap[difficulty]}). 
Return ONLY this JSON format:
[
  {
    "question": "Question text?",
    "options": ["A", "B", "C", "D"],
    "correctIndex": 0,
    "hint": "Brief hint",
    "explanation": "Why correct"
  }
]

Content:
${truncatedText}`;

    const tokensPerQuestion = 120;
    const baseTokens = 200;
    const maxTokens = Math.min(4000, baseTokens + (requestedCount * tokensPerQuestion));

    const quiz = await callAI(prompt, maxTokens);
    const quizData = parseQuizResponse(quiz, requestedCount);

    const filtered = quizData
      .filter(q => q.question && Array.isArray(q.options) && q.options.length >= 2 && typeof q.correctIndex === 'number')
      .slice(0, requestedCount)
      .map(q => ({
        question: q.question.trim(),
        options: q.options.map(opt => String(opt).trim()),
        correctIndex: q.correctIndex,
        hint: q.hint || "Think about the key concepts",
        explanation: q.explanation || "Review the material"
      }));

    if (filtered.length === 0) throw new Error("No valid questions generated");

    res.json({ questions: filtered });

  } catch (err) {
    console.error("Quiz generation error:", err);
    res.status(500).json({ error: "Failed to generate quiz", details: err.message });
  }
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error', details: err.message });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ AI Study Tutor running on port ${PORT}`);
  console.log("Environment check:", { hasApiKey: !!process.env.OPENROUTER_API_KEY });
});
