// Port of supabase/functions/extract-questions-preview. Extracts MCQ, written and proficiency
// questions from a document in parallel chunks, recovers missing ones with follow-up AI calls,
// and fills answers from the answer key found in the text.
// Auth: a valid user Bearer token, or x-service-key matching SERVICE_KEY.
// The AI provider comes from ai_settings 'ai_api_config', as in the other AI functions.
import express from "express";
import jwt from "jsonwebtoken";
import crypto from "node:crypto";
import { query } from "../_shared/db.js";

export const router = express.Router();

// Test hook: lets tests stub the AI provider so no real request is sent.
export const hooks = { fetch: (...args) => fetch(...args) };

function isAuthorised(req) {
  const svc = process.env.SERVICE_KEY || "";
  const got = req.get("x-service-key") || "";
  if (svc && got.length === svc.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(svc))) return true;
  const h = req.get("Authorization") || "";
  if (!h.startsWith("Bearer ")) return false;
  try {
    return Boolean(jwt.verify(h.slice(7), process.env.JWT_SECRET)?.sub);
  } catch {
    return false;
  }
}


// Maximum questions to extract - papers can have 1-200 questions
const MAX_QUESTIONS = 200;
// Number of parallel chunks to process
const CHUNK_COUNT = 6;
// Maximum recovery attempts per chunk
const MAX_CHUNK_RECOVERY_ATTEMPTS = 3;
// Questions to target per recovery call
const RECOVERY_BATCH_SIZE = 10;
// Chunk overlap in characters - INCREASED from 500 to 3000
const CHUNK_OVERLAP = 3000;
// Global recovery threshold - INCREASED from 25 to 50
const GLOBAL_RECOVERY_THRESHOLD = 50;

// Document Analysis types (matching frontend types)

/**
 * Convert numeric answer (1-4) to letter (A-D)
 */
export function numericToLetter(num        )                {
  const map                         = { "1": "A", "2": "B", "3": "C", "4": "D" };
  return map[num] || null;
}

/**
 * Parse markdown table rows for answer key
 */
export function parseTableAnswers(text        )                      {
  const answers = new Map                ();

  const primaryPattern = /\|\s*(\d{1,3})\s*\.?\s*\(([^)]+)\)/g;
  let match;

  while ((match = primaryPattern.exec(text)) !== null) {
    const qNum = parseInt(match[1], 10);
    const rawAnswer = match[2].trim();

    if (qNum < 1 || qNum > MAX_QUESTIONS) continue;

    if (/^[1-4]$/.test(rawAnswer)) {
      const letter = numericToLetter(rawAnswer);
      if (letter) answers.set(qNum, letter);
    } else if (/^[A-Da-d]$/.test(rawAnswer)) {
      answers.set(qNum, rawAnswer.toUpperCase());
    } else if (/^-?\d+\.?\d*$/.test(rawAnswer)) {
      answers.set(qNum, rawAnswer);
    }
  }

  const simpleTablePattern = /\|\s*(\d{1,3})\s*\|\s*([A-Da-d1-4])\s*\|/g;
  while ((match = simpleTablePattern.exec(text)) !== null) {
    const qNum = parseInt(match[1], 10);
    if (answers.has(qNum)) continue;

    let answer = match[2].toUpperCase();
    if (/^[1-4]$/.test(answer)) {
      const converted = numericToLetter(answer);
      if (converted) answer = converted;
    }

    if (qNum >= 1 && qNum <= MAX_QUESTIONS && /^[A-D]$/.test(answer)) {
      answers.set(qNum, answer);
    }
  }

  return answers;
}

/**
 * Extract answer key from the document text
 */
export function extractAnswerKey(text        )                      {
  const answerMap = new Map                ();

  const answerKeyHeaders = [
    /ANSWER\s*KEY/i,
    /ANSWERS?\s*:/i,
    /SOLUTION\s*KEY/i,
    /CORRECT\s*ANSWERS?/i,
    /KEY\s*:/i,
  ];

  let searchText = text;
  let answerKeyStart = -1;

  for (const header of answerKeyHeaders) {
    const match = text.search(header);
    if (match !== -1 && (answerKeyStart === -1 || match > answerKeyStart)) {
      answerKeyStart = match;
    }
  }

  if (answerKeyStart !== -1) {
    searchText = text.slice(answerKeyStart);
    console.log(`Found answer key section at position ${answerKeyStart}`);
  } else {
    searchText = text.slice(-80000);
    console.log("No answer key header found, searching last 80K chars...");
  }

  const tableLines = (searchText.match(/\|.*\|/g) || []).length;
  if (tableLines > 5) {
    const tableAnswers = parseTableAnswers(searchText);
    for (const [k, v] of tableAnswers) {
      answerMap.set(k, v);
    }
  }

  const mcqPatterns = [
    /(\d{1,3})\s*\.?\s*\(([A-Da-d])\)/g,
    /(\d{1,3})\s*[\.\)\-:]\s*([A-Da-d])(?=[\s,;.\n\r]|$)/g,
    /Q\.?\s*(\d{1,3})\s*[\:\-\.\)]\s*\(?([A-Da-d])\)?/gi,
  ];

  const numericMcqPatterns = [
    /(\d{1,3})\s*\.?\s*\(([1-4])\)/g,
    /(\d{1,3})\s*[\.\)\-:]\s*([1-4])(?=[\s,;.\n\r]|$)/g,
  ];

  const integerPatterns = [
    /(\d{1,3})\s*\.?\s*\((-?\d{2,})\)/g,
    /(\d{1,3})\s*[:\-]\s*(-?\d{2,})(?=[\s,;.\n\r]|$)/g,
  ];

  for (const pattern of mcqPatterns) {
    let match;
    while ((match = pattern.exec(searchText)) !== null) {
      const qNum = parseInt(match[1], 10);
      const answer = match[2].toUpperCase();
      if (qNum >= 1 && qNum <= MAX_QUESTIONS && /^[A-D]$/.test(answer) && !answerMap.has(qNum)) {
        answerMap.set(qNum, answer);
      }
    }
  }

  for (const pattern of numericMcqPatterns) {
    let match;
    while ((match = pattern.exec(searchText)) !== null) {
      const qNum = parseInt(match[1], 10);
      const numAnswer = match[2];
      if (qNum >= 1 && qNum <= MAX_QUESTIONS && !answerMap.has(qNum)) {
        const letter = numericToLetter(numAnswer);
        if (letter) answerMap.set(qNum, letter);
      }
    }
  }

  for (const pattern of integerPatterns) {
    let match;
    while ((match = pattern.exec(searchText)) !== null) {
      const qNum = parseInt(match[1], 10);
      const intAnswer = match[2];
      if (qNum >= 1 && qNum <= MAX_QUESTIONS && !answerMap.has(qNum)) {
        answerMap.set(qNum, intAnswer);
      }
    }
  }

  console.log(`Total answers found: ${answerMap.size}`);
  return answerMap;
}

/**
 * Helper function for delay
 */
export function delay(ms        )                {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Find all question positions with improved patterns
 */
export function findQuestionPositions(text        )                                    {
  const positions                                    = [];
  const seen = new Set        ();

  // Multiple patterns to catch different question formats
  const patterns = [
    /(?:^|\n)\s*(?:Q|Question)\s*\.?\s*(\d{1,3})\s*[\.\):\-]/gmi,  // Q1. Q.1 Question 1
    /(?:^|\n)\s*(\d{1,3})\s*\.\s+[A-Z]/gm,                          // 1. A sentence...
    /(?:^|\n)\s*(\d{1,3})\s*\)\s+/gm,                               // 1) 
    /(?:^|\n)\s*\((\d{1,3})\)\s+/gm,                                // (1)
    /(?:^|\n)\s*(\d{1,3})\s*[\.\)]\s*(?:Match|Which|What|If|A|The|In|For|Consider)/gmi, // 1. Match...
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const qNum = parseInt(match[1], 10);
      if (qNum >= 1 && qNum <= MAX_QUESTIONS && !seen.has(qNum)) {
        seen.add(qNum);
        positions.push({ index: match.index, qNum });
      }
    }
  }

  // Sort by position in text
  return positions.sort((a, b) => a.index - b.index);
}

/**
 * Find the questions section in a proficiency test document
 * Returns the portion of text containing only the questions (not answers)
 */
export function findProficiencyQuestionsSection(text        )                                        {
  // Match "# PROFICIENCY TEST" or "## PROFICIENCY TEST" but NOT "ANSWERS TO PROFICIENCY TEST"
  // The key is to match the header that starts the questions section
  const questionsPatterns = [
    /(?:^|\n)##?\s*PROFICIENCY\s+TEST(?:-[IVX]+)?(?:\s|$)/im, // # PROFICIENCY TEST or ## PROFICIENCY TEST-I
    /(?:^|\n)PROFICIENCY\s+TEST(?:-[IVX]+)?(?:\s|$)/im, // PROFICIENCY TEST without #
  ];

  const answersPattern = /ANSWERS?\s+TO\s+PROFICIENCY\s+TEST/i;
  const answersMatch = text.match(answersPattern);
  const answersIdx = answersMatch?.index ?? -1;

  let questionsIdx = -1;
  for (const pattern of questionsPatterns) {
    const match = text.match(pattern);
    if (match && match.index !== undefined) {
      // Make sure this is not the ANSWERS header
      const matchText = match[0];
      if (!/ANSWERS?\s+TO/i.test(matchText)) {
        questionsIdx = match.index;
        break;
      }
    }
  }

  console.log(`Proficiency section detection - answers at: ${answersIdx}, questions at: ${questionsIdx}`);

  if (questionsIdx !== -1 && answersIdx !== -1) {
    if (questionsIdx > answersIdx) {
      // Answers come BEFORE questions - extract from questions header onwards
      console.log(`Answers before questions - using text from position ${questionsIdx}`);
      return { section: text.slice(questionsIdx), startIdx: questionsIdx };
    } else {
      // Questions come BEFORE answers - extract between them
      console.log(`Questions before answers - using text from ${questionsIdx} to ${answersIdx}`);
      return { section: text.slice(questionsIdx, answersIdx), startIdx: questionsIdx };
    }
  } else if (questionsIdx !== -1) {
    return { section: text.slice(questionsIdx), startIdx: questionsIdx };
  } else if (answersIdx !== -1) {
    // No questions header found, but answers found - questions are likely after answers
    // Try searching after the answers section for question patterns
    const afterAnswers = text.slice(answersIdx);
    const firstQuestionMatch = afterAnswers.match(/(?:^|\n)\s*1\.\s+[A-Z]/m);
    if (firstQuestionMatch && firstQuestionMatch.index !== undefined) {
      const qStartIdx = answersIdx + firstQuestionMatch.index;
      console.log(`Found questions after answers section at position ${qStartIdx}`);
      return { section: text.slice(qStartIdx), startIdx: qStartIdx };
    }
  }

  // Fallback: use full text
  console.log("No clear section headers found, searching full text");
  return { section: text, startIdx: 0 };
}

/**
 * Build expected question range from document analysis section numbering
 * Returns sorted array of absolute question numbers
 */
export function buildExpectedRangeFromSections(sections               )           {
  const expected           = [];
  for (const section of sections) {
    const parts = section.absoluteRange.split('-').map(s => parseInt(s.trim(), 10));
    const start = parts[0];
    const end = parts.length > 1 ? parts[1] : parts[0];
    if (!isNaN(start) && !isNaN(end)) {
      for (let i = start; i <= end; i++) {
        expected.push(i);
      }
    } else if (!isNaN(start)) {
      expected.push(start);
    }
  }
  return expected.sort((a, b) => a - b);
}

/**
 * Detect actual question numbers in proficiency/practice documents
 * Returns sorted array of unique question numbers found
 */
export function detectProficiencyQuestionNumbers(text        , documentAnalysis                   )           {
  // Priority 1: Use document analysis section numbering (absolute ranges)
  if (documentAnalysis?.sectionNumbering?.sections?.length > 0) {
    const fromAnalysis = buildExpectedRangeFromSections(documentAnalysis.sectionNumbering.sections);
    if (fromAnalysis.length > 0) {
      console.log(`Using document analysis sections: ${fromAnalysis.join(", ")} (${fromAnalysis.length} questions)`);
      return fromAnalysis;
    }
  }

  // Priority 2: Use total estimated questions from analysis
  if (documentAnalysis?.totalEstimatedQuestions && documentAnalysis.totalEstimatedQuestions > 0) {
    const range = Array.from({ length: documentAnalysis.totalEstimatedQuestions }, (_, i) => i + 1);
    console.log(`Using analysis estimated count: ${range.join(", ")} (${range.length} questions)`);
    return range;
  }

  // Fallback: Regex-based detection
  const numbers = new Set        ();

  // Get only the questions section
  const { section: questionsSection } = findProficiencyQuestionsSection(text);

  // Patterns specifically for proficiency test question numbers
  // CRITICAL: Exclude patterns that look like answers (starting with $, x=, True, False, etc.)
  const patterns = [
    /(?:^|\n)\s*(\d{1,2})\.\s+(?![Tt]rue|[Ff]alse|[A-D]\)|[$\\]|x\s*=|[a-z]\s*=)/gm, // "1. Question..." but not "1. $x$" or "1. x ="
    /(?:^|\n)\s*(\d{1,2})\)\s+(?![Tt]rue|[Ff]alse|[A-D]\)|[$\\])/gm,                   // "1) Question..."
    /(?:^|\n)\s*\((\d{1,2})\)\s+/gm,                                                     // "(1) Question..."
    /(?:^|\n)\s*Q\.?\s*(\d{1,2})[\.\):\s]/gmi,                                           // "Q1." or "Q.1"
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(questionsSection)) !== null) {
      const qNum = parseInt(match[1], 10);
      if (qNum >= 1 && qNum <= 50) { // Proficiency tests typically have <= 50 questions
        numbers.add(qNum);
      }
    }
  }

  const sorted = Array.from(numbers).sort((a, b) => a - b);
  console.log(`Detected ${sorted.length} proficiency question numbers (regex fallback): ${sorted.join(", ")}`);
  return sorted;
}

/**
 * Extract answers from proficiency test ANSWERS section
 * Returns map of question number -> answer text
 */
export function extractProficiencyAnswers(text        )                      {
  const answerMap = new Map                ();

  // Find the ANSWERS section header
  const answerMatch = text.match(/ANSWERS?\s+TO\s+PROFICIENCY\s+TEST[^\n]*/i);
  if (!answerMatch || answerMatch.index === undefined) {
    console.log("No proficiency answers section found");
    return answerMap;
  }

  const answersHeaderEnd = answerMatch.index + answerMatch[0].length;

  // Find where the QUESTIONS section starts by searching AFTER the answers header
  // Look for "PROFICIENCY TEST" that is NOT part of "ANSWERS TO PROFICIENCY TEST"
  const textAfterAnswersHeader = text.slice(answersHeaderEnd);

  const questionsPatterns = [
    /(?:^|\n)##?\s*PROFICIENCY\s+TEST(?:-[IVX]+)?(?:\s|$)/im,
    /(?:^|\n)PROFICIENCY\s+TEST(?:-[IVX]+)?(?:\s|$)/im,
    /(?:^|\n)##?\s*Mathematics(?:\s|$)/im, // Sometimes page 2 starts with # Mathematics
  ];

  let questionsIdx = -1;
  for (const pattern of questionsPatterns) {
    const match = textAfterAnswersHeader.match(pattern);
    if (match && match.index !== undefined) {
      // Make sure this is not another ANSWERS header
      if (!/ANSWERS?\s+TO/i.test(match[0])) {
        questionsIdx = answersHeaderEnd + match.index;
        console.log(`Found questions section header at position ${questionsIdx}: "${match[0].trim().slice(0, 50)}"`);
        break;
      }
    }
  }

  // Also look for the first numbered question pattern (1. ...) after answers header
  const firstQuestionMatch = textAfterAnswersHeader.match(/(?:^|\n)\s*1\.\s+[A-Z]/m);
  if (firstQuestionMatch && firstQuestionMatch.index !== undefined) {
    const firstQIdx = answersHeaderEnd + firstQuestionMatch.index;
    // Use this if it comes before our header match (or if no header found)
    if (questionsIdx === -1 || firstQIdx < questionsIdx) {
      console.log(`Found first question (1.) at position ${firstQIdx}`);
      questionsIdx = firstQIdx;
    }
  }

  let answersSection        ;
  if (questionsIdx > answersHeaderEnd) {
    // Extract answers section between header and questions
    answersSection = text.slice(answerMatch.index, questionsIdx);
    console.log(`Found proficiency answers section from ${answerMatch.index} to ${questionsIdx}, length: ${answersSection.length}`);
  } else {
    // No questions section found after - use a generous portion
    answersSection = text.slice(answerMatch.index, answerMatch.index + 8000);
    console.log(`Found proficiency answers section (generous limit), length: ${answersSection.length}`);
  }

  console.log(`Answers section preview: "${answersSection.slice(0, 300).replace(/\n/g, '\\n')}..."`);

  // Split by question numbers and extract answers
  const lines = answersSection.split('\n');
  let currentNum                = null;
  let currentAnswer           = [];

  for (const line of lines) {
    // Skip the header line itself
    if (/ANSWERS?\s+TO\s+PROFICIENCY/i.test(line)) continue;
    // Skip empty lines or lines that are just markdown headers
    if (/^#\s*$/.test(line.trim())) continue;

    // Check if line starts with a question number - more flexible pattern
    const numMatch = line.match(/^\s*[#*\-]*\s*(\d{1,2})[\.\)]\s*(.*)$/);

    if (numMatch) {
      // Save previous answer if exists
      if (currentNum !== null && currentAnswer.length > 0) {
        const answerText = currentAnswer.join(' ').trim();
        if (answerText) {
          answerMap.set(currentNum, answerText);
          console.log(`Saved answer ${currentNum}: "${answerText.slice(0, 50)}..."`);
        }
      }

      // Start new answer
      currentNum = parseInt(numMatch[1], 10);
      const answerStart = numMatch[2].trim();
      currentAnswer = answerStart ? [answerStart] : [];
    } else if (currentNum !== null && line.trim()) {
      // Continue previous answer (multi-line)
      currentAnswer.push(line.trim());
    }
  }

  // Save last answer
  if (currentNum !== null && currentAnswer.length > 0) {
    const answerText = currentAnswer.join(' ').trim();
    if (answerText) {
      answerMap.set(currentNum, answerText);
      console.log(`Saved answer ${currentNum}: "${answerText.slice(0, 50)}..."`);
    }
  }

  console.log(`Extracted ${answerMap.size} proficiency answers: ${Array.from(answerMap.keys()).sort((a,b) => a-b).join(', ')}`);
  return answerMap;
}

/**
 * Create smart chunks with expected question ranges - IMPROVED with more overlap
 */
export function createSmartChunks(
  text        , 
  totalQuestions        ,
  answerKey                     
)                   {
  const chunks                   = [];
  const questionsPerChunk = Math.ceil(totalQuestions / CHUNK_COUNT);

  // Find all question positions with improved detection
  const questionPositions = findQuestionPositions(text);
  console.log(`Found ${questionPositions.length} question markers in text`);

  // If we found enough markers, use position-based chunking with HEAVY overlap
  if (questionPositions.length >= CHUNK_COUNT * 2) {
    for (let i = 0; i < CHUNK_COUNT; i++) {
      const rangeStart = i * questionsPerChunk + 1;
      const rangeEnd = Math.min((i + 1) * questionsPerChunk, totalQuestions);
      const expectedRange = Array.from({ length: rangeEnd - rangeStart + 1 }, (_, j) => rangeStart + j);

      // Find text boundaries - look for questions just before and after range
      const startQ = questionPositions.find(p => p.qNum >= rangeStart - 2);
      const endQ = questionPositions.find(p => p.qNum > rangeEnd + 2);

      // Use generous overlap on both sides
      let chunkStart = startQ ? Math.max(0, startQ.index - CHUNK_OVERLAP) : (i * Math.ceil(text.length / CHUNK_COUNT));
      let chunkEnd = endQ ? Math.min(text.length, endQ.index + CHUNK_OVERLAP) : Math.min(text.length, ((i + 1) * Math.ceil(text.length / CHUNK_COUNT)) + CHUNK_OVERLAP);

      // Find paragraph boundaries to avoid cutting mid-sentence
      const beforeStart = text.lastIndexOf('\n\n', chunkStart + 100);
      if (beforeStart > chunkStart - 500 && beforeStart > 0) {
        chunkStart = beforeStart;
      }

      const afterEnd = text.indexOf('\n\n', chunkEnd - 100);
      if (afterEnd !== -1 && afterEnd < chunkEnd + 500) {
        chunkEnd = afterEnd;
      }

      chunkStart = Math.max(0, chunkStart);
      chunkEnd = Math.min(text.length, chunkEnd);

      const chunkText = text.slice(chunkStart, chunkEnd);

      if (chunkText.trim().length < 100) continue;

      const answerKeySlice = new Map                ();
      for (const qNum of expectedRange) {
        const answer = answerKey.get(qNum);
        if (answer) answerKeySlice.set(qNum, answer);
      }

      chunks.push({
        text: chunkText,
        chunkIndex: i,
        expectedRange,
        answerKeySlice,
      });
    }
  } else {
    // Fallback: split by character count with MUCH MORE overlap
    const baseChunkSize = Math.ceil(text.length / CHUNK_COUNT);
    const overlapSize = CHUNK_OVERLAP;

    for (let i = 0; i < CHUNK_COUNT; i++) {
      const rangeStart = i * questionsPerChunk + 1;
      const rangeEnd = Math.min((i + 1) * questionsPerChunk, totalQuestions);
      const expectedRange = Array.from({ length: rangeEnd - rangeStart + 1 }, (_, j) => rangeStart + j);

      // Calculate chunk boundaries with overlap
      const start = Math.max(0, i * baseChunkSize - overlapSize);
      const end = Math.min(text.length, (i + 1) * baseChunkSize + overlapSize);

      const chunkText = text.slice(start, end);

      if (chunkText.trim().length < 100) continue;

      const answerKeySlice = new Map                ();
      for (const qNum of expectedRange) {
        const answer = answerKey.get(qNum);
        if (answer) answerKeySlice.set(qNum, answer);
      }

      chunks.push({
        text: chunkText,
        chunkIndex: i,
        expectedRange,
        answerKeySlice,
      });
    }
  }

  console.log(`Created ${chunks.length} smart chunks with ${CHUNK_OVERLAP} char overlap`);
  return chunks;
}

/**
 * Normalize raw extracted questions from AI response
 * Now supports inline answers from document analysis
 */
export function normalizeQuestions(
  raw       , 
  isWrittenTest          = false, 
  proficiencyAnswers                      ,
  documentAnalysis                   
)                      {
  const seen = new Set        ();
  const result                      = [];

  // Check if document has inline answers
  const hasInlineAnswers = documentAnalysis?.answerKeyDetails?.format === "inline_with_question" ||
                          documentAnalysis?.answerKeyLocation === "inline";

  for (const q of raw) {
    const num = Number(q.question_number || q.number || q.q_num || 0);
    if (num <= 0 || seen.has(num)) continue;
    seen.add(num);

    let options                                  = {};

    // Determine if this specific question is MCQ-like (has options)
    // Normalize options based on question type, not document type
    const qTypeRaw = String(q.question_type || "").toLowerCase();
    const isMCQQuestion = qTypeRaw === "mcq" || qTypeRaw === "single_choice" || 
                          qTypeRaw === "multiple_choice" || qTypeRaw === "true_false" ||
                          (q.options && Object.keys(q.options).length > 0);

    // Normalize options for any MCQ question (regardless of document type)
    if (isMCQQuestion && q.options) {
      if (Array.isArray(q.options)) {
        const labels = ["A", "B", "C", "D", "E"];
        q.options.forEach((opt     , i        ) => {
          if (i < labels.length) {
            const text = typeof opt === "string" ? opt : (opt?.text || opt?.value || String(opt));
            options[labels[i]] = { text };
          }
        });
      } else if (typeof q.options === "object") {
        for (const [key, val] of Object.entries(q.options)) {
          const normalKey = key.toUpperCase().replace(/[^A-E]/g, "");
          if (normalKey && normalKey.length === 1) {
            const text = typeof val === "string" ? val : ((val       )?.text || String(val));
            options[normalKey] = { text };
          }
        }
      }
    }

    let difficulty = "Medium";
    const rawDiff = String(q.difficulty || "medium").toLowerCase();
    if (rawDiff.includes("easy") || rawDiff.includes("low")) difficulty = "Low";
    else if (rawDiff.includes("hard") || rawDiff.includes("advanced")) difficulty = "Advanced";
    else if (rawDiff.includes("intermediate")) difficulty = "Intermediate";

    // Determine question type - support mixed documents
    let questionType                                     = "mcq";
    if (isWrittenTest) {
      questionType = "written";
    } else if (q.question_type) {
      const qType = String(q.question_type).toLowerCase();
      if (qType === "written" || qType === "subjective" || qType === "short_answer" || qType === "long_answer") {
        questionType = "written";
      } else if (qType === "mcq" || qType === "single_choice" || qType === "multiple_choice") {
        questionType = "mcq";
      } else if (qType === "integer" || qType === "numerical") {
        questionType = "integer";
      } else if (qType === "fill_blank") {
        questionType = "fill_blank";
      } else if (qType === "true_false") {
        questionType = "true_false";
      } else if (qType === "assertion_reason") {
        questionType = "assertion_reason";
      } else if (qType === "match") {
        questionType = "match";
      }
    }

    // Determine correct answer and source
    let correctAnswer = "";
    let answerSource                              = "document";

    // Priority 1: Proficiency answers map (for proficiency tests)
    if (proficiencyAnswers && proficiencyAnswers.has(num)) {
      correctAnswer = proficiencyAnswers.get(num) || "";
      answerSource = "document";
      console.log(`Q${num}: Using proficiency answer from document: ${correctAnswer.substring(0, 50)}...`);
    }
    // Priority 2: AI-extracted answer when document has inline answers
    else if (hasInlineAnswers && q.correct_answer && String(q.correct_answer).trim() !== "") {
      correctAnswer = String(q.correct_answer).trim();
      // For MCQs, normalize letter answers
      if (questionType === "mcq" && /^[A-Da-d][\)\.\s]?/.test(correctAnswer)) {
        correctAnswer = correctAnswer.charAt(0).toUpperCase();
      }
      answerSource = "document"; // Trust AI extraction when inline answers are detected
      console.log(`Q${num}: Using inline answer from AI extraction: ${correctAnswer.substring(0, 50)}${correctAnswer.length > 50 ? "..." : ""}`);
    }
    // Priority 3: For written questions, check solution/explanation fields
    else if ((questionType === "written" || questionType === "fill_blank") && hasInlineAnswers) {
      // For written questions, the answer might be in solution, explanation, or answer fields
      const answerText = String(q.correct_answer || q.answer || q.solution || q.explanation || "").trim();
      if (answerText) {
        correctAnswer = answerText;
        answerSource = "document";
        console.log(`Q${num}: Using written answer from document: ${correctAnswer.substring(0, 50)}...`);
      }
    }
    // Priority 4: Raw answer from AI (will be marked for verification later)
    else if (q.correct_answer && String(q.correct_answer).trim() !== "") {
      correctAnswer = String(q.correct_answer).trim();
      // Only trust if it's a simple letter answer for MCQs
      if (/^[A-Da-d]$/.test(correctAnswer)) {
        answerSource = "document";
      } else {
        answerSource = "ai_generated";
      }
    }

    // Track if answer came from document or not
    if (!correctAnswer || correctAnswer.trim() === "") {
      answerSource = "ai_generated"; // Will be generated later
    }

    result.push({
      question_number: num,
      question_text: String(q.question_text || q.text || q.question || ""),
      options,
      correct_answer: correctAnswer,
      question_type: questionType,
      explanation: String(q.explanation || q.solution || ""),
      difficulty,
      marks: Number(q.marks || q.mark || 4),
      answer_source: answerSource,
    });
  }

  return result.sort((a, b) => a.question_number - b.question_number);
}

router.post("/", async (req, res) => {
  if (!isAuthorised(req)) return res.status(401).json({ error: "Unauthorized" });

  try {
    const { contentJson, contentMarkdown, examName, year, paperType, documentType, documentAnalysis } = req.body || {};

    console.log("=== Starting IMPROVED MCQ Extraction ===");
    console.log(`Exam: ${examName}  Year: ${year} Type: ${paperType} DocumentType: ${documentType || 'mcq'}`);

    // If documentAnalysis provided, log it
    if (documentAnalysis) {
      console.log("=== Using Document Analysis for Dynamic Extraction ===");
      console.log(`Detected types: ${documentAnalysis.questionTypes?.map((t     ) => t.type).join(", ") || "unknown"}`);
      console.log(`Estimated questions: ${documentAnalysis.totalEstimatedQuestions}`);
      console.log(`Answer key: ${documentAnalysis.hasAnswerKey ? documentAnalysis.answerKeyLocation : "not found"}`);
    }

    // For practice/proficiency tests, extraction is different
    // Also check documentAnalysis to see if it's a written test
    const hasWrittenQuestions = documentAnalysis?.questionTypes?.some((t     ) => 
      t.type === "written" || t.type === "fill_blank"
    );
    const isWrittenTest = documentType === "practice" || documentType === "proficiency" || hasWrittenQuestions;

    let extractionText = "";
    if (contentMarkdown && typeof contentMarkdown === "string" && contentMarkdown.length > 100) {
      extractionText = contentMarkdown;
      console.log(`Using markdown content, length: ${extractionText.length}`);
    } else if (contentJson) {
      extractionText = typeof contentJson === "string" ? contentJson : JSON.stringify(contentJson);
      console.log(`Using stringified contentJson, length: ${extractionText.length}`);
    }

    if (!extractionText || extractionText.length < 100) {
      return res.status(200).json({
          success: false,
          questions: [],
          questionsCount: 0,
          error: "No valid content provided for extraction",
          errorCode: "NO_CONTENT",
        });
    }

    // Step 1: Extract answer key (NO AI - regex only)
    console.log("Extracting answer key...");

    // For proficiency tests, use different extraction logic
    let answerKey                     ;
    let expectedQuestionCount        ;
    let detectedProficiencyNumbers           = [];
    let proficiencyAnswers                      = new Map();

    if (isWrittenTest) {
      // Use document analysis for section numbering (CRITICAL for multi-section docs)
      detectedProficiencyNumbers = detectProficiencyQuestionNumbers(extractionText, documentAnalysis);

      // Extract proficiency answers from ANSWERS section
      proficiencyAnswers = extractProficiencyAnswers(extractionText);

      // Use document analysis total if available, then detected numbers, then proficiency answers
      expectedQuestionCount = documentAnalysis?.totalEstimatedQuestions && documentAnalysis.totalEstimatedQuestions > 0
        ? documentAnalysis.totalEstimatedQuestions
        : detectedProficiencyNumbers.length > 0 
          ? detectedProficiencyNumbers.length 
          : (proficiencyAnswers.size > 0 ? proficiencyAnswers.size : 10);

      // Build answerKey from proficiencyAnswers (which HAS the answers)
      // Fall back to detected numbers only if no answers were found
      answerKey = new Map();
      const questionNumbers = detectedProficiencyNumbers.length > 0
        ? detectedProficiencyNumbers
        : (proficiencyAnswers.size > 0 
            ? Array.from(proficiencyAnswers.keys()) 
            : Array.from({ length: expectedQuestionCount }, (_, i) => i + 1));

      for (const num of questionNumbers) {
        answerKey.set(num, proficiencyAnswers.get(num) || "");
      }

      console.log(`🎯 PROFICIENCY/WRITTEN: Detected ${detectedProficiencyNumbers.length} question numbers, ${proficiencyAnswers.size} answers, expected: ${expectedQuestionCount}`);
    } else {
      // MCQ extraction - use existing logic
      answerKey = extractAnswerKey(extractionText);
      expectedQuestionCount = answerKey.size;
      console.log(`🎯 EXPECTED QUESTIONS: ${expectedQuestionCount} (from answer key)`);
    }
    const { rows: cfgRows } = await query(
      "SELECT setting_value FROM public.ai_settings WHERE setting_key = 'ai_api_config' LIMIT 1",
    );
    const config = cfgRows[0]?.setting_value;

    let apiUrl        ;
    let apiKey        ;
    let model        ;

    if (config?.enabled && config?.provider === 'openrouter' && config?.openrouter_api_key) {
      apiUrl = "https://openrouter.ai/api/v1/chat/completions";
      apiKey = config.openrouter_api_key;
      model = config.default_model || "google/gemini-2.5-flash";
    } else if (config?.enabled && config?.provider === 'google' && config?.google_api_key) {
      apiUrl = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";
      apiKey = config.google_api_key;
      model = config.default_model || "gemini-2.5-flash";
      console.log(`Using Google AI API with model: ${model}`);
    } else if (config?.enabled && config?.provider === 'openai' && config?.openai_api_key) {
      apiUrl = "https://api.openai.com/v1/chat/completions";
      apiKey = config.openai_api_key;
      model = config.default_model || "gpt-4o";
      console.log(`Using OpenAI API with model: ${model}`);
    } else {
      return res.status(200).json({
          success: false,
          questions: [],
          questionsCount: 0,
          error: "AI API not configured. Please go to Admin → Settings → AI Functions API Key Settings to add your API key.",
          errorCode: "AI_NOT_CONFIGURED",
        });
    }

    // Step 2: Create smart chunks with question ranges
    // For proficiency tests with few questions, use single chunk with ONLY questions section
    let smartChunks                  ;
    if (isWrittenTest && expectedQuestionCount <= 30) {
      // Get only the questions section (not answers) for AI extraction
      const { section: questionsOnlyText } = findProficiencyQuestionsSection(extractionText);
      console.log(`Using questions-only section for AI, length: ${questionsOnlyText.length} (vs full: ${extractionText.length})`);

      // Single chunk for small proficiency tests - use ONLY questions section
      smartChunks = [{
        text: questionsOnlyText,
        chunkIndex: 0,
        expectedRange: detectedProficiencyNumbers.length > 0 
          ? detectedProficiencyNumbers 
          : Array.from({ length: expectedQuestionCount }, (_, i) => i + 1),
        answerKeySlice: answerKey,
      }];
      console.log(`Using single chunk for proficiency test with ${expectedQuestionCount} questions`);
    } else {
      smartChunks = createSmartChunks(extractionText, expectedQuestionCount || 90, answerKey);
      console.log(`Created ${smartChunks.length} parallel chunks`);
    }

    // Flexible tool schema that supports ALL question types
    const flexibleTools = [
      {
        type: "function",
        function: {
          name: "extract_questions",
          description: "Extract all questions with their type-appropriate structure",
          parameters: {
            type: "object",
            properties: {
              questions: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    question_number: { type: "number" },
                    question_text: { type: "string" },
                    question_type: { 
                      type: "string",
                      enum: ["mcq", "integer", "fill_blank", "match", "true_false", "written", "assertion_reason"]
                    },
                    // MCQ-specific
                    options: {
                      type: "object",
                      description: "For MCQ: { A: 'text', B: 'text', C: 'text', D: 'text' }",
                      additionalProperties: { type: "string" }
                    },
                    // Match the Following
                    column_a: {
                      type: "array",
                      items: { type: "object", properties: { id: { type: "string" }, text: { type: "string" } } }
                    },
                    column_b: {
                      type: "array", 
                      items: { type: "object", properties: { id: { type: "string" }, text: { type: "string" } } }
                    },
                    // Assertion-Reason
                    assertion: { type: "string" },
                    reason: { type: "string" },
                    // Common fields
                    correct_answer: { type: "string" },
                    explanation: { type: "string" },
                    difficulty: { type: "string" },
                    marks: { type: "number" },
                    section: { type: "string" }
                  },
                  required: ["question_number", "question_text"]
                }
              }
            },
            required: ["questions"]
          }
        }
      }
    ];

    // Legacy MCQ tools for backward compatibility
    const mcqTools = [
      {
        type: "function",
        function: {
          name: "extract_questions",
          description: "Extract multiple choice questions from exam paper content.",
          parameters: {
            type: "object",
            properties: {
              questions: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    question_number: { type: "number" },
                    question_text: { type: "string" },
                    options: {
                      type: "object",
                      properties: {
                        A: { type: "string" },
                        B: { type: "string" },
                        C: { type: "string" },
                        D: { type: "string" },
                      },
                      required: ["A", "B", "C", "D"],
                      additionalProperties: true,
                    },
                    difficulty: { type: "string" },
                    marks: { type: "number" },
                    explanation: { type: "string" },
                  },
                  required: ["question_number", "question_text", "options"],
                  additionalProperties: false,
                },
              },
            },
            required: ["questions"],
            additionalProperties: false,
          },
        },
      },
    ];

    const writtenTools = [
      {
        type: "function",
        function: {
          name: "extract_questions",
          description: "Extract written answer questions from exam paper content (no options needed).",
          parameters: {
            type: "object",
            properties: {
              questions: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    question_number: { type: "number" },
                    question_text: { type: "string" },
                    correct_answer: { type: "string" },
                    difficulty: { type: "string" },
                    marks: { type: "number" },
                    explanation: { type: "string" },
                  },
                  required: ["question_number", "question_text"],
                  additionalProperties: false,
                },
              },
            },
            required: ["questions"],
            additionalProperties: false,
          },
        },
      },
    ];

    // Select tools based on document analysis or fallback to legacy logic
    // deno-lint-ignore no-explicit-any
    let tools       ;
    if (documentAnalysis && documentAnalysis.questionTypes?.length > 0) {
      // Use flexible schema when we have document analysis (supports mixed types)
      tools = flexibleTools;
      console.log("Using flexible tool schema for multi-type extraction");
    } else if (isWrittenTest) {
      tools = writtenTools;
      console.log("Using written test tools");
    } else {
      tools = mcqTools;
      console.log("Using MCQ tools");
    }

    const tool_choice = { type: "function", function: { name: "extract_questions" } };

    /**
     * Generate dynamic extraction prompt based on document analysis
     */
    function generateDynamicPrompt(analysis                  , targetRange          , isRecovery          = false, targetQuestions           )                                   {
      const questionTypes = analysis.questionTypes?.map(t => t.type) || [];

      let systemPrompt = `You are an expert question extractor for ${examName} exams.\n\n`;
      systemPrompt += `DOCUMENT STRUCTURE ANALYSIS:\n`;
      systemPrompt += `- Total questions: ~${analysis.totalEstimatedQuestions}\n`;
      systemPrompt += `- Question types found: ${questionTypes.join(", ")}\n`;
      systemPrompt += `- Answer key: ${analysis.hasAnswerKey ? `Found at ${analysis.answerKeyLocation}` : "Not detected"}\n\n`;

      systemPrompt += `EXTRACTION RULES:\n`;

      // Add type-specific rules based on what was detected
      if (questionTypes.includes("mcq")) {
        systemPrompt += `- MCQ Questions: Extract question text and ALL 4 options (${analysis.formatPatterns?.optionFormat || "A, B, C, D"}). Set question_type="mcq"\n`;
      }
      if (questionTypes.includes("integer")) {
        systemPrompt += `- Integer/Numerical Questions: Extract question text only, no options. The answer is a number. Set question_type="integer"\n`;
      }
      if (questionTypes.includes("fill_blank")) {
        systemPrompt += `- Fill in Blank: Preserve the blank marker (_____ or [blank]). Set question_type="fill_blank"\n`;
      }
      if (questionTypes.includes("match")) {
        systemPrompt += `- Match the Following: Extract both column_a and column_b as arrays. Set question_type="match"\n`;
      }
      if (questionTypes.includes("true_false")) {
        systemPrompt += `- True/False: Extract statement. Set question_type="true_false"\n`;
      }
      if (questionTypes.includes("written")) {
        systemPrompt += `- Written/Subjective: Extract question text only. Set question_type="written"\n`;
      }
      if (questionTypes.includes("assertion_reason")) {
        systemPrompt += `- Assertion-Reason: Extract both assertion and reason fields. Set question_type="assertion_reason"\n`;
      }

      systemPrompt += `\nQUESTION NUMBER FORMAT: Look for patterns like "${analysis.formatPatterns?.questionNumberFormat || "1."}"\n`;

      if (analysis.formatPatterns?.hasMathNotation) {
        systemPrompt += `\nMATH NOTATION: Preserve all LaTeX/mathematical symbols exactly (\\frac, \\sqrt, $...$, etc.)\n`;
      }

      // NEW: Handle inline answers - CRITICAL for documents with answers after each question
      if (analysis.answerKeyDetails?.format === "inline_with_question" || analysis.answerKeyLocation === "inline") {
        systemPrompt += `\n**ANSWER EXTRACTION (INLINE ANSWERS DETECTED):**\n`;
        systemPrompt += `- This document has answers INLINE with each question\n`;
        if (analysis.answerKeyDetails?.answerPatterns?.length > 0) {
          systemPrompt += `- Look for these answer patterns: ${analysis.answerKeyDetails.answerPatterns.join(", ")}\n`;
        } else {
          systemPrompt += `- Look for patterns like: "Answer: B)", "Ans: (C)", "Correct Answer: A", "Sol:"\n`;
        }
        systemPrompt += `- **EXTRACT the correct_answer field from these patterns**\n`;
        systemPrompt += `- Example: "Answer: B) Full text..." → correct_answer = "B"\n`;
        systemPrompt += `- Example: "Ans: (C)" → correct_answer = "C"\n`;
      } else {
        systemPrompt += `\nDO NOT determine correct answers - leave blank (we'll apply from answer key)\n`;
      }

      // NEW: Handle section numbering for multi-section documents
      if (analysis.sectionNumbering?.sectionsRestartNumbering && analysis.sectionNumbering?.sections?.length > 0) {
        systemPrompt += `\n**SECTION NUMBERING (IMPORTANT):**\n`;
        systemPrompt += `- This document has sections with RESTARTING numbers\n`;
        for (const section of analysis.sectionNumbering.sections) {
          systemPrompt += `- ${section.name}: local Q${section.questionRange} → ABSOLUTE Q${section.absoluteRange}\n`;
        }
        systemPrompt += `- Use ABSOLUTE numbering in your output\n`;
        systemPrompt += `- Example: Short Answer Q1 might be absolute Q6 if MCQs are 1-5\n`;
      }

      // Add any special instructions from analysis
      if (analysis.extractionStrategy?.specialInstructions?.length > 0) {
        systemPrompt += `\nSPECIAL INSTRUCTIONS:\n`;
        analysis.extractionStrategy.specialInstructions.forEach(inst => {
          systemPrompt += `- ${inst}\n`;
        });
      }

      systemPrompt += `\nCRITICAL:\n`;
      systemPrompt += `- Extract EXACT question text - do not paraphrase\n`;
      systemPrompt += `- Do NOT invent or hallucinate questions\n`;
      systemPrompt += `- Set the correct question_type for each question\n`;

      let userPrompt        ;
      if (isRecovery && targetQuestions && targetQuestions.length > 0) {
        userPrompt = `RECOVERY: Find ONLY these specific questions: ${targetQuestions.join(", ")}\n\n`;
      } else {
        userPrompt = `Extract questions ${targetRange[0]}-${targetRange[targetRange.length - 1]} from this ${examName} paper.\n\n`;
      }
      userPrompt += `Document content follows:`;

      return { system: systemPrompt, user: userPrompt };
    }

    /**
     * Process a single chunk with the AI - IMPROVED prompts
     */
    async function callAI(
      chunkText        ,
      expectedRange          ,
      isRecovery          = false,
      targetQuestions           ,
      temperature         = 0.1
    )                               {
      const rangeStr = expectedRange.length > 0 
        ? `Questions ${expectedRange[0]}-${expectedRange[expectedRange.length - 1]}`
        : "Questions";

      let systemPrompt        ;
      let userPrompt        ;

      // Use different prompts for proficiency/written tests vs MCQ
      // NEW: Check for mixed documents with multiple question types
      const hasMixedTypes = documentAnalysis?.questionTypes && documentAnalysis.questionTypes.length > 1;
      const hasSectionNumbering = documentAnalysis?.sectionNumbering?.sectionsRestartNumbering;
      const hasInlineAnswersFlag = documentAnalysis?.answerKeyDetails?.format === "inline_with_question" ||
                                   documentAnalysis?.answerKeyLocation === "inline";

      if (isWrittenTest || hasMixedTypes) {
        // MIXED/WRITTEN TEST PROMPTS - handles MCQ + Short Answer + Long Answer
        const sectionInfo = hasSectionNumbering && documentAnalysis?.sectionNumbering?.sections?.length > 0
          ? `\n\n**SECTION NUMBERING (CRITICAL):**
This document has multiple sections with RESTARTING numbers. Use ABSOLUTE numbering:
${documentAnalysis.sectionNumbering.sections.map(s => `- ${s.name}: local Q${s.questionRange} → OUTPUT as Q${s.absoluteRange} (${s.type})`).join("\n")}
Example: If MCQs are 1-5 and Short Answer restarts at 1, output Short Answer Q1 as question_number: 6`
          : "";

        const answerInstructions = hasInlineAnswersFlag
          ? `\n\n**ANSWER EXTRACTION (INLINE ANSWERS DETECTED):**
- Look for patterns like: ${documentAnalysis?.answerKeyDetails?.answerPatterns?.join(", ") || '"Answer: B)", "Ans: (C)", "Sol:"'}
- For MCQs: Extract the letter as correct_answer (A, B, C, or D)
- For written questions: Extract the full answer text as correct_answer
- Mark question_type appropriately: "mcq" for MCQs, "written" for short/long answers`
          : "";

        if (isRecovery && targetQuestions && targetQuestions.length > 0) {
          systemPrompt = `You are an expert question extractor for ${examName} mixed-type question banks.

CRITICAL INSTRUCTIONS:
1. Find ONLY these specific questions: ${targetQuestions.join(", ")}
2. This document may contain BOTH MCQs AND written answer questions
3. For MCQs: Extract options (A, B, C, D) and set question_type="mcq"
4. For written/short/long answer: No options, set question_type="written"
5. Extract the EXACT question text - do not paraphrase
6. Preserve all math formulas, symbols, LaTeX exactly
${sectionInfo}${answerInstructions}

Return format:
{
  "questions": [
    {
      "question_number": 1,
      "question_text": "The full question text...",
      "question_type": "mcq" or "written",
      "options": { "A": "...", "B": "...", "C": "...", "D": "..." } or null for written,
      "correct_answer": "B" or "full answer text",
      "difficulty": "Medium",
      "marks": 4
    }
  ]
}`;

          userPrompt = `FIND THESE SPECIFIC QUESTIONS: ${targetQuestions.join(", ")}

This document contains mixed question types.
Look for question numbers like: "1.", "1)", "(1)", "Q1."
${sectionInfo}

IMPORTANT: 
- Extract both MCQs (with options) and written questions (no options)
- Set question_type correctly for each
${hasInlineAnswersFlag ? "- Extract answers from inline patterns like 'Answer: B)' or 'Sol: ...'" : ""}

Document content:
${chunkText}`;
        } else {
          // Initial extraction for mixed/written tests
          const expectedNumbers = expectedRange.join(", ");
          systemPrompt = `You are an expert question extractor for ${examName} mixed-type question banks.

EXTRACTION RULES:
1. This document may contain BOTH MCQs AND written answer questions
2. Extract questions numbered (ABSOLUTE): ${expectedNumbers}
3. This document has approximately ${expectedRange.length} questions total
4. For MCQs: Extract all 4 options (A, B, C, D), set question_type="mcq"
5. For Short Answer/Long Answer: No options, set question_type="written"
6. Preserve exact question text including formulas, symbols, LaTeX
7. Do NOT invent or hallucinate questions
${sectionInfo}${answerInstructions}

CRITICAL: 
- Use ABSOLUTE question numbering as specified above
- Extract ALL question types (MCQ, Short Answer, Long Answer)
- Set correct question_type for each`;

          userPrompt = `Extract ALL questions from this ${examName} question bank.

IMPORTANT:
- This document has MIXED question types (MCQs + Written questions)
- Expected questions (ABSOLUTE numbering): ${expectedNumbers}
${hasSectionNumbering ? `- Note: Some sections restart numbering. Use ABSOLUTE numbers in output.` : ""}
${hasInlineAnswersFlag ? `- Answers are INLINE - extract them from patterns like "Answer: B)" or "Sol: ..."` : ""}

Look for:
- MCQ sections with options (A, B, C, D)
- Short Answer Questions (written, no options)
- Long Answer Questions (written, no options)

Document content:
${chunkText}`;
        }
      } else {
        // MCQ PROMPTS - existing logic
        if (isRecovery && targetQuestions && targetQuestions.length > 0) {
          // IMPROVED recovery prompt - more explicit and structured
          systemPrompt = `You are an expert exam paper parser. Your task is to find SPECIFIC questions from an exam document.

CRITICAL INSTRUCTIONS:
1. You MUST find questions numbered: ${targetQuestions.join(", ")}
2. Search for patterns like: "Q${targetQuestions[0]}.", "${targetQuestions[0]}.", "(${targetQuestions[0]})", "Question ${targetQuestions[0]}"
3. Each question has 4 options (A, B, C, D)
4. Extract the EXACT text - do not paraphrase
5. If a question has math/formulas, preserve them exactly

Return format:
{
  "questions": [
    {
      "question_number": 16,
      "question_text": "The full question text...",
      "options": { "A": "...", "B": "...", "C": "...", "D": "..." },
      "difficulty": "Medium",
      "marks": 4
    }
  ]
}`;

          userPrompt = `FIND THESE SPECIFIC QUESTIONS: ${targetQuestions.join(", ")}

Look carefully for each question number. Common patterns:
- "Q16." or "16." at start of line
- "(16)" or "16)" 
- "Question 16:"

IMPORTANT: Extract ALL ${targetQuestions.length} questions listed above. Do not skip any.

Document content:
${chunkText}`;
        } else {
          // IMPROVED initial extraction prompt for MCQ - now handles inline answers
          const hasInlineAnswers = documentAnalysis?.answerKeyDetails?.format === "inline_with_question" ||
                                   documentAnalysis?.answerKeyLocation === "inline";

          systemPrompt = `You are an expert MCQ extractor for ${examName} exam papers.

EXTRACTION RULES:
1. Extract ALL questions from ${rangeStr}
2. Preserve exact question text including formulas, symbols, special characters
3. Extract all 4 options (A, B, C, D) for each question
${hasInlineAnswers ? `4. **EXTRACT INLINE ANSWERS** - This document has answers INLINE with questions
   - Look for patterns: "Answer: B)", "Ans: (C)", "Correct Answer: A"
   - Extract the correct_answer field (just the letter: A, B, C, or D)` :
`4. DO NOT determine correct answers - leave blank`}
5. Look for question patterns: "Q1.", "1.", "(1)", "Question 1"
6. Difficulty: estimate as Low/Medium/Advanced based on complexity
7. Marks: typically 4 for MCQ, 2-4 for integer type

CRITICAL: You MUST extract ALL questions in the range ${rangeStr}. Missing questions is not acceptable.

Return structured JSON with the questions array.`;

          userPrompt = `Extract ${rangeStr} from this ${examName} ${year} ${paperType || ""} exam paper.

YOU MUST FIND AND EXTRACT THESE QUESTION NUMBERS: ${expectedRange.join(", ")}

Search the entire content carefully. Questions may use different formats:
- "Q16. Which of the following..."
- "16. Consider the reaction..."
- "(16) A ball is thrown..."
${hasInlineAnswers ? `
IMPORTANT: Look for answer patterns after each question like:
- "Answer: B) Can be expressed..."
- "Ans: (C)"
- Extract the letter as correct_answer` : ""}

Content:
${chunkText}`;
        }
      }

      const maxRetries = 2;

      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
          if (attempt > 0) {
            await delay(attempt * 1500);
          }

          const response = await hooks.fetch(apiUrl, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${apiKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              model: model,
              messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: userPrompt },
              ],
              tools,
              tool_choice,
              temperature: temperature + (attempt * 0.1), // Increase temp on retries
              max_tokens: 16000,
            }),
          });

          if (response.status === 401 || response.status === 403) {
            throw new Error("Invalid API key. Please check your API key in Admin → Settings → AI Functions API Key Settings.");
          }

          if (response.status === 429) {
            if (attempt < maxRetries) continue;
            throw new Error("Rate limited by AI provider. Please wait a moment and try again.");
          }

          if (!response.ok) {
            const errorBody = await response.text();
            console.error(`API error ${response.status}:`, errorBody);
            if (attempt < maxRetries) continue;
            throw new Error(`API error ${response.status}: ${errorBody.slice(0, 200)}`);
          }

          const data = await response.json();
          const message = data.choices?.[0]?.message;
          const toolArgs = message?.tool_calls?.[0]?.function?.arguments                      ;
          const content = (message?.content                      ) || "";

          let parsed      = null;

          if (toolArgs) {
            try {
              parsed = JSON.parse(toolArgs);
            } catch (e) {
              console.error("Tool args parse error:", e);
            }
          }

          if (!parsed && content) {
            try {
              let jsonText = content.trim();
              if (jsonText.startsWith("```")) {
                jsonText = jsonText.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
              }
              const objectMatch = jsonText.match(/\{[\s\S]*\}/);
              if (objectMatch) {
                parsed = JSON.parse(objectMatch[0]);
              }
            } catch (e) {
              console.error("Content parse error:", e);
            }
          }

          if (parsed) {
            const rawQuestions = parsed.questions || (Array.isArray(parsed) ? parsed : []);
            if (Array.isArray(rawQuestions) && rawQuestions.length > 0) {
              // For tests with document analysis, use the full expected range from analysis
              // This is CRITICAL for multi-section documents where sections restart numbering
              let filtered = rawQuestions;
              const expectedFromAnalysis = documentAnalysis?.sectionNumbering?.sections?.length > 0
                ? buildExpectedRangeFromSections(documentAnalysis.sectionNumbering.sections)
                : [];

              if (expectedFromAnalysis.length > 0) {
                // Use analysis-based filtering (respects absolute numbering)
                filtered = rawQuestions.filter((q     ) => {
                  const num = Number(q.question_number || q.number || 0);
                  return expectedFromAnalysis.includes(num);
                });
                console.log(`Filtered to ${filtered.length} questions (using analysis sections: ${expectedFromAnalysis.join(", ")})`);
              } else if (isWrittenTest && detectedProficiencyNumbers.length > 0) {
                // Fallback to regex-detected numbers
                filtered = rawQuestions.filter((q     ) => {
                  const num = Number(q.question_number || q.number || 0);
                  return detectedProficiencyNumbers.includes(num);
                });
                console.log(`Filtered to ${filtered.length} questions (using regex detection)`);
              }
              return normalizeQuestions(filtered, isWrittenTest, proficiencyAnswers, documentAnalysis);
            }
          }

          return [];

        } catch (err) {
          if (attempt === maxRetries) throw err;
        }
      }

      return [];
    }

    /**
     * Process a single chunk with AGGRESSIVE recovery
     */
    async function processChunkWithRecovery(chunk                , fullText        )                       {
      const { text, chunkIndex, expectedRange, answerKeySlice } = chunk;
      const errors           = [];
      let totalRecovered = 0;

      console.log(`\n📦 Chunk ${chunkIndex + 1}: Processing Q${expectedRange[0]}-${expectedRange[expectedRange.length - 1]}`);

      // Initial extraction
      let questions                      = [];
      try {
        questions = await callAI(text, expectedRange);
        console.log(`   Chunk ${chunkIndex + 1}: Initial extraction got ${questions.length} questions`);
      } catch (err) {
        errors.push(`Chunk ${chunkIndex + 1} initial: ${err instanceof Error ? err.message : "Unknown"}`);
        console.error(`   Chunk ${chunkIndex + 1} failed:`, err);
      }

      // Build map of extracted questions
      const questionMap = new Map                           ();
      for (const q of questions) {
        if (expectedRange.includes(q.question_number)) {
          questionMap.set(q.question_number, q);
        }
      }

      // Check extraction rate
      const extractionRate = questionMap.size / expectedRange.length;
      const missing = expectedRange.filter(n => !questionMap.has(n) && answerKeySlice.has(n));

      // AGGRESSIVE recovery if less than 80% extracted
      if (missing.length > 0) {
        console.log(`   Chunk ${chunkIndex + 1}: Missing ${missing.length} questions (${Math.round(extractionRate * 100)}% rate), attempting recovery...`);

        // More recovery attempts for badly failed chunks
        const maxAttempts = extractionRate < 0.5 ? MAX_CHUNK_RECOVERY_ATTEMPTS : 2;

        for (let attempt = 0; attempt < maxAttempts; attempt++) {
          const currentMissing = expectedRange.filter(n => !questionMap.has(n) && answerKeySlice.has(n));
          if (currentMissing.length === 0) break;

          try {
            await delay(300 + attempt * 300);

            // For very poor extraction, try with extended context
            let recoveryText = text;
            if (extractionRate < 0.3 && attempt > 0) {
              // Use a broader portion of the full text
              const chunkCenter = Math.floor(fullText.length * (chunkIndex + 0.5) / CHUNK_COUNT);
              const extendedStart = Math.max(0, chunkCenter - 15000);
              const extendedEnd = Math.min(fullText.length, chunkCenter + 15000);
              recoveryText = fullText.slice(extendedStart, extendedEnd);
              console.log(`   Chunk ${chunkIndex + 1}: Using extended context (${recoveryText.length} chars)`);
            }

            // Process in smaller batches for recovery
            const batchSize = attempt === 0 ? RECOVERY_BATCH_SIZE : Math.min(5, currentMissing.length);
            const batch = currentMissing.slice(0, batchSize);

            const recovered = await callAI(recoveryText, expectedRange, true, batch, 0.2 + attempt * 0.1);

            let newlyRecovered = 0;
            for (const q of recovered) {
              if (currentMissing.includes(q.question_number) && !questionMap.has(q.question_number)) {
                questionMap.set(q.question_number, q);
                newlyRecovered++;
              }
            }

            totalRecovered += newlyRecovered;
            console.log(`   Chunk ${chunkIndex + 1}: Recovery attempt ${attempt + 1} got ${newlyRecovered}/${batch.length} questions`);

            // If recovery is working, continue; if not, try different approach
            if (newlyRecovered === 0 && attempt < maxAttempts - 1) {
              // Try with higher temperature
              continue;
            }
          } catch (err) {
            errors.push(`Chunk ${chunkIndex + 1} recovery ${attempt + 1}: ${err instanceof Error ? err.message : "Unknown"}`);
            // Don't break - try next attempt with different params
          }
        }
      }

      const finalQuestions = Array.from(questionMap.values());
      console.log(`   Chunk ${chunkIndex + 1}: Final count ${finalQuestions.length}/${expectedRange.length}`);

      return {
        chunkIndex,
        questions: finalQuestions,
        recovered: totalRecovered,
        errors,
      };
    }

    // ===== PARALLEL EXTRACTION =====
    console.log("\n===== PHASE 1: PARALLEL EXTRACTION =====");

    // Launch all chunks in parallel with small stagger to avoid rate limits
    const chunkPromises = smartChunks.map((chunk, i) => 
      delay(i * 200).then(() => processChunkWithRecovery(chunk, extractionText))
    );

    const startTime = Date.now();
    const chunkResults = await Promise.all(chunkPromises);
    const elapsedTime = Date.now() - startTime;

    console.log(`\n⏱️ Parallel extraction completed in ${elapsedTime}ms`);

    // ===== MERGE RESULTS =====
    console.log("\n===== PHASE 2: MERGE RESULTS =====");

    const allQuestions                      = [];
    const allErrors           = [];
    let totalRecovered = 0;
    let chunksProcessed = 0;

    for (const result of chunkResults) {
      allQuestions.push(...result.questions);
      allErrors.push(...result.errors);
      totalRecovered += result.recovered;
      if (result.questions.length > 0) chunksProcessed++;
    }

    // Deduplicate by question number
    const questionMap = new Map                           ();
    for (const q of allQuestions) {
      if (!questionMap.has(q.question_number)) {
        questionMap.set(q.question_number, q);
      }
    }

    console.log(`Merged: ${questionMap.size} unique questions from ${chunksProcessed} chunks`);

    // ===== PHASE 2.5: GLOBAL RECOVERY - IMPROVED with higher threshold =====
    const globalMissing = Array.from(answerKey.keys()).filter(n => !questionMap.has(n));

    // Increased threshold from 25 to 50
    if (globalMissing.length > 0 && globalMissing.length <= GLOBAL_RECOVERY_THRESHOLD) {
      console.log(`\n===== PHASE 2.5: GLOBAL RECOVERY =====`);
      console.log(`Attempting global recovery for ${globalMissing.length} missing questions`);

      // Split missing into batches and try multiple times
      const globalBatchSize = 15;
      let globalNewlyRecovered = 0;

      for (let batchStart = 0; batchStart < globalMissing.length; batchStart += globalBatchSize) {
        const batch = globalMissing.slice(batchStart, batchStart + globalBatchSize);
        const stillMissingInBatch = batch.filter(n => !questionMap.has(n));

        if (stillMissingInBatch.length === 0) continue;

        try {
          await delay(300);

          // Try different portions of the text for each batch
          let recoveryText        ;
          if (batchStart === 0) {
            // First batch - use end of document
            recoveryText = extractionText.slice(-50000);
          } else if (batchStart < globalMissing.length / 2) {
            // Middle batches - use full document middle
            const midStart = Math.floor(extractionText.length * 0.2);
            const midEnd = Math.floor(extractionText.length * 0.8);
            recoveryText = extractionText.slice(midStart, midEnd);
          } else {
            // Later batches - use start of document
            recoveryText = extractionText.slice(0, 50000);
          }

          console.log(`   Global batch ${Math.floor(batchStart / globalBatchSize) + 1}: Looking for ${stillMissingInBatch.join(", ")}`);

          const recovered = await callAI(recoveryText, stillMissingInBatch, true, stillMissingInBatch, 0.2);

          for (const q of recovered) {
            if (stillMissingInBatch.includes(q.question_number) && !questionMap.has(q.question_number)) {
              questionMap.set(q.question_number, q);
              globalNewlyRecovered++;
              totalRecovered++;
            }
          }
        } catch (err) {
          console.error(`Global batch recovery failed:`, err);
        }
      }

      console.log(`Global recovery: Found ${globalNewlyRecovered} additional questions`);

      // Second pass - full document scan for remaining
      const stillMissingAfterGlobal = Array.from(answerKey.keys()).filter(n => !questionMap.has(n));
      if (stillMissingAfterGlobal.length > 0 && stillMissingAfterGlobal.length <= 20) {
        console.log(`\nSecond global pass for ${stillMissingAfterGlobal.length} questions...`);
        try {
          await delay(500);
          const secondRecovered = await callAI(extractionText, stillMissingAfterGlobal, true, stillMissingAfterGlobal, 0.3);

          for (const q of secondRecovered) {
            if (stillMissingAfterGlobal.includes(q.question_number) && !questionMap.has(q.question_number)) {
              questionMap.set(q.question_number, q);
              totalRecovered++;
            }
          }
        } catch (err) {
          console.error(`Second global pass failed:`, err);
        }
      }
    } else if (globalMissing.length > GLOBAL_RECOVERY_THRESHOLD) {
      console.log(`\n⚠️ Skipping global recovery: ${globalMissing.length} missing questions exceeds threshold of ${GLOBAL_RECOVERY_THRESHOLD}`);
    }

    // ===== APPLY ANSWER KEY =====
    console.log("\n===== PHASE 3: APPLY ANSWER KEY =====");

    // Check if document had inline answers - if so, questions already have answers from AI extraction
    const hasInlineAnswers = documentAnalysis?.answerKeyDetails?.format === "inline_with_question" ||
                            documentAnalysis?.answerKeyLocation === "inline";

    let answersApplied = 0;
    const missingAnswers           = [];

    for (const [qNum, question] of questionMap) {
      // Priority 1: If question already has answer from inline extraction, keep it
      if (hasInlineAnswers && question.correct_answer && question.correct_answer.trim() !== "" && question.answer_source === "document") {
        answersApplied++;
        console.log(`Q${qNum}: Keeping inline answer "${question.correct_answer}"`);
        continue;
      }

      // Priority 2: Apply from extracted answer key
      const answer = answerKey.get(qNum);
      if (answer) {
        question.correct_answer = answer;
        question.question_type = /^[A-D]$/.test(answer) ? "mcq" : 
                                (question.question_type || (/^-?\d+\.?\d*$/.test(answer) ? "integer" : "written"));
        question.answer_source = "document";
        answersApplied++;
      } else if (!question.correct_answer || question.correct_answer.trim() === "") {
        missingAnswers.push(qNum);
      } else {
        // Question has answer from AI extraction
        answersApplied++;
      }
    }

    console.log(`Applied ${answersApplied} answers (${hasInlineAnswers ? "inline + answer key" : "answer key"})`);
    console.log(`Questions needing AI answers: ${missingAnswers.length}`);

    // ===== PHASE 4: AI ANSWER GENERATION FOR MISSING =====
    if (missingAnswers.length > 0) {
      console.log(`\n===== PHASE 4: AI ANSWER GENERATION =====`);
      console.log(`Generating AI answers for ${missingAnswers.length} questions without answers`);

      // Process in batches to avoid timeout
      const answerBatchSize = 10;
      let aiAnswersGenerated = 0;

      for (let i = 0; i < missingAnswers.length; i += answerBatchSize) {
        const batch = missingAnswers.slice(i, i + answerBatchSize);
        const questionsToAnswer = batch
          .map(qNum => questionMap.get(qNum))
          .filter((q)                         => q !== undefined);

        if (questionsToAnswer.length === 0) continue;

        try {
          await delay(200);

          const answerPrompt = `You are an expert in ${examName || "academic subjects"}. Generate correct answers for these questions.

For each question, provide the correct answer in a concise format:
- For MCQ: just the letter (A, B, C, or D)
- For numerical: just the number
- For written answers: a brief but complete answer

Questions:
${questionsToAnswer.map(q => `
Q${q.question_number}: ${q.question_text.substring(0, 500)}
${Object.keys(q.options || {}).length > 0 ? `Options: ${Object.entries(q.options).map(([k, v]) => `${k}) ${v.text}`).join(", ")}` : "(Written answer question)"}
`).join("\n")}

Return ONLY valid JSON in this format:
{
  "answers": [
    {"question_number": 1, "correct_answer": "A or answer text", "explanation": "brief explanation"}
  ]
}`;

          const response = await hooks.fetch(apiUrl, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${apiKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              model: model,
              messages: [
                { role: "user", content: answerPrompt },
              ],
              temperature: 0.2,
              max_tokens: 4000,
            }),
          });

          if (response.ok) {
            const data = await response.json();
            const content = data.choices?.[0]?.message?.content;

            if (content) {
              try {
                let jsonStr = content;
                const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
                if (jsonMatch) jsonStr = jsonMatch[1].trim();
                else {
                  const objectMatch = content.match(/\{[\s\S]*\}/);
                  if (objectMatch) jsonStr = objectMatch[0];
                }

                const parsed = JSON.parse(jsonStr);
                const generatedAnswers = parsed.answers || [];

                for (const ans of generatedAnswers) {
                  const qNum = Number(ans.question_number);
                  const question = questionMap.get(qNum);
                  if (question && (!question.correct_answer || question.correct_answer.trim() === "")) {
                    question.correct_answer = String(ans.correct_answer || "");
                    question.explanation = String(ans.explanation || question.explanation || "");
                    question.answer_source = "ai_generated";
                    aiAnswersGenerated++;
                  }
                }
              } catch (parseErr) {
                console.error("Failed to parse AI answer response:", parseErr);
              }
            }
          }
        } catch (err) {
          console.error(`AI answer generation failed for batch:`, err);
        }
      }

      console.log(`AI generated ${aiAnswersGenerated} answers for questions without document answers`);
    }

    // Final sorted array
    const finalQuestions = Array.from(questionMap.values())
      .sort((a, b) => a.question_number - b.question_number)
      .slice(0, MAX_QUESTIONS);

    // Calculate statistics
    const stillMissing = expectedQuestionCount > 0 
      ? Array.from(answerKey.keys()).filter(n => !questionMap.has(n))
      : [];
    const completionRate = expectedQuestionCount > 0 
      ? `${Math.round((finalQuestions.length / expectedQuestionCount) * 100)}%`
      : "N/A";

    console.log(`\n===== EXTRACTION COMPLETE =====`);
    console.log(`📊 Final: ${finalQuestions.length}/${expectedQuestionCount} questions (${completionRate})`);
    console.log(`⏱️ Total time: ${elapsedTime}ms`);
    console.log(`✅ Recovered in retries: ${totalRecovered}`);
    if (stillMissing.length > 0) {
      console.log(`❌ Still missing: ${stillMissing.slice(0, 20).join(", ")}${stillMissing.length > 20 ? "..." : ""}`);
    }

    const isPartial = expectedQuestionCount > 0 && finalQuestions.length < expectedQuestionCount * 0.95;

    const response                  = {
      success: finalQuestions.length > 0,
      questions: finalQuestions,
      questionsCount: finalQuestions.length,
      partial: isPartial || (allErrors.length > 0 && finalQuestions.length > 0),
      error: finalQuestions.length === 0 ? "No MCQs could be extracted" : 
             isPartial ? `Extracted ${finalQuestions.length} of ${expectedQuestionCount} expected questions (${completionRate})` : undefined,
      errorCode: finalQuestions.length === 0 ? "NO_QUESTIONS" : undefined,
      errors: allErrors.length > 0 ? allErrors : undefined,
      chunksProcessed,
      answerKeyStats: {
        found: answerKey.size,
        applied: answersApplied,
        missing: missingAnswers.slice(0, 20),
      },
      extractionStats: {
        expected: expectedQuestionCount,
        extracted: finalQuestions.length,
        recoveryAttempts: smartChunks.length,
        recoveredInRetries: totalRecovered,
        stillMissing: stillMissing.slice(0, 30),
        completionRate,
      },
    };

    return res.status(200).json(response);

  } catch (error) {
    console.error("Extraction error:", error);
    return res.status(500).json({
        success: false,
        questions: [],
        questionsCount: 0,
        error: error instanceof Error ? error.message : "Unknown error",
        errorCode: "SERVER_ERROR",
      });
  }
});
