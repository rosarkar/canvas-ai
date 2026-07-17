import { db } from "@/db.js";
import { config } from "@/config/index.js";
import { getAdvertiserByWallet } from "@/adapters/advertisers.adapter.js";
import { fromMicroUnits } from "@/utils/usdc.js";

/** States counted as a completed (billable / payable) verification. */
const PASS_STATES = `('PASSED','RULES_PENDING','ADMITTED','RULES_TIMED_OUT')`;

export interface DashboardGroupCampaign {
  advertiserId: number;
  advertiserWallet: string | null;
  bidPerVerification: number;
  remainingBudget: number;
  briefSummary: string | null;
}

export interface DashboardVerificationEntry {
  createdAt: string;
  passed: boolean;
  conversationTurns: number;
  kimiScore: number | null;
  groupTitle?: string | null;
}

export interface DashboardGroup {
  groupId: number;
  groupTitle: string | null;
  portalInviteLink: string | null;
  topic: string;
  minPrice: number | null;
  groupTags: Record<string, unknown>;
  registeredAt: string;
  earnings: { allTime: number; thisMonth: number; thisWeek: number; pending: number };
  activity: { attempts30d: number; passed30d: number; failed30d: number; passRatePct: number | null };
  activeCampaigns: DashboardGroupCampaign[];
  recentVerifications: DashboardVerificationEntry[];
}

export interface DashboardCampaign {
  advertiserId: number;
  groupId: number;
  groupTitle: string | null;
  groupTags: Record<string, unknown>;
  bidPerVerification: number;
  totalDeposited: number;
  remainingBudget: number;
  completions: number;
  passRatePct: number | null;
  status: string;
  createdAt: string;
  brief: { goal?: string; targetSignal?: string; openingPrompt?: string } | null;
  taskText: string | null;
}

export interface DashboardAvailableGroup {
  groupId: number;
  groupTitle: string | null;
  groupTags: Record<string, unknown>;
  minPrice: number | null;
  topBid: number | null;
}

export interface DashboardSpendSummary {
  totalSpent: number;
  spentThisMonth: number;
  totalCompletions: number;
  avgCostPerCompletion: number | null;
  avgKimiScore: number | null;
}

export interface DashboardData {
  wallet: string;
  roles: ("group_owner" | "advertiser")[];
  groups: DashboardGroup[];
  campaigns: DashboardCampaign[];
  availableGroups: DashboardAvailableGroup[];
  completionFeed: DashboardVerificationEntry[];
  spendSummary: DashboardSpendSummary;
}

function isPassState(state: string): boolean {
  return ["PASSED", "RULES_PENDING", "ADMITTED", "RULES_TIMED_OUT"].includes(state);
}

function briefFromTemplate(
  taskTemplate: unknown,
  taskText: string | null,
): { goal?: string; targetSignal?: string; openingPrompt?: string } | null {
  if (taskTemplate && typeof taskTemplate === "object") {
    const t = taskTemplate as Record<string, unknown>;
    const out: { goal?: string; targetSignal?: string; openingPrompt?: string } = {};
    if (typeof t.goal === "string") out.goal = t.goal;
    if (typeof t.targetSignal === "string") out.targetSignal = t.targetSignal;
    if (typeof t.openingPrompt === "string") out.openingPrompt = t.openingPrompt;
    if (Object.keys(out).length > 0) return out;
  }
  return taskText ? { openingPrompt: taskText } : null;
}

async function loadOwnerGroups(wallet: string): Promise<DashboardGroup[]> {
  const feeBps = config.payments.platformFeeBps;
  const groupsRes = await db.query(
    `SELECT group_id, group_title, portal_invite_link, verification_task_text,
            min_price_micro, group_tags, registered_at
     FROM groups
     WHERE owner_wallet = $1 AND is_active = true
     ORDER BY registered_at DESC`,
    [wallet],
  );
  if (groupsRes.rows.length === 0) return [];
  const groupIds = groupsRes.rows.map((r) => r.group_id as number);

  // One query per panel across all owned groups — no per-group loops.
  const [earningsRes, activityRes, campaignsRes, recentRes] = await Promise.all([
    db.query(
      `SELECT group_id,
              COALESCE(SUM(net), 0)::BIGINT AS all_time,
              COALESCE(SUM(net) FILTER (WHERE created_at >= date_trunc('month', NOW())), 0)::BIGINT AS this_month,
              COALESCE(SUM(net) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days'), 0)::BIGINT AS this_week,
              COALESCE(SUM(net) FILTER (WHERE payout_status = 'pending'), 0)::BIGINT AS pending
       FROM (
         SELECT group_id, created_at, payout_status,
                (locked_bid_price * (10000 - $2) / 10000) AS net
         FROM verifications
         WHERE group_id = ANY($1) AND state IN ${PASS_STATES} AND locked_bid_price IS NOT NULL
       ) t
       GROUP BY group_id`,
      [groupIds, feeBps],
    ),
    db.query(
      `SELECT group_id,
              COUNT(*)::INT AS attempts,
              COUNT(*) FILTER (WHERE state IN ${PASS_STATES})::INT AS passed
       FROM verifications
       WHERE group_id = ANY($1) AND created_at >= NOW() - INTERVAL '30 days'
       GROUP BY group_id`,
      [groupIds],
    ),
    db.query(
      `SELECT ab.group_id, ab.advertiser_id, a.wallet_address,
              ab.bid_per_verification, ab.remaining_budget, ab.task_template, ab.task_text
       FROM advertiser_budgets ab
       LEFT JOIN advertisers a ON a.tg_id = ab.advertiser_tg_id
       WHERE ab.group_id = ANY($1) AND ab.campaign_status = 'active'
       ORDER BY ab.bid_per_verification DESC`,
      [groupIds],
    ),
    db.query(
      `SELECT group_id, created_at, state, conversation_turn, kimi_score
       FROM (
         SELECT group_id, created_at, state, conversation_turn, kimi_score,
                ROW_NUMBER() OVER (PARTITION BY group_id ORDER BY created_at DESC) AS rn
         FROM verifications
         WHERE group_id = ANY($1)
       ) t
       WHERE rn <= 10`,
      [groupIds],
    ),
  ]);

  const byGroup = <T extends { group_id: number }>(rows: T[]) => {
    const m = new Map<number, T[]>();
    for (const r of rows) {
      const list = m.get(r.group_id) ?? [];
      list.push(r);
      m.set(r.group_id, list);
    }
    return m;
  };
  const earningsMap = new Map(earningsRes.rows.map((r) => [r.group_id as number, r]));
  const activityMap = new Map(activityRes.rows.map((r) => [r.group_id as number, r]));
  const campaignsMap = byGroup(campaignsRes.rows as { group_id: number }[]);
  const recentMap = byGroup(recentRes.rows as { group_id: number }[]);

  return groupsRes.rows.map((g) => {
    const groupId = g.group_id as number;
    const e = earningsMap.get(groupId);
    const a = activityMap.get(groupId);
    const attempts = a ? Number(a.attempts) : 0;
    const passed = a ? Number(a.passed) : 0;
    return {
      groupId,
      groupTitle: (g.group_title as string | null) ?? null,
      portalInviteLink: (g.portal_invite_link as string | null) ?? null,
      topic: g.verification_task_text as string,
      minPrice: g.min_price_micro != null ? fromMicroUnits(BigInt(g.min_price_micro)) : null,
      groupTags: (g.group_tags as Record<string, unknown> | null) ?? {},
      registeredAt: (g.registered_at as Date).toISOString(),
      earnings: {
        allTime: fromMicroUnits(BigInt(e?.all_time ?? 0)),
        thisMonth: fromMicroUnits(BigInt(e?.this_month ?? 0)),
        thisWeek: fromMicroUnits(BigInt(e?.this_week ?? 0)),
        pending: fromMicroUnits(BigInt(e?.pending ?? 0)),
      },
      activity: {
        attempts30d: attempts,
        passed30d: passed,
        failed30d: attempts - passed,
        passRatePct: attempts > 0 ? Math.round((passed / attempts) * 100) : null,
      },
      activeCampaigns: (campaignsMap.get(groupId) ?? []).map((c) => {
        const row = c as Record<string, unknown>;
        const brief = briefFromTemplate(row.task_template, (row.task_text as string | null) ?? null);
        return {
          advertiserId: row.advertiser_id as number,
          advertiserWallet: (row.wallet_address as string | null) ?? null,
          bidPerVerification: fromMicroUnits(BigInt(row.bid_per_verification as string)),
          remainingBudget: fromMicroUnits(BigInt(row.remaining_budget as string)),
          briefSummary: brief?.openingPrompt ?? brief?.goal ?? null,
        };
      }),
      recentVerifications: (recentMap.get(groupId) ?? []).map((v) => {
        const row = v as Record<string, unknown>;
        return {
          createdAt: (row.created_at as Date).toISOString(),
          passed: isPassState(row.state as string),
          conversationTurns: Number(row.conversation_turn ?? 0),
          kimiScore: row.kimi_score != null ? Number(row.kimi_score) : null,
        };
      }),
    };
  });
}

async function loadAdvertiserSide(wallet: string): Promise<{
  campaigns: DashboardCampaign[];
  completionFeed: DashboardVerificationEntry[];
  spendSummary: DashboardSpendSummary;
  advertiserTgId: bigint | null;
}> {
  const emptySpend: DashboardSpendSummary = {
    totalSpent: 0,
    spentThisMonth: 0,
    totalCompletions: 0,
    avgCostPerCompletion: null,
    avgKimiScore: null,
  };
  const advertiser = await getAdvertiserByWallet(wallet);
  if (!advertiser) {
    return { campaigns: [], completionFeed: [], spendSummary: emptySpend, advertiserTgId: null };
  }
  const tgId = advertiser.tgId.toString();

  const [campaignsRes, feedRes, spendRes] = await Promise.all([
    db.query(
      `SELECT ab.advertiser_id, ab.group_id, g.group_title, g.group_tags,
              ab.bid_per_verification, ab.remaining_budget, ab.campaign_status,
              ab.task_template, ab.task_text, ab.created_at,
              COALESCE(v.attempts, 0)::INT AS attempts,
              COALESCE(v.passed, 0)::INT AS passed
       FROM advertiser_budgets ab
       JOIN groups g ON g.group_id = ab.group_id
       LEFT JOIN (
         SELECT advertiser_id,
                COUNT(*) AS attempts,
                COUNT(*) FILTER (WHERE state IN ${PASS_STATES}) AS passed
         FROM verifications
         GROUP BY advertiser_id
       ) v ON v.advertiser_id = ab.advertiser_id
       WHERE ab.advertiser_tg_id = $1
       ORDER BY ab.created_at DESC`,
      [tgId],
    ),
    db.query(
      `SELECT v.created_at, g.group_title, v.state, v.conversation_turn, v.kimi_score
       FROM verifications v
       JOIN advertiser_budgets ab ON ab.advertiser_id = v.advertiser_id
       JOIN groups g ON g.group_id = v.group_id
       WHERE ab.advertiser_tg_id = $1
         AND (v.state IN ${PASS_STATES} OR v.state = 'KIMI_FAILED')
       ORDER BY v.created_at DESC
       LIMIT 20`,
      [tgId],
    ),
    db.query(
      `SELECT COALESCE(SUM(v.locked_bid_price), 0)::BIGINT AS total_spent,
              COALESCE(SUM(v.locked_bid_price) FILTER (WHERE v.created_at >= date_trunc('month', NOW())), 0)::BIGINT AS month_spent,
              COUNT(*)::INT AS completions,
              AVG(v.kimi_score) AS avg_score
       FROM verifications v
       JOIN advertiser_budgets ab ON ab.advertiser_id = v.advertiser_id
       WHERE ab.advertiser_tg_id = $1
         AND v.state IN ${PASS_STATES} AND v.locked_bid_price IS NOT NULL`,
      [tgId],
    ),
  ]);

  const campaigns: DashboardCampaign[] = campaignsRes.rows.map((row) => {
    const bid = fromMicroUnits(BigInt(row.bid_per_verification as string));
    const remaining = fromMicroUnits(BigInt(row.remaining_budget as string));
    const passed = Number(row.passed);
    const attempts = Number(row.attempts);
    // Exhausted means the budget can no longer cover one verification; the DB status
    // can lag (e.g. after a topup), so derive it from remaining vs bid for display.
    const dbStatus = row.campaign_status as string;
    const status =
      dbStatus === "active" || dbStatus === "exhausted"
        ? remaining >= bid
          ? "active"
          : "exhausted"
        : dbStatus;
    return {
      advertiserId: row.advertiser_id as number,
      groupId: row.group_id as number,
      groupTitle: (row.group_title as string | null) ?? null,
      groupTags: (row.group_tags as Record<string, unknown> | null) ?? {},
      bidPerVerification: bid,
      // Original deposit amount isn't stored on the row; remaining + spend is the
      // exact deposited total as long as topups also land in remaining_budget.
      totalDeposited: Math.round((remaining + passed * bid) * 100) / 100,
      remainingBudget: remaining,
      completions: passed,
      passRatePct: attempts > 0 ? Math.round((passed / attempts) * 100) : null,
      status,
      createdAt: (row.created_at as Date).toISOString(),
      brief: briefFromTemplate(row.task_template, (row.task_text as string | null) ?? null),
      taskText: (row.task_text as string | null) ?? null,
    };
  });

  const spendRow = spendRes.rows[0]!;
  const totalSpent = fromMicroUnits(BigInt(spendRow.total_spent ?? 0));
  const completions = Number(spendRow.completions ?? 0);
  const spendSummary: DashboardSpendSummary = {
    totalSpent,
    spentThisMonth: fromMicroUnits(BigInt(spendRow.month_spent ?? 0)),
    totalCompletions: completions,
    avgCostPerCompletion:
      completions > 0 ? Math.round((totalSpent / completions) * 100) / 100 : null,
    avgKimiScore:
      spendRow.avg_score != null ? Math.round(Number(spendRow.avg_score) * 10) / 10 : null,
  };

  const completionFeed: DashboardVerificationEntry[] = feedRes.rows.map((row) => ({
    createdAt: (row.created_at as Date).toISOString(),
    groupTitle: (row.group_title as string | null) ?? null,
    passed: isPassState(row.state as string),
    conversationTurns: Number(row.conversation_turn ?? 0),
    kimiScore: row.kimi_score != null ? Number(row.kimi_score) : null,
  }));

  return { campaigns, completionFeed, spendSummary, advertiserTgId: advertiser.tgId };
}

async function loadAvailableGroups(
  advertiserTgId: bigint | null,
): Promise<DashboardAvailableGroup[]> {
  // Active groups this advertiser isn't already running/queueing a campaign in.
  const res = await db.query(
    `SELECT g.group_id, g.group_title, g.group_tags, g.min_price_micro,
            ab.bid_per_verification AS top_bid
     FROM groups g
     LEFT JOIN LATERAL (
       SELECT bid_per_verification
       FROM advertiser_budgets
       WHERE group_id = g.group_id AND campaign_status = 'active' AND remaining_budget > 0
       ORDER BY bid_per_verification DESC
       LIMIT 1
     ) ab ON true
     WHERE g.is_active = true
       AND ($1::BIGINT IS NULL OR g.group_id NOT IN (
         SELECT group_id FROM advertiser_budgets
         WHERE advertiser_tg_id = $1
           AND campaign_status IN ('active','paused','pending_deposit','pending_approval')
       ))
     ORDER BY g.registered_at DESC`,
    [advertiserTgId?.toString() ?? null],
  );
  return res.rows.map((row) => ({
    groupId: row.group_id as number,
    groupTitle: (row.group_title as string | null) ?? null,
    groupTags: (row.group_tags as Record<string, unknown> | null) ?? {},
    minPrice: row.min_price_micro != null ? fromMicroUnits(BigInt(row.min_price_micro)) : null,
    topBid: row.top_bid != null ? fromMicroUnits(BigInt(row.top_bid as string)) : null,
  }));
}

export async function getDashboardData(walletAddress: string): Promise<DashboardData> {
  const wallet = walletAddress.toLowerCase();
  const [groups, advertiserSide] = await Promise.all([
    loadOwnerGroups(wallet),
    loadAdvertiserSide(wallet),
  ]);
  const availableGroups = await loadAvailableGroups(advertiserSide.advertiserTgId);

  const roles: ("group_owner" | "advertiser")[] = [];
  if (groups.length > 0) roles.push("group_owner");
  if (advertiserSide.campaigns.length > 0) roles.push("advertiser");

  return {
    wallet,
    roles,
    groups,
    campaigns: advertiserSide.campaigns,
    availableGroups,
    completionFeed: advertiserSide.completionFeed,
    spendSummary: advertiserSide.spendSummary,
  };
}
