import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { hashJson } from '../../schema/canonical.js';
import type { Json, JsonObject } from '../../schema/types.js';
import { GIT_SPIKE_SEED_RECIPE_DIGEST } from '../git-spike/fixture.js';
import { GIT_SPIKE_TARGET } from '../git-spike/config.js';
import { GIT_VERIFIER_POLICY_TABLE_DIGEST } from './verifier-policy.js';
import { GIT_GATE_E2_TARGET_WRAPPER_IDS, gitGateE2TargetWrapperBundle } from './gate-e2-wrappers.js';

export const GIT_GATE_E2_MUTATION_REGISTRY_SCHEMA = 'git-gate-e2-mutation-registry-v1' as const;
export const GIT_GATE_E2_MUTATION_REGISTRY_ID = 'git-gate-e2-mutation-registry-v1' as const;
export type GitMutationLayer = 'target' | 'adapter' | 'verifier' | 'transport' | 'fixture';
export type GitMutationClassification = 'harmful' | 'benign_control';

export interface GitGateE2MutationEntry {
  id: string;
  layer: GitMutationLayer;
  classification: GitMutationClassification;
  baseArtifactOrSourceDigest: string;
  mechanism: string;
  mechanismDigest: string;
  intendedEffect: string;
  designatedScenarios: string[];
  expectedVerifierOutcome: string;
  expectedSuiteResult: string;
  expectedLayerSpecificDetection: string;
  trialCount: 3;
  cleanupRequirements: string;
  nonClaim: string;
}

export interface GitGateE2MutationRegistry {
  schema: typeof GIT_GATE_E2_MUTATION_REGISTRY_SCHEMA;
  registryId: typeof GIT_GATE_E2_MUTATION_REGISTRY_ID;
  reviewedBeforeExecution: true;
  frozenTrialCount: 3;
  entries: GitGateE2MutationEntry[];
  harmfulCountsByLayer: Record<GitMutationLayer, number>;
  benignControlCount: 5;
  registryDigest: string;
}

const TARGET_NON_CLAIM = 'Controlled regression simulation bound to the pinned source; not a claim of an upstream vulnerability.';
const GENERAL_NON_CLAIM = 'Controlled Oculory test mutation; not target vulnerability, conformance, security, or production evidence.';

export function buildGitGateE2MutationRegistry(root = process.cwd()): GitGateE2MutationRegistry {
  const sourceDigests: Record<GitMutationLayer, string> = {
    target: GIT_SPIKE_TARGET.installedServerSourceSha256,
    adapter: hashJson({ adapterVersion: 'git-scripted-adapter-v1' }),
    verifier: GIT_VERIFIER_POLICY_TABLE_DIGEST,
    transport: sha256(readFileSync(resolve(root, 'src/mcp/client/stdio-client.ts'))),
    fixture: GIT_SPIKE_SEED_RECIPE_DIGEST,
  };
  const entries = definitions().map((definition): GitGateE2MutationEntry => {
    const mechanismDigest = (GIT_GATE_E2_TARGET_WRAPPER_IDS as readonly string[]).includes(definition.id)
      ? gitGateE2TargetWrapperBundle(definition.id).digest
      : hashJson({ id: definition.id, mechanism: definition.mechanism, version: 1 } as unknown as JsonObject);
    return {
      ...definition,
      baseArtifactOrSourceDigest: sourceDigests[definition.layer],
      mechanismDigest,
      trialCount: 3,
      cleanupRequirements: definition.id === 'fixture/cleanup-residue'
        ? 'Retain the intentional residue finding in evidence, then perform bounded emergency removal.'
        : 'CP-1 or deterministic local-fixture process cleanup; no canonical retry replacement.',
      nonClaim: definition.layer === 'target' || definition.id === 'control/transparent-target-wrapper' || definition.id === 'control/presentation-only-result-prose'
        ? TARGET_NON_CLAIM
        : GENERAL_NON_CLAIM,
    };
  });
  const harmfulCountsByLayer = Object.fromEntries((['target', 'adapter', 'verifier', 'transport', 'fixture'] as const).map((layer) => [
    layer,
    entries.filter((entry) => entry.classification === 'harmful' && entry.layer === layer).length,
  ])) as Record<GitMutationLayer, number>;
  const withoutDigest = {
    schema: GIT_GATE_E2_MUTATION_REGISTRY_SCHEMA,
    registryId: GIT_GATE_E2_MUTATION_REGISTRY_ID,
    reviewedBeforeExecution: true as const,
    frozenTrialCount: 3 as const,
    entries,
    harmfulCountsByLayer,
    benignControlCount: 5 as const,
  };
  return { ...withoutDigest, registryDigest: hashJson(withoutDigest as unknown as Json) };
}

export function validateGitGateE2MutationRegistry(registry: GitGateE2MutationRegistry, root = process.cwd()): void {
  const expected = buildGitGateE2MutationRegistry(root);
  if (registry.schema !== GIT_GATE_E2_MUTATION_REGISTRY_SCHEMA || registry.registryId !== GIT_GATE_E2_MUTATION_REGISTRY_ID) throw new Error('mutation registry identity differs');
  if (registry.reviewedBeforeExecution !== true || registry.frozenTrialCount !== 3) throw new Error('mutation registry was not frozen before execution');
  if (JSON.stringify(registry) !== JSON.stringify(expected)) throw new Error('mutation registry differs from preregistered definitions');
  const ids = registry.entries.map((entry) => entry.id);
  if (new Set(ids).size !== ids.length) throw new Error('mutation registry contains duplicate IDs');
  if (registry.entries.filter((entry) => entry.classification === 'harmful').length !== 34) throw new Error('mutation registry must contain exactly 34 harmful mutations');
  if (registry.entries.filter((entry) => entry.classification === 'benign_control').length !== 5) throw new Error('mutation registry must contain exactly five benign controls');
  if (registry.entries.some((entry) => entry.trialCount !== 3 || entry.designatedScenarios.length === 0)) throw new Error('mutation trial count or designated scenario is incomplete');
}

type Definition = Omit<GitGateE2MutationEntry, 'baseArtifactOrSourceDigest' | 'mechanismDigest' | 'trialCount' | 'cleanupRequirements' | 'nonClaim'>;

function definitions(): Definition[] {
  const harmful = (id: string, layer: GitMutationLayer, mechanism: string, intendedEffect: string, designatedScenarios: string[], expectedVerifierOutcome: string, expectedSuiteResult: string, expectedLayerSpecificDetection: string): Definition => ({
    id, layer, classification: 'harmful', mechanism, intendedEffect, designatedScenarios, expectedVerifierOutcome, expectedSuiteResult, expectedLayerSpecificDetection,
  });
  const control = (id: string, layer: GitMutationLayer, mechanism: string, intendedEffect: string, designatedScenarios: string[]): Definition => ({
    id, layer, classification: 'benign_control', mechanism, intendedEffect, designatedScenarios,
    expectedVerifierOutcome: 'verified_success', expectedSuiteResult: 'pass where suite applies', expectedLayerSpecificDetection: 'no regression detection',
  });
  return [
    harmful('target/add-silent-noop', 'target', 'run-local Python launcher monkey-patches git_add to return success without invoking Git', 'Report add success while leaving the intended index entry unchanged.', ['git-stage-m1'], 'verified_failure', 'fail required selected-index and outcome assertions', 'golden and approved suite'),
    harmful('target/add-wrong-file', 'target', 'run-local Python launcher monkey-patches git_add to edit and stage README.md regardless of the requested file', 'Stage a different tracked entity.', ['git-stage-h1'], 'verified_failure/wrong_entity', 'fail entity/state/outcome assertions', 'golden and approved suite'),
    harmful('target/reset-noop', 'target', 'run-local Python launcher monkey-patches git_reset to return success without resetting', 'Leave the staged overlay in the index.', ['git-reset-h1'], 'verified_failure', 'not applicable to approved families', 'golden verifier'),
    harmful('target/create-branch-wrong-base', 'target', 'run-local Python launcher monkey-patches git_create_branch to use feature/seed', 'Create the requested ref at the wrong commit.', ['git-branch-h1'], 'verified_failure', 'fail selected-ref and outcome assertions', 'golden and approved suite'),
    harmful('target/checkout-wrong-branch', 'target', 'run-local Python launcher monkey-patches git_checkout to select main', 'Do not reach the requested existing branch.', ['git-checkout-h1'], 'verified_failure', 'not applicable to approved families', 'golden verifier'),
    harmful('target/repository-scope-bypass', 'target', 'run-local Python launcher replaces validate_repo_path with a no-op for the registered sibling-repository probe', 'Accept an out-of-scope generated sibling repository.', ['git-outside-repository-a1'], 'invalid_acceptance', 'not applicable to approved families', 'golden verifier and boundary evidence'),
    harmful('target/error-as-success', 'target', 'run-local Python launcher monkey-patches git_show to return ordinary success text for a missing revision', 'Convert a required target error into success.', ['git-missing-revision-a1'], 'invalid_acceptance', 'not applicable to approved families', 'golden verifier'),

    harmful('adapter/files-array-stringified', 'adapter', 'test-only scenario adapter serializes files array as a scalar string', 'Send an invalid argument shape for a valid stage intent.', ['git-stage-h1'], 'verified_failure', 'fail selected-state and outcome assertions', 'approved suite and golden verifier'),
    harmful('adapter/wrong-repo-path', 'adapter', 'test-only scenario adapter substitutes the registered sibling path for the fixture path', 'Route a valid operation to the wrong generated repository.', ['git-stage-m1'], 'verified_failure', 'fail selected-state and outcome assertions', 'golden verifier and boundary evidence'),
    harmful('adapter/stale-tools-cache', 'adapter', 'test-only adapter compares a one-page cached discovery digest against a fresh multi-page discovery', 'Use stale discovery/schema provenance.', ['transport-fixture/tools-list-multi-page'], 'not applicable', 'not applicable', 'discovery provenance mismatch'),
    harmful('adapter/drop-rpc-code', 'adapter', 'test-only adapter removes code -32042 from a retained JSON-RPC error', 'Lose structured RPC error evidence.', ['transport-fixture/json-rpc-error'], 'not applicable', 'not applicable', 'raw-to-normalized result binding'),
    harmful('adapter/ignore-is-error', 'adapter', 'test-only adapter maps an MCP isError result to tool_success', 'Treat a target rejection as success.', ['git-missing-revision-a1'], 'invalid_acceptance', 'not applicable', 'golden verifier'),
    harmful('adapter/duplicate-call', 'adapter', 'test-only adapter emits a second logical git_add operation', 'Duplicate a mutating call.', ['git-stage-m2'], 'verified_failure/duplicate_side_effect', 'fail outcome assertion', 'golden verifier and approved suite'),
    harmful('adapter/swallow-transport-failure', 'adapter', 'test-only adapter fabricates success while retaining a failed transport transcript', 'Hide a classified protocol failure.', ['transport-fixture/malformed-json'], 'unknown', 'not applicable', 'transport transcript integrity'),
    harmful('adapter/wrong-result-normalization', 'adapter', 'test-only adapter maps an existing-branch MCP error to tool_success', 'Normalize an invalid operation as success.', ['git-existing-branch-a1'], 'invalid_acceptance', 'not applicable', 'golden verifier'),

    harmful('verifier/final-hash-only', 'verifier', 'test-only verifier policy ignores journals and inspects only equal initial/final hashes', 'Miss add-then-reset transient mutation.', ['verifier-case/A22'], 'incorrect verified_success under mutation', 'not applicable', 'independent verifier meta-oracle'),
    harmful('verifier/ignore-index', 'verifier', 'test-only verifier policy treats edited worktree bytes as sufficient and ignores index state', 'Miss a silent add no-op.', ['verifier-case/A34'], 'incorrect verified_success under mutation', 'not applicable', 'independent verifier meta-oracle'),
    harmful('verifier/ignore-unexpected-ref', 'verifier', 'test-only verifier policy ignores non-intended ref deltas', 'Miss a wrong or unexpected ref.', ['verifier-case/A12'], 'incorrect verified_success under mutation', 'not applicable', 'independent verifier meta-oracle'),
    harmful('verifier/trust-success-text', 'verifier', 'test-only verifier policy accepts positive server prose without independent state', 'Accept success text with absent state.', ['verifier-case/A34'], 'incorrect verified_success under mutation', 'not applicable', 'independent verifier meta-oracle'),
    harmful('verifier/global-no-tool-rejection', 'verifier', 'test-only verifier policy accepts every no-call refusal', 'Accept no-call evidence where a required tool path is mandatory.', ['verifier-case/A10'], 'incorrect valid_rejection under mutation', 'not applicable', 'independent verifier meta-oracle'),
    harmful('verifier/wrong-entity-selector', 'verifier', 'test-only verifier policy accepts any changed index path or ref', 'Accept a change to the wrong entity.', ['verifier-case/A11'], 'incorrect verified_success under mutation', 'not applicable', 'independent verifier meta-oracle'),
    harmful('verifier/ignore-cleanup', 'verifier', 'test-only verifier policy accepts a residue cleanup proof', 'Pass despite retained fixture residue.', ['verifier-case/A19'], 'incorrect verified_success under mutation', 'not applicable', 'independent verifier meta-oracle'),

    harmful('transport/wrong-response-id', 'transport', 'deterministic protocol fixture returns a valid response under an unmatched ID', 'Break request correlation.', ['transport-fixture/mismatched-response-id'], 'unknown/fail closed', 'not applicable', 'transport integrity'),
    harmful('transport/non-protocol-stdout', 'transport', 'deterministic protocol fixture writes diagnostic prose to stdout', 'Contaminate protocol stdout.', ['transport-fixture/stdout-contamination'], 'unknown/fail closed', 'not applicable', 'transport integrity'),
    harmful('transport/malformed-json', 'transport', 'deterministic protocol fixture emits malformed JSON', 'Break JSON framing/parsing.', ['transport-fixture/malformed-json'], 'unknown/fail closed', 'not applicable', 'transport integrity'),
    harmful('transport/process-crash-after-mutation', 'transport', 'run-local target launcher performs git_add and exits 23 before replying', 'Mutate the index then crash the target process.', ['git-stage-m1'], 'unknown with intended state observed', 'fail no-error/outcome assertion', 'transport integrity plus independent state'),
    harmful('transport/timeout-and-late-response', 'transport', 'deterministic protocol fixture responds after cancellation tombstoning', 'Produce timeout followed by a late response.', ['transport-fixture/late-response-after-cancellation'], 'unknown/fail closed', 'not applicable', 'timeout/cancellation transcript integrity'),
    harmful('transport/cancellation-ignored', 'transport', 'deterministic protocol fixture retains the request and ignores notifications/cancelled', 'Ignore request cancellation until bounded shutdown.', ['transport-fixture/cancellation-ignored'], 'unknown/fail closed', 'not applicable', 'timeout/cancellation and process cleanup'),

    harmful('fixture/reuse-trial-root', 'fixture', 'test-only fixture identity ledger repeats a registered trial root', 'Reuse isolated state across canonical trials.', ['fixture-ledger/root-uniqueness'], 'not applicable', 'not applicable', 'fixture root uniqueness'),
    harmful('fixture/reuse-server-process', 'fixture', 'test-only fixture identity ledger repeats a server process identity', 'Reuse a server process across canonical trials.', ['fixture-ledger/process-uniqueness'], 'not applicable', 'not applicable', 'process uniqueness'),
    harmful('fixture/seed-overlay-omitted', 'fixture', 'test-only scenario removes the required unstaged edit before stage execution', 'Start from an unregistered initial overlay.', ['git-stage-m1'], 'verified_failure or initial-state mismatch', 'fail selected-state and outcome assertions', 'registered initial state and golden verifier'),
    harmful('fixture/outside-sentinel-changed', 'fixture', 'test-only full verifier evidence changes the sibling sentinel', 'Alter the out-of-scope sentinel.', ['verifier-case/A17'], 'verified_failure/state_leakage', 'not applicable', 'sentinel proof'),
    harmful('fixture/cleanup-residue', 'fixture', 'test-only full verifier evidence retains fixture residue', 'Leave registered cleanup residue.', ['verifier-case/A19'], 'verified_failure/cleanup_failure', 'not applicable', 'cleanup proof'),
    harmful('fixture/stale-index-lock', 'fixture', 'test-only fixture snapshot includes .git/index.lock', 'Start or finish with stale Git lock residue.', ['fixture-snapshot/lockfiles'], 'verified_failure or fixture refusal', 'not applicable', 'lockfile inspection'),

    control('control/transparent-target-wrapper', 'target', 'run-local Python launcher delegates to the pinned source without behavior changes', 'Preserve exact target semantics through a transparent wrapper.', ['git-stage-m2']),
    control('control/presentation-only-result-prose', 'target', 'run-local Python launcher delegates git_add then changes only returned prose', 'Change presentation text after preserving semantic state.', ['git-stage-m2']),
    control('control/transport-out-of-order-valid-ids', 'transport', 'deterministic two-request fixture returns the second valid ID before the first', 'Preserve valid request correlation under out-of-order delivery.', ['transport-fixture/out-of-order-valid-ids']),
    control('control/transport-split-and-coalesced-frames', 'transport', 'deterministic fixtures split one frame and coalesce multiple valid frames', 'Preserve framing across chunk boundaries and coalescing.', ['transport-fixture/partial-stdout-chunks', 'transport-fixture/multiple-lines-one-chunk']),
    control('control/transport-notification-interleaving', 'transport', 'deterministic fixture emits a notification before the matching valid response', 'Preserve semantic behavior with an interleaved notification.', ['transport-fixture/notification-interleaved']),
  ];
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
