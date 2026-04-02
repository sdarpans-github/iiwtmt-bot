import OpenAI from "openai";
import TelegramBot from "node-telegram-bot-api";
import dotenv from "dotenv";

dotenv.config();

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Structure: { chatId: { count, lastUsed, pendingDecision, context } }
const sessions = new Map();
const FREE_LIMIT = 10;

function getSession(chatId) {
  if (!sessions.has(chatId)) {
    sessions.set(chatId, { count: 0, lastUsed: null, pendingDecision: null, context: null });
  }
  return sessions.get(chatId);
}

const SYSTEM_PROMPT = `You are "Is It Worth My Time?" — a sharp, honest, and grounded decision-clarity assistant.

Your job: help the person think more clearly by surfacing what they haven't fully calculated yet — the real time cost, hidden obligations, and what this decision actually reveals about where they are right now.

CRITICAL RULES FOR SPECIFICITY:
- You MUST reference the exact details from their decision in every section. If they mentioned a number, use it. If they mentioned a timeframe, use it. If they mentioned a person or context, reference it.
- NEVER write generic advice that could apply to anyone. Every sentence must be about THIS specific decision.
- If the decision is vague, make reasonable assumptions based on context and state them briefly.

FORMAT YOUR RESPONSE EXACTLY like this — no deviations:

⏱️ *Time & Energy Cost*
The real cost of THIS decision specifically. Not just hours — include mental load, follow-on commitments, energy drain. Use their actual numbers where given. Quantify what you can.

🧊 *What You Might Be Missing*
The specific hidden costs or obligations THIS person in THIS situation likely hasn't calculated. Second-order effects. What comes attached to this decision they haven't mentioned.

🔮 *Pre-Mortem*
The single most likely specific reason THIS decision leads to regret in 3 months. Not generic. Name it precisely.

💡 *The Signal*
What saying yes or no to THIS specific decision reveals about where this person is right now — their priorities, constraints, or a pattern worth noticing. One observation, made honestly.

📍 *Lean*
Yes / No / Yes but only if [specific condition] — one sentence of reasoning tied directly to their situation. A suggestion, not a verdict.

---
Additional rules:
- Under 300 words total. This is Telegram — mobile, on the go.
- 2-3 sentences per section. No padding.
- Match tone to stakes: light for small decisions, careful for big ones.
- Never preachy. Never moralistic. Never hedge everything.
- If context (work/personal/financial) was provided, use it to sharpen every section.`;

async function analyseDecision(decisionText, context) {
  const userContent = context
    ? `Decision: ${decisionText}\nContext: ${context}`
    : `Decision: ${decisionText}`;

  const response = await openai.chat.completions.create({
    model: "gpt-4o",
    max_tokens: 700,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userContent }
    ],
  });
  return response.choices[0].message.content;
}

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

  // Step 1 — ask one context question first
  if (!session.pendingDecision) {
    session.pendingDecision = text;
    await bot.sendMessage(
      chatId,
      `Got it. One quick question before I analyse:\n\n*Is this primarily a work, personal, or financial decision?*\n\nReply with one of those — or add a sentence of context if it helps.`,
      { parse_mode: "Markdown" }
    );
    return;
  }

  // Step 2 — context received, now analyse
  session.context = text;
  const decision = session.pendingDecision;
  const context = session.context;
  session.pendingDecision = null;
  session.context = null;

  bot.sendChatAction(chatId, "typing");

  try {
    const analysis = await analyseDecision(decision, context);
    session.count += 1;
    session.lastUsed = new Date().toISOString();
    const remaining = FREE_LIMIT - session.count;

    await bot.sendMessage(chatId, analysis, { parse_mode: "Markdown" });

    const followUp =
      remaining > 0
        ? `_${remaining} free ${remaining === 1 ? "analysis" : "analyses"} remaining._`
        : `_That was your last free analysis. Full platform coming soon._`;

    await bot.sendMessage(chatId, followUp, { parse_mode: "Markdown" });
  } catch (err) {
    console.error("Analysis error:", err);
    session.pendingDecision = null;
    session.context = null;
    bot.sendMessage(chatId, `Something went wrong. Try again in a moment.`);
  }
});

bot.on("polling_error", (err) => {
  console.error("Polling error:", err.message);
});

console.log("✅ IIWTMT bot is running...");