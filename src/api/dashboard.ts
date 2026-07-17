import { Router, type Request, type Response } from "express";

import { getDashboardData } from "@/adapters/dashboard.adapter.js";
import { requireWalletAuth } from "@/api/wallet-auth.js";
import { logger } from "@/utils/logger.js";

export const dashboardRouter = Router();

/**
 * Unified dashboard payload for the single-page dashboard at /dashboard.
 * Roles are derived server-side: group_owner if the wallet owns active groups,
 * advertiser if it has campaigns. A wallet with neither still gets a 200 with
 * empty roles so the client can render the get-started empty state.
 */
dashboardRouter.get("/api/dashboard", requireWalletAuth, async (req: Request, res: Response) => {
  const wallet = req.query.wallet as string;
  try {
    res.json(await getDashboardData(wallet));
  } catch (err) {
    logger.error({ err, wallet }, "Dashboard query failed");
    res.status(500).json({ error: "Could not load dashboard data" });
  }
});
