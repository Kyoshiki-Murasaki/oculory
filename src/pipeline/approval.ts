import type { CandidateTest } from '../schema/types.js';

/**
 * Candidate approval with model-safety gating (Phase 3.5).
 *
 * Legacy scripted candidates have no `risk_profile`, so they behave exactly as
 * before: `approve --all-stable` approves any candidate with a stable
 * assertion. Model-derived candidates (which DO carry a risk_profile) are
 * blocked from bulk approval when they are smoke-only, come from an unstable
 * scenario, or carry other risk flags — unless the operator passes the
 * matching --allow-* override, which is then recorded in the approval record.
 */

export interface ApproveFlags {
  allowSmoke: boolean;
  allowUnstable: boolean;
  allowRisky: boolean;
  reason: string;
  reviewedBy?: string | null;
}

export interface BlockedCandidate {
  candidate_id: string;
  reasons: string[];
  needs: string[];
}

export interface ApproveResult {
  candidates: CandidateTest[];
  approved: number;
  blocked: BlockedCandidate[];
}

interface Gate {
  blocked: string[];
  overridden: string[];
  needs: string[];
}

/** Compute which warning categories block bulk approval and which are overridden. */
function gateFor(candidate: CandidateTest, flags: ApproveFlags): Gate {
  const rp = candidate.risk_profile;
  const blocked: string[] = [];
  const overridden: string[] = [];
  const needs: string[] = [];
  if (!rp) return { blocked, overridden, needs }; // legacy scripted candidate: no gating

  if (rp.smoke_only) {
    if (flags.allowSmoke) overridden.push('smoke_only');
    else {
      blocked.push('smoke_only');
      needs.push('--allow-smoke');
    }
  }
  if (rp.from_unstable_scenario) {
    if (flags.allowUnstable) overridden.push('unstable_scenario');
    else {
      blocked.push('unstable_scenario');
      needs.push('--allow-unstable');
    }
  }
  if (rp.risky) {
    if (flags.allowRisky) overridden.push('risky');
    else {
      blocked.push('risky');
      needs.push('--allow-risky');
    }
  }
  return { blocked, overridden, needs };
}

function approveRecord(flags: ApproveFlags, mode: 'all-stable' | 'single', overridden: string[]): CandidateTest['review'] {
  return {
    action: 'approve',
    reason: flags.reason,
    at: new Date().toISOString(),
    approved_by: flags.reviewedBy ?? null,
    approval_mode: mode,
    overridden_warnings: overridden,
  };
}

/**
 * Bulk-approve every candidate that has a stable assertion AND whose warnings
 * are either absent or fully overridden. Candidates with no stable assertion
 * are rejected (legacy behaviour). Blocked candidates keep status 'candidate'.
 */
export function approveAllStable(candidates: CandidateTest[], flags: ApproveFlags): ApproveResult {
  const blocked: BlockedCandidate[] = [];
  const next = candidates.map((c) => {
    const hasStable = c.assertions.some((a) => a.stable);
    if (!hasStable) {
      return {
        ...c,
        status: 'rejected' as const,
        review: { action: 'reject' as const, reason: 'no stable assertions', at: new Date().toISOString() },
      };
    }
    const gate = gateFor(c, flags);
    if (gate.blocked.length > 0) {
      blocked.push({ candidate_id: c.candidate_id, reasons: gate.blocked, needs: [...new Set(gate.needs)] });
      return c; // left as 'candidate' — deliberately NOT approved
    }
    return { ...c, status: 'approved' as const, review: approveRecord(flags, 'all-stable', gate.overridden) };
  });
  return { candidates: next, approved: next.filter((c) => c.status === 'approved').length, blocked };
}

/**
 * Approve a single named candidate. The human named it explicitly, so it is
 * always approved, but its warnings are surfaced to the caller and recorded as
 * overridden in the approval record.
 */
export function approveOne(
  candidates: CandidateTest[],
  id: string,
  flags: ApproveFlags,
): { result: ApproveResult; warnings: string[]; found: boolean } {
  let found = false;
  let warnings: string[] = [];
  const next = candidates.map((c) => {
    if (c.candidate_id !== id) return c;
    found = true;
    const gate = gateFor(c, flags);
    warnings = [...gate.blocked, ...gate.overridden];
    return { ...c, status: 'approved' as const, review: approveRecord(flags, 'single', warnings) };
  });
  return {
    result: { candidates: next, approved: next.filter((c) => c.status === 'approved').length, blocked: [] },
    warnings,
    found,
  };
}
