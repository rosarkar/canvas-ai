import "@/load-env.js";

const requireEnv = (name: string, value?: string): string => {
  if (!value) throw new Error(`${name} is required in .env`);
  return value;
};

interface Config {
  env: string;
  databaseUrl: string;
  telegram: {
    botToken: string;
    webhookUrl: string;
    webhookSecret: string;
    webhookPort: number;
    /** Telegram user ID that receives operational alert DMs (empty = alerts disabled). */
    adminTelegramId: string;
  };
  kimi: {
    apiKey: string;
    baseUrl: string;
    model: string;
  };
  base: {
    rpcUrl: string;
    relayerPrivateKey: string;
    deployerPrivateKey: string;
  };
  payments: {
    escrowContractAddress: string;
    usdcAddress: string;
    bankrApiKey: string;
    depositPollIntervalMs: number;
    depositTtlMs: number;
    depositUrlSecret: string;
    miniAppBaseUrl: string;
    payoutBatchIntervalMs: number;
    companyWallet: string;
    /** Platform fee in basis points (100 = 1%, 1000 = 10%). Default: 1000. */
    platformFeeBps: number;
  };
  openai: {
    apiKey: string;
  };
  markets: {
    /** TxODDS hackathon API key. Empty → the risk desk runs on sample fixtures. */
    txoddsApiKey: string;
    txoddsBaseUrl: string;
    /** When true (and a Bankr key is set) settlement places real on-chain bets. */
    liveSettlement: boolean;
    /** Repeated-bet horizon for the Monte-Carlo bankroll projection. */
    simHorizonBets: number;
  };
  solana: {
    network: "devnet" | "mainnet";
    /** Base58 or JSON-array secret key for the TxLINE subscription wallet. */
    devnetSecretKey: string;
    /** TxLINE free service level (devnet 1; mainnet 1=60s, 12=realtime). */
    serviceLevel: number;
    /** Use the real on-chain TxLINE feed instead of sample fixtures. */
    useTxline: boolean;
  };
  constants: {
    /** Calibrated after founder review of first ~50 responses; placeholder until then. */
    KIMI_PASS_THRESHOLD: number;
    VERIFICATION_TTL_MS: number;
    COOLDOWN_MS: number;
    MIN_BID_MICROUNITS: bigint;
    MIN_CAMPAIGN_QUANTITY: number;
    /** Window to tap "I agree" on the post-verification rules gate before being left muted. */
    RULES_PENDING_TTL_MS: number;
  };
}

export const config: Config = {
  env: process.env.NODE_ENV ?? "development",
  databaseUrl: requireEnv("DATABASE_URL", process.env.DATABASE_URL),
  telegram: {
    botToken: requireEnv("TELEGRAM_BOT_TOKEN", process.env.TELEGRAM_BOT_TOKEN?.trim()),
    webhookUrl: requireEnv("TELEGRAM_WEBHOOK_URL", process.env.TELEGRAM_WEBHOOK_URL?.trim()),
    webhookSecret: requireEnv(
      "TELEGRAM_WEBHOOK_SECRET",
      process.env.TELEGRAM_WEBHOOK_SECRET?.trim(),
    ),
    webhookPort: parseInt(process.env.PORT ?? "3000", 10),
    adminTelegramId: process.env.ADMIN_TELEGRAM_ID?.trim() ?? "",
  },
  kimi: {
    apiKey: process.env.KIMI_API_KEY?.trim() ?? "",
    baseUrl: process.env.KIMI_BASE_URL?.trim() ?? "https://api.moonshot.ai/v1",
    model: process.env.KIMI_MODEL?.trim() ?? "moonshot-v1-8k",
  },
  base: {
    rpcUrl: process.env.BASE_RPC_URL?.trim() || "https://mainnet.base.org",
    relayerPrivateKey: process.env.RELAYER_PRIVATE_KEY?.trim() ?? "",
    deployerPrivateKey:
      process.env.DEPLOYER_PRIVATE_KEY?.trim() ??
      process.env.RELAYER_PRIVATE_KEY?.trim() ??
      "",
  },
  payments: {
    escrowContractAddress: process.env.ESCROW_CONTRACT_ADDRESS?.trim() ?? "",
    usdcAddress:
      process.env.USDC_BASE_ADDRESS?.trim() ??
      "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    bankrApiKey: process.env.BANKR_API_KEY?.trim() ?? "",
    depositPollIntervalMs: Number(process.env.DEPOSIT_POLL_INTERVAL_MS ?? "30000"),
    depositTtlMs: Number(process.env.DEPOSIT_TTL_MS ?? "7200000"),
    depositUrlSecret: process.env.DEPOSIT_URL_SECRET?.trim() ?? "",
    miniAppBaseUrl:
      process.env.MINI_APP_BASE_URL?.trim() ??
      (process.env.TELEGRAM_WEBHOOK_URL?.trim()
        ? new URL(process.env.TELEGRAM_WEBHOOK_URL.trim()).origin
        : "http://localhost:3000"),
    payoutBatchIntervalMs: Number(process.env.PAYOUT_BATCH_INTERVAL_MS ?? "86400000"),
    companyWallet: process.env.COMPANY_WALLET?.trim() ?? "",
    platformFeeBps: Number(process.env.PLATFORM_FEE_BPS ?? "1000"),
  },
  openai: {
    apiKey: process.env.OPENAI_API_KEY?.trim() ?? "",
  },
  markets: {
    txoddsApiKey: process.env.TXODDS_API_KEY?.trim() ?? "",
    txoddsBaseUrl: process.env.TXODDS_BASE_URL?.trim() ?? "https://api.txodds.net",
    liveSettlement: (process.env.MARKETS_LIVE_SETTLEMENT?.trim() ?? "false") === "true",
    simHorizonBets: Number(process.env.MARKETS_SIM_HORIZON_BETS ?? "40"),
  },
  solana: {
    network: process.env.SOLANA_NETWORK?.trim() === "mainnet" ? "mainnet" : "devnet",
    devnetSecretKey: process.env.SOLANA_DEVNET_SECRET_KEY?.trim() ?? "",
    serviceLevel: Number(process.env.TXLINE_SERVICE_LEVEL ?? "1"),
    useTxline: (process.env.USE_TXLINE?.trim() ?? "false") === "true",
  },
  constants: {
    KIMI_PASS_THRESHOLD: Number(process.env.KIMI_PASS_THRESHOLD ?? "0"),
    VERIFICATION_TTL_MS: 300_000,
    COOLDOWN_MS: 86_400_000,
    MIN_BID_MICROUNITS: BigInt(process.env.MIN_BID_MICROUNITS ?? "10000"),
    MIN_CAMPAIGN_QUANTITY: Number(process.env.MIN_CAMPAIGN_QUANTITY ?? "1"),
    RULES_PENDING_TTL_MS: 600_000,
  },
};
