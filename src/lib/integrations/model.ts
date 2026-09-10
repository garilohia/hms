import { z } from "zod";

export const integrationProvider = z.enum(["google_health", "whoop"]);
export type IntegrationProvider = z.infer<typeof integrationProvider>;

export type IntegrationStatus = {
  provider: IntegrationProvider;
  connected: boolean;
  configured: boolean;
  lastSyncAt: string | null;
  label: string;
};

export type StoredTokens = {
  accessToken: string;
  refreshToken?: string;
  tokenType: string;
  expiresAt?: string;
};
