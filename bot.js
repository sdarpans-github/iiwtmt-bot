import OpenAI from "openai";
import TelegramBot from "node-telegram-bot-api";
import dotenv from "dotenv";

dotenv.config();

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ── Session store ─────────────────────────────────────────────────────────────
// TODO Phase 1: move to Supabase — sessions reset on every Railway redeploy
const sessions = new Map();
const FREE_LIMIT = 10;

function getSession(chatId) {
  if (!sessions.has(chatId)) {
    sessions.set(chatId, {
      count: 0,
      lastUsed: null,
      lastDecision: null,
      awaitingContext: false,
    });
  }
  return sessions.get(chatId);
}

// ── Analysis prompt ───────────────────────────────────────────────────────────
const ANALYSIS_PROMPT = `You are "Is It Worth My Time?" — a sharp, honest decision-clarity assistant.

Your job: surface what the person hasn't fully calculated — real time cost, hidden obligations, what this decision reveals.

== SPECIFICITY — NON-NEGOTIABLE ==
Every sentence must be about THIS specific decision.
Reference the person's exact words, numbers, timeframes, and context throughout.
Never write a sentence that could apply to any decision.

BAD: "This could affect your productivity and requires careful time management."
GOOD: "The ₹40k project runs 6 weeks — that's your SaleIQ build limited to evenings until mid-May."

== HANDLING MISSING INFORMATION ==

If a piece of info is MISSING BUT MINOR (analysis holds either way):
- Make a reasonable assumption
- Flag it clearly inline like this: _(assuming X)_
- Continue with the analysis

If a piece of info is MISSING AND CENTRAL (the entire analysis would change without it):
- Do NOT analyse
- Do NOT assume
- Respond with ONLY this exact format:
  "Before I can give you a useful analysis — [one precise, specific question]"
- Nothing else. Wait for their answer before analysing.

== FORMAT ==

⏱️ *Time & Energy Cost*
Real cost of THIS decision. Hours, mental load, follow-on commitments. Use their actual numbers.

🧊 *What You Might Be Missing*
Specific hidden costs THIS person hasn't counted. What comes attached to their situation they haven't mentioned.

🔮 *Pre-Mortem*
The single most likely specific reason THIS decision leads to regret. Name it precisely.

💡 *The Signal*
What this decision reveals about where this person is right now. One honest observation tied to something they said.

📍 *Lean*
Yes / No / Yes but only if [specific condition]. One sentence. A suggestion, not a verdict.

---
Then on a new line, ONE of:
- If one specific piece of context would meaningfully sharpen the analysis: ask that precise question
- Otherwise write: "_Want to add anything? Reply and I'll re-analyse with the extra context._"

== RULES ==
- Under 300 words for the main analysis
- 2-3 sentences per section
- Light tone for small decisions, careful for major ones
- Never preachy, never moralistic
- If the user provided additional context, use it to sharpen every section`;

// ── Re-analysis prompt ────────────────────────────────────────────────────────
const REANALYSIS_PROMPT = `You are "Is It Worth My Time?" — a sharp, honest decision-clarity assistant.

The user submitted a decision and you gave an initial analysis. They have now added more context. Use everything — original decision plus new context — to give a sharper re-analysis.

Same rules:
- Every sentence must reference their specific situation
- Flag any remaining assumptions with _(assuming X)_
- Should be noticeably more precise than the first pass

Same format:
⏱️ *Time & Energy Cost*
🧊 *What You Might Be Missing*
🔮 *Pre-Mortem*
💡 *The Signal*
📍 *Lean*

End with: "_Updated with your context._"

Under 300 words. 2-3 sentences per section. Never generic.`;

// ── API call ──────────────────────────────────────────────────────────────────
async function callAnalysis(prompt, decisionText, additionalContext) {
  let userContent = `Decision: "${decisionText}"`;
  if (additionalContext) {
    userContent += `\n\nUser added context: "${additionalContext}"`;
  }

  const response = await openai.chat.completions.create({
    model: "gpt-4o",
    max_tokens: 700,
    messages: [
      { role: "system", content: prompt },
      { role: "user", content: userContent }
    ],
  });

  return response.choices[0].message.content;
}

// ── Logging ───────────────────────────────────────────────────────────────────
// TODO Phase 1: replace with Supabase insert
// Table: decisions(id, chat_id, decision_text, context, analysis, created_at)
function logDecision(chatId, decision, context, analysisLength) {
  console.log(JSON.stringify({
    event: "decision_analysed",
    chat_id: chatId,
    decision,
    context: context || null,
    analysis_length: analysisLength,
    timestamp: new Date().toISOString()
  }));
}

// ── Send analysis ─────────────────────────────────────────────────────────────
async function sendAnalysis(chatId, decision, additionalContext, session, isReanalysis) {
  bot.sendChatAction(chatId, "typing");

  try {
    const prompt = isReanalysis ? REANALYSIS_PROMPT : ANALYSIS_PROMPT;
    const analysis = await callAnalysis(prompt, decision, additionalContext);

    // Detect if model asked a clarifying question instead of analysing
    // (triggered when a central piece of info is missing)
    const isClarifyingQuestion =
      analysis.trim().startsWith("Before I can") ||
      analysis.trim().startsWith("Before giving");

    if (isClarifyingQuestion) {
      // Store decision, wait for answer — don't count against free limit
      session.lastDecision = decision;
      session.awaitingContext = true;
      await bot.sendMessage(chatId, analysis, { parse_mode: "Markdown" });
      return;
    }

    // Normal analysis
    if (!isReanalysis) {
      session.count += 1;
      session.lastUsed = new Date().toISOString();
      session.lastDecision = decision;
      session.awaitingContext = false;
    }

    logDecision(chatId, decision, additionalContext, analysis.length);

    await bot.sendMessage(chatId, analysis, { parse_mode: "Markdown" });

    if (!isReanalysis) {
      const remaining = FREE_LIMIT - session.count;
      const followUp = remaining > 0
        ? `_${remaining} free ${remaining === 1 ? "analysis" : "analyses"} remaining._`
        : `_That was your last free analysis. Full platform coming soon._`;
      await bot.sendMessage(chatId, followUp, { parse_mode: "Markdown" });
    }

  } catch (err) {
    console.error("Analysis error:", err);
    session.awaitingContext = false;
    bot.sendMessage(chatId, `Something went wrong. Try again in a moment.`);
  }
}

// ── Commands ──────────────────────────────────────────────────────────────────
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  const name = msg.from.first_name || "there";
  bot.sendMessage(
    chatId,
    `Hey ${name} 👋\n\nI'm *Is It Worth My Time?*\n\nSend me any decision — big or small — and I'll analyse it immediately.\n\nThe more specific you are, the sharper the output. Numbers, timeframes, context — all help.\n\nExamples:\n_"Should I take this freelance project at ₹40k for 3 weeks?"_\n_"Is it worth attending this 3-hour workshop on Saturday?"_\n_"Should I keep building two projects or focus on one?"_\n\nYou get *${FREE_LIMIT} free analyses*. Make them count. 🎯`,
    { parse_mode: "Markdown" }
  );
});

bot.onText(/\/help/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(
    chatId,
    `*How to use this bot*\n\nSend a decision in plain language. I'll analyse it straight away.\n\n*What I surface:*\n• Real time & energy cost — with your actual numbers\n• Hidden obligations you haven't counted\n• The most likely specific reason for regret\n• What the decision reveals about where you are right now\n• A clear lean with reasoning\n\n*How assumptions work:*\nIf I need to assume something minor, I'll flag it clearly in the output. If I need one central piece of info before I can give you a useful analysis, I'll ask — once.\n\nAfter any analysis, reply with more context and I'll re-analyse with the extra detail — no extra charge.\n\n*Commands:*\n/start — Welcome\n/help — This message\n/count — Analyses used\n\nI reason. I don't decide. You always make the final call.`,
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

  // Case 1: bot asked a clarifying question — this message is the answer
  if (session.awaitingContext && session.lastDecision) {
    const decision = session.lastDecision;
    session.awaitingContext = false;
    session.lastDecision = null;
    await sendAnalysis(chatId, decision, text, session, false);
    return;
  }

  // Case 2: user is adding context to a recent decision
  // Conditions: within 5 mins, short reply (under 80 chars), no question mark
  const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const hasRecentDecision =
    session.lastDecision &&
    session.lastUsed &&
    session.lastUsed > fiveMinutesAgo;
  const looksLikeContext = text.length < 80 && !text.includes("?");

  if (hasRecentDecision && looksLikeContext) {
    await sendAnalysis(chatId, session.lastDecision, text, session, true);
    return;
  }

  // Case 3: new decision — analyse immediately
  session.lastDecision = null;
  session.awaitingContext = false;
  await sendAnalysis(chatId, text, null, session, false);
});

// ── Error handling ────────────────────────────────────────────────────────────
bot.on("polling_error", (err) => {
  console.error("Polling error:", err.message);
});

console.log("✅ IIWTMT bot is running...");
