// Port of supabase/functions/analyze-document-structure. Asks the configured AI provider (ai_settings
// 'ai_api_config') to describe an exam paper's structure: question types, answer-key format, section numbering,
// and an extraction strategy. Uses a forced tool call, so the reply is a JSON object.
// POST { contentMarkdown?, contentJson?, documentName? }. Errors keep the original { success:false, errorCode } shape.
// The original had no check of its own (the Supabase gateway required a JWT); this port keeps it open as before.
import express from "express";
import { query } from "../_shared/db.js";

export const router = express.Router();

const analysisToolSchema = [
  {
    type: "function",
    function: {
      name: "analyze_document_structure",
      description:
        "Analyze the structure of an educational document to understand question types, patterns, answer key locations, and section numbering.",
      parameters: {
        type: "object",
        properties: {
          totalEstimatedQuestions: {
            type: "number",
            description: "Total estimated number of questions in the document (across ALL sections)",
          },
          hasAnswerKey: {
            type: "boolean",
            description: "Whether an answer key section or inline answers are present",
          },
          answerKeyLocation: {
            type: "string",
            enum: ["beginning", "end", "inline", "separate_section", "not_found"],
            description: "Where the answer key is located in the document",
          },
          questionTypes: {
            type: "array",
            items: {
              type: "object",
              properties: {
                type: {
                  type: "string",
                  enum: ["mcq", "integer", "fill_blank", "match", "true_false", "written", "assertion_reason"],
                  description: "Type of question",
                },
                count: { type: "number", description: "Estimated count of this question type" },
                questionRange: { type: "string", description: "Range of question numbers, e.g., '1-30' or 'Q31-Q35'" },
                sectionName: { type: "string", description: "Name of the section, e.g., 'Section A', 'Part I'" },
              },
              required: ["type", "count"],
            },
          },
          formatPatterns: {
            type: "object",
            properties: {
              questionNumberFormat: { type: "string", description: "Pattern for question numbers, e.g., 'Q1.', '1.', '(1)'" },
              optionFormat: { type: "string", description: "Pattern for options, e.g., '(A)', 'A.', 'a)'" },
              hasMathNotation: { type: "boolean", description: "Whether document contains LaTeX or mathematical notation" },
              hasImages: { type: "boolean", description: "Whether document contains embedded images" },
            },
            required: ["questionNumberFormat", "hasMathNotation", "hasImages"],
          },
          documentSections: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string", description: "Name of the section" },
                purpose: {
                  type: "string",
                  enum: ["questions", "answers", "instructions", "other"],
                  description: "Purpose of this section",
                },
                approximatePosition: {
                  type: "string",
                  enum: ["beginning", "middle", "end"],
                  description: "Where this section appears in the document",
                },
              },
              required: ["name", "purpose", "approximatePosition"],
            },
          },
          extractionStrategy: {
            type: "object",
            properties: {
              recommendedApproach: {
                type: "string",
                enum: ["single_pass", "section_by_section", "type_by_type"],
                description: "Recommended extraction approach",
              },
              suggestedChunkCount: { type: "number", description: "Suggested number of chunks for parallel processing" },
              specialInstructions: {
                type: "array",
                items: { type: "string" },
                description: "Special instructions for extraction",
              },
            },
            required: ["recommendedApproach", "suggestedChunkCount", "specialInstructions"],
          },
          answerKeyDetails: {
            type: "object",
            properties: {
              format: {
                type: "string",
                enum: ["table", "inline_with_question", "numbered_list", "key_value_pairs", "not_found"],
                description: "How answers are structured in the document",
              },
              answerPatterns: {
                type: "array",
                items: { type: "string" },
                description: "Pattern strings for answer formats found, e.g., 'Answer: X)', 'Ans: (X)', 'Sol:'",
              },
              sampleAnswers: {
                type: "array",
                items: {
                  type: "object",
                  properties: { question: { type: "number" }, answer: { type: "string" } },
                },
                description: "First 3 example question-answer pairs found in the document",
              },
            },
            required: ["format", "answerPatterns"],
          },
          sectionNumbering: {
            type: "object",
            properties: {
              hasMultipleSections: {
                type: "boolean",
                description: "Whether document has distinct sections (MCQs, Short Answer, Long Answer, etc.)",
              },
              sectionsRestartNumbering: {
                type: "boolean",
                description: "Whether numbering restarts in each section (e.g., MCQ 1-5, then Short Answer 1-2 starts over)",
              },
              sections: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    name: { type: "string", description: "Section name like 'MCQs', 'Short Answer Questions'" },
                    type: { type: "string", enum: ["mcq", "written", "mixed"] },
                    questionRange: { type: "string", description: "Local range in section, e.g., '1-5'" },
                    absoluteRange: { type: "string", description: "Absolute range in document, e.g., '1-5' or '6-7'" },
                  },
                  required: ["name", "type", "questionRange", "absoluteRange"],
                },
              },
              recommendedIdPrefix: {
                type: "boolean",
                description: "Whether to use prefixed IDs like MCQ-1, SA-1 to avoid number conflicts",
              },
            },
            required: ["hasMultipleSections", "sectionsRestartNumbering"],
          },
        },
        required: [
          "totalEstimatedQuestions",
          "hasAnswerKey",
          "answerKeyLocation",
          "questionTypes",
          "formatPatterns",
          "documentSections",
          "extractionStrategy",
          "answerKeyDetails",
          "sectionNumbering",
        ],
      },
    },
  },
];

const SYSTEM_PROMPT = `You are a document structure analyzer for educational exam papers and question banks.

Your task is to analyze the given document and identify:

1. QUESTION TYPES PRESENT:
   - MCQ (Multiple Choice with options A,B,C,D)
   - Integer/Numerical (answer is a number, no options)
   - Fill in the Blank (complete the sentence with _____)
   - Match the Following (column A to column B matching)
   - True/False questions
   - Written/Subjective (short or long answer)
   - Assertion-Reason (two statements to analyze)

2. DOCUMENT STRUCTURE:
   - Where do questions start? (look for "QUESTIONS", "Part A", "Section I", "PROFICIENCY TEST", etc.)
   - Where do answers appear? (look for "ANSWER KEY", "SOLUTIONS", "ANSWERS TO...", etc.)
   - Is this a single-section or multi-section paper?
   - Any special patterns (e.g., "Q1-30 are MCQ", "Q31-35 are Integer")

3. ANSWER KEY ANALYSIS (CRITICAL - ANALYZE CAREFULLY):
   Carefully examine HOW answers appear in the document:

   a) INLINE ANSWERS (answers appear right after each question):
      - Patterns: "Answer: B)", "Ans: (C)", "Answer: B) Full text...", "Correct Answer: A"
      - "Sol:", "Solution:", "Ans.", "Answer:"
      - The answer text may include the full option text, not just a letter
      - If you see these patterns after questions, set format="inline_with_question"

   b) SEPARATE ANSWER KEY (answers in a dedicated section):
      - Table format: |1|B|2|C|3|A|
      - Key-value: 1.(B), 2.(C), 3.(A)
      - Numbered list: 1. B, 2. C, 3. A

   c) For each document, you MUST identify:
      - The exact format of answers (choose from: table, inline_with_question, numbered_list, key_value_pairs, not_found)
      - The pattern strings used (e.g., ["Answer: X)", "Ans: (X)"])
      - 3 sample question-answer pairs as examples

4. SECTION NUMBERING ANALYSIS (CRITICAL FOR MULTI-SECTION DOCS):
   Many question banks have multiple sections where numbering restarts:

   a) Identify if document has distinct sections:
      - # MCQs, ## Short Answer Questions, ### Long Answer
      - Section A, Section B, Part I, Part II

   b) Check if numbering RESTARTS in each section:
      - MCQs: 1-5, Short Answer: 1-2 (starts over at 1), Long Answer: 1 (starts over)

   c) Calculate ABSOLUTE question numbers:
      - MCQ 1-5 → absolute 1-5
      - Short Answer 1-2 → absolute 6-7
      - Long Answer 1 → absolute 8

   d) Report:
      - hasMultipleSections: true/false
      - sectionsRestartNumbering: true/false (if different sections restart at 1)
      - sections: array with name, type, local range, absolute range
      - recommendedIdPrefix: true if sections overlap (use MCQ-1, SA-1 format)

5. QUESTION FORMAT PATTERNS:
   - How are questions numbered? (1. or Q1. or (1) or 1) or Question 1: etc.)
   - How are MCQ options formatted? ((A) or A. or a) or (a) etc.)
   - Is there LaTeX/mathematical notation? (look for $, \\, \\frac, etc.)
   - Are there embedded images referenced?

6. EXTRACTION STRATEGY:
   - For small documents (<30 questions): single_pass
   - For medium documents (30-100 questions): section_by_section with 3-4 chunks
   - For large documents (>100 questions): type_by_type with 6 chunks
   - Add special instructions for unique patterns

BE ACCURATE about question counts - count all questions across all sections.
If sections restart numbering, calculate the true total (e.g., MCQ 1-5 + SA 1-2 + LA 1 = 8 total).`;

const fail = (res, status, body) => res.status(status).json({ success: false, ...body });

router.post("/", async (req, res) => {
  try {
    const { contentMarkdown, contentJson, documentName } = req.body || {};

    let extractionText = "";
    if (contentMarkdown && typeof contentMarkdown === "string" && contentMarkdown.length > 100) {
      extractionText = contentMarkdown;
    } else if (contentJson) {
      extractionText = typeof contentJson === "string" ? contentJson : JSON.stringify(contentJson);
    }
    if (!extractionText || extractionText.length < 100) {
      return res.json({ success: false, error: "No valid content provided for analysis", errorCode: "NO_CONTENT" });
    }

    const { rows } = await query("SELECT setting_value FROM public.ai_settings WHERE setting_key = $1 LIMIT 1", ["ai_api_config"]);
    const config = rows[0]?.setting_value || null;

    let apiUrl;
    let apiKey;
    let model;
    if (config?.enabled && config.provider === "openrouter" && config.openrouter_api_key) {
      apiUrl = "https://openrouter.ai/api/v1/chat/completions";
      apiKey = config.openrouter_api_key;
      model = config.default_model || "google/gemini-2.5-flash";
    } else if (config?.enabled && config.provider === "google" && config.google_api_key) {
      apiUrl = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";
      apiKey = config.google_api_key;
      model = config.default_model || "gemini-2.5-flash";
    } else if (config?.enabled && config.provider === "openai" && config.openai_api_key) {
      apiUrl = "https://api.openai.com/v1/chat/completions";
      apiKey = config.openai_api_key;
      model = config.default_model || "gpt-4o";
    } else {
      return res.json({
        success: false,
        error: "AI API not configured. Please go to Admin → Settings → AI Functions API Key Settings.",
        errorCode: "AI_NOT_CONFIGURED",
      });
    }

    // Keep the first and last halves of long documents, so the prompt stays within token limits.
    const maxChars = 60000;
    const half = Math.floor(maxChars / 2);
    const analysisText =
      extractionText.length > maxChars
        ? extractionText.slice(0, half) + "\n\n[...middle content omitted...]\n\n" + extractionText.slice(-half)
        : extractionText;

    const userPrompt = `Analyze this educational document and provide a structured analysis:

Document Name: ${documentName || "Unknown"}

Document Content (first and last portions):
${analysisText}

IMPORTANT - Analyze these aspects carefully:

1. Total number of questions (count ALL questions across ALL sections - if sections restart at 1, add them up)
2. Types of questions present (MCQ, Written/Short Answer, Long Answer, etc.)
3. **Answer key analysis** - Look for:
   - Inline answers like "Answer: B)", "Ans: (C)", "Sol:" after each question
   - Separate answer key section
   - Report the exact patterns found and 3 sample answers
4. **Section numbering** - Check if:
   - Document has multiple sections (MCQs, Short Answer, Long Answer)
   - Each section restarts numbering at 1
   - Calculate absolute question numbers (MCQ 1-5 + SA 1-2 = questions 1-7 total)
5. Question numbering format (1., Q1., (1), etc.)
6. Option format for MCQs (A), a., etc.)

Return your analysis using the analyze_document_structure function.`;

    const response = await fetch(apiUrl, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userPrompt },
        ],
        tools: analysisToolSchema,
        tool_choice: { type: "function", function: { name: "analyze_document_structure" } },
        temperature: 0.1,
        max_tokens: 4000,
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      console.error(`AI API error ${response.status}:`, errorBody.slice(0, 300));
      return res.json({ success: false, error: `AI API error: ${response.status}`, errorCode: "AI_ERROR" });
    }

    const data = await response.json();
    const toolArgs = data.choices?.[0]?.message?.tool_calls?.[0]?.function?.arguments;
    if (!toolArgs) {
      return res.json({ success: false, error: "AI did not return a valid analysis", errorCode: "INVALID_RESPONSE" });
    }

    let analysis;
    try {
      analysis = JSON.parse(toolArgs);
    } catch {
      return res.json({ success: false, error: "Failed to parse AI analysis", errorCode: "PARSE_ERROR" });
    }

    return res.json({ success: true, analysis });
  } catch (error) {
    console.error("Analysis error:", error?.message);
    return fail(res, 500, {
      error: error instanceof Error ? error.message : "Unknown error",
      errorCode: "SERVER_ERROR",
    });
  }
});
