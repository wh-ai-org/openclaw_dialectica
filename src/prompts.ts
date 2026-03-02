import { ISO_RESULT_SCHEMA_JSON, VFP_RESULT_SCHEMA_JSON } from "./schemas.js";

// ─── Types mirroring Dialectica protocol ──────────────────────────────────────

export interface Opportunity {
  id: string;
  type: "ISR" | "ISO";
  data: Record<string, unknown>;
  arenaContext?: Record<string, unknown>;
}

export interface CachedConfig {
  isoResultSchema?: string;
  vfpResultSchema?: string;
  agentRole?: string[];
  [key: string]: unknown;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function prettyJson(obj: unknown): string {
  return JSON.stringify(obj, null, 2);
}

function formatArenaContext(metadata: Record<string, unknown> | undefined): string {
  if (!metadata) return "(none provided)";
  const parts: string[] = [];
  if (metadata.answerRules) {
    parts.push(`ANSWER RULES:\n${prettyJson(metadata.answerRules)}`);
  }
  if (metadata.verificationRules) {
    parts.push(`VERIFICATION RULES:\n${prettyJson(metadata.verificationRules)}`);
  }
  if (metadata.turnNumber !== undefined) {
    parts.push(`Turn number: ${metadata.turnNumber}`);
  }
  if (metadata.priorVerifiedAnswers) {
    parts.push(`PRIOR VERIFIED ANSWERS:\n${prettyJson(metadata.priorVerifiedAnswers)}`);
  }
  return parts.length > 0 ? parts.join("\n\n") : "(none provided)";
}

// ─── Evaluation prompts ───────────────────────────────────────────────────────

/**
 * Build a fast evaluation prompt (must respond within 30 seconds with {"score": N}).
 */
export function buildEvaluationPrompt(opportunity: Opportunity): string {
  const { type, data, metadata } = opportunity;

  if (type === "ISR") {
    const question = (data.content as string | undefined) ?? "(no content)";
    const arenaId = (data.arenaId as string | undefined) ?? "(unknown)";
    const domainTags = (data.domain_tags as string[] | undefined) ?? [];

    return `[DIALECTICA:evaluate-request — ISP role]
Arena: ${arenaId}${domainTags.length > 0 ? `\nDomain tags: ${domainTags.join(", ")}` : ""}

QUESTION:
${question}

${metadata?.answerRules ? `Answer rules summary:\n${prettyJson(metadata.answerRules)}\n` : ""}
Evaluate your fitness to answer this question.
- Score 0 if the question is outside your capability or you cannot comply with the arena rules.
- Score 1-40 for low confidence.
- Score 41-70 for moderate fit.
- Score 71-100 for strong fit and high confidence.

Respond with ONLY valid JSON — no prose, no markdown, no code fences:
{"score": <integer 0-100>}`;
  }

  // ISO (IVSP role)
  const answerData = (data.structured_data as Record<string, unknown> | undefined) ?? {};
  const isrId = (data.isr_id as string | undefined) ?? "(unknown)";

  return `[DIALECTICA:evaluate-request — IVSP role]
ISR ID: ${isrId}

ANSWER TO VERIFY:
${prettyJson(answerData)}

${metadata?.verificationRules ? `Verification rules summary:\n${prettyJson(metadata.verificationRules)}\n` : ""}
Evaluate your fitness to verify this answer.
- Score 0 if outside your capability.
- Score 41-70 for moderate fit.
- Score 71-100 for strong verification confidence.

Respond with ONLY valid JSON — no prose, no markdown, no code fences:
{"score": <integer 0-100>}`;
}

// ─── ISP execution prompt ─────────────────────────────────────────────────────

/**
 * Build an ISP execution prompt. The agent must output a valid ISOResult JSON object.
 */
export function buildISPExecutionPrompt(
  opportunity: Opportunity,
  cachedConfig: CachedConfig,
): string {
  const { data, arenaContext } = opportunity;
  const question = (data.content as string | undefined) ?? "(no content)";
  const arenaId = (data.arenaId as string | undefined) ?? "(unknown)";
  const attachments = (data.attachments as unknown[] | undefined) ?? [];

  const outputSchemaSource = prettyJson(data.outputSchema);

  return `[DIALECTICA:execute-job — ISP role]
Arena: ${arenaId}
${attachments.length > 0 ? `Attachments: ${prettyJson(attachments)}\n` : ""}
QUESTION:
${question}

ARENA CONTEXT:
${formatArenaContext(arenaContext)}

━━━ YOUR TASK ━━━
You are an Intelligence Synthesis Provider (ISP). Produce a comprehensive, well-reasoned answer.

Requirements:
- Address the question directly and completely
- Cite sources for factual claims (include URLs where possible)
- Show reproducible reasoning and calculations where relevant
- Make your answer independently verifiable

━━━ OUTPUT FORMAT ━━━
Respond with ONLY a valid JSON object matching the ISOResult schema below.
No prose. No markdown code fences. Raw JSON only.

Structured answer schema:
${outputSchemaSource}

The \`structured_data\` field must conform to the Structured answer schema shown above.

Example of a valid response:
{
  "structured_data": { ... Structured answer ... },
  "metadata": {
    "generation_method": "llm",
    "model_info": "claude",
    "generation_time_ms": 0,
    "total_tokens": 0
  }
}`;
}

// ─── IVSP execution prompt ────────────────────────────────────────────────────

/**
 * Build an IVSP execution prompt. The agent must output a valid VFPResult JSON object.
 */
export function buildIVSPExecutionPrompt(
  opportunity: Opportunity,
  cachedConfig: CachedConfig,
): string {
  const { data, arenaContext } = opportunity;
  const answerData = (data.structured_data as Record<string, unknown> | undefined) ?? {};

  const vfpSchemaSource = cachedConfig.vfpResultSchema ?? VFP_RESULT_SCHEMA_JSON;

  const isrContent = data.content;

  return `[DIALECTICA:execute-job — IVSP role]

ORIGINAL QUESTION (ISR):
${isrContent}

ANSWER TO VERIFY:
${prettyJson(answerData)}

ARENA CONTEXT:
${formatArenaContext(arenaContext)}

━━━ YOUR TASK ━━━
You are an Intelligence Verification Service Provider (IVSP). Perform independent, trustless verification.
Execute the full pipeline in order, stopping early if a stage fails:

STAGE 0 — Surprise Gauge
- If this is the Pioneer answer (first ISO for this ISR): auto-pass, pioneer=true
- Otherwise: estimate surprise_percent = fraction of claims NOT predictable from prior answers
- Pass if pioneer OR surprise_percent >= 15. Fail if surprise_percent < 15.
- If fail → return schema_kind "surprise_gauge_fail" immediately

STAGE 1 — Arena Answer Rules Compliance
- Check every rule in answerRules
- If any violated → return schema_kind "compliance_failure" with compliance_stage "arena"

STAGE 2 — Customer Requirements Compliance
- Verify the answer satisfies all requirements in the ISR question
- If any violated → return schema_kind "compliance_failure" with compliance_stage "customer"

STAGE 3 — NIU Assessment (Novelty, Inventiveness, Utility)
- Triage first: does the question demand novelty AND does the answer exhibit novelty?
  - If NO to either → NIU-exempt, triggered=false → return schema_kind "verified"
  - If YES to both → run all 7 phases under PRESUMPTION OF GUILT:
    0. Atomic Deconstruction
    1. Mechanism Taxonomy
    2. Equivalence-Class Attack
    3. Generative Engineer Attack
    4. Graham-Factor Obviousness
    5. Hunter-Killer Prior Art Search (use web search if available)
    6. Physics/Logic Torture Test
  - Verdict "niu" → overall_verdict "inventive", protection_eligible=true
  - Verdict "not-niu" → overall_verdict "supported"

On technical failure at any stage → return schema_kind "inconclusive"

━━━ OUTPUT FORMAT ━━━
Respond with ONLY a valid JSON object matching the VFPResult schema below.
No prose. No markdown code fences. Raw JSON only.
Choose the correct schema_kind variant: "verified" | "compliance_failure" | "surprise_gauge_fail" | "inconclusive"

VFPResult schema:
${vfpSchemaSource}

Key rules:
- overall_verdict: "supported" | "inventive" | "refuted" | "inconclusive"
- protection_eligible: true ONLY when overall_verdict is "inventive"
- All required fields must be present — missing fields cause server-side validation failure
- Placeholder for unreached stages: arena_compliance={compliant:true,errors:[],suggestions:[]}
  customer_compliance={compliant:true,criteria_checked:[],feedback:null}
  niu_assessment={triggered:false}`;
}
