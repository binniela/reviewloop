import { KeywordClassifier } from "../inbound/classify.js";
import Anthropic from "@anthropic-ai/sdk";
import type { Property } from "../properties.js";

export interface DraftContext {
  property: Pick<Property, "name" | "voice_notes" | "signoff">;
  review: { author: string | null; rating: number | null; body: string | null };
  /** What happened during the stay, from recovery cases. Private: informs the reply, never quoted. */
  stayNotes: string[];
  /** Recent replies the GM edited before posting, as examples of the voice they want. */
  voiceExamples: { draft: string; final: string }[];
}

export interface ReplyDrafter {
  draft(ctx: DraftContext): Promise<string>;
}

const SYSTEM = `You write public replies to guest reviews on behalf of a hotel's general manager.

Rules:
- Match the property's voice notes. Sound like a real person at a small hotel, not a brand.
- Keep it short: 2 to 4 sentences for positive reviews, up to 5 for critical ones.
- Respond to what the reviewer actually said. Never invent details, offers, amenities, or fixes.
- The private stay notes are background only. Do not reveal anything the reviewer did not post
  publicly: no room numbers, names of staff or other guests, dates, prices, compensation given,
  or personal circumstances. You may say an issue they mentioned was addressed only if the notes
  show it was resolved.
- For critical reviews: thank them, acknowledge the specific problem without excuses or blaming the
  guest, say what changes if the notes support it, and invite them to contact the hotel directly.
  Do not argue, and do not mention refunds, legal matters, or policies.
- Do not ask them to change or remove the review. Do not mention other review sites.
- No em dashes. No emojis. No sign-off other than the one provided.
- Output only the reply text.`;

export class ClaudeDrafter implements ReplyDrafter {
  private readonly client: Anthropic;
  constructor(
    apiKey: string,
    private readonly model = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-5-5",
  ) {
    this.client = new Anthropic({ apiKey });
  }

  async draft(ctx: DraftContext): Promise<string> {
    const examples = ctx.voiceExamples
      .map((e, i) => `Example ${i + 1}\nDraft: ${e.draft}\nWhat the manager actually posted: ${e.final}`)
      .join("\n\n");
    const user = [
      `Property: ${ctx.property.name}`,
      `Voice notes: ${ctx.property.voice_notes || "(none)"}`,
      `Sign-off: ${ctx.property.signoff || "(none)"}`,
      examples ? `Past corrections from the manager (follow their style):\n${examples}` : "",
      `Private stay notes:\n${ctx.stayNotes.length ? ctx.stayNotes.map((n) => `- ${n}`).join("\n") : "(none)"}`,
      `Review by ${ctx.review.author ?? "a guest"}, ${ctx.review.rating ?? "?"} stars:\n${ctx.review.body ?? "(rating only, no text)"}`,
    ]
      .filter(Boolean)
      .join("\n\n");

    const msg = await this.client.messages.create({
      model: this.model,
      max_tokens: 400,
      system: SYSTEM,
      messages: [{ role: "user", content: user }],
    }, { timeout: 15_000, maxRetries: 0 });
    const text = msg.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();
    if (!text) throw new Error("empty draft from model");
    return cleanDraft(text);
  }
}

/** Used when no API key is set, so the app works end to end before Claude is configured. */
export class TemplateDrafter implements ReplyDrafter {
  async draft(ctx: DraftContext): Promise<string> {
    const name = firstName(ctx.review.author);
    const hi = name ? `Thank you, ${name}.` : "Thank you for your review.";
    const sign = ctx.property.signoff ? `\n${ctx.property.signoff}` : "";
    const r = ctx.review.rating ?? 3;
    const classification = await new KeywordClassifier().classify(ctx.review.body ?? "");
    if (classification.sentiment === "negative" || /\b(but|however|although)\b/i.test(ctx.review.body ?? "")) {
      return `${hi} We're sorry there were problems during your stay at ${ctx.property.name}. Please contact the front desk so we can discuss what happened.${sign}`;
    }
    if (r >= 4) return `${hi} We're glad you enjoyed your stay at ${ctx.property.name} and hope to see you again soon.${sign}`;
    if (r === 3)
      return `${hi} We appreciate your feedback. Please contact the front desk if you would like to discuss your stay. We hope to give you a better stay next time.${sign}`;
    return `${hi} We're sorry your stay at ${ctx.property.name} fell short. Please reach out to us directly so we can make this right.${sign}`;
  }
}

export function drafterFromEnv(env = process.env): ReplyDrafter {
  return env.ANTHROPIC_API_KEY ? new ClaudeDrafter(env.ANTHROPIC_API_KEY) : new TemplateDrafter();
}

export function firstName(author: string | null): string | null {
  if (!author) return null;
  const first = author.trim().split(/\s+/)[0];
  return first && /^\p{L}/u.test(first) ? first : null;
}

/** Belt and braces for the style rules: models sometimes slip. */
export function cleanDraft(text: string): string {
  return text
    .replace(/^["']|["']$/g, "")
    .replace(/\s*—\s*/g, ", ")
    .replace(/\s*–\s*/g, " to ")
    .trim();
}
