import { buildChannelConfigSchema } from "openclaw/plugin-sdk";
import { z } from "zod";

/**
 * Per-account config for a Dialectica WebSocket connection.
 */
export const DialecticaAccountSchema = z.object({
  /** Display name for this account */
  name: z.string().optional(),

  /** Whether this account is enabled */
  enabled: z.boolean().optional(),

  /** The WebSocket server URL (wss://...) */
  wsUrl: z.string().url().optional(),

  /** Agent ID to route incoming messages to */
  agent: z.string().optional(),
});

export type DialecticaAccountConfig = z.infer<typeof DialecticaAccountSchema>;

/**
 * Top-level channels.dialectica config.
 * All accounts are named under accounts.<id> — there is no implicit default account.
 *
 * Example:
 *   channels:
 *     dialectica:
 *       accounts:
 *         mybot:
 *           wsUrl: wss://example.com/ws
 *           agent: main
 */
export const DialecticaConfigSchema = z.object({
  /** Named accounts — every Dialectica connection must be a named account */
  accounts: z.record(z.string(), DialecticaAccountSchema).optional(),
});

export type DialecticaConfig = z.infer<typeof DialecticaConfigSchema>;

export const dialecticaChannelConfigSchema = buildChannelConfigSchema(DialecticaConfigSchema);
