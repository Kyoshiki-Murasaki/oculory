import { hashJson } from '../../schema/canonical.js';
import type { Json, JsonObject } from '../../schema/types.js';
import {
  changedIndexPaths,
  changedRefNames,
  diffGitSpikeSnapshots,
  type GitSpikeSnapshot,
  type GitSpikeSnapshotLayer,
} from '../git-spike/snapshot.js';
import {
  GIT_VERIFIER_VERSION,
  type GitVerifierFailureSubtype,
  type GitVerifierInput,
  type GitVerifierOutcome,
  type GitVerifierPostcondition,
  type GitVerifierResult,
} from './verifier-types.js';

interface Finding {
  subtype: GitVerifierFailureSubtype;
  reason: string;
}

interface PostconditionResult {
  id: string;
  passed: boolean;
}

export function verifyGitEvidence(value: unknown): GitVerifierResult {
  try {
    return verifyGitEvidenceInternal(value);
  } catch {
    return finalizeResult(baseResult(
      '<invalid>',
      '<invalid>',
      'unknown',
      'evidence_incomplete',
      ['verifier_input_validation_failed'],
    ));
  }
}

function verifyGitEvidenceInternal(value: unknown): GitVerifierResult {
  if (!isVerifierInput(value)) {
    return finalizeResult(baseResult(
      '<invalid>',
      '<invalid>',
      'unknown',
      'evidence_incomplete',
      ['malformed_verifier_input'],
    ));
  }
  const input = value;
  const reasons = new Set<string>();
  const observedPath = input.calls.map((call) => call.tool);
  const pathMatched = pathIn(input.policy.allowedCallPaths, observedPath);
  const readAndStopMatched = pathIn(input.policy.readAndStopPaths, observedPath);
  const referenceIds = input.evidenceReferences.map((entry) => entry.id);
  const duplicateReferenceIds = duplicates(referenceIds);
  const referenceSet = new Set(referenceIds);
  const unresolvedReferences = uniqueSorted([
    ...input.requiredEvidenceReferences,
    input.initialSnapshotRef,
    input.finalSnapshotRef,
    input.transportEvidenceId,
    input.cleanup.evidenceId,
    input.sentinelEvidenceId,
    ...input.calls.flatMap((call) => [call.evidenceId, call.beforeSnapshotRef, call.afterSnapshotRef]),
  ].filter((id) => !referenceSet.has(id)));
  const declaredMissing = uniqueSorted(input.declaredMissingEvidence);

  const evidenceComplete =
    input.evidenceComplete &&
    input.rawEvidenceRetained &&
    input.initialSnapshot !== null &&
    input.finalSnapshot !== null &&
    duplicateReferenceIds.length === 0 &&
    unresolvedReferences.length === 0 &&
    declaredMissing.length === 0 &&
    journalIsComplete(input);

  if (input.verifierVersion !== GIT_VERIFIER_VERSION) reasons.add('unsupported_verifier_version');
  if (!input.rawEvidenceRetained) reasons.add('raw_evidence_missing');
  if (!input.evidenceComplete) reasons.add('evidence_declared_incomplete');
  if (duplicateReferenceIds.length > 0) reasons.add('duplicate_evidence_ids');
  if (unresolvedReferences.length > 0) reasons.add('unresolved_evidence_references');
  if (!journalIsComplete(input)) reasons.add('journal_incomplete_or_inconsistent');

  const initial = input.initialSnapshot;
  const final = input.finalSnapshot;
  const finalDiff = initial !== null && final !== null ? diffGitSpikeSnapshots(initial, final) : null;
  const changedLayers = finalDiff?.changedLayers ?? [];
  const allowedFinal = new Set(input.policy.allowedFinalChangedLayers);
  const unexpectedChangedLayers = changedLayers.filter((layer) => !allowedFinal.has(layer));
  const postconditions = initial !== null && final !== null
    ? input.policy.postconditions.map((condition) => evaluatePostcondition(condition, initial, final))
    : input.policy.postconditions.map((condition) => ({ id: condition.id, passed: false }));
  const passedPostconditions = postconditions.filter((entry) => entry.passed).map((entry) => entry.id).sort();
  const failedPostconditions = postconditions.filter((entry) => !entry.passed).map((entry) => entry.id).sort();
  const findings: Finding[] = [];

  if (initial !== null && initial.stateHash !== input.policy.registeredInitialStateHash) {
    findings.push({ subtype: 'state_leakage', reason: 'initial_state_mismatch' });
  }
  if (input.sentinelUnchanged === false || input.calls.some((call) =>
    call.stateDiff.sentinelMetadataChanged || call.stateDiff.changedLayers.includes('sibling_boundary'))
  ) {
    findings.push({ subtype: 'state_leakage', reason: 'sibling_or_sentinel_mutation' });
  }
  if (input.cleanup.status === 'residue' || input.cleanup.proof?.passed === false) {
    findings.push({ subtype: 'cleanup_failure', reason: 'proven_cleanup_residue' });
  }

  const counts = countTools(observedPath);
  for (const [tool, count] of Object.entries(counts)) {
    const maximum = input.policy.cardinality.perToolMax[tool];
    if (maximum !== undefined && count > maximum && input.policy.mutatingTools.includes(tool)) {
      findings.push({ subtype: 'duplicate_side_effect', reason: `duplicate_mutating_call:${tool}` });
    }
  }
  if (observedPath.length > input.policy.cardinality.maxTotal) {
    const excessiveMutator = input.calls.find((call) => input.policy.mutatingTools.includes(call.tool));
    if (excessiveMutator !== undefined) {
      findings.push({ subtype: 'duplicate_side_effect', reason: 'call_cardinality_exceeded' });
    }
  }

  for (const call of input.calls) {
    const changed = call.stateDiff.changedLayers;
    if (changed.length === 0) continue;
    if (input.policy.prohibitedTools.includes(call.tool)) {
      findings.push({ subtype: 'prohibited_mutation', reason: `prohibited_tool_mutated:${call.tool}` });
    }
    const allowed = new Set(input.policy.allowedChangedLayersByTool[call.tool] ?? []);
    if (changed.some((layer) => !allowed.has(layer))) {
      findings.push({ subtype: 'prohibited_mutation', reason: `unexpected_intermediate_layer:${call.tool}` });
    }
    if (!input.policy.allowAnyIndexPath) {
      const wrongPaths = changedIndexPaths(call.before, call.after)
        .filter((path) => !input.policy.intendedPaths.includes(path));
      if (wrongPaths.length > 0) {
        findings.push({ subtype: 'wrong_entity', reason: `wrong_index_entity:${wrongPaths.join(',')}` });
      }
    }
    if (!input.policy.allowAnyRef) {
      const wrongRefs = changedRefNames(call.before, call.after)
        .filter((name) => !input.policy.intendedRefs.includes(name));
      if (wrongRefs.length > 0) {
        findings.push({ subtype: 'wrong_entity', reason: `wrong_ref_entity:${wrongRefs.join(',')}` });
      }
    }
  }

  if (unexpectedChangedLayers.length > 0) {
    findings.push({
      subtype: 'prohibited_mutation',
      reason: `unexpected_final_layers:${unexpectedChangedLayers.join(',')}`,
    });
  }
  const anyObservedMutation = input.calls.some((call) => call.stateDiff.changedLayers.length > 0);
  if (!pathMatched && !readAndStopMatched && anyObservedMutation) {
    findings.push({ subtype: 'invalid_recovery', reason: 'wrong_call_path_with_mutation' });
  }

  if (findings.length > 0) {
    let subtype = chooseFailureSubtype(findings);
    if (
      initial !== null && final !== null && initial.stateHash === final.stateHash &&
      findings.some((finding) => ['prohibited_mutation', 'invalid_recovery', 'wrong_entity'].includes(finding.subtype)) &&
      !findings.some((finding) => finding.subtype === 'state_leakage' || finding.subtype === 'cleanup_failure')
    ) {
      subtype = 'transient_mutation';
      reasons.add('prohibited_intermediate_mutation_restored');
    } else if (
      input.transport !== 'completed' &&
      findings.some((finding) => ['prohibited_mutation', 'wrong_entity', 'invalid_recovery'].includes(finding.subtype))
    ) {
      subtype = 'transport_after_mutation';
      reasons.add('transport_failure_after_proven_mutation');
    }
    for (const finding of findings) reasons.add(finding.reason);
    return makeResult('verified_failure', subtype);
  }

  if (input.oracleStatus === 'error') {
    reasons.add('oracle_error');
    return makeResult('unknown', 'oracle_failure');
  }
  if (input.verifierVersion !== GIT_VERIFIER_VERSION || !evidenceComplete) {
    reasons.add('evidence_incomplete');
    return makeResult('unknown', 'evidence_incomplete');
  }
  if (input.cleanup.status === 'unknown' || input.sentinelUnchanged === null) {
    reasons.add('cleanup_or_sentinel_unknown');
    return makeResult('unknown', 'evidence_incomplete');
  }
  if (input.transport !== 'completed') {
    reasons.add(`inconclusive_transport:${input.transport}`);
    return makeResult('unknown', null);
  }
  if (input.calls.some((call) => call.rawResponseClass !== 'valid')) {
    reasons.add('malformed_or_missing_call_result');
    return makeResult('unknown', null);
  }

  const unchanged = finalDiff?.changedLayers.length === 0;
  const cardinalityMatched =
    observedPath.length >= input.policy.cardinality.minTotal &&
    observedPath.length <= input.policy.cardinality.maxTotal &&
    Object.entries(counts).every(([tool, count]) => {
      const maximum = input.policy.cardinality.perToolMax[tool];
      return maximum === undefined || count <= maximum;
    });

  if (input.policy.expectedOperation === 'rejection') {
    if (observedPath.length === 0) {
      if (input.policy.noToolRejectionAllowed && unchanged) {
        reasons.add('scenario_specific_no_tool_rejection');
        return makeResult('valid_rejection', null);
      }
      reasons.add('required_rejection_call_missing');
      return makeResult('verified_failure', 'unexpected_state');
    }
    if (readAndStopMatched && unchanged) {
      reasons.add('scenario_specific_read_and_stop_rejection');
      return makeResult('valid_rejection', null);
    }
    const expectedError = input.calls.some((call) =>
      input.policy.expectedRejectionClasses.includes(call.outcomeClass));
    if (pathMatched && cardinalityMatched && expectedError && unchanged) {
      reasons.add('expected_tool_rejection');
      return makeResult('valid_rejection', null);
    }
    if (input.calls.some((call) => call.outcomeClass === 'tool_success')) {
      reasons.add('rejection_request_accepted');
      return makeResult('invalid_acceptance', null);
    }
    reasons.add('unexpected_rejection_class_or_path');
    return makeResult('verified_failure', 'unexpected_state');
  }

  const allPostconditions = postconditions.length > 0 && failedPostconditions.length === 0;
  const anyPostcondition = passedPostconditions.length > 0;
  if (allPostconditions && pathMatched && cardinalityMatched) {
    if (input.calls.some((call) => !input.policy.expectedSuccessClasses.includes(call.outcomeClass) || call.isError === true)) {
      reasons.add('server_error_flag_overruled_by_complete_state');
    } else {
      reasons.add('independent_state_and_path_verified');
    }
    return makeResult('verified_success', null);
  }
  if (anyPostcondition && failedPostconditions.length > 0) {
    reasons.add('partial_intended_state');
    return makeResult('partial_success', null);
  }
  reasons.add(!pathMatched ? 'unexpected_call_path' : 'intended_state_absent');
  return makeResult('verified_failure', 'unexpected_state');

  function makeResult(
    outcome: GitVerifierOutcome,
    failureSubtype: GitVerifierFailureSubtype | null,
  ): GitVerifierResult {
    const result: GitVerifierResult = {
      verifierVersion: GIT_VERIFIER_VERSION,
      scenarioId: input.scenarioId,
      policyId: input.policy.policyId,
      outcome,
      failureSubtype,
      reasons: uniqueSorted([...reasons]),
      evidenceReferences: uniqueSorted(input.requiredEvidenceReferences),
      callPath: {
        expected: input.policy.allowedCallPaths.map((path) => [...path]),
        observed: observedPath,
        matched: pathMatched,
      },
      state: {
        initialHash: initial?.stateHash ?? null,
        expectedInitialHash: input.policy.registeredInitialStateHash,
        finalHash: final?.stateHash ?? null,
        changedLayers,
        unexpectedChangedLayers,
        passedPostconditions,
        failedPostconditions,
      },
      evidenceCompleteness: {
        complete: evidenceComplete,
        declaredMissing,
        unresolvedReferences,
        duplicateReferenceIds,
      },
      digest: '',
    };
    return finalizeResult(result);
  }
}

function evaluatePostcondition(
  condition: GitVerifierPostcondition,
  initial: GitSpikeSnapshot,
  final: GitSpikeSnapshot,
): PostconditionResult {
  switch (condition.kind) {
    case 'state_unchanged':
      return { id: condition.id, passed: initial.stateHash === final.stateHash };
    case 'state_hash':
      return { id: condition.id, passed: final.stateHash === condition.expected };
    case 'index_entry':
      return {
        id: condition.id,
        passed: (final.index.find((entry) => entry.stage === 0 && entry.path === condition.path)?.objectId ?? null) === condition.objectId,
      };
    case 'ref':
      return {
        id: condition.id,
        passed: (final.refs.find((entry) => entry.name === condition.name)?.objectId ?? null) === condition.objectId,
      };
    case 'symbolic_branch':
      return { id: condition.id, passed: final.symbolicBranch === condition.expected };
    case 'head_object_id':
      return { id: condition.id, passed: final.headObjectId === condition.expected };
    case 'worktree_file_sha256':
      return {
        id: condition.id,
        passed: final.worktree.find((entry) => entry.path === condition.path)?.sha256 === condition.expected,
      };
  }
}

function journalIsComplete(input: GitVerifierInput): boolean {
  const entriesValid = input.calls.every((call, index) => {
    if (call.index !== index) return false;
    if (call.stateDiff.beforeStateHash !== call.before.stateHash) return false;
    if (call.stateDiff.afterStateHash !== call.after.stateHash) return false;
    const recalculated = diffGitSpikeSnapshots(call.before, call.after);
    return hashJson(recalculated as unknown as Json) === hashJson(call.stateDiff as unknown as Json);
  });
  if (!entriesValid) return false;
  if (input.calls.length === 0) return true;
  if (input.initialSnapshot !== null && input.calls[0]!.before.stateHash !== input.initialSnapshot.stateHash) return false;
  for (let index = 1; index < input.calls.length; index += 1) {
    if (input.calls[index - 1]!.after.stateHash !== input.calls[index]!.before.stateHash) return false;
  }
  if (input.finalSnapshot !== null && input.calls.at(-1)!.after.stateHash !== input.finalSnapshot.stateHash) return false;
  return true;
}

function chooseFailureSubtype(findings: readonly Finding[]): GitVerifierFailureSubtype {
  const priority: GitVerifierFailureSubtype[] = [
    'state_leakage',
    'cleanup_failure',
    'duplicate_side_effect',
    'wrong_entity',
    'prohibited_mutation',
    'invalid_recovery',
    'unexpected_state',
  ];
  return priority.find((subtype) => findings.some((finding) => finding.subtype === subtype)) ?? 'unexpected_state';
}

function finalizeResult(result: GitVerifierResult): GitVerifierResult {
  const { digest: _ignored, ...digestInput } = result;
  const digest = hashJson(digestInput as unknown as JsonObject);
  return { ...result, digest };
}

function baseResult(
  scenarioId: string,
  policyId: string,
  outcome: GitVerifierOutcome,
  failureSubtype: GitVerifierFailureSubtype | null,
  reasons: readonly string[],
): GitVerifierResult {
  return {
    verifierVersion: GIT_VERIFIER_VERSION,
    scenarioId,
    policyId,
    outcome,
    failureSubtype,
    reasons: [...reasons].sort(),
    evidenceReferences: [],
    callPath: { expected: [], observed: [], matched: false },
    state: {
      initialHash: null,
      expectedInitialHash: '<unknown>',
      finalHash: null,
      changedLayers: [],
      unexpectedChangedLayers: [],
      passedPostconditions: [],
      failedPostconditions: [],
    },
    evidenceCompleteness: {
      complete: false,
      declaredMissing: ['input'],
      unresolvedReferences: [],
      duplicateReferenceIds: [],
    },
    digest: '',
  };
}

function pathIn(paths: readonly (readonly string[])[], observed: readonly string[]): boolean {
  return paths.some((path) => path.length === observed.length && path.every((tool, index) => tool === observed[index]));
}

function countTools(tools: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const tool of tools) counts[tool] = (counts[tool] ?? 0) + 1;
  return counts;
}

function duplicates(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const duplicate = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicate.add(value);
    seen.add(value);
  }
  return [...duplicate].sort();
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function isVerifierInput(value: unknown): value is GitVerifierInput {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const input = value as Partial<GitVerifierInput>;
  return typeof input.verifierVersion === 'string' &&
    typeof input.scenarioId === 'string' &&
    input.policy !== null && typeof input.policy === 'object' &&
    Array.isArray(input.evidenceReferences) &&
    Array.isArray(input.requiredEvidenceReferences) &&
    Array.isArray(input.calls) &&
    typeof input.initialSnapshotRef === 'string' &&
    typeof input.finalSnapshotRef === 'string' &&
    typeof input.transportEvidenceId === 'string' &&
    typeof input.transport === 'string' &&
    typeof input.oracleStatus === 'string' &&
    input.cleanup !== null && typeof input.cleanup === 'object' &&
    typeof input.sentinelEvidenceId === 'string' &&
    typeof input.rawEvidenceRetained === 'boolean' &&
    typeof input.evidenceComplete === 'boolean' &&
    Array.isArray(input.declaredMissingEvidence);
}
