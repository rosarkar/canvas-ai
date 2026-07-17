# Canvas Protocol — Build Log
**Last updated:** July 7, 2026  
**Repo:** `rosarkar/canvas-ai` · **Branch:** `main` (auto-deploys to Railway)  
**Infrastructure:** Railway — Rohit's workspace (canvas-ai + Postgres, `canvas-ai-production-eae7.up.railway.app`) · Base mainnet · `@CanvasVerificationBot`  
**Smart contract:** `CanvasEscrowV0.sol` at `0xf808b264E13Bf809C8e86afaF4e14c200931101E` (verified on Basescan; relayer `0xbD5f…56d9`; includes the first-depositor guard)  
**Deprecated:** `fweekshow/canvas-ai` repo, Mateo's-workspace Railway (suspended), escrows `0x262a…5890` (partial bytecode) and `0x13aA…561B` (pre-guard, 0 balance)

---

## Changelog

### July 17, 2026 — audience tagging phase in conversational /register
- After the four core fields are confirmed and `registerGroup` fires, the register-assistant session continues into a Kimi-driven tagging phase (2–3 natural turns, capped at 3 agent turns) collecting audience signals for advertiser targeting: free-form `categories` (Canvas groups are any interest community — food, fashion, fitness, gaming, local, not just crypto; no fixed list), a Kimi-written `audienceDescription` sentence, `primaryLanguage` (ISO 639-1), `activityLevel` (the only constrained field — high/medium/low, one re-ask on an invalid value then null accepted), and `estimatedMonthlyJoins`. Kimi infers what it can from the link/topic and only asks the rest.
- Stored in new `groups.group_tags` JSONB (default `{}`) — `migrations/2026-07-17-group-tags.sql` + idempotent equivalent in `schema.ts`; partial objects are stored as-is and tagging never blocks registration (Kimi failure or malformed JSON at any tagging turn completes the registration gracefully with whatever was collected).
- `GroupRow.groupTags` exposed via `mapGroup`, so every group query (including the buy flow's `listActiveGroups`) carries the tags; new `updateGroupTags` adapter write. 5 new tests (62 passing).

### July 17, 2026 — 30-minute idle TTL on in-memory sessions
- Buy-agent and register-assistant session Maps now store `lastActivityAt`; entries idle >30 min are deleted lazily at lookup time (`getLiveSession` in `buy-agent.ts` / `register-assistant.ts`) — no background sweep. `hasActiveBuyAgentSession` / `hasActiveRegisterSession` perform the expiry, so `message.ts` routing falls through to verification exactly as if no session existed. Timestamp refreshes on every message that touches the session. Closes the "stale session suppresses verification replies" Must Fix item. 3 new TTL tests (57 passing); the buy-agent Map shares the identical pattern, unit-tested via register-assistant.

### July 17, 2026 — Conversational captcha flow

**New services**
- captcha-agent.ts — multi-turn Kimi conversation agent for end-user verification. Generates opening question from advertiser brief, probes thin responses, closes after 2–4 turns, sends full transcript to Kimi scorer. Hard cap of 3 agent turns enforced in code, not just prompt. Fails closed on any parse error or Kimi failure.
- register-assistant.ts — Kimi-powered conversational registration flow for group owners. Collects group link, topic, payout wallet, and price per verification across multiple turns. TypeScript validates all fields. Fires DB write only on explicit confirmation.

**Schema changes**
- verifications: added conversation_history JSONB DEFAULT '[]' and conversation_turn INT DEFAULT 0
- advertiser_budgets: added task_template JSONB column alongside existing task_text. task_template stores structured brief (goal, targetSignal, openingPrompt, thinResponseExamples) produced by buy-assistant at campaign creation. task_text preserved for all legacy consumers.
- groups: added min_price_micro BIGINT column for price per verification set during registration

**Updated flows**
- begin-verification.ts: opens every join with a Kimi-generated question from the advertiser brief. Falls back to legacy static task DM if agent fails on first turn, so no joins are blocked.
- process-text-response.ts: conversational rows (conversation_turn > 0) route through multi-turn handler. Legacy rows (conversation_turn = 0) unchanged.
- buy-assistant.ts: final task design step now produces structured JSONB brief with goal, targetSignal, openingPrompt, and thinResponseExamples instead of plain string.
- message.ts: routing priority is buy session → register session → active verification → register assistant continuation. Verification takes strict priority over registration.

**Defensive hardening**
- Non-text messages (photo, sticker, voice, file) during active verification reply with guidance instead of silently failing
- Whitespace-only replies rejected before reaching Kimi
- Empty advertiser brief substitutes generic fallback question
- Failed opening DM (user has DMs disabled) now posts a deep-link verify button in the group chat instead of leaving the user muted with no path forward
- Empty Kimi closing message substituted with neutral fallback before scoring begins
- Deleted group or cancelled campaign mid-conversation fails closed with clear message
- Completed verification users (PASSED/ADMITTED) receive acknowledgement instead of silence

**Test count: 54 passing**

---

## Known Issues

### Must fix before permissionless launch

- **In-memory session TTL missing — ✅ RESOLVED (July 17)** — 30-minute lazy idle expiry added to the buy-agent and register-assistant session Maps (the Maps live in `buy-agent.ts` and `register-assistant.ts`; `register.ts` only holds the wallet/rules prompt maps). Checked at lookup time, no background sweep. See the July 17 TTL changelog entry.

### Known gaps (not blocking)

- Concurrent join shadowing — if a user joins two groups in quick succession, DM replies route to the most recent verification. The older verification becomes reachable again after the newer one closes or expires. Fixing this would require group disambiguation in DMs, which requires UX design.
- No abandonment flow for /buy — a user who confirms a campaign but never funds escrow has a campaign row that stays open. No timeout or expiry currently exists.

---

### July 17, 2026 — demo-hardening audit (edge-case DM handling)
- Non-text DMs (photo/sticker/voice/file) and whitespace-only replies during an active verification now get a plain text nudge instead of silence; neither reaches Kimi (`message.ts`).
- Group deleted mid-verification fails closed with "This verification is no longer active." instead of silently dropping the reply.
- Already-verified users (PASSED/ADMITTED, new `hasAnyCompletedVerification`) who DM the bot with no active flow get "You're already verified" instead of silence.
- Conversational close now sends the agent's closing line — previously dropped — or a neutral "one moment while we verify" fallback before scoring (`process-text-response.ts`).
- Open-join users whose opening DM fails (DMs disabled) get a deep-link "Verify to join →" button posted in the group — previously muted with no path forward (`begin-verification.ts`).
- captcha-agent falls back to a generic experience question if the advertiser brief is ever empty.
- Audited as already-correct: edited_message updates are ignored (no handler registered), legacy `conversation_turn = 0` rows route through the single-shot path, and every Telegram mute/unmute/kick call is try/caught + logged.

### July 17, 2026 — enriched task_template brief for the captcha agent
- Buy agent now produces a structured task-design brief — `{goal, targetSignal, openingPrompt, thinResponseExamples}` — stored in new JSONB column `advertiser_budgets.task_template` (`migrations/2026-07-17-task-template-jsonb.sql`; the spec's "campaigns" table is advertiser_budgets here). `task_text` intentionally stays TEXT: it is read as a plain string in 8 call sites, so the enriched object got its own column instead of a type conversion; legacy rows (NULL) fall back to task_text unchanged.
- TS-validated in `buildTaskTemplate()` (buy-assistant.ts): openingPrompt required, else falls back to `{openingPrompt: <raw text>}`.
- captcha-agent's `advertiserBrief` stays `string`; it internally JSON.parses and, when structured fields are present, feeds them to the model as labeled context (goal / good-response shape / suggested opening to vary / probe-trigger examples) instead of a raw blob.
- The verification task payload keeps a human-readable `prompt` (scorer + resend-DM fallback) alongside the serialized `brief` used on later agent turns.

### July 17, 2026 — conversational /register (Kimi-powered owner onboarding)
- DM `/register` (which previously just printed instructions) now runs a Kimi-driven conversation via new `src/services/register-assistant.ts` (tested in `register-assistant.test.ts`), collecting group link, topic, Base payout wallet, and price per verification in any order. In-group `/register` and auto-registration are unchanged.
- All validation is TypeScript-side (Kimi only extracts): link must be `t.me/`/`@`, wallet must be a 42-char 0x hex address, price ≥ $0.10. The `registerGroup` write fires only on an explicit "confirm"/"yes" with all four fields valid; malformed Kimi JSON gets a retry reply without advancing session state.
- Group links resolve to a real chat id via `getChat` (`buildResolveGroupFn` in `register.ts`); unresolvable/private-hash links fall back to the in-group `/register` instruction.
- New `groups.min_price_micro` column (owner-stated price, USDC microunits) — `migrations/2026-07-17-group-min-price.sql` + idempotent equivalent in `schema.ts`.
- DM routing in `message.ts`: verification replies keep priority; only when no active verification claims the text does an open registration session receive it.

### July 17, 2026 — conversational captcha (multi-turn dialogue agent)
- Single-shot captcha replaced with a multi-turn conversation: a dialogue agent (new `src/services/captcha-agent.ts`, tested in `captcha-agent.test.ts`) drives the DM exchange; the Kimi quality gate is unchanged and scores the full transcript at close.
- Agent opens with a natural question generated from the advertiser brief (template prompt → campaign task_text → group topic fallback), probes once or twice on vague/thin/pattern-like answers, and is hard-capped at 3 agent turns. JSON parse failures fail closed.
- New `verifications` columns: `conversation_history` JSONB (full agent/user log) and `conversation_turn` INT — `migrations/2026-07-17-conversational-captcha.sql` for the live DB, idempotent equivalents in `schema.ts` for fresh DBs (migrations/ folder is new; schema.ts remains the boot-time mechanism).
- Flow: join handler (`begin-verification.ts`) stores the opening as turn 1 and DMs it (legacy static task DM is the fallback if the agent errors); the DM reply handler (`process-text-response.ts`) appends each user reply, increments the turn, and closes at turn ≥ 4 or when the agent says so — row stays in TASK_SENT/DEEP_LINK_SENT between probes. Scoring threshold, payout logic, and terminal states untouched.

### July 7, 2026 — UX audit fixes (commits 6ca18bf → 8d4d791)

A post-marathon audit of the seams between the day's new features surfaced four edge cases, all fixed and deployed:

- `6ca18bf` — **Timeout copy contradiction:** timeout DMs invited an immediate retry that the cooldown + 12h attempt limit would silently reject. Both messages now state the real 24-hour wait.
- `fad4324` — **Silent cooldown rejections:** all four rejection sites (both join entry paths × both reasons) now send a best-effort DM before the kick/decline — "you can try again in about N hours," computed from the last real attempt's terminal timestamp. DM failure never breaks the rejection.
- `60f9e3b` — **Kimi exhaustion punished the user:** exhausted scoring retries no longer route through the failure path (kick + "wrong answer" copy + 24h cooldown). New terminal state `SCORING_UNAVAILABLE` — honest "technical issue on our side" DM, no cooldown, and exempt from the 12h attempt window so the user can retry the moment scoring recovers. Admin alert notes the user was not penalized.
- `8d4d791` — **Withdraw stranded in-flight payouts:** `withdrawCampaign` now refuses (inside the withdraw transaction, after the row lock) while any verification sits in `BID_LOCK_STATES` against the campaign — draining escrow mid-verification left the group owner's payout to fail at the next batch. Advertiser sees "N member(s) mid-verification — try again in a few minutes."

State machine note: with `COOLDOWN_REJECTED` (rate-limit audit log) and `SCORING_UNAVAILABLE`, the verification state machine now has **17 states**; each new state's exemptions (cooldown, attempt window, sweeps) are documented at its definition in `verification-states.ts`.

---

### July 7, 2026 — remaining open items closed (commits f02b19a → a2e6897)

- `f02b19a` / `a2e6897` — **Verification rate limiting + rejection audit log:** one attempt per Telegram user **per group** per 12h, keyed `(tg_user_id, group_id)`, enforced at both join entry points after the active-verification resume check. Every turned-away join (24h failure cooldown or 12h attempt limit) now inserts a `COOLDOWN_REJECTED` row with `rejection_reason` (`group_cooldown_24h` | `attempt_limit_12h`) — invisible to sweeps/payouts, excluded from the window check so repeated knocking can't extend a lockout, and a ready-made signal source for Phase 2 abuse detection (per-group rejection pressure).
- `c9e6a5f` — **Kimi-outage scoring retry queue:** Kimi *errors* no longer fail users closed. The row parks in `SCORING` (user DM'd "no action needed"), a 60s sweep retries up to 4 times over ~10 min through the same CAS transitions, and only exhausted retries fail closed — with an admin alert. Genuine low scores never defer. Known tradeoff: the binary-task reasoning bonus only applies on immediate scoring.
- `a756d6d` — **Refund-wallet gate on the buy flow:** `/buy` and `/topup` require a linked wallet in `advertisers` before any funding flow starts (all refund paths pay that wallet via `releasePayout`). Live-DB audit: all real advertisers already linked; only `tg_id = 0` seed artifacts weren't.

---

### July 5–7, 2026 — deployment cutover, escrow redeploy, pending-items marathon

**Infrastructure cutover (July 5):**
- Repo moved to `rosarkar/canvas-ai` (standalone private repo, full history — not a GitHub fork, so it survives independently of the old repo). New Railway project in Rohit's workspace with its own Postgres; data migrated via `pg_dump --clean`; webhook cut over to `canvas-ai-production-eae7.up.railway.app`. Old service suspended, not deleted.
- All secrets rotated: `TELEGRAM_WEBHOOK_SECRET`, `DEPOSIT_URL_SECRET`, and the escrow relayer — `setRelayer` executed on-chain (tx `0x8f1401ef…c5620`), relayer is now `0xbD5f…56d9`, held only in the new Railway env. Bot token regen in BotFather still pending.

**Escrow redeploy (July 7, commit `634f654`):**
- Discovered the old deployed contract at `0x262a…5890` was a *partial* build — `creditDirectDeposit`, `totalHeld`, and `withdrawUnallocated` don't exist in its bytecode, so every Base Pay deposit would have been permanently stranded (uncreditable, unrecoverable). Base Pay UI was disabled (`ef30ea3`) until the fix.
- Full 7-function `CanvasEscrowV0.sol` deployed to `0x13aA343c3CEC62FA6ef9c454761Fb54eeE77561B` with relayer `0xbD5f…56d9` from block one. Verified on Basescan. `ESCROW_CONTRACT_ADDRESS` updated; Base Pay re-enabled.
- All pre-existing test campaigns marked `exhausted` (no on-chain backing on the new contract; no real funds involved).

**Pending-items marathon (July 7, commits `1a41b10` → `e7449c7`):**
- `1a41b10` — **Recovery sweeps + COOP header:** stuck-`PASSED` sweep (re-attempts rules DM after 2 min, `RULES_TIMED_OUT` on second failure); TTL sweep extended to `SCORING`/`RESPONSE_RECEIVED`; stuck-`processing` payout sweep (null `payout_tx_hash` → reset to `pending`, non-null → admin alert for manual review); `Cross-Origin-Opener-Policy: same-origin-allow-popups` on payment pages so Coinbase smart wallet works in Telegram's in-app browser.
- `6ccc5c9` — **Dashboard sign-in, `/api/groups`, persistent sessions:** both dashboards now connect-and-sign (`Canvas auth: <ts>` via Coinbase SDK) instead of pasting a wallet; new `/api/groups` endpoint (title, member count, top bid) feeds the Available Groups tab; dual-identity sessions persist in a new `user_sessions` table with write-through cache — Railway deploys no longer log users out mid-flow.
- `3a475f7` — **Group owner accept/decline gate:** funded campaigns land in `pending_approval`; owner gets an Accept/Decline DM; decline refunds the advertiser via `releasePayout` to their DB wallet; 48h auto-accept sweep; advertisers can withdraw while pending.
- `e7449c7` — **`campaignDepositor` dust-hijack fix (source only, NOT deployed):** first-depositor-wins guard in `depositBudget` and `creditDirectDeposit` + 3 Foundry regression tests (7/7 passing). The live contract at `0x13aA…561B` still has the overwrite — mitigated by the app-layer refund routing — until the next contract deploy.

---

### July 4, 2026 — third batch (commits 3c55f56 → 8956c82)

- `3c55f56` — **Admin DM alerts for silent failures:** new `src/services/admin-alerts.ts` (`sendAdminAlert` — never throws, no-op when unset) + `ADMIN_TELEGRAM_ID` env var (added to config and `.env.example`; must be set in Railway or alerts stay disabled). Alert sites: payout failures in the batch (insufficient escrow balance, owner-leg transfer failure, fee-leg failure), refund failures on withdraw (tx failure and no-wallet-linked), rules-pending sweep firings (one aggregated DM per sweep), and a watchdog for rows stuck in `processing` >6h at the start of each batch run. Plain text DMs with campaign #, group title, dollar amounts, truncated verification IDs. Hook comment left in `index.ts` for Mateo's future recovery sweep.
- `8956c82` — **Wallet signature verification on read endpoints:** `/api/advertiser` and `/api/group-owner` now require the caller to sign `Canvas auth: <epoch-ms>` with the queried wallet (`x-canvas-timestamp`/`x-canvas-signature` headers or `ts`/`sig` query params). Timestamp must be within 5 minutes (replay protection). Verification uses viem's public-client `verifyMessage` on Base RPC so both EOAs and Coinbase smart wallets (ERC-1271/6492) verify correctly. Bad signature → 401 with the expected message format; RPC outage → 503 (fail closed). New middleware in `src/api/wallet-auth.ts`.

---

### July 4, 2026 — second batch (commits 9494135 → 3ae77d9 → 915e475)

- `9494135` — **npm audit fix:** `ws` moved to 8.21.0, `viem` to 2.54.3, 0 production vulnerabilities. Low-severity esbuild advisory remains in dev dependencies only (Windows-only, does not ship to Railway).
- `3ae77d9` — **`registered_at` migration:** `ALTER TABLE groups ADD COLUMN IF NOT EXISTS registered_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP` added to boot migration block in `schema.ts`. Existing rows backfilled with migration timestamp, not true registration dates. New registrations get accurate timestamps from here.
- `915e475` — **`FOR UPDATE SKIP LOCKED` fix:** payout batch now uses a claim pattern — explicit transaction wraps the SELECT + claim UPDATE to `processing`, commits before on-chain transfers. Per-leg status writes stay individually committed. Crash strands rows in `processing` (unpaid, never double-paid). Per-leg "set processing" UPDATE removed. SELECT uses `FOR UPDATE OF v` to lock only verification rows, not joined `groups` rows.

---

### July 4, 2026 (session fixes, commits 88c838b → 950de19)

A Fable 5 repo audit surfaced six bugs not previously tracked. All six were fixed via Claude Code and pushed to main in two commits:

- `88c838b` — fix: compare-and-swap state transitions, payout batch fee leg separation, stuck-state comment for Mateo (Fixes 1, 3, 5)
- `950de19` — fix: scoring prompt injection and fail-closed, deposit monitor chunking, refund reroute away from contract (Fixes 2, 4, 6)

**Fix 1 (`verification.adapter.ts`):** `transitionState` now takes an optional `expectedState` and returns true/false. All three entry paths that reach payout accrual (DM text replies, Mini App completions, captcha button taps) now bail if 0 rows update — closes the double-payout race condition.

**Fix 2 (`scoring.ts`):** User response wrapped in `<user_response>` delimiters in the Kimi prompt to block prompt injection. Keyword fallback switched from substring to word-boundary regex. Dead `hits` variable removed. Kimi errors and unparseable JSON now fail closed for advertiser-funded verifications instead of falling through to the weak keyword fallback. Missing API key case left on keyword fallback deliberately (no-Kimi config mode).

**Fix 3 (`payout-batch.ts` + schema):** Added `fee_status` and `fee_tx_hash` columns via `ADD COLUMN IF NOT EXISTS` boot migration. Fee leg now writes only to its own columns; owner leg writes only to `payout_status`/`payout_tx_hash`. Balance check now covers owner + fee combined before either leg fires.

**Fix 4 (`deposit-monitor.ts`):** `getContractEvents` now chunks to 2,000 blocks per poll iteration, advancing the cursor per chunk. Prevents permanent wedge after extended downtime.

**Fix 5 (`process-text-response.ts`):** TODO comment added for Mateo at the SCORING transition point — TTL recovery sweep must cover `SCORING` and `RESPONSE_RECEIVED`, not just `DEEP_LINK_SENT` and `TASK_SENT`.

**Fix 6 (`campaigns.ts`):** Refund flow rerouted from `refundUnusedBudget` to `releasePayout(campaignId, advertiserWallet, amount)` using the advertiser wallet from DB. TODO comment added for Mateo flagging the `campaignDepositor` overwrite in `CanvasEscrowV0.sol` as a theft vector for V1.

---

### July 2, 2026 (evening)

**Fix: Kimi fallback URL corrected** (commit `23584ed` part 1)
- `src/config/config.ts` — hardcoded fallback for `KIMI_BASE_URL` changed from `"https://api.moonshot.cn/v1"` to `"https://api.moonshot.ai/v1"`
- Production was already correct via Railway env var but any new environment (local dev, staging, env reset) would have silently routed all Kimi calls to the wrong domain

**Fix: No-advertiser groups bypass Kimi** (commit `23584ed`)
- `src/telegram/services/process-text-response.ts` — `finalize()` now checks `verification.advertiserId == null` before calling Kimi
- If null, synthesizes `{ score: 100, method: "manual" }` and sets `passed = true` directly — no Kimi HTTP call made
- `src/telegram/services/captcha-dm.ts` — TODO comment removed (issue resolved)

### July 2, 2026 (afternoon)

**Group picker for multi-group owners**
- `/start` owner path now detects how many groups an owner has registered
- 1 group → proceeds directly to 5-button owner menu as before
- 2+ groups → shows inline keyboard listing each group by `group_title` with callback `select_group:{tg_group_id}`
- Selected group stored as `activeTgGroupId` in session Map
- Session Map type changed from `Map<number, 'owner' | 'advertiser'>` to `Map<number, { mode: 'owner' | 'advertiser', activeTgGroupId?: number }>`

**Scoped menu actions**
- All owner menu actions (Portal Link, My Stats, Edit Rules, Update Wallet) now call `resolveActiveGroup(fromId)` first and scope queries to `WHERE tg_group_id = $1` instead of iterating all groups for the owner
- If `activeTgGroupId` is missing from session (bot restart, session cleared), action re-shows group picker inline via `editMessageText`
- `updateGroupWallet` scoped to active group's `tg_group_id` rather than owner-wide wallet update

**6-button owner menu**
- Added "🔄 Switch group" button (clears `activeTgGroupId`, re-shows picker)
- "🔄 Switch mode" button retained for dual-identity users

**"Type /start to return to the main menu" footer**
- Added to every handler that sends a flow screen or multi-step prompt and has no natural back button
- Added in: `process-text-response.ts` (all 4 re-prompt constants), `captcha-callback.ts` (wrong answer message), `campaigns.ts` (campaigns list), `buy.ts` (all buy flow steps), `register.ts` (all registration steps), `menu.ts` (group picker and wallet prompt)
- Intentionally excluded from: success confirmations, the owner menu itself, the mode selector, admission rules DM (has "I agree ✓" exit), timeout notifications, all group chat messages

**Database cleanup**
- Old test groups deactivated: `UPDATE groups SET is_active = false WHERE group_id IN (5, 8, 12);`
- Canvas / Bankr (group_id 14) is now the only active group in the picker

---

### June 30, 2026

**Verification UX**
- Rewrote initial DM copy for `OPEN_TEXT` tasks — warmer opener explaining Canvas, removed "quick verification" header and "In one sentence" constraint
- Removed pre-task `RULES_SENT` gate — captcha is now the first message a joining user sees
- Post-verification rules gate added: after Kimi pass, user sees group rules + "I agree ✓" inline button; unmuted and admitted only after tapping
- New states: `RULES_PENDING` (10-min TTL), `ADMITTED` (terminal), `RULES_TIMED_OUT`
- `RULES_PENDING` timeout sweep added to existing 60s TTL loop
- Fixed critical bug: `state = 'PASSED'` was hardcoded as terminal in `payout-batch.ts` and two stats queries — all three now match any post-pass state so group owner payouts don't silently break

**Group rules**
- Replaced Kimi multi-turn rules drafting flow (`rules-setup.ts`, `rules-assistant.ts`, `/rules` command) with simple send-or-skip prompt at end of `/register`
- Rules stored in `groups.rules` JSONB column
- Post-verification rules message reads from `groups.rules`; falls back to three hardcoded defaults if null/empty
- Rules editable anytime via `/menu` → Edit Rules

**Registration flow — moved to DM**
- All registration confirmation messages now sent to group owner via DM only
- Group chat receives one public line: `✅ [group name] is now verified by Canvas. New members will be asked to complete a quick verification before joining.`
- Group chat also sends a notification tagging the owner to check their DM
- `/wallet` command now DM-only; redirects to DM if run in group chat

**Owner menu**
- `/menu` command (DM-only) with 5-button inline keyboard: 📊 My Stats / 🔗 Portal Link / ✏️ Edit Rules / 💰 Update Wallet / ❓ Help
- My Stats: weekly verifications, total pending earnings, top active bid
- Portal Link: resends group invite link
- Edit Rules: reuses registration rules-save flow
- Update Wallet: prompts for new address, writes to `groups.wallet`
- Help: sends command list

**Dual-identity routing**
- `/start` detects if user is both a group owner and an advertiser
- Single-identity users go straight to their menu
- Dual-identity users see mode selector: "🏘️ Manage my groups / 📢 Run campaigns"
- Mode stored in session Map; "🔄 Switch mode" button in both menus

---

### June 28, 2026 (Mateo commits e43a039 → 644a5f3)

- `CanvasEscrowV0.sol` deployed on Base mainnet — deposit, payout, refund functions
- `/buy` flow switched from Kimi conversational agent back to guided button flow (reverses `d901fba`)
- Base Pay credit timing fix + orphaned USDC recovery
- Top-up flow for existing campaigns
- Withdraw/refund surfaced as inline buttons on `/start` and `/campaigns`

---

### June 25, 2026

- Kimi API endpoint corrected: `api.moonshot.cn` → `api.moonshot.ai/v1`
- `callKimi` extracted as shared client in `scoring.ts`, reused by scoring and rules assistant
- `KIMI_BASE_URL` added to Railway environment variables
- `BUILD_PLAN.md` created at repo root

---

### June 7, 2026 (Phase 1 launch)

- Railway deployment live: `canvas-ai` service + Postgres, both Online
- Webhook live at `canvas-ai-production.up.railway.app/telegram/webhook`
- Kimi API key loaded in Railway as `KIMI_API_KEY` ($20 credits)
- Canvas Test group seeded (`tg_group_id -5145298837`)
- Join interception confirmed; `DEEP_LINK_SENT` state writing to Postgres

---

## Current State (as of July 2, 2026)

### Working
- Join interception and mute
- Conversational captcha via DM — dialogue agent opens from the advertiser brief, probes thin answers (max 3 agent turns), transcript scored at close (July 17, 2026; legacy static task DM is the fallback path)
- Kimi scoring of responses (with no-advertiser bypass) — now scores the full conversation transcript
- Re-prompt on thin/short answers (legacy single-shot path; the dialogue agent handles this conversationally)
- Post-verification rules gate with "I agree ✓"
- USDC payout on verification pass
- Group owner DM menu (6 buttons, group-scoped)
- Group picker for multi-group owners
- Dual-identity mode selector
- Conversational /register in DM — Kimi collects link/topic/wallet/price, TS validates, explicit confirm gates the DB write (July 17, 2026; in-group /register unchanged)
- Advertiser buy flow (guided button flow)
- Campaigns list with withdraw/pause/resume/top-up
- `/start` escape hint on all flow screens

### Needs End-to-End Testing
- Full verification loop with a real non-admin account in Canvas / Bankr group
- Confirm USDC payout fires correctly on pass
- Confirm Kimi scoring works on a live response (first real test of Kimi connectivity)
- Confirm rules gate appears and "I agree ✓" admits user
- Confirm group picker routes correctly for multi-group owner

---

## Issues & Pending Work

### Mateo — Fix immediately (blocks live testing)

**`registered_at` not written on group insert — ✅ RESOLVED (July 4, commit `3ae77d9`)**
- Boot migration added; existing rows backfilled with migration timestamp, new rows get accurate defaults.

---

**Stuck `PASSED` state — ✅ RESOLVED (July 7, commit `1a41b10`)**
- Recovery sweep in the 60s loop re-attempts `sendAdmissionRulesDm` for rows in `PASSED` > 2 min; second failure → `RULES_TIMED_OUT`, user left muted.

---

**TTL recovery sweep must also cover `SCORING` and `RESPONSE_RECEIVED` — ✅ RESOLVED (July 7, commit `1a41b10`)**
- Sweep now covers both states in addition to `DEEP_LINK_SENT`/`TASK_SENT`. (The `getMe`/`getChat` calls that stranded rows here were also removed from the hot path in `dc9e91a`.)

---

**Stuck-`processing` payout recovery sweep — ✅ RESOLVED (July 7, commit `1a41b10`)**
- Sweep resets stuck `processing` rows with null `payout_tx_hash` to `pending` (transfer never fired); non-null hashes trigger an admin alert for manual review instead of auto-retry.

---

### Mateo — Fix before approaching advertisers

**Dashboards need a connect-wallet-and-sign step — ✅ RESOLVED (July 7, commit `6ccc5c9`)**
- Both dashboards now connect the Coinbase smart wallet and sign `Canvas auth: <ts>`; signature cached in sessionStorage for the 5-min window.

---

**`campaignDepositor` overwrite in `CanvasEscrowV0.sol` — refund theft vector — ✅ RESOLVED (July 7, guard deployed)**
- First-depositor-wins guard (commit `e7449c7`, 7/7 Foundry tests) deployed to `0xf808b264E13Bf809C8e86afaF4e14c200931101E` (tx `0x1e0dee1b…1033e9`), verified on Basescan, relayer `0xbD5f…56d9` from block one. Pre-guard contract `0x13aA…561B` held 0 USDC at cutover — nothing migrated, left untouched.
- App-layer refund routing (`releasePayout` to the DB wallet) is **retained by choice**: it works on both contracts and keeps refund destinations under DB control. `refundUnusedBudget` now pays the immutable first depositor if ever needed.

---

**Basescan contract verification — ✅ RESOLVED for the live contract (July 7)**
- `0x13aA…561B` verified on Basescan (source + constructor args visible). The deprecated `0x262a…5890` was left unverified — its deployed bytecode doesn't match any source in the repo (partial build) and it holds no funds.

---

**Coinbase smart wallet fails in Telegram in-app browser — ✅ RESOLVED (July 7, commit `1a41b10`)**
- `Cross-Origin-Opener-Policy: same-origin-allow-popups` header added to the payment page responses (fix option 1).

---

**Advertiser accept/decline layer for group owners — ✅ RESOLVED (July 7, commit `3a475f7`)**
- Funded campaigns land in `pending_approval`; owner gets Accept/Decline DM with task preview; decline refunds via `releasePayout` to the advertiser's DB wallet; 48h auto-accept sweep in the 60s loop; advertisers can withdraw while pending. Bid-ladder auto-promote note retained for Phase 2.

---

**Rate limiting — ✅ RESOLVED (July 7, commits `f02b19a` + `a2e6897`)**
- Per-group 12h attempt limit keyed `(tg_user_id, group_id)`, queried straight off the `verifications` table (no new tracking table needed). All rejections logged as `COOLDOWN_REJECTED` rows with reasons. Final semantics per founder decision: turned away from group A ≠ blocked from group B.

---

**`/api/groups` endpoint — ✅ RESOLVED (July 7, commit `6ccc5c9`)**
- Live at `/api/groups`: group title, member count, top bid per registered active group. Public read (group directory is non-sensitive marketplace data — no per-wallet information).

---

### Known — Deferred (not blocking)

**Dual-identity session clears on bot restart — ✅ RESOLVED (July 7, commit `6ccc5c9`)**
- Sessions persist in a `user_sessions` table (write-through in-memory cache; DB blips degrade to old restart behavior). Deploys no longer log users out mid-flow.

---

**Read endpoints trust bare wallet strings — ✅ RESOLVED (July 4, commit `8956c82`)**
- Fixed via signed-message auth: caller signs `Canvas auth: <epoch-ms>` with the queried wallet, verified server-side through viem's public-client `verifyMessage` (EOA + Coinbase smart wallet support), 5-minute replay window. See the July 4 third-batch changelog entry. Frontend follow-up tracked under "Mateo — Fix before approaching advertisers" → "Dashboards need a connect-wallet-and-sign step".

---

**Kimi outage now fails advertiser-funded verifications closed — ✅ RESOLVED (July 7, commit `c9e6a5f`)**
- Scoring retry queue shipped: Kimi errors defer the row in `SCORING` and retry over ~10 min; only exhausted retries fail closed (admin alerted). See `src/services/scoring-retry.ts`.

---

**Withdraw dead-ends for advertisers with no linked wallet — ✅ RESOLVED (July 7, commit `a756d6d`)**
- `/buy` and `/topup` now require a linked refund wallet before any funding starts, so the dead end can no longer be reached by new campaigns. Existing advertisers audited: all real ones have wallets linked.

---

**`FOR UPDATE SKIP LOCKED` in payout-batch is a no-op — ✅ RESOLVED (July 4, commit `915e475`)**
- Fixed via claim pattern: explicit transaction wraps the SELECT + claim UPDATE to `processing`, committing before on-chain transfers so a crash can never roll paid rows back to `pending`. See the July 4 second-batch changelog entry.

---

## Planned Features

### Group owner abuse detection (Phase 2)
**Goal:** Detect group owners farming payouts with bot accounts and freeze payouts pending manual review.

**Red flags to score per group:**
- High verification volume in a short window relative to group member count
- Unusually high pass rate (near-100% is suspicious — legitimate groups expect some failures)
- Response similarity across verifications in the same group (bots submit near-identical answers)
- New accounts passing at high rates (no prior Telegram history detectable via join date)
- Verification attempts clustered in tight time intervals (e.g. 10 joins in 2 minutes)

**Proposed flow:**
1. After each verification batch, Kimi scores the group's aggregate response patterns against the red flag criteria above
2. If any threshold is exceeded, group owner payouts are frozen — funds remain in escrow, not released
3. Bot sends owner a DM: "Your payouts have been paused for review. Our team will be in touch within 48 hours."
4. Canvas team is notified (Telegram DM or email alert) to review manually
5. Team either clears the group (payouts resume) or confirms fraud (escrow refunded to advertiser, group deregistered)

**Schema additions needed:**
- `groups.payout_frozen` boolean, default false
- `groups.frozen_at` timestamp
- `groups.freeze_reason` text
- Payout batch query must check `payout_frozen = false` before releasing USDC

**Smart contract note:** Freeze enforced at agent server level (skip Step 2 call) — not at contract level. Adding a freeze function to `CanvasEscrowV0.sol` increases audit surface area before the contract is audited.

---

## Deferred

- Smart contract audit (unaudited, marked test-only in NatSpec — budget before public rollout)
- Re-verification cadence (Phase 2)
- Mod/admin payout splits (Phase 2)
- Token issuance decision (deferred until term sheet or funding clarity)
- Incorporation (deferred until term sheet or token decision)
- Mateo relocation to North America (deferred until Canvas has funding — Alliance DAO acceptance would require NYC)

---

## Founding Context (Archive)

### What Canvas Protocol Is

Canvas Protocol is a decentralized verification marketplace that replaces standard Telegram group join checks with meaningful sponsored captcha tasks.

**The one-sentence pitch:** Instead of solving a useless bot-check to join a Telegram group, you complete a short task sponsored by an advertiser or AI lab — the group owner gets paid in USDC, the advertiser gets a verified human completion with audience context, and the human gets access.

**Origin:** Rohit has been building this concept for several years. He presented an MVP at an EigenLayer + ETH Foundation hacker house in Buenos Aires during DevConnect 2024, where it was selected as one of five featured projects. The original design used EigenLayer for trust. The current iteration runs on Base.

---

### Team

**Rohit Sarkar** (@_rosark, Toronto) — product, GTM, copywriting, investor relations. Background in protocol research and content across InfStones, Figment, Caldera, and 0x (Content Manager Jan–Jun 2026, laid off June 5). Statistics education. Can code SQL/Python/R, comfortable in terminal. Now fully focused on Canvas.

**Mateo** (@0xteo, based in Asia) — smart contract development, backend infrastructure, complex state machine work. Builder of Basemate (Base Batches 002 alumnus). Introduced by Igor from the Bankr team. 50/50 equity split.

Canvas was started as a clean separate project from Basemate — new repo, new entity — so both founders have clean ownership with no cap table entanglement.

---

### Business Model

**Protocol fee:** Canvas takes 50% at launch, with a stated trajectory toward a smaller cut as volume scales. (Note: the original spec said 10–15%; the launch number is 50% as an interim marketplace rate while supply and demand are thin. This compresses over time — position as marketplace-comp trajectory when pitching.)

**Moat:** The group registry and quality verification layer. Canvas becomes the trust infrastructure that tells advertisers which groups are legitimate and which completions are genuine.

**Revenue math (Phase 3):** A group with 5,000 members re-verified monthly at $0.10 generates $500/month passively. Canvas keeps its protocol share. Scaled across thousands of groups this is significant recurring protocol revenue.

---

### Captcha Task Design

**Type 1 — RLHF training data (AI lab advertiser)**
Human ranks AI responses from most to least helpful, matched to group topic. A crypto-native human's ranking of DeFi responses is premium training data. Verified contextual humans vs. random Mechanical Turk annotators.

Example (crypto trading group, DeFi AI Lab):
> Rank these 3 responses from most to least helpful. Reply B, A, C.
> A — "To swap tokens, connect your wallet, select the pair, and confirm."
> B — "You need ETH for gas. Approve the token first, then swap. Check slippage."
> C — "Blockchain technology enables decentralised finance through trustless smart contracts."

**Type 2 — Agent acquisition (DeFi protocol advertiser)**
No wrong answer. Human engages with advertiser's product framing, gets offered an agent connection post-verification. Advertiser pays per verified DeFi-native lead, not per impression.

Example (Base DeFi Traders group, Aave):
> You have 10,000 USDC. What would you do?
> A — Supply to Aave at 4.2% APY and borrow against it
> B — Hold in cold wallet
> C — Bridge to another chain for higher yield
> Sponsored by Aave · no wrong answer

---

### Competitive Positioning

**vs. Google reCAPTCHA:** Google keeps all the value. Canvas pays publishers directly.

**vs. Basemate / Mateo's original PPH model:** Basemate has agents paying to reach humans, Basemate taking the fee, and humans receiving only an invite. The human is the product but doesn't get compensated. Canvas is transparent — humans opt in by completing a task, group owners earn directly, advertisers get verified completions not scraped signals.

**vs. Scale AI / Mechanical Turk:** Active opt-in labor markets. Canvas is ambient — humans are already joining a group, the captcha redirects that micro-attention toward valuable tasks. Lower friction, higher scale, better demographic coverage, cryptographically provable provenance.

**vs. World ID:** Proves you're human but generates no useful signal. Canvas combines proof of humanity with productive micro-tasks.

---

### Target Advertisers

**Tier 1 (warm, approach first):** Moonwell, Avantis, Bankr ecosystem agents  
**Tier 2:** Aave, Morpho, Across, Gauntlet  
**Tier 3 (longer sales cycles):** Nous Research, Sentient, Gensyn

**Target group supply side:** Lennox Cartel, Mfers, OCR. First group owner: Ant (gave permission for early testing).

---

### Funding Targets

Alliance DAO, Base Batches, Bankr. Traditional seed VCs deferred until live revenue milestones. Pitch frames Canvas as the foundational missing market — verified human attention priced onchain.

---

### Open Questions (Founding Session — most resolved)

- Equity split → resolved: 50/50
- Smart contract auditor before Phase 2 → deferred, budget before public rollout
- Minimum group size to prevent sybil groups → open
- Escrow lock period and refund trigger → open
- Task types in Phase 1 → resolved: open text, ranking, binary choice all live
- First AI labs to approach → resolved: Tier 1 = Moonwell, Avantis, Bankr agents
- Canvas token vs. USDC only → deferred until term sheet or funding clarity

---

### Key Environment Variables
- `KIMI_BASE_URL=https://api.moonshot.ai/v1`
- `KIMI_API_KEY` — in Railway
- `COMPANY_WALLET=0x199390C2C6Af11b8938c6fCd86208b370D43C61F`

### Key IDs
- Railway project (live, Rohit's workspace): `30c2e333-d2ac-40dc-b722-70c7209170c6`
- Railway project (deprecated, Mateo's workspace, suspended): `bef22e72-bab1-4682-8495-c534cddedf45`
- Canvas Test group: `tg_group_id -5145298837`
- Canvas / Bankr group: `tg_group_id -5501340634` (group_id 14, active)
- Bot: `@CanvasVerificationBot`
- Domain: `canvas-protocol.com` (Cloudflare + Vercel)

---

## Post-Launch TODOs (July 13 2026)

### 1. SCORING-state stranding sweep
If anything throws between a verification entering SCORING state and the final state transition, the row gets stuck in SCORING permanently with the user muted. The TTL sweep does not cover SCORING or RESPONSE_RECEIVED states. Fix: extend the TTL sweep in the existing recovery job to include both states, transitioning them to TIMED_OUT after a threshold (suggest 10 minutes). Reference: `src/telegram/services/process-text-response.ts:74`.

### 2. KIMI_MODEL missing from .env.example
`KIMI_MODEL` is read from env in `src/services/scoring.ts` and defaults to `moonshot-v1-8k` if absent, but it is not documented in `.env.example`. Add it with the default value and a comment explaining it controls the Kimi inference model used for response scoring.

### 3. campaignDepositor guard on V1 contract path
There is a known TODO at `src/telegram/handlers/campaigns.ts:338` flagging that the V1 contract path does not enforce the `campaignDepositor` guard. This is acceptable for the current whitelisted phase but must be resolved before going permissionless. Log it here as a pre-permissionless blocker.

---

*Canvas Protocol · BUILD.md · confidential*
