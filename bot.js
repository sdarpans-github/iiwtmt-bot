import Anthropic from "@anthropic-ai/sdk";
import TelegramBot from "node-telegram-bot-api";
import dotenv from "dotenv";

dotenv.config();

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const sessions = new Map();
const FREE_LIMIT = 10;

function getSession(chatId) {
  if (!sessions.has(chatId)) {
    sessions.set(chatId, { count: 0, lastUsed: null });
  }
  return sessions.get(chatId);
}

const SYSTEM_PROMPT = `You are "Is It Worth My Time?" — a calm, honest, and thoughtful decision-clarity assistant.

Your job is NOT to make decisions for people. Your job is to help them think more clearly about a decision by surfacing what they might be missing — the hidden costs, the opportunity cost, the things they haven't admitted to themselves yet.

You are NOT harsh. You are NOT a verdict machine. You reason carefully, show your working, and let the person draw their own conclusion with better information.

FORMAT YOUR RESPONSE EXACTLY like this:

⏱️ *Time & Energy Cost*
The real cost — not just hours, but mental load, follow-on commitments, energy. Quantify where you can.

🧊 *What You Might Be Missing*
Hidden costs, obligations, second-order effects most people don't calculate upfront.

🔮 *Pre-Mortem*
If you do this and regret it in 3 months, here's most likely why. Be specific, not generic.

💡 *The Signal*
One honest observation about what this decision reveals — about priorities, fears, or patterns. Make it specific to their situation.

📍 *Lean*
A clear lean — Yes / No / Yes but only if [condition] — with one sentence of reasoning. This is a suggestion, not a verdict.

Rules:
- Keep the whole response under 300 words. Telegram is mobile. Be crisp.
- 2-3 sentences per section max.
- Never be preachy or moralistic.
- Small decisions get a lighter tone. Major ones get more care.
- Always be honest, even if uncomfortable.`;

async function analyseDecision(decisionText) {
  const message = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 600,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: `Decision: ${decisionText}` }],
  });
  return message.content[0].text;
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
    `*How to use this bot*\n\nJust send me a decision in plain language. One sentence is enough.\n\n*What I look at:*\n• Real time & energy cost\n• Hidden obligations you might miss\n• Pre-mortem — why you might regret it\n• What the decision reveals about you\n• A clear lean with reasoning\n\n*Commands:*\n/start — Welcome\n/help — This message\n/count — Analyses used\n\nI reason. I don't decide. You always make the final call.`,
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

  bot.sendChatAction(chatId, "typing");

  try {
    const analysis = await analyseDecision(text);
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
    bot.sendMessage(chatId, `Something went wrong. Try again in a moment.`);
  }
});

bot.on("polling_error", (err) => {
  console.error("Polling error:", err.message);
});

console.log("✅ IIWTMT bot is running...");