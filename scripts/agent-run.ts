#!/usr/bin/env tsx
/** Headless Canvas Edge agent loop. `npm run agent:run` */
process.env.DATABASE_URL ??= "postgres://agent-run";
process.env.TELEGRAM_BOT_TOKEN ??= "agent-run";
process.env.TELEGRAM_WEBHOOK_URL ??= "http://localhost:4300";
process.env.TELEGRAM_WEBHOOK_SECRET ??= "agent-run";

const { startAgentLoop, agentState } = await import("@/services/agent/loop.js");

const interval = Number(process.env.AGENT_LOOP_INTERVAL_MS ?? "12000");
console.log("Canvas Edge — headless agent loop\n");
startAgentLoop(interval);
setInterval(() => {
  const open = agentState.positions.filter((p) => p.status === "open").length;
  console.log(
    `[${new Date().toISOString().slice(11, 19)}] bankroll $${agentState.bankroll.toFixed(2)} · ` +
      `realized $${agentState.realizedPnl.toFixed(2)} · open ${open} · source ${agentState.source}` +
      (agentState.blockedReason ? ` · BLOCKED: ${agentState.blockedReason}` : ""),
  );
}, interval);
