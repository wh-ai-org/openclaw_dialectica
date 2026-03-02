import type { OpenClawConfig } from "openclaw/plugin-sdk";
import type { DialecticaAccountConfig, DialecticaConfig } from "./config-schema.js";

export interface ResolvedDialecticaAccount {
  accountId: string;
  name?: string;
  enabled: boolean;
  configured: boolean;
  wsUrl: string;
  agent?: string;
  config: DialecticaAccountConfig;
}

function getDialecticaCfg(cfg: OpenClawConfig): DialecticaConfig | undefined {
  return (cfg.channels as Record<string, unknown> | undefined)?.dialectica as
    | DialecticaConfig
    | undefined;
}

export function listDialecticaAccountIds(cfg: OpenClawConfig): string[] {
  const dc = getDialecticaCfg(cfg);
  return Object.keys(dc?.accounts ?? {});
}

export function resolveDefaultDialecticaAccountId(cfg: OpenClawConfig): string {
  return listDialecticaAccountIds(cfg)[0] ?? "";
}

export function resolveDialecticaAccount(opts: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): ResolvedDialecticaAccount {
  const dc = getDialecticaCfg(opts.cfg);
  const accountId = opts.accountId ?? resolveDefaultDialecticaAccountId(opts.cfg);
  const raw: DialecticaAccountConfig = dc?.accounts?.[accountId] ?? {};

  const wsUrl = raw.wsUrl ?? "";

  return {
    accountId,
    name: raw.name,
    enabled: raw.enabled !== false,
    configured: Boolean(wsUrl.trim()),
    wsUrl,
    agent: raw.agent,
    config: raw,
  };
}
