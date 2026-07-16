import { gitGateE1Scenario, type GitGateE1Scenario } from './catalogue.js';

/**
 * Materialize the exact test-only adapter mutations registered for Gate E2.
 * Keeping this mechanism beside the registry lets provider-free pilot tooling
 * observe a reviewed regression without depending on repository test files.
 */
export function gitGateE2AdapterScenario(id: string): GitGateE1Scenario {
  if (id === 'adapter/files-array-stringified') {
    const scenario = structuredClone(gitGateE1Scenario('git-stage-h1'));
    scenario.scriptedCalls = scenario.scriptedCalls.map((call) =>
      call.tool === 'git_add'
        ? { ...call, arguments: { files: 'docs/release.md' } }
        : call,
    );
    return scenario;
  }
  if (id === 'adapter/wrong-repo-path') {
    const scenario = structuredClone(gitGateE1Scenario('git-stage-m1'));
    scenario.scriptedCalls = scenario.scriptedCalls.map((call) => ({
      ...call,
      arguments: { ...call.arguments, repo_path: '@sibling_root' },
      reviewedNonFixtureRepositoryPath: true,
      reviewedBoundaryReason: 'nonfixture_repo_path_probe' as const,
    }));
    return scenario;
  }
  if (id === 'adapter/duplicate-call') {
    const scenario = structuredClone(gitGateE1Scenario('git-stage-m2'));
    scenario.scriptedCalls = [...scenario.scriptedCalls, structuredClone(scenario.scriptedCalls[0]!)];
    return scenario;
  }
  if (id === 'adapter/ignore-is-error') return structuredClone(gitGateE1Scenario('git-missing-revision-a1'));
  if (id === 'adapter/wrong-result-normalization') return structuredClone(gitGateE1Scenario('git-existing-branch-a1'));
  throw new Error(`unhandled adapter scenario ${id}`);
}
