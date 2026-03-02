import { z } from "zod";

// ─── Sub-structures ───────────────────────────────────────────────────────────

export const CostInfoSchema = z.object({
  call_count: z.number(),
  total_tokens: z.number(),
  total_prompt_tokens: z.number(),
  total_completion_tokens: z.number(),
  total_cost_usd: z.number(),
  breakdown: z.array(z.unknown()),
  currency: z.literal("USD"),
});

export const EvidenceSchema = z.object({
  type: z.enum(["web", "scholarly", "dataset", "calculation", "simulation", "prototype"]),
  reference: z.string(),
  accessed_at: z.number(),
  excerpt: z.string(),
  confidence: z.number().min(0).max(1),
  contradicts: z.boolean(),
});

export const SurpriseGaugeResultSchema = z.object({
  pioneer: z.boolean(),
  surprise_percent: z.number().nullable(),
  surprise_gauge: z.enum(["pass", "fail"]),
  reasoning: z.string(),
});

export const ArenaComplianceResultSchema = z.object({
  compliant: z.boolean(),
  errors: z.array(z.string()),
  suggestions: z.array(z.string()),
});

export const ArenaCompliancePlaceholder = {
  compliant: true as const,
  errors: [] as string[],
  suggestions: [] as string[],
};

export const CustomerComplianceResultSchema = z.object({
  compliant: z.boolean(),
  criteria_checked: z.array(
    z.object({
      criterion: z.string(),
      met: z.boolean(),
      detail: z.string(),
    }),
  ),
  feedback: z.string().nullable(),
});

export const CustomerCompliancePlaceholder = {
  compliant: true as const,
  criteria_checked: [] as Array<{ criterion: string; met: boolean; detail: string }>,
  feedback: null as null,
};

export const NIUAssessmentResultSchema = z.discriminatedUnion("triggered", [
  z.object({ triggered: z.literal(false) }),
  z.object({
    triggered: z.literal(true),
    verdict: z.enum(["niu", "not-niu"]),
    novelty_score: z.number().min(0).max(100),
    inventiveness_score: z.number().min(0).max(100),
    utility_score: z.number().min(0).max(100),
    reasoning: z.string(),
    prior_art_sources: z.array(z.string()),
  }),
]);

export const VFPMetadataSchema = z.object({
  verification_time_ms: z.number(),
  web_searches_performed: z.number(),
  sources_checked: z.number(),
  cost_info: CostInfoSchema,
  surprise_gauge_ran: z.boolean(),
  arena_compliance_ran: z.boolean(),
  customer_compliance_ran: z.boolean(),
  niu_ran: z.boolean(),
});

// ─── ISOResult ────────────────────────────────────────────────────────────────

export const ISOResultMetadataSchema = z.object({
  generation_method: z.enum(["human", "llm", "hybrid"]),
  model_info: z.string().optional(),
  generation_time_ms: z.number().optional(),
  total_tokens: z.number().optional(),
  cost_info: CostInfoSchema.optional(),
});

export const ISOResultSchema = z.object({
  structured_data: z.record(z.string(), z.unknown()),
  metadata: ISOResultMetadataSchema,
});

export type ISOResult = z.infer<typeof ISOResultSchema>;

// ─── VFPResult variants ───────────────────────────────────────────────────────

// Common fields shared across all VFP variants (niu_assessment defined per-variant)
const vfpBase = {
  evidence: z.array(EvidenceSchema),
  reasoning_summary: z.string(),
  improvement_suggestions: z.string(),
  metadata: VFPMetadataSchema,
  arena_compliance: ArenaComplianceResultSchema,
  protection_eligible: z.boolean(),
};

export const VFPVerifiedSchema = z.object({
  schema_kind: z.literal("verified"),
  overall_verdict: z.enum(["supported", "inventive"]),
  surprise_gauge: SurpriseGaugeResultSchema,
  customer_compliance: CustomerComplianceResultSchema,
  niu_assessment: NIUAssessmentResultSchema,
  confidence: z.number().min(0).max(1),
  ...vfpBase,
});

export const VFPComplianceFailureSchema = z.object({
  schema_kind: z.literal("compliance_failure"),
  overall_verdict: z.literal("refuted"),
  compliance_stage: z.enum(["arena", "customer"]),
  customer_compliance: CustomerComplianceResultSchema,
  niu_assessment: z.object({ triggered: z.literal(false) }),
  protection_eligible: z.literal(false),
  ...vfpBase,
});

export const VFPSurpriseGaugeFailSchema = z.object({
  schema_kind: z.literal("surprise_gauge_fail"),
  overall_verdict: z.literal("refuted"),
  surprise_gauge: SurpriseGaugeResultSchema,
  customer_compliance: CustomerComplianceResultSchema,
  niu_assessment: z.object({ triggered: z.literal(false) }),
  protection_eligible: z.literal(false),
  ...vfpBase,
});

export const VFPInconclusiveSchema = z.object({
  schema_kind: z.literal("inconclusive"),
  overall_verdict: z.literal("inconclusive"),
  customer_compliance: CustomerComplianceResultSchema,
  niu_assessment: z.object({ triggered: z.literal(false) }),
  protection_eligible: z.literal(false),
  ...vfpBase,
});

export const VFPResultSchema = z.discriminatedUnion("schema_kind", [
  VFPVerifiedSchema,
  VFPComplianceFailureSchema,
  VFPSurpriseGaugeFailSchema,
  VFPInconclusiveSchema,
]);

export type VFPResult = z.infer<typeof VFPResultSchema>;

// ─── Validation helpers ───────────────────────────────────────────────────────

export function validateISOResult(
  data: unknown,
): { ok: true; value: ISOResult } | { ok: false; errors: string } {
  const result = ISOResultSchema.safeParse(data);
  if (result.success) return { ok: true, value: result.data };
  return { ok: false, errors: result.error.message };
}

export function validateVFPResult(
  data: unknown,
): { ok: true; value: VFPResult } | { ok: false; errors: string } {
  const result = VFPResultSchema.safeParse(data);
  if (result.success) return { ok: true, value: result.data };
  return { ok: false, errors: result.error.message };
}

// ─── JSON Schema strings for prompt injection ─────────────────────────────────

export const ISO_RESULT_SCHEMA_JSON = JSON.stringify(ISOResultSchema.toJSONSchema(), null, 2);
export const VFP_RESULT_SCHEMA_JSON = JSON.stringify(VFPResultSchema.toJSONSchema(), null, 2);
