import { GoogleGenerativeAI } from "@google/generative-ai";
import { env } from "../config/env.js";
import { narrativeCacheRepo } from "../db/repos.js";
import type { TokenSummary } from "../gmgn/types.js";
import { logger } from "../utils/logger.js";

const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

const genAI = env.GEMINI_API_KEY ? new GoogleGenerativeAI(env.GEMINI_API_KEY) : null;

export interface NarrativeResult {
  score: number; // 0..10
  reasoning: string;
  source: "gemini" | "cache" | "fallback";
}

const PROMPT_SYSTEM = `You are a Solana meme coin narrative analyst.
Score the meme on a scale of 0-10 for "narrative strength" — the likelihood that a degen retail crowd will rally around the meme.

Heuristics:
- Strong: timely cultural reference, crisp visual potential, easy to caption, clean pun, news-pegged.
- Mid: generic animal/food, low-effort copycats, vague utility claims.
- Weak: random scam-name, copy of another live meme, unreadable, bot-stuffed description, no socials.

Output ONLY a compact JSON object: {"score": <0-10 number>, "reasoning": "<1 sentence>"}.
No prose, no markdown.`;

export async function narrativeScore(token: TokenSummary): Promise<NarrativeResult> {
  if (!genAI) {
    return { score: 7, reasoning: "Gemini disabled, default 7", source: "fallback" };
  }
  const cached = narrativeCacheRepo.get(token.ca, CACHE_TTL_MS);
  if (cached) return { ...cached, source: "cache" };

  const userPart = [
    `Symbol: ${token.symbol}`,
    `Name: ${token.name}`,
    `Description: ${token.description ?? "(none)"}`,
    `Twitter: ${token.socials.twitter ?? "(none)"}`,
    `Telegram: ${token.socials.telegram ?? "(none)"}`,
    `Website: ${token.socials.website ?? "(none)"}`,
  ].join("\n");

  try {
    const model = genAI.getGenerativeModel({ model: env.GEMINI_MODEL });
    const result = await model.generateContent({
      contents: [
        { role: "user", parts: [{ text: PROMPT_SYSTEM + "\n\n" + userPart }] },
      ],
      generationConfig: { temperature: 0.2, maxOutputTokens: 120 },
    });
    const text = result.response.text().trim();
    const jsonStart = text.indexOf("{");
    const jsonEnd = text.lastIndexOf("}");
    if (jsonStart < 0 || jsonEnd < 0) throw new Error(`Bad JSON: ${text.slice(0, 80)}`);
    const parsed = JSON.parse(text.slice(jsonStart, jsonEnd + 1)) as {
      score: number;
      reasoning: string;
    };
    const score = Math.max(0, Math.min(10, Number(parsed.score)));
    const reasoning = String(parsed.reasoning ?? "").slice(0, 240);
    narrativeCacheRepo.set(token.ca, score, reasoning);
    return { score, reasoning, source: "gemini" };
  } catch (err) {
    logger.warn({ ca: token.ca, err: String(err) }, "narrative scoring failed");
    return { score: 5, reasoning: "Gemini error, default 5", source: "fallback" };
  }
}
