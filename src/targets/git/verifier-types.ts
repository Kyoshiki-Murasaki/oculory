import type { JsonObject } from '../../schema/types.js';
import type { GitSpikeCleanupProof } from '../git-spike/fixture.js';
import type {
  GitSpikeCallOutcomeClass,
} from '../git-spike/direct-harness.js';
import type {
  GitSpikeSnapshot,
  GitSpikeSnapshotDiff,
  GitSpikeSnapshotLayer,
} from '../git-spike/snapshot.js';

export const GIT_VERIFIER_VERSION = 'git-verifier-v1' as const;

export type GitVerifierOutcome =
  | 'verified_success'
  | 'valid_rejection'
  | 'verified_failure'
  | 'partial_success'
  | 'invalid_acceptance'
  | 'unknown';

export type GitVerifierFailureSubtype =
  | 'wrong_entity'
  | 'prohibited_mutation'
  | 'duplicate_side_effect'
  | 'invalid_recovery'
  | 'transient_mutation'
  | 'state_leakage'
  | 'cleanup_failure'
  | 'unexpected_state'
  | 'transport_after_mutation'
  | 'oracle_failure'
  | 'evidence_incomplete';

export type GitVerifierTransportClass =
  | 'completed'
  | 'timeout'
  | 'process_crash'
  | 'transport_eof'
  | 'malformed_response';

export type GitVerifierPostcondition =
  | { id: string; kind: 'state_unchanged' }
  | { id: string; kind: 'state_hash'; expected: string }
  | { id: string; kind: 'index_entry'; path: string; objectId: string | null }
  | { id: string; kind: 'ref'; name: string; objectId: string | null }
  | { id: string; kind: 'symbolic_branch'; expected: string }
  | { id: string; kind: 'head_object_id'; expected: string }
  | { id: string; kind: 'worktree_file_sha256'; path: string; expected: string };

export interface GitVerifierCallCardinality {
  minTotal: number;
  maxTotal: number;
  perToolMax: Readonly<Record<string, number>>;
}

export interface GitVerifierPolicy {
  policyId: string;
  expectedOperation: 'success' | 'no_state_success' | 'rejection';
  intendedPaths: readonly string[];
  intendedRefs: readonly string[];
  allowedCallPaths: readonly (readonly string[])[];
  readAndStopPaths: readonly (readonly string[])[];
  prohibitedTools: readonly string[];
  mutatingTools: readonly string[];
  cardinality: GitVerifierCallCardinality;
  expectedSuccessClasses: readonly GitSpikeCallOutcomeClass[];
  expectedRejectionClasses: readonly GitSpikeCallOutcomeClass[];
  noToolRejectionAllowed: boolean;
  registeredInitialStateHash: string;
  postconditions: readonly GitVerifierPostcondition[];
  allowedFinalChangedLayers: readonly GitSpikeSnapshotLayer[];
  allowedChangedLayersByTool: Readonly<Record<string, readonly GitSpikeSnapshotLayer[]>>;
  allowAnyIndexPath: boolean;
  allowAnyRef: boolean;
}

export interface GitVerifierEvidenceReference {
  id: string;
  kind: 'snapshot' | 'journal' | 'call' | 'transport' | 'cleanup' | 'sentinel' | 'raw';
}

export interface GitVerifierCallEvidence {
  evidenceId: string;
  index: number;
  tool: string;
  arguments: JsonObject;
  outcomeClass: GitSpikeCallOutcomeClass;
  isError: boolean | null;
  serverProse: string | null;
  rawResponseClass: 'valid' | 'malformed' | 'missing';
  beforeSnapshotRef: string;
  afterSnapshotRef: string;
  before: GitSpikeSnapshot;
  after: GitSpikeSnapshot;
  stateDiff: GitSpikeSnapshotDiff;
}

export interface GitVerifierCleanupEvidence {
  evidenceId: string;
  status: 'clean' | 'residue' | 'unknown';
  proof: GitSpikeCleanupProof | null;
}

export interface GitVerifierInput {
  verifierVersion: string;
  scenarioId: string;
  policy: GitVerifierPolicy;
  evidenceReferences: readonly GitVerifierEvidenceReference[];
  requiredEvidenceReferences: readonly string[];
  initialSnapshotRef: string;
  initialSnapshot: GitSpikeSnapshot | null;
  calls: readonly GitVerifierCallEvidence[];
  finalSnapshotRef: string;
  finalSnapshot: GitSpikeSnapshot | null;
  transportEvidenceId: string;
  transport: GitVerifierTransportClass;
  oracleStatus: 'complete' | 'error';
  cleanup: GitVerifierCleanupEvidence;
  sentinelEvidenceId: string;
  sentinelUnchanged: boolean | null;
  rawEvidenceRetained: boolean;
  evidenceComplete: boolean;
  declaredMissingEvidence: readonly string[];
}

export interface GitVerifierResult {
  verifierVersion: typeof GIT_VERIFIER_VERSION;
  scenarioId: string;
  policyId: string;
  outcome: GitVerifierOutcome;
  failureSubtype: GitVerifierFailureSubtype | null;
  reasons: readonly string[];
  evidenceReferences: readonly string[];
  callPath: {
    expected: readonly (readonly string[])[];
    observed: readonly string[];
    matched: boolean;
  };
  state: {
    initialHash: string | null;
    expectedInitialHash: string;
    finalHash: string | null;
    changedLayers: readonly GitSpikeSnapshotLayer[];
    unexpectedChangedLayers: readonly GitSpikeSnapshotLayer[];
    passedPostconditions: readonly string[];
    failedPostconditions: readonly string[];
  };
  evidenceCompleteness: {
    complete: boolean;
    declaredMissing: readonly string[];
    unresolvedReferences: readonly string[];
    duplicateReferenceIds: readonly string[];
  };
  digest: string;
}
