import { db } from "@/db.js";

/** Canvas v0.2 Postgres schema — see design doc matthewmeakin-unknown-design-20260531-224711.md */
export async function createCanvasTables(): Promise<void> {
  const client = await db.connect();
  try {
    await client.query(`
      CREATE EXTENSION IF NOT EXISTS pgcrypto;

      CREATE TABLE IF NOT EXISTS groups (
        group_id              SERIAL PRIMARY KEY,
        tg_group_id           BIGINT NOT NULL UNIQUE,
        owner_wallet          VARCHAR(42) NOT NULL,
        owner_tg_id           BIGINT NOT NULL,
        verification_task_text TEXT NOT NULL DEFAULT 'In one sentence: what do you use DeFi for?',
        is_active             BOOLEAN NOT NULL DEFAULT true,
        registered_at         TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS advertiser_budgets (
        advertiser_id         SERIAL PRIMARY KEY,
        group_id              INT NOT NULL REFERENCES groups(group_id),
        bid_per_verification  BIGINT NOT NULL,
        remaining_budget      BIGINT NOT NULL,
        task_text             TEXT,
        advertiser_tg_id      BIGINT,
        campaign_status       TEXT NOT NULL DEFAULT 'pending_deposit',
        outbid_notified       BOOLEAN NOT NULL DEFAULT false,
        expected_deposit_micro BIGINT,
        deposit_tx_hash       TEXT,
        deposit_confirmed_at  TIMESTAMPTZ,
        created_at            TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at            TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_advertiser_budgets_group_status
        ON advertiser_budgets(group_id, campaign_status);

      CREATE TABLE IF NOT EXISTS bid_log (
        log_id                SERIAL PRIMARY KEY,
        advertiser_id         INT NOT NULL REFERENCES advertiser_budgets(advertiser_id),
        group_id              INT NOT NULL REFERENCES groups(group_id),
        bid_amount            BIGINT NOT NULL,
        placed_at             TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS verifications (
        verification_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tg_user_id            BIGINT NOT NULL,
        group_id              INT NOT NULL REFERENCES groups(group_id),
        advertiser_id         INT REFERENCES advertiser_budgets(advertiser_id),
        state                 TEXT NOT NULL DEFAULT 'PENDING',
        locked_bid_price      BIGINT,
        kimi_score            INT,
        response_text         TEXT,
        attempt_count         INT NOT NULL DEFAULT 1,
        created_at            TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at            TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        expires_at            TIMESTAMPTZ
      );
      CREATE INDEX IF NOT EXISTS idx_verifications_user_group
        ON verifications(tg_user_id, group_id);
      CREATE INDEX IF NOT EXISTS idx_verifications_state
        ON verifications(state);

      CREATE TABLE IF NOT EXISTS user_cooldowns (
        tg_user_id            BIGINT NOT NULL,
        group_id              INT NOT NULL REFERENCES groups(group_id),
        cooldown_until        TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (tg_user_id, group_id)
      );

      ALTER TABLE verifications ADD COLUMN IF NOT EXISTS captcha_question_id TEXT;
      ALTER TABLE verifications ADD COLUMN IF NOT EXISTS captcha_correct_option TEXT;
      ALTER TABLE verifications ADD COLUMN IF NOT EXISTS entry_type TEXT NOT NULL DEFAULT 'open_join';
      ALTER TABLE verifications ADD COLUMN IF NOT EXISTS task_type TEXT;
      ALTER TABLE verifications ADD COLUMN IF NOT EXISTS task_payload JSONB;
      ALTER TABLE groups ADD COLUMN IF NOT EXISTS last_welcome_message_id BIGINT;
      ALTER TABLE groups ADD COLUMN IF NOT EXISTS portal_invite_link TEXT;
      ALTER TABLE groups ADD COLUMN IF NOT EXISTS group_title TEXT;
      ALTER TABLE groups ADD COLUMN IF NOT EXISTS rules JSONB NOT NULL DEFAULT '[]'::jsonb;
      -- Owner-stated price per verification (USDC microunits), collected by the
      -- conversational /register assistant.
      ALTER TABLE groups ADD COLUMN IF NOT EXISTS min_price_micro BIGINT;
      -- Structured audience signals from the /register tagging phase (free-form
      -- categories, audience description, language, activity, est. monthly joins).
      ALTER TABLE groups ADD COLUMN IF NOT EXISTS group_tags JSONB NOT NULL DEFAULT '{}'::jsonb;
      -- Owner accept/decline gate: when the approval request was DM'd to the group
      -- owner (campaigns auto-accept 48h after this timestamp).
      ALTER TABLE advertiser_budgets ADD COLUMN IF NOT EXISTS approval_requested_at TIMESTAMPTZ;
      -- Enriched task-design brief ({goal, targetSignal, openingPrompt,
      -- thinResponseExamples}) for the conversational captcha agent. task_text
      -- stays TEXT for its legacy string consumers.
      ALTER TABLE advertiser_budgets ADD COLUMN IF NOT EXISTS task_template JSONB;

      -- registered_at was defined inside CREATE TABLE IF NOT EXISTS, which Postgres skips
      -- when the table already exists — the live DB never got the column (BUILD.md issue).
      ALTER TABLE groups ADD COLUMN IF NOT EXISTS registered_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP;
      ALTER TABLE advertiser_budgets ADD COLUMN IF NOT EXISTS template_id INT;

      CREATE TABLE IF NOT EXISTS task_templates (
        template_id           SERIAL PRIMARY KEY,
        advertiser_tg_id      BIGINT,
        name                  TEXT NOT NULL,
        task_type             TEXT NOT NULL,
        payload               JSONB NOT NULL,
        preview_image_url     TEXT,
        created_at            TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at            TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      -- task_type used to be DB-enforced via CHECK, which meant a migration every time a new
      -- template type shipped. Validation now lives in createTemplate() against the TaskType
      -- union instead — drop the old constraint (best-effort; Postgres' default name for an
      -- unnamed single-column CHECK) so it doesn't block newer types like rank_reasoning.
      ALTER TABLE task_templates DROP CONSTRAINT IF EXISTS task_templates_task_type_check;

      CREATE TABLE IF NOT EXISTS advertisers (
        tg_id                 BIGINT PRIMARY KEY,
        wallet_address        VARCHAR(42) UNIQUE,
        created_at            TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS deposit_cursor (
        id                    INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
        last_block            BIGINT NOT NULL DEFAULT 0
      );
      INSERT INTO deposit_cursor (id, last_block) VALUES (1, 0) ON CONFLICT (id) DO NOTHING;

      ALTER TABLE advertiser_budgets DROP CONSTRAINT IF EXISTS advertiser_budgets_campaign_status_check;
      ALTER TABLE advertiser_budgets ADD CONSTRAINT advertiser_budgets_campaign_status_check
        CHECK (campaign_status IN ('active', 'paused', 'exhausted', 'expired', 'pending_deposit', 'pending_approval', 'withdrawn'));

      ALTER TABLE advertiser_budgets ADD COLUMN IF NOT EXISTS paused_at TIMESTAMPTZ;
      ALTER TABLE advertiser_budgets ADD COLUMN IF NOT EXISTS withdrawn_at TIMESTAMPTZ;
      ALTER TABLE advertiser_budgets ADD COLUMN IF NOT EXISTS refund_tx_hash TEXT;

      ALTER TABLE verifications ADD COLUMN IF NOT EXISTS payout_status TEXT;
      ALTER TABLE verifications ADD COLUMN IF NOT EXISTS payout_tx_hash TEXT;
      ALTER TABLE verifications ADD COLUMN IF NOT EXISTS payout_batch_id UUID;
      -- Platform-fee leg tracked separately from the owner leg so a fee transfer
      -- outcome can never overwrite payout_status (owner payout bookkeeping).
      ALTER TABLE verifications ADD COLUMN IF NOT EXISTS fee_status TEXT;
      ALTER TABLE verifications ADD COLUMN IF NOT EXISTS fee_tx_hash TEXT;
      -- Kimi-outage retry queue: attempts made by the scoring-retry sweep.
      ALTER TABLE verifications ADD COLUMN IF NOT EXISTS scoring_retries INT NOT NULL DEFAULT 0;
      -- Why a COOLDOWN_REJECTED row was logged: 'group_cooldown_24h' | 'attempt_limit_12h'.
      ALTER TABLE verifications ADD COLUMN IF NOT EXISTS rejection_reason TEXT;
      -- Conversational captcha: full agent/user message log + turn counter
      -- (turn increments on the agent opening and on each user reply).
      ALTER TABLE verifications ADD COLUMN IF NOT EXISTS conversation_history JSONB NOT NULL DEFAULT '[]'::jsonb;
      ALTER TABLE verifications ADD COLUMN IF NOT EXISTS conversation_turn INT NOT NULL DEFAULT 0;

      CREATE INDEX IF NOT EXISTS idx_verifications_payout_pending
        ON verifications (payout_status) WHERE payout_status = 'pending';

      -- Global 12h rate-limit check on join intercept (hasRecentGlobalAttempt).
      CREATE INDEX IF NOT EXISTS idx_verifications_user_created
        ON verifications (tg_user_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS payment_credits (
        payment_id     TEXT PRIMARY KEY,
        campaign_id    INT NOT NULL REFERENCES advertiser_budgets(advertiser_id),
        amount_micro   BIGINT NOT NULL,
        sender         VARCHAR(42),
        status         TEXT NOT NULL CHECK (status IN ('pending','submitted','confirmed','failed')),
        credit_tx_hash TEXT,
        created_at     TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS payout_batches (
        batch_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        run_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        total_micro     BIGINT NOT NULL,
        tx_count        INT NOT NULL,
        status          TEXT NOT NULL DEFAULT 'completed'
      );

      CREATE TABLE IF NOT EXISTS campaign_topups (
        topup_id        SERIAL PRIMARY KEY,
        advertiser_id   INT NOT NULL REFERENCES advertiser_budgets(advertiser_id),
        verifications   INT NOT NULL,
        amount_micro    BIGINT NOT NULL,
        status          TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'confirmed', 'expired', 'failed')),
        credit_tx_hash  TEXT,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX IF NOT EXISTS idx_campaign_topups_pending
        ON campaign_topups (advertiser_id, status) WHERE status = 'pending';

      ALTER TABLE payment_credits ADD COLUMN IF NOT EXISTS topup_id INT REFERENCES campaign_topups(topup_id);

      -- Dual-identity session state, persisted so Railway deploys (process restarts)
      -- stop logging users out of their flow mid-conversation.
      CREATE TABLE IF NOT EXISTS user_sessions (
        tg_user_id          BIGINT PRIMARY KEY,
        mode                TEXT NOT NULL CHECK (mode IN ('owner', 'advertiser')),
        active_tg_group_id  BIGINT,
        updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
  } finally {
    client.release();
  }
}
