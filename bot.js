import OpenAI from "openai";
import TelegramBot from "node-telegram-bot-api";
import dotenv from "dotenv";

dotenv.config();

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ── Session store (in-memory — resets on redeploy) ───────────────────────────
// Structure: { chatId: { count, lastUsed, pendingDecision } }
// TODO Phase 1: move to Supabase so sessions persist across redeploys
const sessions = new Map();
const FREE_LIMIT = 10;

function getSession(chatId) {
  if (!sessions.has(chatId)) {
    sessions.set(chatId, { count: 0, lastUsed: null, pendingDecision: null });
  }
  return sessions.get(chatId);
}

// ── Triage prompt ─────────────────────────────────────────────────────────────
// Fast, cheap call — reads the decision and decides if clarification is needed
const TRIAGE_PROMPT = `You are a decision triage assistant. Your only job is to decide if a decision needs one clarifying question before analysis, or can be analysed directly.

A decision is CLEAR if:
- The context is obvious from the text (e.g. mentions money, work, a specific person, a timeframe, a role)
- Adding a clarifying question would feel annoying or patronising

A decision is AMBIGUOUS if:
- The context would genuinely change the analysis in a meaningful way
- Without it, the analysis would be noticeably generic

Respond ONLY with valid JSON in this exact format — nothing else:
{
  "needsClarification": true or false,
  "inferredContext": "one sentence describing what you inferred about the decision type and stakes",
  "clarifyingQuestion": "one short, specific question — only if needsClarification is true, otherwise null"
}`;

// ── Analysis prompt ───────────────────────────────────────────────────────────
const ANALYSIS_PROMPT = `You are "Is It Worth My Time?" — a sharp, honest, and grounded decision-clarity assistant.

Your job: help the person think more clearly by surfacing what they haven't fully calculated yet — the real time cost, hidden obligations, and what this decision actually reveals about where they are right now.

CRITICAL RULES FOR SPECIFICITY:
- You MUST reference the exact details from their decision in every section. If they mentioned a number, use it. If they mentioned a timeframe, use it. If they mentioned a person or context, reference it directly.
- NEVER write generic advice that could apply to anyone. Every sentence must be unmistakably about THIS specific decision.
- If something is unclear, make a reasonable assumption and state it briefly in one phrase.

FORMAT YOUR RESPONSE EXACTLY like this:

⏱️ *Time & Energy Cost*
The real cost of THIS decision. Not just hours — mental load, follow-on commitments, energy drain. Use their actual numbers. Quantify what you can.

🧊 *What You Might Be Missing*
The specific hidden costs THIS person in THIS situation likely hasn't calculated. What comes attached to this decision that they haven't mentioned.

🔮 *Pre-Mortem*
The single most likely specific reason THIS decision leads to regret. Not generic. Name it precisely.

💡 *The Signal*
What saying yes or no to THIS specific decision reveals about where this person is right now — a priority, a constraint, or a pattern worth noticing. One honest observation.

📍 *Lean*
Yes / No / Yes but only if [specific condition] — one sentence tied directly to their situation. A suggestion, not a verdict.

---
Rules:
- Under 300 words total. Telegram is mobile.
- 2-3 sentences per section. No padding.
- Match tone to stakes: light for trivial decisions, careful for major ones.
- Never preachy. Never moralistic.
- Use the inferred context and any clarification provided to sharpen every section.`;

// ── API calls ─────────────────────────────────────────────────────────────────
async function triageDecision(decisionText) {
  const response = await openai.chat.completions.create({
    model: "gpt-4o",
    max_tokens: 150,
    messages: [
      { role: "system", content: TRIAGE_PROMPT },
      { role: "user", content: `Decision: ${decisionText}` }
    ],
  });
  const raw = response.choices[0].message.content;
  return JSON.parse(raw.replace(/```json|```/g, "").trim());
}

async function analyseDecision(decisionText, inferredContext, clarification) {
  let userContent = `Decision: ${decisionText}`;
  if (inferredContext) userContent += `\nInferred context: ${inferredContext}`;
  if (clarification) userContent += `\nUser clarification: ${clarification}`;

  const response = await openai.chat.completions.create({
    model: "gpt-4o",
    max_tokens: 700,
    messages: [
      { role: "system", content: ANALYSIS_PROMPT },
      { role: "user", content: userContent }
    ],
  });
  return response.choices[0].message.content;
}

// ── Logging ───────────────────────────────────────────────────────────────────
// TODO Phase 1: replace console.log with Supabase inserts
// Table needed: decisions(id, chat_id, decision_text, context, analysis, created_at)
function logDecision(chatId, decision, context, analysis) {
  console.log(JSON.stringify({
    event: "decision_analysed",
    chat_id: chatId,
    decision,
    context,
    analysis_length: analysis.length,
    timestamp: new Date().toISOString()
  }));
}

// ── Helper: send analysis + follow-up ────────────────────────────────────────
async function sendAnalysis(chatId, decision, inferredContext, clarification, session) {
  bot.sendChatAction(chatId, "typing");

  try {
    const analysis = await analyseDecision(decision, inferredContext, clarification);
    session.count += 1;
    session.lastUsed = new Date().toISOString();
    const remaining = FREE_LIMIT - session.count;

    logDecision(chatId, decision, inferredContext || clarification, analysis);

    await bot.sendMessage(chatId, analysis, { parse_mode: "Markdown" });

    const followUp = remaining > 0
      ? `_${remaining} free ${remaining === 1 ? "analysis" : "analyses"} remaining._`
      : `_That was your last free analysis. Full platform coming soon._`;

    await bot.sendMessage(chatId, followUp, { parse_mode: "Markdown" });
  } catch (err) {
    console.error("Analysis error:", err);
    session.pendingDecision = null;
    bot.sendMessage(chatId, `Something went wrong. Try again in a moment.`);
  }
}

// ── Commands ──────────────────────────────────────────────────────────────────
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  const name = msg.from.first_name || "there";
  bot.sendMessage(
    chatId,
    `Hey ${name} 👋\n\nI'm *Is It Worth My Time?*\n\nSend me any decision — big or small — and I'll help you think through it clearly.\n\nExamples:\n_"Should I take this freelance project at ₹40k for 3 weeks?"_\n_"Is it worth attending this 3-hour workshop on Saturday?"_\n_"Should I hire a developer or keep building myself?"_\n\nYou get *${FREE_LIMIT} free analyses*. Make them count. 🎯`,
    { parse_mode: "Markdown" }
  );
});

bot.onText(/\/help/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(
    chatId,
    `*How to use this bot*\n\nJust send me a decision in plain language. One sentence is enough.\n\n*What I look at:*\n• Real time & energy cost — specific to your situation\n• Hidden obligations you might miss\n• Pre-mortem — the most likely specific reason for regret\n• What the decision reveals about where you are right now\n• A clear lean with reasoning\n\n*Commands:*\n/start — Welcome\n/help — This message\n/count — Analyses used\n\nI reason. I don't decide. You always make the final call.`,
    { parse_mode: "Markdown" }
  );
});

bot.onText(/\/count/, (msg) => {
  const chatId = msg.chat.id;
  const session = getSession(chatId);
  const remaining = Math.max(0, FREE_LIMIT - session.count);
  bot.sendMessage(
    chatId,
    `You've used *${session.count}/${FREE_LIMIT}* free analyses.\n${remaining > 0 ? `*${remaining} remaining.*` : `You've used all your free analyses.`}`,
    { parse_mode: "Markdown" }
  );
});

// ── Main message handler ──────────────────────────────────────────────────────
bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;

  if (!text || text.startsWith("/")) return;

  if (text.trim().length < 10) {
    bot.sendMessage(chatId, `Tell me a bit more. What are you weighing up?`);
    return;
  }

  const session = getSession(chatId);

  if (session.count >= FREE_LIMIT) {
    bot.sendMessage(
      chatId,
      `You've used all *${FREE_LIMIT}* free analyses.\n\nFull platform with unlimited access + decision history is coming soon. Stay tuned.`,
      { parse_mode: "Markdown" }
    );
    return;
  }

  // Step 2 — pending decision exists, this message is the clarification
  if (session.pendingDecision) {
    const { decision, inferredContext } = session.pendingDecision;
    const clarification = text;
    session.pendingDecision = null;
    await sendAnalysis(chatId, decision, inferredContext, clarification, session);
    return;
  }

  // Step 1 — new decision: triage first
  bot.sendChatAction(chatId, "typing");

  try {
    const triage = await triageDecision(text);

    if (triage.needsClarification) {
      session.pendingDecision = {
        decision: text,
        inferredContext: triage.inferredContext
      };
      await bot.sendMessage(chatId, triage.clarifyingQuestion, { parse_mode: "Markdown" });
    } else {
      await sendAnalysis(chatId, text, triage.inferredContext, null, session);
    }
  } catch (err) {
    console.error("Triage error:", err);
    // Triage failed — fall back to direct analysis without context
    await sendAnalysis(chatId, text, null, null, session);
  }
});

// ── Error handling ────────────────────────────────────────────────────────────
bot.on("polling_error", (err) => {
  console.error("Polling error:", err.message);
});

console.log("✅ IIWTMT bot is running...");
