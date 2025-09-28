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

// Helper function: call AI with fallback models
async function callAI(prompt, maxTokens = 1000) {
  // List of free models to try in order
  const freeModels = [
    "meta-llama/llama-3.2-3b-instruct:free",
    "microsoft/phi-3-mini-128k-instruct:free", 
    "google/gemma-2-9b-it:free",
    "huggingface/zephyr-7b-beta:free",
    "openchat/openchat-7b:free"
  ];

  console.log("Sending prompt to AI:", prompt.substring(0, 200) + "...");
  
  for (let i = 0; i < freeModels.length; i++) {
    const model = freeModels[i];
    console.log(`Trying model ${i + 1}/${freeModels.length}: ${model}`);
    
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
        
        // If it's not a rate limit, try next model
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

      console.log(`Success with ${model}! Response:`, data.choices[0].message.content.substring(0, 200) + "...");
      return data.choices[0].message.content;

    } catch (err) {
      console.error(`Error with model ${model}:`, err.message);
      
      // If this is the last model, re-throw the error
      if (i === freeModels.length - 1) {
        throw new Error(`All models failed. Last error: ${err.message}`);
      }
      
      // Otherwise, continue to next model
      console.log("Trying next model...");
      continue;
    }
  }
  
  throw new Error("All available models are currently unavailable");
}

// Homepage route
app.get("/", (req, res) => {
  res.send("AI Study Tutor API is running! Use /api/summarize or /api/generateQuiz.");
});

// Summarize endpoint
app.post("/api/summarize", async (req, res) => {
  try {
    const { content, length = 'medium' } = req.body;
    
    if (!content) {
      return res.status(400).json({ error: "No content provided" });
    }

    if (!process.env.OPENROUTER_API_KEY) {
      return res.status(500).json({ error: "API key not configured" });
    }

    const truncatedContent = content.length > 3000 ? content.substring(0, 3000) + "..." : content;
    
    const lengthInstructions = {
      'short': 'max 100 words',
      'medium': 'max 200 words', 
      'long': 'max 300 words'
    };

    const rawSummary = await callAI(
      `Provide a concise summary of the following text for a student (${lengthInstructions[length] || 'max 200 words'}). Return ONLY the summary content without any introductory phrases:\n\n${truncatedContent}`,
      500
    );

    // Clean up the summary response
    let summary = rawSummary.trim();
    
    // Remove common AI intro phrases
    const introPatterns = [
      /^Here's a summary of the text in \d+ words or less that a student can understand:\s*/i,
      /^Here's a summary of the text:\s*/i,
      /^Here's a concise summary:\s*/i,
      /^Summary:\s*/i,
      /^Here is a summary:\s*/i,
      /^The text can be summarized as follows:\s*/i,
      /^This text discusses:\s*/i,
      /^The following is a summary:\s*/i,
      /^Below is a summary:\s*/i
    ];
    
    for (const pattern of introPatterns) {
      summary = summary.replace(pattern, '');
    }
    
    // Clean up any remaining formatting issues
    summary = summary.trim();
    
    console.log("Cleaned summary:", summary.substring(0, 100) + "...");
    res.json({ summary });
  } catch (err) {
    console.error("Error generating summary:", err);
    const errorMessage = err.message || err.toString() || "Unknown error occurred";
    res.status(500).json({ 
      error: "Failed to summarize", 
      details: errorMessage 
    });
  }
});

// Quiz endpoint
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

    const truncatedText = sourceText.length > 2000 ? sourceText.substring(0, 2000) + "..." : sourceText;
    
    const difficultyInstructions = {
      'easy': 'Use simple language and basic concepts',
      'medium': 'Use moderate complexity with some technical terms',
      'hard': 'Use advanced concepts and technical terminology'
    };

    const quiz = await callAI(
      `Create exactly ${count} multiple-choice questions based on this text. ${difficultyInstructions[difficulty] || ''}. 

CRITICAL: You must return ONLY valid JSON. No explanations, no markdown, no extra text.

Format: Return exactly this JSON structure (with proper quotes and commas):
[
  {
    "question": "Your question here?",
    "options": ["Option A", "Option B", "Option C", "Option D"],
    "correctIndex": 0,
    "hint": "Brief hint",
    "explanation": "Why this answer is correct"
  }
]

Rules:
- Use double quotes only
- No single quotes anywhere  
- Ensure all strings are properly quoted
- Add commas between all array elements
- No trailing commas
- correctIndex must be 0, 1, 2, or 3
- Make sure JSON is valid

Text for questions:
${truncatedText}`,
      Math.max(1200, count * 250) // More tokens for complex JSON
    );

    console.log("Quiz raw response:", quiz.substring(0, 500) + "...");

    let cleaned = quiz.trim();
    
    // Remove code blocks if present
    if (cleaned.includes('```')) {
      cleaned = cleaned.replace(/```json\s*|\s*```/g, '');
      cleaned = cleaned.trim();
    }
    
    // Remove any explanatory text before the array
    const arrayStart = cleaned.indexOf('[');
    const arrayEnd = cleaned.lastIndexOf(']') + 1;
    
    if (arrayStart === -1 || arrayEnd <= arrayStart) {
      console.error("No JSON array found in response:", cleaned);
      throw new Error("No valid JSON array found in response");
    }
    
    cleaned = cleaned.substring(arrayStart, arrayEnd);
    console.log("Extracted JSON:", cleaned.substring(0, 300) + "...");

    let quizData = [];
    try {
      // Try parsing the JSON as-is first
      quizData = JSON.parse(cleaned);
      if (!Array.isArray(quizData)) {
        throw new Error("Response is not an array");
      }
      
    } catch (jsonErr) {
      console.error("Direct JSON parsing failed:", jsonErr.message);
      
      // Fallback: try to manually extract and build questions
      try {
        console.log("Attempting fallback parsing...");
        
        // Split by question boundaries and extract each question
        const questions = [];
        const questionPattern = /"question"\s*:\s*"([^"]+)"/g;
        const optionsPattern = /"options"\s*:\s*\[([^\]]+)\]/g;
        const correctIndexPattern = /"correctIndex"\s*:\s*(\d+)/g;
        
        let questionMatch;
        const questionTexts = [];
        while ((questionMatch = questionPattern.exec(cleaned)) !== null) {
          questionTexts.push(questionMatch[1]);
        }
        
        let optionsMatch;
        const allOptions = [];
        while ((optionsMatch = optionsPattern.exec(cleaned)) !== null) {
          try {
            const optionsStr = `[${optionsMatch[1]}]`;
            const parsedOptions = JSON.parse(optionsStr);
            allOptions.push(parsedOptions);
          } catch (e) {
            console.log("Failed to parse options:", optionsMatch[1]);
            allOptions.push(["Option A", "Option B", "Option C", "Option D"]);
          }
        }
        
        let correctIndexMatch;
        const correctIndices = [];
        while ((correctIndexMatch = correctIndexPattern.exec(cleaned)) !== null) {
          correctIndices.push(parseInt(correctIndexMatch[1]));
        }
        
        // Build questions from extracted data
        const maxQuestions = Math.min(questionTexts.length, allOptions.length, correctIndices.length);
        for (let i = 0; i < maxQuestions; i++) {
          questions.push({
            question: questionTexts[i],
            options: allOptions[i],
            correctIndex: correctIndices[i],
            hint: "Review the material carefully",
            explanation: "This is the correct answer based on the content."
          });
        }
        
        if (questions.length > 0) {
          quizData = questions;
          console.log(`Fallback parsing successful: extracted ${questions.length} questions`);
        } else {
          throw new Error("Fallback parsing also failed");
        }
        
      } catch (fallbackErr) {
        console.error("Fallback parsing failed:", fallbackErr.message);
        throw new Error(`Failed to parse quiz response: ${jsonErr.message}`);
      }
    }

    console.log(`Successfully parsed ${quizData.length} questions`);
    
    // Validate and filter questions
    quizData = quizData.filter((q, index) => {
      const isValid = q.question && 
                     typeof q.question === 'string' && 
                     q.question.trim().length > 0 &&
                     Array.isArray(q.options) && 
                     q.options.length >= 2 && 
                     typeof q.correctIndex === 'number' &&
                     q.correctIndex >= 0 && 
                     q.correctIndex < q.options.length;
      
      if (!isValid) {
        console.log(`Question ${index + 1} is invalid:`, JSON.stringify(q));
      }
      return isValid;
    }).slice(0, parseInt(count) || 5);

    if (quizData.length === 0) {
      throw new Error("No valid questions were generated. Please try with shorter content or fewer questions.");
    }

    console.log(`Returning ${quizData.length} questions`);
    res.json({ questions: quizData });

  } catch (err) {
    console.error("Quiz generation error:", err);
    const errorMessage = err.message || err.toString() || "Unknown error occurred";
    res.status(500).json({ 
      error: "Failed to generate quiz", 
      details: errorMessage 
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
