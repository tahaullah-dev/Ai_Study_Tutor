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

// Cache for successful models to avoid retrying failed ones
let workingModelCache = null;
let lastModelCacheTime = 0;
const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

// Helper function: call AI with optimized model selection
async function callAI(prompt, maxTokens = 1000) {
  const freeModels = [
    "meta-llama/llama-3.2-3b-instruct:free",
    "microsoft/phi-3-mini-128k-instruct:free", 
    "google/gemma-2-9b-it:free",
    "huggingface/zephyr-7b-beta:free",
    "openchat/openchat-7b:free"
  ];

  // Use cached working model if available and recent
  const now = Date.now();
  let modelsToTry = freeModels;
  
  if (workingModelCache && (now - lastModelCacheTime) < CACHE_DURATION) {
    modelsToTry = [workingModelCache, ...freeModels.filter(m => m !== workingModelCache)];
  }

  console.log("Sending prompt to AI:", prompt.substring(0, 100) + "...");
  
  for (let i = 0; i < modelsToTry.length; i++) {
    const model = modelsToTry[i];
    console.log(`Trying model ${i + 1}/${modelsToTry.length}: ${model}`);
    
    try {
      const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${process.env.OPENROUTER_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: model,
          messages: [{ role: "user", content: prompt }],
          max_tokens: maxTokens,
          temperature: 0.7,
          top_p: 0.9,
          stream: false
        }),
      });

      const data = await response.json();

      // If rate limited (429), try next model
      if (response.status === 429) {
        console.log(`Model ${model} is rate limited, trying next model...`);
        continue;
      }

      if (!response.ok) {
        console.error(`API Error for ${model}:`, data);
        const errorMessage = data?.error?.message || data?.error || response.statusText || "Unknown API error";
        
        if (response.status >= 500 || response.status === 503) {
          console.log(`Server error with ${model}, trying next model...`);
          continue;
        }
        
        throw new Error(`API Error (${response.status}): ${errorMessage}`);
      }

      if (!data.choices || !data.choices[0]?.message?.content) {
        console.error(`Unexpected response from ${model}:`, data);
        continue;
      }

      // Cache successful model
      workingModelCache = model;
      lastModelCacheTime = now;
      
      console.log(`Success with ${model}!`);
      return data.choices[0].message.content;

    } catch (err) {
      console.error(`Error with model ${model}:`, err.message);
      
      if (i === modelsToTry.length - 1) {
        throw new Error(`All models failed. Last error: ${err.message}`);
      }
      
      console.log("Trying next model...");
      continue;
    }
  }
  
  throw new Error("All available models are currently unavailable");
}

// Optimized JSON parsing with better error recovery
function parseQuizResponse(rawResponse, requestedCount) {
  let cleaned = rawResponse.trim();
  
  // Remove code blocks if present
  if (cleaned.includes('```')) {
    cleaned = cleaned.replace(/```json\s*|\s*```/g, '');
    cleaned = cleaned.trim();
  }
  
  // Find JSON array boundaries
  const arrayStart = cleaned.indexOf('[');
  const arrayEnd = cleaned.lastIndexOf(']') + 1;
  
  if (arrayStart === -1 || arrayEnd <= arrayStart) {
    throw new Error("No valid JSON array found in response");
  }
  
  cleaned = cleaned.substring(arrayStart, arrayEnd);
  
  try {
    const quizData = JSON.parse(cleaned);
    if (!Array.isArray(quizData)) {
      throw new Error("Response is not an array");
    }
    return quizData;
    
  } catch (jsonErr) {
    console.log("Direct JSON parsing failed, attempting recovery...");
    
    // Enhanced fallback parsing with regex
    const questions = [];
    const questionRegex = /"question"\s*:\s*"([^"\\]*(\\.[^"\\]*)*)"/g;
    const optionsRegex = /"options"\s*:\s*\[\s*("(?:[^"\\]|\\.)*"(?:\s*,\s*"(?:[^"\\]|\\.)*")*)\s*\]/g;
    const correctIndexRegex = /"correctIndex"\s*:\s*(\d+)/g;
    const hintRegex = /"hint"\s*:\s*"([^"\\]*(\\.[^"\\]*)*)"/g;
    const explanationRegex = /"explanation"\s*:\s*"([^"\\]*(\\.[^"\\]*)*)"/g;
    
    let match;
    const questionTexts = [];
    const allOptions = [];
    const correctIndices = [];
    const hints = [];
    const explanations = [];
    
    // Extract all components
    while ((match = questionRegex.exec(cleaned)) !== null) {
      questionTexts.push(match[1]);
    }
    
    while ((match = optionsRegex.exec(cleaned)) !== null) {
      try {
        const optionsStr = `[${match[1]}]`;
        const parsedOptions = JSON.parse(optionsStr);
        allOptions.push(parsedOptions);
      } catch (e) {
        allOptions.push(["Option A", "Option B", "Option C", "Option D"]);
      }
    }
    
    while ((match = correctIndexRegex.exec(cleaned)) !== null) {
      correctIndices.push(parseInt(match[1]));
    }
    
    while ((match = hintRegex.exec(cleaned)) !== null) {
      hints.push(match[1]);
    }
    
    while ((match = explanationRegex.exec(cleaned)) !== null) {
      explanations.push(match[1]);
    }
    
    // Build questions from extracted data
    const maxQuestions = Math.min(
      requestedCount,
      questionTexts.length, 
      allOptions.length, 
      correctIndices.length
    );
    
    for (let i = 0; i < maxQuestions; i++) {
      questions.push({
        question: questionTexts[i] || `Sample question ${i + 1}`,
        options: allOptions[i] || ["Option A", "Option B", "Option C", "Option D"],
        correctIndex: correctIndices[i] !== undefined ? correctIndices[i] : 0,
        hint: hints[i] || "Review the material carefully",
        explanation: explanations[i] || "This is the correct answer based on the content."
      });
    }
    
    if (questions.length === 0) {
      throw new Error("Fallback parsing also failed");
    }
    
    return questions;
  }
}

// Homepage route
app.get("/", (req, res) => {
  res.send("AI Study Tutor API is running! Use /api/summarize or /api/generateQuiz.");
});

// Optimized summarize endpoint
app.post("/api/summarize", async (req, res) => {
  try {
    const { content, length = 'medium' } = req.body;
    
    if (!content) {
      return res.status(400).json({ error: "No content provided" });
    }

    if (!process.env.OPENROUTER_API_KEY) {
      return res.status(500).json({ error: "API key not configured" });
    }

    // Aggressive truncation for faster processing
    const truncatedContent = content.length > 2500 ? content.substring(0, 2500) + "..." : content;
    
    const lengthInstructions = {
      'short': 'max 80 words',
      'medium': 'max 150 words', 
      'long': 'max 250 words'
    };

    // Shorter, more direct prompt
    const rawSummary = await callAI(
      `Summarize this text (${lengthInstructions[length] || 'max 150 words'}). Use simple language for students:\n\n${truncatedContent}`,
      Math.min(400, parseInt(lengthInstructions[length]?.match(/\d+/)?.[0] || 150) * 2)
    );

    // Streamlined cleanup
    let summary = rawSummary.trim()
      .replace(/^(Here's|Here is|This is|The following is)\s+(a\s+)?(summary|text|content)[^:]*:\s*/i, '')
      .replace(/^Summary:\s*/i, '')
      .trim();
    
    res.json({ summary });
  } catch (err) {
    console.error("Error generating summary:", err);
    res.status(500).json({ 
      error: "Failed to summarize", 
      details: err.message || "Unknown error occurred" 
    });
  }
});

// Heavily optimized quiz endpoint
app.post("/api/generateQuiz", async (req, res) => {
  try {
    const { summary, content, count = 5, difficulty = 'medium' } = req.body;
    const sourceText = content || summary;
    
    if (!sourceText) {
      return res.status(400).json({ error: "No content or summary provided" });
    }

    if (!process.env.OPENROUTER_API_KEY) {
      return res.status(500).json({ error: "API key not configured" });
    }

    const requestedCount = Math.min(parseInt(count), 20); // Cap at 20 for performance
    
    // More aggressive truncation for large quiz requests
    const maxContentLength = requestedCount > 10 ? 1500 : 2000;
    const truncatedText = sourceText.length > maxContentLength ? 
      sourceText.substring(0, maxContentLength) + "..." : sourceText;
    
    // Simplified difficulty mapping
    const difficultyMap = {
      'easy': 'simple concepts',
      'medium': 'standard difficulty',
      'hard': 'complex concepts'
    };

    // Optimized prompt - more concise and direct
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

    console.log(`Generating ${requestedCount} questions...`);
    
    // Dynamic token allocation based on question count
    const tokensPerQuestion = 120;
    const baseTokens = 200;
    const maxTokens = Math.min(4000, baseTokens + (requestedCount * tokensPerQuestion));
    
    const quiz = await callAI(prompt, maxTokens);

    console.log("Quiz response received, parsing...");
    
    let quizData = parseQuizResponse(quiz, requestedCount);

    // Efficient validation and filtering
    quizData = quizData
      .filter(q => {
        return q.question && 
               typeof q.question === 'string' && 
               q.question.trim().length > 5 &&
               Array.isArray(q.options) && 
               q.options.length >= 2 && 
               typeof q.correctIndex === 'number' &&
               q.correctIndex >= 0 && 
               q.correctIndex < q.options.length;
      })
      .slice(0, requestedCount)
      .map(q => ({
        question: q.question.trim(),
        options: q.options.map(opt => String(opt).trim()),
        correctIndex: q.correctIndex,
        hint: q.hint || "Think about the key concepts in the material",
        explanation: q.explanation || "Review the relevant section for more details"
      }));

    if (quizData.length === 0) {
      throw new Error("No valid questions were generated. Try with shorter content.");
    }

    console.log(`Successfully generated ${quizData.length} questions`);
    res.json({ questions: quizData });

  } catch (err) {
    console.error("Quiz generation error:", err);
    res.status(500).json({ 
      error: "Failed to generate quiz", 
      details: err.message || "Unknown error occurred" 
    });
  }
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ 
    error: 'Internal server error', 
    details: err.message || 'Unknown error' 
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ AI Study Tutor running on port ${PORT}`);
  console.log("Environment check:", {
    hasApiKey: !!process.env.OPENROUTER_API_KEY,
    nodeVersion: process.version
  });
});