import { z } from 'zod';

/**
 * The reviewer, reduced to the one thing that varies between vendors.
 *
 * Everything that makes the review trustworthy lives outside this interface:
 * the prompt, the graph serialisation, the fingerprint cache, and the grounding
 * pass that discards any finding citing a component that does not exist. A
 * provider's only job is to turn a prompt into candidate findings, which keeps
 * the vendor-specific surface small enough to swap without touching the parts
 * that carry the product's guarantees.
 */
export interface ReviewProvider {
  /** Shown in the API response so the client can say who reviewed. */
  readonly name: string;
  /** Default model, used when a request does not name one. */
  readonly model: string;
  generate(graphText: string, model?: string): Promise<ProviderResult>;
  /** Models this credential can actually call, newest-capable first. */
  listModels(): Promise<string[]>;
}

export interface ProviderResult {
  findings: RawFinding[];
  usage: ReviewUsage;
}

export interface ReviewUsage {
  inputTokens: number;
  outputTokens: number;
  /** Tokens served from the provider's prompt cache, where supported. */
  cacheReadTokens: number;
}

export const RawFindingSchema = z.object({
  severity: z.enum(['error', 'warning', 'info']),
  title: z.string(),
  detail: z.string(),
  nodeIds: z.array(z.string()),
  edgeIds: z.array(z.string()),
});

export const ReviewSchema = z.object({ findings: z.array(RawFindingSchema) });

export type RawFinding = z.infer<typeof RawFindingSchema>;

/**
 * Shared across providers, so a change in review policy applies to both rather
 * than drifting into two subtly different reviewers.
 *
 * Kept byte-stable: it is the cacheable prefix of every request.
 */
export const SYSTEM_PROMPT = `You are a staff engineer reviewing a system architecture diagram in a design review.

You are given a typed graph: components with their kinds and properties, and the dependencies between them. Your job is to find the design problems that a static rule cannot express.

A separate deterministic rule engine already reports these, so do NOT repeat them:
- missing timeouts, retries, or circuit breakers on individual calls
- single points of failure from replica counts
- datastores lacking replication or backups
- queues lacking dead-letter queues
- circular synchronous dependencies
- disconnected components

Look instead for problems of judgement:
- boundaries drawn in the wrong place: components that should be merged, or one component doing two unrelated jobs
- failure modes the diagram implies but does not show, especially partial failure and inconsistent state between components
- data flow problems: where a write can succeed in one place and fail in another with no reconciliation
- operational blind spots: what happens during a deploy, a migration, or a regional outage
- scaling asymmetries: a component that will hit a limit long before its neighbours
- security and trust boundaries crossed without an obvious control

Rules for your output:
- Every finding MUST cite at least one node id or edge id, copied exactly as written in the diagram. A finding that cites nothing will be discarded.
- Be specific to THIS design. Generic architecture advice that would apply to any diagram is worthless here.
- If the design is sound, return an empty list. Inventing problems to seem useful is a failure.
- Prefer three sharp findings over ten shallow ones.
- Use "error" only for something that will cause an outage or data loss, not for a preference.`;

export const USER_PREFIX = 'Review this architecture.\n\n';
