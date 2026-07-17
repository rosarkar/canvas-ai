import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { registerGroup } from "@/adapters/groups.adapter.js";
import {
  endRegisterSession,
  handleRegisterMessage,
  hasActiveRegisterSession,
  mergeRegisterFields,
  parseRegisterResponse,
  startRegisterSession,
  validateGroupLink,
  validatePrice,
  validateWallet,
} from "./register-assistant.js";
import { callKimi } from "./scoring.js";

vi.mock("./scoring.js", () => ({
  callKimi: vi.fn(),
}));

vi.mock("@/adapters/groups.adapter.js", () => ({
  registerGroup: vi.fn(),
}));

// logger transitively requires the full .env config — stub it out for unit tests.
vi.mock("@/utils/logger.js", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

const mockedCallKimi = vi.mocked(callKimi);
const mockedRegisterGroup = vi.mocked(registerGroup);

const USER_ID = 777;
const VALID_WALLET = "0x1234567890abcdef1234567890abcdef12345678";
const resolveGroup = vi.fn(async () => ({ tgGroupId: -100123n, title: "Base Yield Farmers" }));

function kimiReply(fields: Record<string, unknown>, reply = "Noted!", readyToConfirm = false): string {
  return JSON.stringify({ reply, extractedFields: fields, readyToConfirm });
}

beforeEach(() => {
  mockedCallKimi.mockReset();
  mockedRegisterGroup.mockReset();
  resolveGroup.mockClear();
  endRegisterSession(USER_ID);
});

describe("field validation", () => {
  it("accepts t.me and @ group links, rejects others", () => {
    expect(validateGroupLink("t.me/basefarmers")).toBe("t.me/basefarmers");
    expect(validateGroupLink("https://t.me/basefarmers")).toBe("https://t.me/basefarmers");
    expect(validateGroupLink("@basefarmers")).toBe("@basefarmers");
    expect(validateGroupLink("discord.gg/whatever")).toBeNull();
    expect(validateGroupLink("basefarmers")).toBeNull();
  });

  it("accepts only 42-char hex 0x wallets and lowercases them", () => {
    expect(validateWallet("0x1234567890ABCDEF1234567890abcdef12345678")).toBe(VALID_WALLET);
    expect(validateWallet("0x1234")).toBeNull();
    expect(validateWallet("1234567890abcdef1234567890abcdef12345678ab")).toBeNull();
    expect(validateWallet(`${VALID_WALLET}ff`)).toBeNull();
  });

  it("rejects prices below $0.10", () => {
    expect(validatePrice(0.1)).toBe(0.1);
    expect(validatePrice(0.5)).toBe(0.5);
    expect(validatePrice(0.05)).toBeNull();
    expect(validatePrice("0.10")).toBeNull();
  });
});

describe("parseRegisterResponse", () => {
  it("nulls invalid extracted fields and reports them as rejected", () => {
    const parsed = parseRegisterResponse(
      kimiReply({ payoutWallet: "0xdeadbeef", pricePerVerification: 0.02, groupLink: "@ok" }),
    );
    expect(parsed.fields.payoutWallet).toBeNull();
    expect(parsed.fields.pricePerVerification).toBeNull();
    expect(parsed.fields.groupLink).toBe("@ok");
    expect(parsed.rejected).toEqual(expect.arrayContaining(["wallet", "price"]));
  });

  it("merges without losing previously stated fields", () => {
    const merged = mergeRegisterFields(
      { groupLink: "@ok", groupTopic: null, payoutWallet: VALID_WALLET, pricePerVerification: null },
      { groupLink: null, groupTopic: "DeFi yield", payoutWallet: null, pricePerVerification: 0.25 },
    );
    expect(merged).toEqual({
      groupLink: "@ok",
      groupTopic: "DeFi yield",
      payoutWallet: VALID_WALLET,
      pricePerVerification: 0.25,
    });
  });
});

describe("session idle expiry (30 min TTL)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-17T12:00:00Z"));
    endRegisterSession(USER_ID);
    startRegisterSession(USER_ID);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("session active within 30 minutes routes correctly", async () => {
    vi.advanceTimersByTime(29 * 60_000);
    expect(hasActiveRegisterSession(USER_ID)).toBe(true);

    mockedCallKimi.mockResolvedValueOnce(kimiReply({ groupLink: "@basefarmers" }));
    const turn = await handleRegisterMessage(USER_ID, "group is @basefarmers", resolveGroup);
    expect(turn.isComplete).toBe(false);
    expect(mockedCallKimi).toHaveBeenCalledTimes(1);
  });

  it("session idle for more than 30 minutes expires silently so messages fall through", () => {
    vi.advanceTimersByTime(31 * 60_000);
    // message.ts gates routing on this check — false means the text falls through
    // to the next handler exactly as if no session had ever existed.
    expect(hasActiveRegisterSession(USER_ID)).toBe(false);
    // Expiry deleted the entry; the check stays false on repeat lookups.
    expect(hasActiveRegisterSession(USER_ID)).toBe(false);
  });

  it("activity timestamp resets on each message", async () => {
    vi.advanceTimersByTime(20 * 60_000);
    mockedCallKimi.mockResolvedValueOnce(kimiReply({ groupLink: "@basefarmers" }));
    await handleRegisterMessage(USER_ID, "group is @basefarmers", resolveGroup);

    // 45 min since session start, but only 25 min since last activity — still live.
    vi.advanceTimersByTime(25 * 60_000);
    expect(hasActiveRegisterSession(USER_ID)).toBe(true);

    // 31 min after the last message it finally expires.
    vi.advanceTimersByTime(6 * 60_000);
    expect(hasActiveRegisterSession(USER_ID)).toBe(false);
  });
});

describe("handleRegisterMessage", () => {
  it("happy path: collects fields across turns, confirm fires the registration write", async () => {
    startRegisterSession(USER_ID);

    mockedCallKimi.mockResolvedValueOnce(
      kimiReply({ groupLink: "t.me/basefarmers", groupTopic: "Base DeFi yield strategies" }),
    );
    let turn = await handleRegisterMessage(
      USER_ID,
      "My group is t.me/basefarmers, it's about Base DeFi yield",
      resolveGroup,
    );
    expect(turn.isComplete).toBe(false);

    mockedCallKimi.mockResolvedValueOnce(
      kimiReply(
        {
          groupLink: "t.me/basefarmers",
          groupTopic: "Base DeFi yield strategies",
          payoutWallet: VALID_WALLET,
          pricePerVerification: 0.25,
        },
        "All set — confirm?",
        true,
      ),
    );
    turn = await handleRegisterMessage(USER_ID, `Wallet ${VALID_WALLET}, price $0.25`, resolveGroup);
    expect(turn.isComplete).toBe(false);
    expect(turn.reply).toContain("confirm");
    expect(mockedRegisterGroup).not.toHaveBeenCalled();

    mockedRegisterGroup.mockResolvedValueOnce({ groupId: 42 } as never);
    turn = await handleRegisterMessage(USER_ID, "confirm", resolveGroup);

    expect(turn.isComplete).toBe(true);
    expect(turn.registeredGroupId).toBe(42);
    expect(turn.reply).toContain("Your group is registered");
    expect(turn.reply).toContain("t.me/basefarmers");
    expect(mockedRegisterGroup).toHaveBeenCalledWith(
      expect.objectContaining({
        tgGroupId: -100123n,
        ownerWallet: VALID_WALLET,
        ownerTgId: BigInt(USER_ID),
        verificationTaskText: "Base DeFi yield strategies",
        minPriceMicro: 250_000n,
      }),
    );
    expect(hasActiveRegisterSession(USER_ID)).toBe(false);
  });

  it("rejects an invalid wallet in TypeScript and asks for a correction", async () => {
    startRegisterSession(USER_ID);
    mockedCallKimi.mockResolvedValueOnce(kimiReply({ payoutWallet: "0xnotawallet" }));

    const turn = await handleRegisterMessage(USER_ID, "my wallet is 0xnotawallet", resolveGroup);

    expect(turn.isComplete).toBe(false);
    expect(turn.reply).toContain("42-character 0x address");

    // Confirm still blocked: the invalid wallet was never stored.
    const confirmTurn = await handleRegisterMessage(USER_ID, "confirm", resolveGroup);
    expect(confirmTurn.isComplete).toBe(false);
    expect(mockedRegisterGroup).not.toHaveBeenCalled();
  });

  it("rejects a price below $0.10 in TypeScript", async () => {
    startRegisterSession(USER_ID);
    mockedCallKimi.mockResolvedValueOnce(kimiReply({ pricePerVerification: 0.05 }));

    const turn = await handleRegisterMessage(USER_ID, "I want $0.05 per verification", resolveGroup);

    expect(turn.isComplete).toBe(false);
    expect(turn.reply).toContain("$0.10");
    expect(mockedRegisterGroup).not.toHaveBeenCalled();
  });

  it("malformed Kimi JSON: graceful fallback, session state not corrupted", async () => {
    startRegisterSession(USER_ID);

    mockedCallKimi.mockResolvedValueOnce(kimiReply({ groupLink: "@basefarmers" }));
    await handleRegisterMessage(USER_ID, "group is @basefarmers", resolveGroup);

    mockedCallKimi.mockResolvedValueOnce("Sure! Here's what I collected so far: ...");
    const badTurn = await handleRegisterMessage(USER_ID, "wallet next", resolveGroup);
    expect(badTurn.isComplete).toBe(false);
    expect(badTurn.reply).toContain("try sending that again");

    // Session survives and previously collected fields are intact — the confirm
    // path still knows the group link is set but the rest is missing.
    expect(hasActiveRegisterSession(USER_ID)).toBe(true);
    const confirmTurn = await handleRegisterMessage(USER_ID, "confirm", resolveGroup);
    expect(confirmTurn.reply).not.toContain("your group link");
    expect(confirmTurn.reply).toContain("wallet");
    expect(mockedRegisterGroup).not.toHaveBeenCalled();
  });

  it("does not register when the group link cannot be resolved", async () => {
    startRegisterSession(USER_ID);
    mockedCallKimi.mockResolvedValueOnce(
      kimiReply(
        {
          groupLink: "t.me/+privatehash",
          groupTopic: "topic",
          payoutWallet: VALID_WALLET,
          pricePerVerification: 0.1,
        },
        "Confirm?",
        true,
      ),
    );
    await handleRegisterMessage(USER_ID, "everything at once", resolveGroup);

    resolveGroup.mockResolvedValueOnce(null as never);
    const turn = await handleRegisterMessage(USER_ID, "yes", resolveGroup);

    expect(turn.isComplete).toBe(false);
    expect(turn.reply).toContain("couldn't find that group");
    expect(mockedRegisterGroup).not.toHaveBeenCalled();
    expect(hasActiveRegisterSession(USER_ID)).toBe(true);
  });
});
