import Anthropic from "@anthropic-ai/sdk";

/** Labels an inbound guest text so we know whether it's a complaint, a request, or fine. */

export const CATEGORIES = [
  "maintenance",
  "cleanliness",
  "noise",
  "billing",
  "request",
  "question",
  "safety",
  "praise",
  "other",
] as const;
export type Category = (typeof CATEGORIES)[number];

export interface Classification {
  sentiment: "positive" | "neutral" | "negative";
  category: Category;
  urgency: "low" | "normal" | "urgent";
  summary: string; // one line for staff
  by: "claude" | "keywords";
}

export interface Classifier {
  classify(text: string, context: { lastOutbound: string | null }): Promise<Classification>;
}

/** Always urgent, whatever a model says. False positives cost a phone call; misses cost far more. */
const SAFETY =
  /\b(smoke|fire|gas|carbon monoxide|co alarm|flood\w*|leak\w*|sparks?|electric\w* shock|injur\w*|hurt|bleed\w*|fell|ambulance|911|police|break[- ]?in|stolen|threat\w*|unsafe|scared)\b/i;

const RULES: { category: Category; re: RegExp }[] = [
  { category: "safety", re: SAFETY },
  { category: "cleanliness", re: /\b(dirty|filthy|stain\w*|hair|smell\w*|smelly|stink\w*|odor|bugs?|roach\w*|bed ?bugs?|mold\w*|trash|unclean)\b|\b(not|isn'?t|wasn'?t|aren'?t|weren'?t) (very |that |really )?clean\b/i },
  { category: "maintenance", re: /\b(broken|not working|doesn'?t work|won'?t|no hot water|cold water|ac|a\/c|air ?con\w*|heat\w*|heater|toilet|clog\w*|shower|tv|wi-?fi|internet|key ?card|lock|light|outlet|fridge|remote)\b/i },
  { category: "noise", re: /\b(noise|noisy|loud|party|music|barking|can'?t sleep|yelling)\b/i },
  { category: "billing", re: /\b(charge\w*|bill\w*|refund|deposit|overcharg\w*|receipt|invoice|price)\b/i },
  { category: "request", re: /\b(towels?|pillows?|blankets?|extra|late check-?out|early check-?in|bring|need (a|an|some|more)|can (i|we) get|crib|iron)\b/i },
];
/** A stated problem. Wins over polite words: "room is nice but the AC is loud" is a complaint. */
const PROBLEM =
  /\b(broken|not working|isn'?t working|doesn'?t work|don'?t work|won'?t|can'?t|no hot water|cold water|no water|no power|out of order|clog\w*|leak\w*|loud|noisy|noise|dirty|filthy|stain\w*|smell\w*|smelly|stink\w*|bugs?|roach\w*|mold\w*|kept (us|me) up|overcharg\w*|charged twice|wrong charge|missing|locked out)\b|\b(not|isn'?t|wasn'?t|aren'?t|weren'?t) (very |that |really )?clean\b/i;
const RESOLVED = /\b(fixed|better now|works now|working now|all good now|much better|sorted)\b/i;
const NEGATIVE =
  /\b(not|no|never|broken|dirty|bad|terrible|awful|horrible|worst|disappoint\w*|unacceptable|angry|upset|annoy\w*|problem|issue|complain\w*|gross|disgusting|rude|still)\b|!{2,}/i;
const POSITIVE = /\b(great|good|perfect|love\w*|amazing|awesome|excellent|wonderful|fine|nice|clean|comfortable|thanks?|thank you|all good|everything'?s? (is )?(good|great|fine))\b/i;
const URGENT = /\b(now|asap|immediately|urgent|emergency|right away|help)\b|!{2,}/i;

export class KeywordClassifier implements Classifier {
  async classify(text: string): Promise<Classification> {
    const t = text.trim();
    const category = RULES.find((r) => r.re.test(t))?.category ?? (/\?\s*$/.test(t) ? "question" : "other");
    const negated = /\b(not|no|never|still)\b/i.test(t);
    const pos = POSITIVE.test(t);
    let sentiment: Classification["sentiment"];
    if (category === "safety") sentiment = "negative";
    else if (PROBLEM.test(t)) sentiment = RESOLVED.test(t) && !/\bstill\b/i.test(t) ? "positive" : "negative";
    else if (NEGATIVE.test(t) && !(pos && !negated)) sentiment = "negative";
    else sentiment = pos ? "positive" : "neutral";
    const urgency: Classification["urgency"] =
      category === "safety" ? "urgent" : URGENT.test(t) && sentiment === "negative" ? "urgent" : sentiment === "positive" ? "low" : "normal";
    return {
      sentiment,
      category: sentiment === "positive" && category === "other" ? "praise" : category,
      urgency,
      summary: t.length > 120 ? `${t.slice(0, 117)}...` : t,
      by: "keywords",
    };
  }
}

const SYSTEM = `You triage text messages from hotel guests for the front desk.
Return only JSON: {"sentiment": "positive"|"neutral"|"negative", "category": one of ${JSON.stringify(CATEGORIES)}, "urgency": "low"|"normal"|"urgent", "summary": string}

- negative: anything wrong with the stay, even if phrased politely ("the shower is a bit cold").
- request: they want something brought or arranged, not a complaint.
- urgent: safety risks, guest can't use the room (no water, locked out, no AC in heat), or clear distress.
- praise: positive feedback with nothing to act on.
- summary: one short line for staff, plain words, include the specific problem or request.
- If the message only answers our last text positively ("all good thanks"), that's positive/praise/low.`;

export class ClaudeClassifier implements Classifier {
  private readonly client: Anthropic;
  private readonly fallback = new KeywordClassifier();
  constructor(
    apiKey: string,
    private readonly model = process.env.ANTHROPIC_CLASSIFIER_MODEL ?? "claude-haiku-5-5",
  ) {
    this.client = new Anthropic({ apiKey });
  }

  async classify(text: string, context: { lastOutbound: string | null }): Promise<Classification> {
    const keyword = await this.fallback.classify(text);
    try {
      const msg = await this.client.messages.create({
        model: this.model,
        max_tokens: 200,
        system: SYSTEM,
        messages: [
          {
            role: "user",
            content: `${context.lastOutbound ? `Our last text to the guest: ${context.lastOutbound}\n\n` : ""}Guest's message: ${text}`,
          },
        ],
      });
      const raw = msg.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("");
      const json = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1)) as Partial<Classification>;
      const result: Classification = {
        sentiment: (["positive", "neutral", "negative"] as const).includes(json.sentiment as never) ? json.sentiment! : keyword.sentiment,
        category: CATEGORIES.includes(json.category as Category) ? json.category! : keyword.category,
        urgency: (["low", "normal", "urgent"] as const).includes(json.urgency as never) ? json.urgency! : keyword.urgency,
        summary: typeof json.summary === "string" && json.summary.trim() ? json.summary.trim().slice(0, 200) : keyword.summary,
        by: "claude",
      };
      return enforceSafety(text, result);
    } catch {
      return keyword; // model outage must never drop a guest complaint
    }
  }
}

export function enforceSafety(text: string, c: Classification): Classification {
  if (!SAFETY.test(text)) return c;
  return { ...c, sentiment: "negative", urgency: "urgent", category: c.category === "praise" ? "safety" : c.category };
}

export function classifierFromEnv(env = process.env): Classifier {
  return env.ANTHROPIC_API_KEY ? new ClaudeClassifier(env.ANTHROPIC_API_KEY) : new KeywordClassifier();
}

/** Needs staff attention, and counts against the stay. */
export function isComplaint(c: Classification) {
  return c.sentiment === "negative" || c.urgency === "urgent";
}

/** Needs staff attention, but isn't a complaint. */
export function isRequest(c: Classification) {
  return !isComplaint(c) && (c.category === "request" || c.category === "question");
}
