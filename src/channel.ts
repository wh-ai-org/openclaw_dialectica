import {
  buildChannelConfigSchema,
  createDefaultChannelRuntimeState,
  type ChannelPlugin,
  type ReplyPayload,
} from "openclaw/plugin-sdk";
import {
  listDialecticaAccountIds,
  resolveDefaultDialecticaAccountId,
  resolveDialecticaAccount,
  type ResolvedDialecticaAccount,
} from "./accounts.js";
import { DialecticaConfigSchema } from "./config-schema.js";
import {
  buildEvaluationPrompt,
  buildISPExecutionPrompt,
  buildIVSPExecutionPrompt,
  type CachedConfig,
  type Opportunity,
} from "./prompts.js";
import { getDialecticaRuntime } from "./runtime.js";
import { validateISOResult, validateVFPResult } from "./schemas.js";

// ─── Per-account runtime state ────────────────────────────────────────────────

interface AccountState {
  /** Config received via config-update messages */
  cachedConfig: CachedConfig;
  /** Jobs cancelled mid-flight — checked before sending job-complete */
  cancelledJobs: Set<string>;
}

const accountStates = new Map<string, AccountState>();

function getAccountState(accountId: string): AccountState {
  let state = accountStates.get(accountId);
  if (!state) {
    state = { cachedConfig: {}, cancelledJobs: new Set() };
    accountStates.set(accountId, state);
  }
  return state;
}

// Active WebSocket connections keyed by accountId
const activeSockets = new Map<string, WebSocket>();

// ─── Send helpers ─────────────────────────────────────────────────────────────

function wsSend(ws: WebSocket, msg: Record<string, unknown>): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

// ─── Agent dispatch ───────────────────────────────────────────────────────────

/**
 * Dispatch a prompt to the configured agent and return the raw text reply.
 * Resolves when the agent sends its final reply, or rejects on timeout.
 */
async function dispatchToAgent(opts: {
  accountId: string;
  agentId: string | undefined;
  prompt: string;
  timeoutMs: number;
  log: (msg: string) => void;
}): Promise<string> {
  const { accountId, agentId, prompt, timeoutMs, log } = opts;
  const core = getDialecticaRuntime();
  const cfg = await core.config.loadConfig();

  // Build session key: prefer account.agent, fall back to routing
  const sessionKey = agentId
    ? `agent:${agentId.toLowerCase()}:main`
    : core.channel.routing.resolveAgentRoute({
        cfg,
        channel: "dialectica",
        accountId,
        peer: { kind: "direct", id: accountId },
      }).sessionKey;

  log(`[${accountId}] dispatching to session=${sessionKey}`);

  return await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`agent dispatch timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );

    let accumulatedText = "";

    const ctx = core.channel.reply.finalizeInboundContext({
      Body: prompt,
      BodyForAgent: prompt,
      RawBody: prompt,
      CommandBody: prompt,
      SessionKey: sessionKey,
      AccountId: accountId,
      ChatType: "direct" as const,
      From: accountId,
      To: accountId,
      Provider: "dialectica" as const,
      Surface: "dialectica" as const,
      SenderId: accountId,
      Timestamp: Date.now(),
      WasMentioned: true,
      CommandAuthorized: false,
    });

    const dispatcher = core.channel.reply.createReplyDispatcherWithTyping({
      deliver: async (payload: ReplyPayload, info) => {
        const text = (payload.text ?? "").trim();
        if (!text) return;
        // Accumulate all blocks; resolve on final
        accumulatedText = text; // final/block overwrites — last wins
        if (info.kind === "final") {
          clearTimeout(timer);
          resolve(accumulatedText);
        }
      },
      onError: (err) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    });

    core.channel.reply
      .withReplyDispatcher({
        dispatcher: dispatcher.dispatcher,
        run: () =>
          core.channel.reply.dispatchReplyFromConfig({
            ctx,
            cfg,
            dispatcher: dispatcher.dispatcher,
            replyOptions: dispatcher.replyOptions,
          }),
        onSettled: () => {
          dispatcher.markDispatchIdle();
          // If final was never called (e.g. NO_REPLY / silent), resolve with whatever we have
          clearTimeout(timer);
          resolve(accumulatedText);
        },
      })
      .catch((err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      });
  });
}

// ─── JSON extraction ──────────────────────────────────────────────────────────

/**
 * Parse JSON from agent reply. Strips markdown code fences if present.
 */
function extractJson(text: string): unknown {
  // Strip ```json ... ``` or ``` ... ``` fences
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced ? fenced[1] : text;
  return JSON.parse(raw.trim());
}

// ─── Message handlers ─────────────────────────────────────────────────────────

async function handleEvaluateRequest(opts: {
  ws: WebSocket;
  accountId: string;
  agentId: string | undefined;
  requestId: string;
  opportunity: Opportunity;
  log: (msg: string) => void;
}): Promise<void> {
  const { ws, accountId, agentId, requestId, opportunity, log } = opts;

  log(`[${accountId}] evaluate-request ${requestId} (type=${opportunity.type})`);

  log(`[${accountId}] evaluate-request ${requestId} \n ${JSON.stringify(opportunity,null,2)}`);


  let score = 0;
  try {
    const prompt = buildEvaluationPrompt(opportunity);
    // 25s budget — leaves 5s headroom before the 30s server timeout
    const reply = await dispatchToAgent({ accountId, agentId, prompt, timeoutMs: 25_000, log });
    const parsed = extractJson(reply) as Record<string, unknown>;
    const raw = Number(parsed?.score ?? 0);
    score = Number.isFinite(raw) ? Math.max(0, Math.min(100, Math.round(raw))) : 0;
    log(`[${accountId}] evaluate-result ${requestId} score=${score}`);
  } catch (err) {
    log(`[${accountId}] evaluate-request error (score→0): ${String(err)}`);
    score = 0;
  }

  wsSend(ws, { type: "evaluate-result", requestId, score });
}

async function handleExecuteJob(opts: {
  ws: WebSocket;
  accountId: string;
  agentId: string | undefined;
  jobId: string;
  opportunity: Opportunity;
  state: AccountState;
  log: (msg: string) => void;
}): Promise<void> {
  const { ws, accountId, agentId, jobId, opportunity, state, log } = opts;
  const startMs = Date.now();

  log(`[${accountId}] execute-job ${jobId} (type=${opportunity.type})`);

  // Immediately report progress so the server knows we started
  wsSend(ws, { type: "job-progress", jobId, message: "Starting…", percentage: 0 });

  try {
    const isISP = opportunity.type === "ISR";
    const prompt = isISP
      ? buildISPExecutionPrompt(opportunity, state.cachedConfig)
      : buildIVSPExecutionPrompt(opportunity, state.cachedConfig);


  log(`[${accountId}] execute-job ${jobId} evaluate: ${prompt}`);

    wsSend(ws, { type: "job-progress", jobId, message: "Generating response…", percentage: 20 });

    // 5-minute budget for execution jobs
    const reply = await dispatchToAgent({ accountId, agentId, prompt, timeoutMs: 300_000, log });

    // Check for cancellation before submitting result
    if (state.cancelledJobs.has(jobId)) {
      log(`[${accountId}] job ${jobId} was cancelled — discarding result`);
      state.cancelledJobs.delete(jobId);
      return;
    }

    wsSend(ws, { type: "job-progress", jobId, message: "Validating result…", percentage: 90 });

    const elapsedMs = Date.now() - startMs;
    const parsed = extractJson(reply);

    if (isISP) {
      const validation = validateISOResult(parsed);
      if (!validation.ok) {
        log(`[${accountId}] ISOResult validation failed: ${validation.errors}`);
        wsSend(ws, {
          type: "job-error",
          jobId,
          error: `Result validation failed: ${validation.errors}`,
        });
        return;
      }
      // Stamp generation time if not set
      if (!validation.value.metadata.generation_time_ms) {
        validation.value.metadata.generation_time_ms = elapsedMs;
      }
      log(`[${accountId}] job-complete ${jobId} (ISP)`);
      wsSend(ws, { type: "job-complete", jobId, result: validation.value });
    } else {
      const validation = validateVFPResult(parsed);
      if (!validation.ok) {
        log(`[${accountId}] VFPResult validation failed: ${validation.errors}`);
        wsSend(ws, {
          type: "job-error",
          jobId,
          error: `Result validation failed: ${validation.errors}`,
        });
        return;
      }
      // Stamp verification time if not set
      if (!validation.value.metadata.verification_time_ms) {
        (validation.value.metadata as { verification_time_ms: number }).verification_time_ms =
          elapsedMs;
      }
      log(`[${accountId}] job-complete ${jobId} (IVSP, verdict=${validation.value.overall_verdict})`);
      wsSend(ws, { type: "job-complete", jobId, result: validation.value });
    }
  } catch (err) {
    log(`[${accountId}] execute-job ${jobId} error: ${String(err)}`);
    wsSend(ws, { type: "job-error", jobId, error: String(err) });
  }
}

// ─── WebSocket runner ─────────────────────────────────────────────────────────

function runWebSocket(opts: {
  accountId: string;
  wsUrl: string;
  agentId: string | undefined;
  abortSignal: AbortSignal;
  log: (msg: string) => void;
}): Promise<void> {
  const { accountId, wsUrl, agentId, abortSignal, log } = opts;

  return new Promise<void>((resolve) => {
    abortSignal.addEventListener("abort", () => resolve(), { once: true });

    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;

    function connect() {
      if (abortSignal.aborted) return;

      log(`[${accountId}] connecting to ${wsUrl}`);
      const ws = new WebSocket(wsUrl);
      activeSockets.set(accountId, ws);

      ws.addEventListener("open", () => {
        attempt = 0;
        log(`[${accountId}] WebSocket connected`);
      });

      ws.addEventListener("message", (event) => {
        const raw = typeof event.data === "string" ? event.data : String(event.data);

        let parsed: Record<string, unknown> | null = null;
        try {
          parsed = JSON.parse(raw) as Record<string, unknown>;
        } catch {
          log(`[${accountId}] non-JSON message ignored`);
          return;
        }

        const type = parsed.type as string | undefined;
        const state = getAccountState(accountId);

        // ── Heartbeat ──────────────────────────────────────────────────────────
        if (type === "heartbeat") {
          wsSend(ws, { type: "heartbeat" });
          return;
        }

        // ── Welcome ────────────────────────────────────────────────────────────
        if (type === "welcome") {
          log(`[${accountId}] welcomed by server`);
          return;
        }

        // ── Config update ──────────────────────────────────────────────────────
        if (type === "config-update") {
          const config = (parsed.config as Record<string, unknown> | undefined) ?? {};
          Object.assign(state.cachedConfig, config);
          log(`[${accountId}] config-update received, keys=${Object.keys(config).join(",")}`);
          wsSend(ws, { type: "config-ack", success: true });
          return;
        }

        // ── Cancel job ─────────────────────────────────────────────────────────
        if (type === "cancel-job") {
          const jobId = parsed.jobId as string | undefined;
          if (jobId) {
            state.cancelledJobs.add(jobId);
            log(`[${accountId}] cancel-job ${jobId}`);
          }
          return;
        }

        // ── Evaluate request ───────────────────────────────────────────────────
        if (type === "evaluate-request") {
          const requestId = parsed.requestId as string | undefined;
          const opportunity = parsed.opportunity as Opportunity | undefined;
          if (!requestId || !opportunity) {
            log(`[${accountId}] evaluate-request missing requestId or opportunity`);
            return;
          }
          void handleEvaluateRequest({ ws, accountId, agentId, requestId, opportunity, log });
          return;
        }

        // ── Execute job ────────────────────────────────────────────────────────
        if (type === "execute-job") {
          const jobId = parsed.jobId as string | undefined;
          const opportunity = parsed.opportunity as Opportunity | undefined;
          if (!jobId || !opportunity) {
            log(`[${accountId}] execute-job missing jobId or opportunity`);
            return;
          }
          void handleExecuteJob({ ws, accountId, agentId, jobId, opportunity, state, log });
          return;
        }

        log(`[${accountId}] unhandled message type: ${type ?? "(none)"}`);
      });

      ws.addEventListener("error", (err) => {
        log(`[${accountId}] WebSocket error: ${String(err)}`);
        resolve();
      });

      ws.addEventListener("close", (ev) => {
        activeSockets.delete(accountId);
        if (abortSignal.aborted) return;

        attempt += 1;
        const delayMs = Math.min(1000 * 2 ** (attempt - 1), 60_000);
        log(
          `[${accountId}] closed (code=${ev.code}), reconnecting in ${Math.round(delayMs / 1000)}s… (attempt ${attempt})`,
        );
        resolve();
        return;
      });
    }

    abortSignal.addEventListener("abort", () => {
      if (reconnectTimer != null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      const ws = activeSockets.get(accountId);
      activeSockets.delete(accountId);
      accountStates.delete(accountId);
      try { ws?.close(); } catch { /* ignore */ }
    });

    connect();
  });
}

// ─── Channel plugin ───────────────────────────────────────────────────────────

export const dialecticaChannelPlugin: ChannelPlugin<ResolvedDialecticaAccount> = {
  id: "dialectica",
  meta: {
    id: "dialectica",
    label: "Dialectica",
    selectionLabel: "Dialectica",
    docsPath: "/channels/dialectica",
    docsLabel: "dialectica",
    blurb: "WebSocket-based channel for Dialectica marketplace",
    order: 200,
  },
  capabilities: {
    chatTypes: ["direct"],
    media: false,
  },
  reload: { configPrefixes: ["channels.dialectica"] },
  configSchema: buildChannelConfigSchema(DialecticaConfigSchema),

  config: {
    listAccountIds: (cfg) => listDialecticaAccountIds(cfg),
    resolveAccount: (cfg, accountId) => resolveDialecticaAccount({ cfg, accountId }),
    defaultAccountId: (cfg) => resolveDefaultDialecticaAccountId(cfg),
    isConfigured: (account) => account.configured,
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
      wsUrl: account.wsUrl,
      agent: account.agent,
    }),
  },

  outbound: {
    deliveryMode: "direct",
    sendText: async ({ to, text, accountId }) => {
      const resolvedAccountId = accountId ?? "";
      const ws = activeSockets.get(resolvedAccountId);
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        throw new Error(`[dialectica:${resolvedAccountId}] WebSocket not connected`);
      }
      ws.send(text);
      return {
        channel: "dialectica" as const,
        to,
        messageId: `dialectica-${Date.now()}`,
      };
    },
  },

  status: {
    defaultRuntime: createDefaultChannelRuntimeState(""),
    buildChannelSummary: ({ snapshot }) => ({
      configured: snapshot.configured ?? false,
      running: snapshot.running ?? false,
      lastStartAt: snapshot.lastStartAt ?? null,
      lastStopAt: snapshot.lastStopAt ?? null,
      lastError: snapshot.lastError ?? null,
    }),
    buildAccountSnapshot: ({ account, runtime }) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
      wsUrl: account.wsUrl,
      agent: account.agent,
      running: runtime?.running ?? false,
      lastStartAt: runtime?.lastStartAt ?? null,
      lastStopAt: runtime?.lastStopAt ?? null,
      lastError: runtime?.lastError ?? null,
    }),
  },

  gateway: {
    startAccount: async (ctx) => {
      const { account, abortSignal } = ctx;

      if (!account.configured) {
        throw new Error(
          `Dialectica account "${account.accountId}" is not configured (missing wsUrl).`,
        );
      }

      ctx.log?.info(`[${account.accountId}] starting Dialectica WebSocket provider`);

      await runWebSocket({
        accountId: account.accountId,
        wsUrl: account.wsUrl,
        agentId: account.agent,
        abortSignal,
        log: (msg) => ctx.log?.info(msg),
      });

      ctx.log?.info(`[${account.accountId}] Dialectica WebSocket provider stopped`);
    },
  },
};
