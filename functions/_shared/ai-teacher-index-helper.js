// Knowledge-index building blocks for the AI Teacher index (port of supabase/functions/_shared/knowledgeIndex.ts).
// Chunking, OpenRouter embeddings, and routing-card generation. Persistence is in ai-teacher-index.
// The embedding model/dimensions must match what ai-teacher uses to embed student questions.
// The OpenRouter base URL is fixed (a public API); the key is always passed in by the caller.

export const EMBED_MODEL = "openai/text-embedding-3-small";
export const EMBED_DIMS = 768;
export const CARD_MODEL = "google/gemini-2.5-flash";
const TARGET_MAX = 1400; // chars per chunk (soft max)
const MERGE_BELOW = 250; // sections shorter than this are merged with the following one
const OPENROUTER = "https://openrouter.ai/api/v1";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- chunking ----------
export function cleanText(s) {
  return s
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ") // image tags (incl. base64)
    .replace(/<img[^>]*>/gi, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function splitSections(md) {
  const lines = md.split("\n");
  const stack = [];
  const sections = [];
  let cur = { path: "", headLine: "", body: [] };
  const flush = () => {
    const body = cleanText(cur.body.join("\n"));
    if (body.length > 0 || cur.headLine) sections.push({ path: cur.path, headLine: cur.headLine, body });
  };
  for (const line of lines) {
    const m = line.match(/^(#{1,6})\s+(.*\S)\s*$/);
    if (m) {
      flush();
      const level = m[1].length;
      while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
      stack.push({ level, title: m[2].trim() });
      cur = { path: stack.map((s) => s.title).join(" > "), headLine: line.trim(), body: [] };
    } else cur.body.push(line);
  }
  flush();
  return sections;
}

function splitLong(text, max) {
  if (text.length <= max) return [text];
  const paras = text.split(/\n\s*\n/);
  const out = [];
  let buf = "";
  const push = () => {
    if (buf.trim()) out.push(buf.trim());
    buf = "";
  };
  for (const p of paras) {
    if (p.length > max) {
      push();
      let rest = p;
      while (rest.length > max) {
        let cut = rest.lastIndexOf(". ", max);
        if (cut < max * 0.5) cut = rest.lastIndexOf(" ", max);
        if (cut < 1) cut = max;
        out.push(rest.slice(0, cut + 1).trim());
        rest = rest.slice(cut + 1);
      }
      buf = rest;
    } else if ((buf + "\n\n" + p).length > max) {
      push();
      buf = p;
    } else buf = buf ? buf + "\n\n" + p : p;
  }
  push();
  return out;
}

export function chunkMarkdown(md) {
  const sections = splitSections(md);
  const chunks = [];
  let pending = null; // merged small sections
  const emit = (path, text) => {
    for (const piece of splitLong(text, TARGET_MAX)) {
      if (piece.replace(/\s/g, "").length >= 30) chunks.push({ path, text: piece });
    }
  };
  for (const s of sections) {
    const text = s.headLine && s.body ? `${s.headLine}\n${s.body}` : s.headLine || s.body;
    if (!text.trim()) continue;
    if (pending) {
      const combined = pending.text + "\n\n" + text;
      if (combined.length <= TARGET_MAX) {
        pending = { path: pending.path, text: combined, small: combined.length < MERGE_BELOW };
        if (!pending.small) {
          emit(pending.path, pending.text);
          pending = null;
        }
        continue;
      }
      emit(pending.path, pending.text);
      pending = null;
    }
    if (text.length < MERGE_BELOW) pending = { path: s.path, text, small: true };
    else emit(s.path, text);
  }
  if (pending) emit(pending.path, pending.text);
  return chunks;
}

// ---------- OpenRouter ----------
function l2(v) {
  const n = Math.sqrt(v.reduce((a, x) => a + x * x, 0)) || 1;
  return v.map((x) => x / n);
}

// Embeds texts (L2-normalised, EMBED_DIMS wide), in the same order. Batches of 64.
export async function embedTexts(apiKey, texts) {
  const out = [];
  for (let b = 0; b < texts.length; b += 64) {
    const batch = texts.slice(b, b + 64);
    let done = false;
    for (let attempt = 1; attempt <= 5 && !done; attempt++) {
      const r = await fetch(`${OPENROUTER}/embeddings`, {
        method: "POST",
        headers: { Authorization: "Bearer " + apiKey, "Content-Type": "application/json" },
        body: JSON.stringify({ model: EMBED_MODEL, input: batch, dimensions: EMBED_DIMS }),
      });
      if (r.ok) {
        const j = await r.json();
        out.push(...j.data.sort((a, b2) => a.index - b2.index).map((d) => l2(d.embedding)));
        done = true;
      } else if (r.status === 429 || r.status >= 500) await sleep(2000 * attempt);
      else throw new Error(`embed ${r.status}: ${(await r.text()).slice(0, 300)}`);
    }
    if (!done) throw new Error("embed failed after retries");
  }
  return out;
}

async function chatJson(apiKey, prompt) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    const r = await fetch(`${OPENROUTER}/chat/completions`, {
      method: "POST",
      headers: { Authorization: "Bearer " + apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: CARD_MODEL,
        temperature: 0.2,
        response_format: { type: "json_object" },
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (r.ok) {
      const j = await r.json();
      return j.choices?.[0]?.message?.content || "";
    }
    if (r.status === 429 || r.status >= 500) {
      await sleep(2000 * attempt);
      continue;
    }
    throw new Error(`chat ${r.status}: ${(await r.text()).slice(0, 300)}`);
  }
  throw new Error("chat failed after retries");
}

// One routing card per topic: summary, keywords, and sample questions, used to pick topics before chunk search.
export async function makeRoutingCard(apiKey, ctx) {
  const excerpt = ctx.markdown.replace(/!\[[^\]]*\]\([^)]*\)/g, " ").slice(0, 7000);
  const raw = await chatJson(
    apiKey,
    `You are indexing study notes for a student Q&A search system.\nSubject: ${ctx.subject}\nChapter: ${ctx.chapter}\nTopic: ${ctx.topic}\n\nNOTES (may be truncated):\n${excerpt}\n\nReturn ONLY JSON: {"summary": "2 plain sentences on what this topic covers", "keywords": ["8-15 key terms, names, dates from the notes"], "sample_questions": ["6-10 questions a student might ask that these notes answer, in simple English"]}`
  );
  const card = JSON.parse(raw.replace(/^```json\s*|\s*```$/g, ""));
  return {
    summary: String(card.summary || "").slice(0, 600),
    keywords: (card.keywords || []).map(String).slice(0, 20),
    sample_questions: (card.sample_questions || []).map(String).slice(0, 12),
  };
}

// The text a card is embedded from (kept identical to the original).
export const cardEmbedText = (chapter, topic, c) =>
  `${chapter} > ${topic}\n${c.summary}\n${c.keywords.join(", ")}\n${c.sample_questions.join("\n")}`;

// The text a chunk is embedded from.
export const chunkEmbedText = (c) => `${c.path}\n${c.text}`.slice(0, 6000);

// pgvector literal, for use as a parameter cast to ::vector.
export const vecLiteral = (v) => `[${v.map((x) => +x.toFixed(6)).join(",")}]`;
