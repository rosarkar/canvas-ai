import { describe, expect, it, vi } from "vitest";

import {
  buildLiveContextMessage,
  buildPhaseContextMessage,
  CAPTCHA_ARCHETYPES,
  derivePhase,
  buildTaskTemplate,
  emptyIntent,
  interpretAdvertiserMessage,
  mergeIntent,
  normalizeIntent,
  parseBuyAgentResponse,
} from "./buy-assistant.js";
import { TaskType } from "./verification-tasks.js";

vi.mock("./scoring.js", () => ({
  callKimi: vi.fn(),
}));

describe("buildLiveContextMessage", () => {
  it("lists groups with id, topic, and top bid", () => {
    const msg = buildLiveContextMessage(
      [{ groupId: 3, title: "Lennox Cartel", topic: "DeFi trading", topBidUsd: 0.35 }],
      { minQuantity: 10, minBidUsd: 0.01 },
    );
    expect(msg).toContain("id 3");
    expect(msg).toContain("Lennox Cartel");
    expect(msg).toContain("DeFi trading");
    expect(msg).toContain("$0.35");
    expect(msg).toContain("Minimum quantity: 10");
  });

  it("shows 'none yet' when a group has no active bid", () => {
    const msg = buildLiveContextMessage([{ groupId: 1, title: "Group #1", topic: "", topBidUsd: null }], {
      minQuantity: 10,
      minBidUsd: 0.01,
    });
    expect(msg).toContain("none yet");
  });

  it("handles no active groups", () => {
    const msg = buildLiveContextMessage([], { minQuantity: 10, minBidUsd: 0.01 });
    expect(msg).toContain("no active groups available");
  });
});

describe("normalizeIntent", () => {
  it("extracts a fully-specified intent", () => {
    const intent = normalizeIntent({
      groupId: 3,
      quantity: 50,
      bidUsd: 0.35,
      taskType: "binary_reasoning",
      templateName: "Audit check",
      payload: {
        prompt: "Would you use AI to audit your contract?",
        optionA: "Yes",
        optionB: "No",
        bonusUsd: 0.05,
      },
    });
    expect(intent.groupId).toBe(3);
    expect(intent.taskType).toBe(TaskType.BINARY_REASONING);
    expect(intent.payload.optionA).toBe("Yes");
    expect(intent.payload.bonusUsd).toBe(0.05);
  });

  it("falls back to null for missing/invalid fields instead of throwing", () => {
    const intent = normalizeIntent({ groupId: "not-a-number", taskType: "made_up_type" });
    expect(intent.groupId).toBeNull();
    expect(intent.taskType).toBeNull();
    expect(intent.payload.prompt).toBeNull();
  });

  it("normalizes option lists given as plain strings or {label,description} objects", () => {
    const intent = normalizeIntent({
      taskType: "rank_reasoning",
      payload: { items: ["Song A", { label: "Song B", description: "1989" }] },
    });
    expect(intent.payload.items).toEqual([{ label: "Song A" }, { label: "Song B", description: "1989" }]);
  });

  it("handles completely empty/garbage input", () => {
    const intent = normalizeIntent(null);
    expect(intent).toEqual(emptyIntent());
  });
});

describe("mergeIntent", () => {
  it("carries forward previously known fields when the new turn omits them", () => {
    const previous = normalizeIntent({ groupId: 3, quantity: 50 });
    const next = normalizeIntent({ bidUsd: 0.35 });
    const merged = mergeIntent(previous, next);
    expect(merged.groupId).toBe(3);
    expect(merged.quantity).toBe(50);
    expect(merged.bidUsd).toBe(0.35);
  });

  it("lets new non-null values overwrite previous ones", () => {
    const previous = normalizeIntent({ bidUsd: 0.2 });
    const next = normalizeIntent({ bidUsd: 0.5 });
    expect(mergeIntent(previous, next).bidUsd).toBe(0.5);
  });
});

describe("buildTaskTemplate", () => {
  it("confirmed campaign produces an object with openingPrompt present, not a plain string", () => {
    const intent = normalizeIntent({
      taskType: "open_text",
      payload: { prompt: "What do you actually look for when buying an NFT?" },
      goal: "Understand NFT purchase drivers",
      targetSignal: "Names concrete traits, projects, or past purchases",
      thinResponseExamples: ["art", "idk"],
    });
    const template = buildTaskTemplate(intent, "fallback");
    expect(typeof template).toBe("object");
    expect(template.openingPrompt).toBe("What do you actually look for when buying an NFT?");
    expect(template.goal).toBe("Understand NFT purchase drivers");
    expect(template.targetSignal).toBe("Names concrete traits, projects, or past purchases");
    expect(template.thinResponseExamples).toEqual(["art", "idk"]);
  });

  it("falls back to wrapping the raw text when the prompt is missing", () => {
    const template = buildTaskTemplate(normalizeIntent({}), "raw Kimi text");
    expect(template).toEqual({ openingPrompt: "raw Kimi text" });
  });

  it("normalizes goal/targetSignal/thinResponseExamples defensively", () => {
    const intent = normalizeIntent({ goal: 42, targetSignal: "  ", thinResponseExamples: ["ok", 7, ""] });
    expect(intent.goal).toBeNull();
    expect(intent.targetSignal).toBeNull();
    expect(intent.thinResponseExamples).toEqual(["ok"]);
  });
});

describe("parseBuyAgentResponse", () => {
  it("parses a valid {reply, intent} JSON response", () => {
    const result = parseBuyAgentResponse(
      JSON.stringify({ reply: "Got it, what's your budget?", intent: { quantity: 20 } }),
    );
    expect(result.reply).toBe("Got it, what's your budget?");
    expect(result.intent.quantity).toBe(20);
  });

  it("defaults reply text when missing", () => {
    const result = parseBuyAgentResponse(JSON.stringify({ intent: {} }));
    expect(result.reply).toBe("Got it.");
  });
});

describe("interpretAdvertiserMessage", () => {
  it("calls callKimi with the system prompt, live context, and history, and parses the result", async () => {
    const { callKimi } = await import("./scoring.js");
    vi.mocked(callKimi).mockResolvedValueOnce(
      JSON.stringify({ reply: "Sounds good!", intent: { groupId: 3 } }),
    );

    const result = await interpretAdvertiserMessage(
      [{ role: "user", content: "I want group 3" }],
      "LIVE CANVAS DATA...",
      "archetype",
    );

    expect(result.reply).toBe("Sounds good!");
    expect(result.intent.groupId).toBe(3);

    const callArgs = vi.mocked(callKimi).mock.calls[0]!;
    const messages = callArgs[0];
    expect(messages[0]).toEqual({ role: "system", content: expect.stringContaining("Canvas Protocol buy agent") });
    expect(messages[1]).toEqual({ role: "system", content: "LIVE CANVAS DATA..." });
    expect(messages[2]).toEqual({ role: "system", content: expect.stringContaining('"archetype" design phase') });
    expect(messages[3]).toEqual({ role: "user", content: "I want group 3" });
  });

  it("throws when callKimi fails so the caller can show a retry message", async () => {
    const { callKimi } = await import("./scoring.js");
    vi.mocked(callKimi).mockRejectedValueOnce(new Error("Kimi HTTP 500"));

    await expect(interpretAdvertiserMessage([], "LIVE CANVAS DATA...")).rejects.toThrow();
  });
});

const SIM = {
  opener: "What was the most confusing part of your first DEX trade?",
  thinResponse: "gas fees",
  probe: "What specifically about gas fees tripped you up?",
  goodResponse: "I approved USDC twice on Uniswap because the first tx looked stuck — cost me $30 extra.",
};

describe("archetype phase flow", () => {
  it("starts in goal phase and advances to archetype once a goal is stated", () => {
    expect(derivePhase(emptyIntent())).toBe("goal");
    const afterGoal = mergeIntent(emptyIntent(), normalizeIntent({ goal: "Understand DEX friction" }));
    expect(derivePhase(afterGoal)).toBe("archetype");
  });

  it("advances to simulation when the advertiser selects an archetype", () => {
    const withGoal = normalizeIntent({ goal: "Understand DEX friction" });
    // Kimi recommends archetypes in phase 2; the advertiser picks product_feedback.
    const picked = mergeIntent(withGoal, normalizeIntent({ selectedArchetypeId: "product_feedback" }));
    expect(derivePhase(picked)).toBe("simulation");
  });

  it("rejects an archetype id not in the library", () => {
    expect(normalizeIntent({ selectedArchetypeId: "made_up" }).selectedArchetypeId).toBeNull();
    for (const a of CAPTCHA_ARCHETYPES) {
      expect(normalizeIntent({ selectedArchetypeId: a.id }).selectedArchetypeId).toBe(a.id);
    }
  });

  it("phase context message names the current phase", () => {
    expect(buildPhaseContextMessage("simulation")).toContain('"simulation"');
  });
});

describe("simulation phase flow", () => {
  it("stores a generated simulation and stays in simulation phase for iteration", () => {
    const base = normalizeIntent({ goal: "g", selectedArchetypeId: "product_feedback" });
    const withSim = mergeIntent(base, normalizeIntent({ simulation: SIM }));
    expect(withSim.simulation).toEqual(SIM);
    expect(derivePhase(withSim)).toBe("simulation");
  });

  it("a regenerated simulation replaces the previous one on iteration", () => {
    const first = mergeIntent(emptyIntent(), normalizeIntent({ goal: "g", selectedArchetypeId: "product_feedback", simulation: SIM }));
    const revised = { ...SIM, opener: "What's the hardest part of bridging for you?" };
    const second = mergeIntent(first, normalizeIntent({ simulation: revised }));
    expect(second.simulation?.opener).toBe("What's the hardest part of bridging for you?");
    expect(derivePhase(second)).toBe("simulation");
  });

  it("a partial simulation object is rejected rather than stored half-formed", () => {
    const intent = normalizeIntent({ simulation: { opener: "q", thinResponse: "meh" } });
    expect(intent.simulation).toBeNull();
  });

  it("advertiser confirmation advances to confirmed and the brief uses simulation thin responses", () => {
    const inSim = mergeIntent(emptyIntent(), normalizeIntent({ goal: "Understand DEX friction", selectedArchetypeId: "product_feedback", simulation: SIM }));
    const confirmed = mergeIntent(
      inSim,
      normalizeIntent({ designConfirmed: true, payload: { prompt: SIM.opener }, targetSignal: "specific first-hand friction" }),
    );
    expect(derivePhase(confirmed)).toBe("confirmed");

    const brief = buildTaskTemplate(confirmed, "fallback");
    expect(brief.openingPrompt).toBe(SIM.opener);
    expect(brief.thinResponseExamples).toEqual([SIM.thinResponse]);
    expect(brief.goal).toBe("Understand DEX friction");
  });

  it("falls back to the simulation opener when no payload prompt was set", () => {
    const intent = normalizeIntent({ simulation: SIM, designConfirmed: true });
    expect(buildTaskTemplate(intent, "fallback").openingPrompt).toBe(SIM.opener);
  });

  it("explicit thinResponseExamples take precedence over the simulation's", () => {
    const intent = normalizeIntent({ payload: { prompt: "q" }, simulation: SIM, thinResponseExamples: ["idk"] });
    expect(buildTaskTemplate(intent, "f").thinResponseExamples).toEqual(["idk"]);
  });
});

describe("malformed Kimi JSON at any phase", () => {
  it("throws on non-JSON so the caller retries without touching session intent", async () => {
    const { callKimi } = await import("./scoring.js");
    vi.mocked(callKimi).mockResolvedValueOnce("Sure! Here are some options...");

    const before = mergeIntent(emptyIntent(), normalizeIntent({ goal: "g", selectedArchetypeId: "code_review" }));
    await expect(interpretAdvertiserMessage([], "LIVE", derivePhase(before))).rejects.toThrow();
    // The caller only merges on success, so the pre-turn intent/phase are untouched.
    expect(derivePhase(before)).toBe("simulation");
  });

  it("garbage field types inside valid JSON degrade to nulls, never corrupt phase state", () => {
    const intent = normalizeIntent({ designConfirmed: "yes", selectedArchetypeId: 7, simulation: "a chat" });
    expect(intent.designConfirmed).toBe(false);
    expect(intent.selectedArchetypeId).toBeNull();
    expect(intent.simulation).toBeNull();
    expect(derivePhase(intent)).toBe("goal");
  });
});
