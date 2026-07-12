#!/usr/bin/env node
/**
 * Oculory CLI (docs/09). Exit codes:
 *   0 success · 1 usage/validation error · 2 regression detected (run/compare)
 *   3 internal error
 * `--json` on reporting commands emits machine-readable output for CI.
 */
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { Store, EXTERNAL_RUNS_SUBDIR, LIVE_RUNS_SUBDIR, MODEL_RUNS_SUBDIR } from '../pipeline/store.js';
import { RunStore } from '../pipeline/run-store.js';
import {
  DEFAULT_LIVE_RUNS_ROOT,
  buildRunManifest,
  prepareRunDir,
  resolveRunDir,
  runIdFor,
  updateManifestForAppend,
  type RunWriteMode,
} from '../pipeline/run-context.js';
import { SCENARIOS, scenarioById } from '../runner/catalogue.js';
import { DEFAULT_POLICIES, policyById, type AgentPolicy } from '../runner/policies.js';
import { recordSession } from '../runner/record.js';
import { ModelPolicy, OpenAiClient, DEFAULT_BUDGET_USD, DEFAULT_MODEL } from '../runner/model-policy.js';
import { verifyOutcome } from '../pipeline/verify.js';
import { normalizeTrace } from '../pipeline/normalize.js';
import { mineAll } from '../pipeline/mine.js';
import { annotateCandidates, renderReviewMarkdown } from '../pipeline/candidate-risk.js';
import { approveAllStable, approveOne } from '../pipeline/approval.js';
import {
  runModelExperiment,
  runModelReplay,
  runModelSmoke,
  type PartitionSelector,
} from '../pipeline/model-run.js';
import { compileSuite, compareRuns, replaySuite, runSchemaSmokeBaseline } from '../pipeline/run.js';
import { loadFixture, runExperiment } from '../pipeline/experiment.js';
import { assessRecordingInstability, type RecordingInstabilityResult } from '../pipeline/instability.js';
import { MUTATIONS } from '../server/mutations.js';
import { DemoServer } from '../server/tools.js';
import { flagsFor } from '../server/mutations.js';
import { InProcessEndpoint } from '../mcp/mcp.js';
import type { ApprovedSuite, CandidateTest, JsonObject, RawTrace } from '../schema/types.js';
// --- Phase 4: filesystem validation target (docs/26). Additive; nothing above changes. ---
import { FS_SCENARIOS } from '../examples/filesystem/scenarios.js';
import { FS_MUTATIONS } from '../examples/filesystem/mutations.js';
import { FsServer } from '../examples/filesystem/server.js';
import { runFsExperiment } from '../examples/filesystem/experiment.js';
import { verifyAndNormalizeAllFs } from '../examples/filesystem/run.js';
import { recordFsSession } from '../examples/filesystem/record.js';
import { FS_DEFAULT_POLICIES } from '../examples/filesystem/policy.js';
import { runFsModelSmoke, runFsModelExperiment, runFsModelReplay } from '../examples/filesystem/model-run.js';
// --- Phase 5: issue-tracker validation target (docs/28). Additive; nothing above changes. ---
import { ISSUE_SCENARIOS } from '../examples/issuetracker/scenarios.js';
import { ISSUE_MUTATIONS } from '../examples/issuetracker/mutations.js';
import { IssueTrackerServer } from '../examples/issuetracker/server.js';
import { runIssueExperiment } from '../examples/issuetracker/experiment.js';
import { verifyAndNormalizeAllIssues } from '../examples/issuetracker/run.js';
import { recordIssueSession } from '../examples/issuetracker/record.js';
import { ISSUE_DEFAULT_POLICIES } from '../examples/issuetracker/policy.js';
import { runIssueModelSmoke, runIssueModelExperiment, runIssueModelReplay } from '../examples/issuetracker/model-run.js';

const argv = process.argv.slice(2);
const command = argv[0] ?? 'help';
const flags = new Map<string, string | boolean>();
const positional: string[] = [];
for (let i = 1; i < argv.length; i++) {
  const a = argv[i]!;
  if (a.startsWith('--')) {
    const eq = a.indexOf('=');
    if (eq > -1) flags.set(a.slice(2, eq), a.slice(eq + 1));
    else if (i + 1 < argv.length && !argv[i + 1]!.startsWith('--')) flags.set(a.slice(2), argv[++i]!);
    else flags.set(a.slice(2), true);
  } else positional.push(a);
}

const store = new Store(String(flags.get('store') ?? '.oculory'));
const fixturePath = String(flags.get('fixture') ?? defaultFixture());
const asJson = flags.get('json') === true;
/** The exact invocation, stamped onto run manifests for reproducibility (docs/24). Declared
 *  before `main()` runs — main()'s synchronous model-* cases read this before any `await`. */
const commandLine = `oculory ${argv.join(' ')}`;

function defaultFixture(): string {
  for (const p of ['fixtures/seed.json', join(import.meta.dirname ?? '.', '..', '..', '..', 'fixtures', 'seed.json')]) {
    if (existsSync(p)) return p;
  }
  return 'fixtures/seed.json';
}

function out(human: string, machine?: JsonObject): void {
  if (asJson && machine) process.stdout.write(JSON.stringify(machine, null, 2) + '\n');
  else process.stdout.write(human + '\n');
}

function fail(message: string, code = 1): never {
  process.stderr.write(`oculory: ${message}\n`);
  process.exit(code);
}

// Wrapped in an async main() because `record` (model policy) and `run`/`experiment`
// (which replay/record internally) now await network-capable AgentPolicy.run() calls.
async function main(): Promise<void> {
try {
  switch (command) {
    case 'help':
    case '--help':
      help();
      break;

    case 'init': {
      store.init();
      out(`Initialised store at ${store.root}. Next: oculory doctor`);
      break;
    }

    case 'doctor': {
      type Status = 'ok' | 'warn' | 'FAIL';
      const checks: { status: Status; name: string; hint?: string }[] = [];
      const push = (status: Status, name: string, hint?: string): void => {
        checks.push(hint === undefined ? { status, name } : { status, name, hint });
      };

      // --- hard checks (a FAIL exits 1) ---
      const [major, minor] = process.versions.node.split('.').map(Number);
      push(major! > 22 || (major === 22 && minor! >= 13) ? 'ok' : 'FAIL', `node ${process.versions.node} (>=22.13)`, 'install Node 22.13+');
      let sqliteOk = false;
      try {
        const server = new DemoServer(flagsFor(null));
        server.domain.reset(loadFixture(fixturePath).rows as never);
        sqliteOk = server.domain.snapshot().rows.length > 0;
        server.domain.close();
      } catch {
        sqliteOk = false;
      }
      push(sqliteOk ? 'ok' : 'FAIL', 'node:sqlite functional', 'run node with --experimental-sqlite (Node <23)');
      push(existsSync(fixturePath) ? 'ok' : 'FAIL', `fixture readable at ${fixturePath}`, 'pass --fixture <path>');

      // --- best-effort checks (never FAIL) ---
      push(existsSync('node_modules') ? 'ok' : 'warn', 'node_modules present', 'run npm install');

      const envPresent = existsSync('.env');
      push(envPresent ? 'warn' : 'ok', envPresent ? '.env present — keys must come from the environment, not a file' : 'no stray .env file', 'delete .env (ensure it is gitignored) and export OPENAI_API_KEY instead');

      let gi = '';
      try {
        gi = readFileSync('.gitignore', 'utf8');
      } catch {
        /* no .gitignore */
      }
      const needed = ['.oculory/', '.oculory-*/', 'dist/', '.env'];
      const missing = needed.filter((n) => !gi.includes(n));
      push(missing.length === 0 ? 'ok' : 'warn', missing.length === 0 ? 'generated output dirs are gitignored' : `.gitignore missing: ${missing.join(', ')}`, 'add the missing entries to .gitignore');

      // git tracked generated files — best-effort; skipped when not a git repo.
      try {
        execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { stdio: ['ignore', 'pipe', 'ignore'] });
        const tracked = execFileSync('git', ['ls-files', 'dist', '.oculory', '.env'], { stdio: ['ignore', 'pipe', 'ignore'] })
          .toString()
          .trim();
        push(tracked.length === 0 ? 'ok' : 'warn', tracked.length === 0 ? 'no generated files tracked in git' : `generated files tracked in git: ${tracked.split('\n').slice(0, 3).join(', ')}…`, 'git rm --cached the generated files');
      } catch {
        push('ok', 'git checks skipped (not a git repository)');
      }

      // OPENAI_API_KEY presence — only when a model command is being prepared; never prints the value.
      const wantsModel = flags.has('model') || flags.has('check-model') || (positional[0]?.startsWith('model-') ?? false);
      if (wantsModel) {
        const keyed = Boolean(process.env.OPENAI_API_KEY);
        push(keyed ? 'ok' : 'warn', `OPENAI_API_KEY present: ${keyed ? 'yes' : 'no'}`, 'export OPENAI_API_KEY=sk-... before running model-* commands');
      }

      const failed = checks.some((c) => c.status === 'FAIL');
      const warned = checks.some((c) => c.status === 'warn');
      const humanLines = checks.map((c) => {
        const label = c.status === 'ok' ? 'ok  ' : c.status === 'warn' ? 'warn' : 'FAIL';
        return `${label}  ${c.name}${c.status !== 'ok' && c.hint ? ` — ${c.hint}` : ''}`;
      });
      humanLines.push(failed ? 'One or more required checks FAILED (see above).' : warned ? 'Environment usable (warnings above). Next: oculory experiment' : 'All checks passed. Next: oculory record --all');
      out(humanLines.join('\n'), { checks, ok: !failed } as unknown as JsonObject);
      if (failed) process.exit(1);
      break;
    }

    case 'inspect': {
      const server = new DemoServer(flagsFor(str('mutation')));
      const tools = new InProcessEndpoint(server).listTools();
      server.domain.close();
      out(tools.map((t) => `${t.name}(${t.params.map((p) => p.name + (p.required ? '' : '?')).join(', ')}) — ${t.description}`).join('\n'),
        { tools } as unknown as JsonObject);
      break;
    }

    case 'scenarios': {
      out(SCENARIOS.map((s) => `${s.scenario_id}  [${s.partition}]  ${s.wording_variants[0]}`).join('\n'),
        { scenarios: SCENARIOS } as unknown as JsonObject);
      break;
    }

    case 'record': {
      const fixture = loadFixture(fixturePath);
      const wanted = flags.get('all') === true
        ? SCENARIOS
        : flags.get('smoke') === true
          ? SCENARIOS.filter((s) => s.partition === 'smoke')
          : positional.map(scenarioById);
      if (wanted.length === 0) fail('nothing to record: pass scenario ids, --smoke, or --all');

      const trials = flags.has('trials') ? Number(flags.get('trials')) : 1;
      if (!Number.isInteger(trials) || trials < 1) fail('--trials must be a positive integer');

      const policyFlag = flags.has('policy') ? String(flags.get('policy')) : null;
      let policies: AgentPolicy[];
      if (policyFlag === null || policyFlag === 'scripted') {
        // Unchanged default: every scripted policy, exactly as before Phase 2.
        policies = DEFAULT_POLICIES;
      } else if (policyFlag === 'model') {
        const apiKey = process.env.OPENAI_API_KEY;
        if (!apiKey) {
          fail(
            'record --policy model requires OPENAI_API_KEY in the environment (never pass a key as a flag or commit one). ' +
              'Run: export OPENAI_API_KEY=sk-... then retry.',
          );
        }
        const model = String(flags.get('model') ?? 'gpt-4.1-mini');
        const budgetUsd = flags.has('budget-usd')
          ? Number(flags.get('budget-usd'))
          : Number(process.env.OCULORY_BUDGET_USD ?? DEFAULT_BUDGET_USD);
        if (!Number.isFinite(budgetUsd) || budgetUsd <= 0) fail('--budget-usd must be a positive number');
        policies = [new ModelPolicy({ client: new OpenAiClient(apiKey), model, budgetUsd })];
      } else {
        policies = [policyById(policyFlag)];
      }

      let n = 0;
      const instabilityGroups: RecordingInstabilityResult[] = [];
      for (const scenario of wanted) {
        for (const policy of policies) {
          const trialTraces: RawTrace[] = [];
          for (let trial = 0; trial < trials; trial++) {
            const raw = await recordSession({
              scenario,
              policy,
              fixture,
              mutationId: str('mutation'),
              trial: trials > 1 ? trial : null,
            });
            store.appendRawTrace(raw);
            trialTraces.push(raw);
            n += 1;
          }
          if (trials > 1) {
            const outcomes = trialTraces.map((t) => verifyOutcome(scenario, t));
            const result = assessRecordingInstability(scenario.scenario_id, policy.id, trialTraces, outcomes);
            instabilityGroups.push(result);
            if (result.unstable) {
              process.stderr.write(`oculory: WARNING recording-time instability — ${scenario.scenario_id} / ${policy.id}: ${result.detail}\n`);
            }
          }
        }
      }
      if (instabilityGroups.length > 0) {
        store.saveJsonReport('recording-instability.json', { groups: instabilityGroups } as unknown as JsonObject);
      }
      const budgetNote = policies[0]?.kind === 'model' && policies[0] instanceof ModelPolicy
        ? ` (spent ~$${policies[0].spentSoFarUsd().toFixed(4)})`
        : '';
      out(`Recorded ${n} traces into ${store.root}/traces/raw.jsonl${budgetNote}. Next: oculory verify`);
      break;
    }

    case 'verify':
    case 'normalize': {
      const st = runDirStore() ?? store;
      const raws = st.loadRawTraces();
      if (raws.length === 0) fail('no raw traces: run `oculory record` first');
      const labels: Record<string, number> = {};
      for (const raw of raws) {
        const outcome = verifyOutcome(scenarioById(raw.scenario_id), raw);
        st.appendOutcome(outcome);
        st.appendNormalizedTrace(normalizeTrace(raw, outcome));
        labels[outcome.label] = (labels[outcome.label] ?? 0) + 1;
      }
      out(`Verified + normalised ${raws.length} traces: ${JSON.stringify(labels)}. Next: oculory mine`, { labels } as JsonObject);
      break;
    }

    case 'mine': {
      const runStore = runDirStore();
      if (runStore) {
        // Isolated run: mine everything except holdout (smoke allowed but flagged),
        // then annotate with provenance/risk so review + approve stay safe.
        const traces = runStore.loadNormalizedTraces().filter((t) => t.partition !== 'holdout');
        if (traces.length === 0) fail('no normalized traces in the run: run `oculory verify --run-dir <dir>` first');
        const candidates = annotateCandidates(mineAll(traces), traces, runStore.loadInstability());
        runStore.saveCandidates(candidates);
        out(
          `Mined ${candidates.length} candidate tests (${candidates.flatMap((c) => c.assertions).filter((a) => a.stable).length} stable) → ${runStore.root}/candidates.json. Next: oculory review --run-dir ${runStore.root}`,
        );
        break;
      }
      const traces = store.loadMiningTraces();
      if (traces.length === 0) fail('no normalized mining traces: run `oculory verify` first');
      const candidates = mineAll(traces);
      store.saveCandidates(candidates);
      out(
        `Mined ${candidates.length} candidate tests (${candidates.flatMap((c) => c.assertions).filter((a) => a.stable).length} stable assertions) → ${store.root}/candidates.json. Next: oculory review`,
      );
      break;
    }

    case 'review': {
      const runStore = runDirStore();
      const st = runStore ?? store;
      const candidates = st.loadCandidates();
      if (candidates.length === 0) fail('no candidates: run `oculory mine` first');
      const lines = candidates.map((c) => {
        const stable = c.assertions.filter((a) => a.stable);
        const rp = c.risk_profile;
        const provenance = rp
          ? [
              `    source: ${rp.source_policies.join(', ') || '—'}  partitions=[${rp.partitions.join(', ')}]  ` +
                `traces=${rp.model_trace_count} model/${rp.scripted_trace_count} scripted`,
              `    safe to approve as a gate: ${rp.safe_to_approve ? 'yes' : 'NO — advisory only'}${rp.mixed_sources ? ' (MIXED sources)' : ''}`,
            ]
          : [];
        return [
          `${c.candidate_id}  [${c.status}]  family=${c.scenario_family}  gate=${c.recommended_gate}`,
          ...provenance,
          ...stable.map((a) => `    ${a.type} ${JSON.stringify(a.params)}  confidence=${a.confidence} support=${a.support}/${a.total}`),
          ...(rp ? rp.risk_flags : c.risk_notes).map((r) => `    ⚠️  ${r}`),
        ].join('\n');
      });
      if (runStore) {
        runStore.saveReport('review.md', renderReviewMarkdown(candidates, `Review — ${runStore.readManifest()?.run_id ?? runStore.root}`));
      }
      out(lines.join('\n') + '\nActions: oculory approve <id>|--all-stable [--allow-smoke|--allow-unstable|--allow-risky] · oculory reject <id> --reason "..."',
        { candidates } as unknown as JsonObject);
      break;
    }

    case 'approve': {
      const st = runDirStore() ?? store;
      const candidates = st.loadCandidates();
      const approveFlags = {
        allowSmoke: flags.get('allow-smoke') === true,
        allowUnstable: flags.get('allow-unstable') === true,
        allowRisky: flags.get('allow-risky') === true,
        reason: String(flags.get('reason') ?? 'approved'),
        reviewedBy: str('reviewed-by'),
      };
      if (flags.get('all-stable') === true) {
        const result = approveAllStable(candidates, approveFlags);
        st.saveCandidates(result.candidates);
        let msg = `Approved: ${result.approved}/${result.candidates.length}. `;
        if (result.blocked.length > 0) {
          msg +=
            `Blocked ${result.blocked.length} candidate(s) pending review (model-safety):\n` +
            result.blocked
              .map((b) => `  ${b.candidate_id}: ${b.reasons.join(', ')} — override with ${b.needs.join(' ')}`)
              .join('\n') +
            '\n';
        }
        out(msg + 'Next: oculory suite');
      } else {
        const id = positional[0] ?? fail('usage: oculory approve <candidate-id> | --all-stable');
        const { result, warnings, found } = approveOne(candidates, id, approveFlags);
        if (!found) fail(`no candidate with id '${id}'`);
        st.saveCandidates(result.candidates);
        for (const w of warnings) process.stderr.write(`oculory: WARNING approving ${id} despite: ${w}\n`);
        out(`Approved ${id}${warnings.length > 0 ? ` (overrode ${warnings.length} warning(s))` : ''}. Next: oculory suite`);
      }
      break;
    }

    case 'reject': {
      const id = positional[0] ?? fail('usage: oculory reject <candidate-id> --reason "..."');
      const reason = String(flags.get('reason') ?? fail('reject requires --reason'));
      const candidates = store.loadCandidates().map((c) =>
        c.candidate_id === id
          ? ({ ...c, status: 'rejected', review: { action: 'reject', reason, at: new Date().toISOString() } } as CandidateTest)
          : c,
      );
      store.saveCandidates(candidates);
      out(`Rejected ${id}.`);
      break;
    }

    case 'suite': {
      const st = runDirStore() ?? store;
      const suite = compileSuite(st.loadCandidates());
      st.saveSuite(suite);
      const suitePath = join(st.root, 'suite.json');
      out(`Compiled ${suite.suite_id} with ${suite.tests.length} tests (hash ${suite.suite_hash.slice(0, 12)}…) → ${suitePath}. Next: oculory run`);
      break;
    }

    case 'run': {
      const suite = store.loadSuite() ?? fail('no suite: run `oculory suite` first');
      const run = await replaySuite(suite, {
        mutationId: str('mutation'),
        fixture: loadFixture(fixturePath),
        partitions: ['mining', 'holdout', 'adversarial'],
      });
      store.saveRun(run);
      const summary = `${run.run_id}: ${run.totals.passed}/${run.totals.tests} passed, ${run.totals.failed} failed`;
      out(summary, run as unknown as JsonObject);
      if (run.totals.failed > 0) process.exit(2);
      break;
    }

    case 'compare': {
      const [baseId, currId] = positional;
      if (!baseId || !currId) fail(`usage: oculory compare <baseline-run-id> <current-run-id>; available: ${store.listRuns().join(', ')}`);
      const cmp = compareRuns(store.loadRun(baseId), store.loadRun(currId));
      const path = store.saveJsonReport(`comparison-${currId}.json`, cmp as unknown as JsonObject);
      out(
        `Regressions: ${cmp.summary.regressed}, improved: ${cmp.summary.improved}, unchanged: ${cmp.summary.unchanged} → ${path}` +
          cmp.regressions.map((r) => `\n  REGRESSION ${r.candidate_id} @ ${r.scenario_id}: ${r.failed_assertions.map((a) => `${a.type}(${a.detail})`).join('; ')}`).join(''),
        cmp as unknown as JsonObject,
      );
      if (cmp.summary.regressed > 0) process.exit(2);
      break;
    }

    case 'mutate': {
      out(MUTATIONS.map((m) => `${m.mutation_id}  [${m.meaningful ? 'meaningful' : 'benign'}]  ${m.description}`).join('\n'),
        { mutations: MUTATIONS } as unknown as JsonObject);
      break;
    }

    case 'baseline': {
      const result = runSchemaSmokeBaseline(str('mutation'), loadFixture(fixturePath));
      out(`schema-smoke-proxy detected=${result.detected} (schema_changed=${result.schema_changed}, smoke_failures=${result.smoke_failures.length})`,
        result as unknown as JsonObject);
      break;
    }

    case 'experiment': {
      const metrics = await runExperiment(store, loadFixture(fixturePath));
      const report = readFileSync(join(store.root, 'reports', 'experiment-report.md'), 'utf8');
      out(report, metrics as unknown as JsonObject);
      break;
    }

    case 'model-smoke': {
      const apiKey = requireApiKey('model-smoke');
      const model = String(flags.get('model') ?? DEFAULT_MODEL);
      const trials = intFlag('trials', 3);
      const budgetUsd = budgetFlag(1);
      const mine = boolFlag('mine', true);
      const rs = openModelRun({ kind: 'model-smoke', model, policyId: `model/openai/${model}`, trials, budgetUsd, partition: 'smoke' });
      const summary = await runModelSmoke(rs, { runId: rs.readManifest()!.run_id, model, trials, budgetUsd, mine }, {
        client: new OpenAiClient(apiKey),
        fixture: loadFixture(fixturePath),
      }).catch((err: unknown) => fail(err instanceof Error ? err.message : String(err)));
      const dir = rs.root;
      const outcomeLines = Object.entries(summary.outcome_counts).map(([k, v]) => `  ${k}: ${v}`).join('\n') || '  (none)';
      out(
        `Model smoke run complete.\n\nRun directory:\n${dir}\n\n` +
          `Traces: ${summary.trace_count}\nOutcomes:\n${outcomeLines}\n` +
          `Unstable scenario groups: ${summary.instability.unstable_groups}/${summary.instability.groups}\n` +
          `Estimated spend: $${summary.spent_usd.toFixed(4)}\n` +
          `Candidates: ${summary.candidate_count} (${summary.risky_candidate_count} risky — none approved)\n\n` +
          `Recommendation: ${summary.recommended_next_step}\nNext:\n` +
          `  inspect ${join(dir, 'reports', 'model-smoke-summary.md')}\n` +
          `  if acceptable, run: oculory model-experiment --model ${model} --trials ${trials} --budget-usd 5 --partition mining`,
        summary as unknown as JsonObject,
      );
      break;
    }

    case 'model-experiment': {
      const apiKey = requireApiKey('model-experiment');
      const model = String(flags.get('model') ?? DEFAULT_MODEL);
      const trials = intFlag('trials', 3);
      const budgetUsd = budgetFlag(5);
      const partitionArg = String(flags.get('partition') ?? 'mining');
      const valid = ['smoke', 'mining', 'holdout', 'adversarial', 'all'];
      if (!valid.includes(partitionArg)) fail(`--partition must be one of: ${valid.join(', ')}`);
      const partition = partitionArg as PartitionSelector;
      const maxScenarios = optIntFlag('max-scenarios');
      const mine = boolFlag('mine', true);
      const review = boolFlag('review', true);
      const rs = openModelRun({
        kind: 'model-experiment', model, policyId: `model/openai/${model}`, trials, budgetUsd, partition, scenarioFilter: maxScenarios ? `max=${maxScenarios}` : null,
      });
      const summary = await runModelExperiment(rs, { runId: rs.readManifest()!.run_id, model, trials, budgetUsd, partition, maxScenarios, mine, review }, {
        client: new OpenAiClient(apiKey),
        fixture: loadFixture(fixturePath),
      }).catch((err: unknown) => fail(err instanceof Error ? err.message : String(err)));
      const dir = rs.root;
      out(
        `Model experiment run complete.\n\nRun directory:\n${dir}\n\n` +
          `Partition: ${summary.partition} · scenarios ${summary.scenario_count} · trials ${summary.trials}\n` +
          `Traces: ${summary.trace_count} (verified ${summary.verified_success_count}, valid_rejection ${summary.valid_rejection_count}, failure ${summary.verified_failure_count}, unknown ${summary.unknown_count})\n` +
          `Unstable scenario groups: ${summary.unstable_scenario_count}\n` +
          `Candidates: ${summary.candidate_count} (${summary.risky_candidate_count} risky — none approved)\n` +
          `Estimated spend: $${summary.spent_usd.toFixed(4)} of $${budgetUsd}\n\n` +
          `Recommendation: ${summary.recommendation}\nNext:\n` +
          `  inspect ${join(dir, 'reports', 'model-experiment-summary.md')}\n` +
          `  review candidates: oculory review --run-dir ${dir}`,
        summary as unknown as JsonObject,
      );
      break;
    }

    case 'model-replay': {
      const apiKey = requireApiKey('model-replay');
      const model = str('model') ?? fail('model-replay requires an explicit --model <name>');
      const suitePath = str('suite') ?? fail('model-replay requires --suite <path-to-suite.json>');
      if (!existsSync(suitePath)) fail(`--suite '${suitePath}' does not exist`);
      const trials = intFlag('trials', 3);
      if (!flags.has('budget-usd')) fail('model-replay requires an explicit --budget-usd <cap>');
      const budgetUsd = budgetFlag(5);
      let suite: ApprovedSuite;
      try {
        suite = JSON.parse(readFileSync(suitePath, 'utf8')) as ApprovedSuite;
      } catch (err) {
        return fail(`could not read suite at '${suitePath}': ${err instanceof Error ? err.message : String(err)}`);
      }
      if (!Array.isArray(suite.tests) || suite.tests.length === 0) fail(`suite '${suitePath}' has no tests`);
      const rs = openModelRun({ kind: 'replay', model, policyId: `model/openai/${model}`, trials, budgetUsd });
      const summary = await runModelReplay(rs, { runId: rs.readManifest()!.run_id, model, trials, budgetUsd, suite }, {
        client: new OpenAiClient(apiKey),
        fixture: loadFixture(fixturePath),
      }).catch((err: unknown) => fail(err instanceof Error ? err.message : String(err)));
      out(
        `Model replay complete.\n\nRun directory:\n${rs.root}\n\n` +
          `Suite: ${summary.suite_id} · trials ${summary.trials}\n` +
          `Totals: ${summary.totals.passed}/${summary.totals.tests} passed · ${summary.totals.failed} failed · ${summary.totals.replay_unstable} replay-unstable\n` +
          `Estimated spend: $${summary.spent_usd.toFixed(4)} of $${budgetUsd}${summary.stopped_on_budget ? ' (STOPPED on budget)' : ''}\n\n` +
          `Recording-time instability and replay-time instability are reported separately (see reports/model-replay-summary.md).`,
        summary as unknown as JsonObject,
      );
      break;
    }

    case 'report': {
      const path = join(store.root, 'reports', 'experiment-report.md');
      if (!existsSync(path)) fail('no experiment report yet: run `oculory experiment`');
      out(readFileSync(path, 'utf8'));
      break;
    }

    case 'clean': {
      // Each irreplaceable evidence root requires its own destructive flag.
      const includeLiveRuns = flags.get('include-live') === true || flags.get('all') === true;
      const includeExternalRuns = flags.get('include-external') === true || flags.get('all') === true;
      const includeModelRuns = flags.get('include-model') === true || flags.get('all') === true;
      const livePath = join(store.root, LIVE_RUNS_SUBDIR);
      const externalPath = join(store.root, EXTERNAL_RUNS_SUBDIR);
      const modelPath = join(store.root, MODEL_RUNS_SUBDIR);
      const preservedLive = !includeLiveRuns && existsSync(livePath);
      const preservedExternal = !includeExternalRuns && existsSync(externalPath);
      const preservedModel = !includeModelRuns && existsSync(modelPath);
      store.clean({ includeLiveRuns, includeExternalRuns, includeModelRuns });
      out(
        `Cleaned ${store.root}` +
          (preservedLive ? ` — preserved ${livePath} (pass --include-live to remove live model run artifacts too)` : '') +
          (preservedExternal ? ` — preserved ${externalPath} (pass --include-external to remove external evidence too)` : '') +
          (preservedModel ? ` — preserved ${modelPath} (pass --include-model to remove offline model evidence too)` : '') +
          '.',
      );
      break;
    }

    /* ===================== Phase 4: filesystem validation target (docs/26) ===================== */

    case 'fs-inspect': {
      const tools = new FsServer('.').toolSpecs();
      out(
        tools.map((t) => `${t.name}(${t.params.map((p) => p.name + (p.required ? '' : '?')).join(', ')}) — ${t.description}`).join('\n'),
        { tools } as unknown as JsonObject,
      );
      break;
    }

    case 'fs-scenarios': {
      out(FS_SCENARIOS.map((s) => `${s.scenario_id}  [${s.partition}]  ${s.wording_variants[0]}`).join('\n'),
        { scenarios: FS_SCENARIOS } as unknown as JsonObject);
      break;
    }

    case 'fs-mutate': {
      out(FS_MUTATIONS.map((m) => `${m.mutation_id}  [${m.meaningful ? 'meaningful' : 'benign'}]  ${m.description}`).join('\n'),
        { mutations: FS_MUTATIONS } as unknown as JsonObject);
      break;
    }

    case 'fs-smoke': {
      const fsStore = new Store(String(flags.get('store') ?? '.oculory-fs'));
      fsStore.clean();
      fsStore.init();
      let n = 0;
      for (const scenario of FS_SCENARIOS.filter((s) => s.partition === 'smoke')) {
        for (const policy of FS_DEFAULT_POLICIES) {
          fsStore.appendRawTrace(await recordFsSession({ scenario, policy, mutationId: str('mutation') }));
          n += 1;
        }
      }
      const { labels } = verifyAndNormalizeAllFs(fsStore);
      out(`Recorded + verified ${n} filesystem smoke traces into ${fsStore.root}: ${JSON.stringify(labels)}. Next: oculory fs-experiment`,
        { labels } as JsonObject);
      break;
    }

    case 'fs-experiment': {
      const fsStore = new Store(String(flags.get('store') ?? '.oculory-fs'));
      const metrics = await runFsExperiment(fsStore);
      const report = readFileSync(join(fsStore.root, 'reports', 'fs-experiment-report.md'), 'utf8');
      out(report, metrics as unknown as JsonObject);
      break;
    }

    case 'fs-report': {
      const fsStore = new Store(String(flags.get('store') ?? '.oculory-fs'));
      const path = join(fsStore.root, 'reports', 'fs-experiment-report.md');
      if (!existsSync(path)) fail('no filesystem experiment report yet: run `oculory fs-experiment`');
      out(readFileSync(path, 'utf8'));
      break;
    }

    case 'fs-model-smoke': {
      const apiKey = requireApiKey('fs-model-smoke');
      const model = String(flags.get('model') ?? DEFAULT_MODEL);
      const trials = intFlag('trials', 3);
      const budgetUsd = budgetFlag(1);
      const mine = boolFlag('mine', true);
      const rs = openModelRun({ kind: 'model-smoke', model, policyId: `model/openai/${model}`, trials, budgetUsd, partition: 'smoke', scenarioFilter: 'target=filesystem', target: 'filesystem' });
      const summary = await runFsModelSmoke(rs, { runId: rs.readManifest()!.run_id, model, trials, budgetUsd, mine }, {
        client: new OpenAiClient(apiKey),
      }).catch((err: unknown) => fail(err instanceof Error ? err.message : String(err)));
      const dir = rs.root;
      const outcomeLines = Object.entries(summary.outcome_counts).map(([k, v]) => `  ${k}: ${v}`).join('\n') || '  (none)';
      out(
        `Filesystem model smoke run complete.\n\nRun directory:\n${dir}\n\n` +
          `Traces: ${summary.trace_count}\nOutcomes:\n${outcomeLines}\n` +
          `Unstable scenario groups: ${summary.instability.unstable_groups}/${summary.instability.groups}\n` +
          `Estimated spend: $${summary.spent_usd.toFixed(4)}\n` +
          `Candidates: ${summary.candidate_count} (${summary.risky_candidate_count} risky — none approved)\n\n` +
          `Recommendation: ${summary.recommended_next_step}\nNext:\n` +
          `  inspect ${join(dir, 'reports', 'model-smoke-summary.md')}\n` +
          `  if acceptable, run: oculory fs-model-experiment --model ${model} --trials ${trials} --budget-usd 5 --partition mining`,
        summary as unknown as JsonObject,
      );
      break;
    }

    case 'fs-model-experiment': {
      const apiKey = requireApiKey('fs-model-experiment');
      const model = String(flags.get('model') ?? DEFAULT_MODEL);
      const trials = intFlag('trials', 3);
      const budgetUsd = budgetFlag(5);
      const partitionArg = String(flags.get('partition') ?? 'mining');
      const valid = ['smoke', 'mining', 'holdout', 'adversarial', 'all'];
      if (!valid.includes(partitionArg)) fail(`--partition must be one of: ${valid.join(', ')}`);
      const partition = partitionArg as PartitionSelector;
      const maxScenarios = optIntFlag('max-scenarios');
      const mine = boolFlag('mine', true);
      const review = boolFlag('review', true);
      const rs = openModelRun({ kind: 'model-experiment', model, policyId: `model/openai/${model}`, trials, budgetUsd, partition, scenarioFilter: `target=filesystem${maxScenarios ? `,max=${maxScenarios}` : ''}`, target: 'filesystem' });
      const summary = await runFsModelExperiment(rs, { runId: rs.readManifest()!.run_id, model, trials, budgetUsd, partition, maxScenarios, mine, review }, {
        client: new OpenAiClient(apiKey),
      }).catch((err: unknown) => fail(err instanceof Error ? err.message : String(err)));
      const dir = rs.root;
      out(
        `Filesystem model experiment run complete.\n\nRun directory:\n${dir}\n\n` +
          `Partition: ${summary.partition} · scenarios ${summary.scenario_count} · trials ${summary.trials}\n` +
          `Traces: ${summary.trace_count} (verified ${summary.verified_success_count}, valid_rejection ${summary.valid_rejection_count}, failure ${summary.verified_failure_count}, unknown ${summary.unknown_count})\n` +
          `Unstable scenario groups: ${summary.unstable_scenario_count}\n` +
          `Candidates: ${summary.candidate_count} (${summary.risky_candidate_count} risky — none approved)\n` +
          `Estimated spend: $${summary.spent_usd.toFixed(4)} of $${budgetUsd}\n\n` +
          `Recommendation: ${summary.recommendation}\nNext:\n` +
          `  inspect ${join(dir, 'reports', 'model-experiment-summary.md')}\n` +
          `  review candidates: oculory review --run-dir ${dir}`,
        summary as unknown as JsonObject,
      );
      break;
    }

    case 'fs-model-replay': {
      const apiKey = requireApiKey('fs-model-replay');
      const model = str('model') ?? fail('fs-model-replay requires an explicit --model <name>');
      const suitePath = str('suite') ?? fail('fs-model-replay requires --suite <path-to-suite.json>');
      if (!existsSync(suitePath)) fail(`--suite '${suitePath}' does not exist`);
      const trials = intFlag('trials', 3);
      if (!flags.has('budget-usd')) fail('fs-model-replay requires an explicit --budget-usd <cap>');
      const budgetUsd = budgetFlag(5);
      let suite: ApprovedSuite;
      try {
        suite = JSON.parse(readFileSync(suitePath, 'utf8')) as ApprovedSuite;
      } catch (err) {
        return fail(`could not read suite at '${suitePath}': ${err instanceof Error ? err.message : String(err)}`);
      }
      if (!Array.isArray(suite.tests) || suite.tests.length === 0) fail(`suite '${suitePath}' has no tests`);
      const rs = openModelRun({ kind: 'replay', model, policyId: `model/openai/${model}`, trials, budgetUsd, scenarioFilter: 'target=filesystem', target: 'filesystem' });
      const summary = await runFsModelReplay(rs, { runId: rs.readManifest()!.run_id, model, trials, budgetUsd, suite }, {
        client: new OpenAiClient(apiKey),
      }).catch((err: unknown) => fail(err instanceof Error ? err.message : String(err)));
      out(
        `Filesystem model replay complete.\n\nRun directory:\n${rs.root}\n\n` +
          `Suite: ${summary.suite_id} · trials ${summary.trials}\n` +
          `Totals: ${summary.totals.passed}/${summary.totals.tests} passed · ${summary.totals.failed} failed · ${summary.totals.replay_unstable} replay-unstable\n` +
          `Estimated spend: $${summary.spent_usd.toFixed(4)} of $${budgetUsd}${summary.stopped_on_budget ? ' (STOPPED on budget)' : ''}\n\n` +
          `Recording-time and replay-time instability are reported separately (see reports/model-replay-summary.md).`,
        summary as unknown as JsonObject,
      );
      break;
    }

    /* ===================== Phase 5: issue-tracker validation target (docs/28) ===================== */

    case 'issue-inspect': {
      const tools = new IssueTrackerServer().toolSpecs();
      out(
        tools.map((t) => `${t.name}(${t.params.map((p) => p.name + (p.required ? '' : '?')).join(', ')}) — ${t.description}`).join('\n'),
        { tools } as unknown as JsonObject,
      );
      break;
    }

    case 'issue-scenarios': {
      out(ISSUE_SCENARIOS.map((s) => `${s.scenario_id}  [${s.partition}]  ${s.wording_variants[0]}`).join('\n'),
        { scenarios: ISSUE_SCENARIOS } as unknown as JsonObject);
      break;
    }

    case 'issue-mutate': {
      out(ISSUE_MUTATIONS.map((m) => `${m.mutation_id}  [${m.meaningful ? 'meaningful' : 'benign'}]  ${m.description}`).join('\n'),
        { mutations: ISSUE_MUTATIONS } as unknown as JsonObject);
      break;
    }

    case 'issue-smoke': {
      const issueStore = new Store(String(flags.get('store') ?? '.oculory-issues'));
      issueStore.clean();
      issueStore.init();
      let n = 0;
      for (const scenario of ISSUE_SCENARIOS.filter((s) => s.partition === 'smoke')) {
        for (const policy of ISSUE_DEFAULT_POLICIES) {
          issueStore.appendRawTrace(await recordIssueSession({ scenario, policy, mutationId: str('mutation') }));
          n += 1;
        }
      }
      const { labels } = verifyAndNormalizeAllIssues(issueStore);
      out(`Recorded + verified ${n} issue-tracker smoke traces into ${issueStore.root}: ${JSON.stringify(labels)}. Next: oculory issue-experiment`,
        { labels } as JsonObject);
      break;
    }

    case 'issue-experiment': {
      const issueStore = new Store(String(flags.get('store') ?? '.oculory-issues'));
      const metrics = await runIssueExperiment(issueStore);
      const report = readFileSync(join(issueStore.root, 'reports', 'issue-experiment-report.md'), 'utf8');
      out(report, metrics as unknown as JsonObject);
      break;
    }

    case 'issue-report': {
      const issueStore = new Store(String(flags.get('store') ?? '.oculory-issues'));
      const path = join(issueStore.root, 'reports', 'issue-experiment-report.md');
      if (!existsSync(path)) fail('no issue-tracker experiment report yet: run `oculory issue-experiment`');
      out(readFileSync(path, 'utf8'));
      break;
    }

    case 'issue-model-smoke': {
      const apiKey = requireApiKey('issue-model-smoke');
      const model = String(flags.get('model') ?? DEFAULT_MODEL);
      const trials = intFlag('trials', 3);
      const budgetUsd = budgetFlag(1);
      const mine = boolFlag('mine', true);
      const rs = openModelRun({ kind: 'model-smoke', model, policyId: `model/openai/${model}`, trials, budgetUsd, partition: 'smoke', scenarioFilter: 'target=issuetracker', target: 'issuetracker' });
      const summary = await runIssueModelSmoke(rs, { runId: rs.readManifest()!.run_id, model, trials, budgetUsd, mine }, {
        client: new OpenAiClient(apiKey),
      }).catch((err: unknown) => fail(err instanceof Error ? err.message : String(err)));
      const dir = rs.root;
      const outcomeLines = Object.entries(summary.outcome_counts).map(([k, v]) => `  ${k}: ${v}`).join('\n') || '  (none)';
      out(
        `Issue-tracker model smoke run complete.\n\nRun directory:\n${dir}\n\n` +
          `Traces: ${summary.trace_count}\nOutcomes:\n${outcomeLines}\n` +
          `Unstable scenario groups: ${summary.instability.unstable_groups}/${summary.instability.groups}\n` +
          `Estimated spend: $${summary.spent_usd.toFixed(4)}\n` +
          `Candidates: ${summary.candidate_count} (${summary.risky_candidate_count} risky — none approved)\n\n` +
          `Recommendation: ${summary.recommended_next_step}\nNext:\n` +
          `  inspect ${join(dir, 'reports', 'model-smoke-summary.md')}\n` +
          `  if acceptable, run: oculory issue-model-experiment --model ${model} --trials ${trials} --budget-usd 5 --partition mining`,
        summary as unknown as JsonObject,
      );
      break;
    }

    case 'issue-model-experiment': {
      const apiKey = requireApiKey('issue-model-experiment');
      const model = String(flags.get('model') ?? DEFAULT_MODEL);
      const trials = intFlag('trials', 3);
      const budgetUsd = budgetFlag(5);
      const partitionArg = String(flags.get('partition') ?? 'mining');
      const valid = ['smoke', 'mining', 'holdout', 'adversarial', 'all'];
      if (!valid.includes(partitionArg)) fail(`--partition must be one of: ${valid.join(', ')}`);
      const partition = partitionArg as PartitionSelector;
      const maxScenarios = optIntFlag('max-scenarios');
      const mine = boolFlag('mine', true);
      const review = boolFlag('review', true);
      const rs = openModelRun({ kind: 'model-experiment', model, policyId: `model/openai/${model}`, trials, budgetUsd, partition, scenarioFilter: `target=issuetracker${maxScenarios ? `,max=${maxScenarios}` : ''}`, target: 'issuetracker' });
      const summary = await runIssueModelExperiment(rs, { runId: rs.readManifest()!.run_id, model, trials, budgetUsd, partition, maxScenarios, mine, review }, {
        client: new OpenAiClient(apiKey),
      }).catch((err: unknown) => fail(err instanceof Error ? err.message : String(err)));
      const dir = rs.root;
      out(
        `Issue-tracker model experiment run complete.\n\nRun directory:\n${dir}\n\n` +
          `Partition: ${summary.partition} · scenarios ${summary.scenario_count} · trials ${summary.trials}\n` +
          `Traces: ${summary.trace_count} (verified ${summary.verified_success_count}, valid_rejection ${summary.valid_rejection_count}, failure ${summary.verified_failure_count}, unknown ${summary.unknown_count})\n` +
          `Unstable scenario groups: ${summary.unstable_scenario_count}\n` +
          `Candidates: ${summary.candidate_count} (${summary.risky_candidate_count} risky — none approved)\n` +
          `Estimated spend: $${summary.spent_usd.toFixed(4)} of $${budgetUsd}\n\n` +
          `Recommendation: ${summary.recommendation}\nNext:\n` +
          `  inspect ${join(dir, 'reports', 'model-experiment-summary.md')}\n` +
          `  review candidates: oculory review --run-dir ${dir}`,
        summary as unknown as JsonObject,
      );
      break;
    }

    case 'issue-model-replay': {
      const apiKey = requireApiKey('issue-model-replay');
      const model = str('model') ?? fail('issue-model-replay requires an explicit --model <name>');
      const suitePath = str('suite') ?? fail('issue-model-replay requires --suite <path-to-suite.json>');
      if (!existsSync(suitePath)) fail(`--suite '${suitePath}' does not exist`);
      const trials = intFlag('trials', 3);
      if (!flags.has('budget-usd')) fail('issue-model-replay requires an explicit --budget-usd <cap>');
      const budgetUsd = budgetFlag(5);
      let suite: ApprovedSuite;
      try {
        suite = JSON.parse(readFileSync(suitePath, 'utf8')) as ApprovedSuite;
      } catch (err) {
        return fail(`could not read suite at '${suitePath}': ${err instanceof Error ? err.message : String(err)}`);
      }
      if (!Array.isArray(suite.tests) || suite.tests.length === 0) fail(`suite '${suitePath}' has no tests`);
      const rs = openModelRun({ kind: 'replay', model, policyId: `model/openai/${model}`, trials, budgetUsd, scenarioFilter: 'target=issuetracker', target: 'issuetracker' });
      const summary = await runIssueModelReplay(rs, { runId: rs.readManifest()!.run_id, model, trials, budgetUsd, suite }, {
        client: new OpenAiClient(apiKey),
      }).catch((err: unknown) => fail(err instanceof Error ? err.message : String(err)));
      out(
        `Issue-tracker model replay complete.\n\nRun directory:\n${rs.root}\n\n` +
          `Suite: ${summary.suite_id} · trials ${summary.trials}\n` +
          `Totals: ${summary.totals.passed}/${summary.totals.tests} passed · ${summary.totals.failed} failed · ${summary.totals.replay_unstable} replay-unstable\n` +
          `Estimated spend: $${summary.spent_usd.toFixed(4)} of $${budgetUsd}${summary.stopped_on_budget ? ' (STOPPED on budget)' : ''}\n\n` +
          `Recording-time and replay-time instability are reported separately (see reports/model-replay-summary.md).`,
        summary as unknown as JsonObject,
      );
      break;
    }

    default:
      fail(`unknown command '${command}' — run \`oculory help\``);
  }
} catch (err) {
  process.stderr.write(`oculory: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(3);
}
}

void main();

function str(name: string): string | null {
  const v = flags.get(name);
  return typeof v === 'string' ? v : null;
}

/** Boolean flag with a default; `--no-<name>` and `--<name> false` both turn it off. */
function boolFlag(name: string, dflt: boolean): boolean {
  if (flags.has(`no-${name}`)) return false;
  const v = flags.get(name);
  if (v === undefined) return dflt;
  if (v === true) return true;
  const s = String(v).toLowerCase();
  return !(s === 'false' || s === '0' || s === 'no' || s === 'off');
}

function intFlag(name: string, dflt: number): number {
  if (!flags.has(name)) return dflt;
  const n = Number(flags.get(name));
  if (!Number.isInteger(n) || n < 1) fail(`--${name} must be a positive integer`);
  return n;
}

function optIntFlag(name: string): number | null {
  if (!flags.has(name)) return null;
  const n = Number(flags.get(name));
  if (!Number.isInteger(n) || n < 1) fail(`--${name} must be a positive integer`);
  return n;
}

function budgetFlag(dflt: number): number {
  if (!flags.has('budget-usd')) return dflt;
  const n = Number(flags.get('budget-usd'));
  if (!Number.isFinite(n) || n <= 0) fail('--budget-usd must be a positive number');
  return n;
}

/** --clean / --append / --force select the write mode for an isolated run directory. */
function writeMode(): RunWriteMode {
  if (flags.get('clean') === true) return 'clean';
  if (flags.get('append') === true) return 'append';
  if (flags.get('force') === true) return 'force';
  return 'create';
}

function requireApiKey(command: string): string {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    fail(
      `${command} requires OPENAI_API_KEY in the environment (never pass a key as a flag or commit one). ` +
        'Run: export OPENAI_API_KEY=sk-... then retry.',
    );
  }
  return apiKey;
}

/** Resolve `--run-dir <path>` to a validated RunStore, or null if the flag is absent. */
function runDirStore(): RunStore | null {
  const rd = str('run-dir');
  if (!rd) return null;
  if (!existsSync(rd)) fail(`--run-dir '${rd}' does not exist`);
  const rs = new RunStore(rd);
  if (!rs.readManifest()) fail(`--run-dir '${rd}' is not an oculory run directory (no manifest.json)`);
  return rs;
}

/** Resolve, isolate, and stamp an isolated model run directory + manifest. */
function openModelRun(opts: {
  kind: 'model-smoke' | 'model-experiment' | 'replay';
  model: string;
  policyId: string;
  trials: number;
  budgetUsd: number;
  partition?: string | null;
  scenarioFilter?: string | null;
  /** 'filesystem'/'issuetracker' prefix the run-id (`fs-`/`issue-`) and record the target, so runs never collide across servers. */
  target?: 'task' | 'filesystem' | 'issuetracker';
}): RunStore {
  const mode = writeMode();
  const when = new Date();
  let runId: string;
  let dir: string;
  try {
    const explicit = str('run-id');
    const base = runIdFor(opts.kind, when, explicit);
    const prefix = opts.target === 'filesystem' ? 'fs-' : opts.target === 'issuetracker' ? 'issue-' : '';
    runId = prefix && !explicit ? `${prefix}${base}` : base;
    dir = resolveRunDir({ outDir: str('out-dir'), runId });
    prepareRunDir(dir, mode);
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
  const rs = new RunStore(dir);
  if (mode === 'force') rs.resetTraceOutputs();
  const existing = rs.readManifest();
  if (mode === 'append' && existing) {
    rs.writeManifest(updateManifestForAppend(existing, { when, command: commandLine }));
  } else {
    rs.writeManifest(
      buildRunManifest({
        kind: opts.kind,
        runId,
        rootDir: dir,
        command: commandLine,
        when,
        policyId: opts.policyId,
        model: opts.model,
        provider: 'openai',
        trials: opts.trials,
        budgetUsd: opts.budgetUsd,
        temperature: 0,
        partition: opts.partition ?? null,
        scenarioFilter: opts.scenarioFilter ?? null,
      }),
    );
  }
  return rs;
}

function help(): void {
  process.stdout.write(`oculory — trace-derived regression testing for MCP servers

Pipeline:   record → verify → mine → review → approve → suite → run → compare
Usage:      oculory <command> [flags]

  init                       create the .oculory store
  doctor [--model <name>]    check environment (node, sqlite, fixture, gitignore, .env, key)
  inspect [--mutation id]    list the demo server's tools
  scenarios                  list the scenario catalogue
  record --all|--smoke|<id…> record traffic (flags: --policy scripted|model|<id>, --mutation,
                             --model <name>, --trials N, --budget-usd <cap>; model policy
                             reads OPENAI_API_KEY from the environment only)
  verify [--run-dir <dir>]   verify outcomes + normalise traces
  mine [--run-dir <dir>]     mine candidate assertions (annotated with risk inside a run dir)
  review [--run-dir <dir>]   print the candidate review table (+ provenance/risk in a run dir)
  approve <id>|--all-stable  approve candidates (--reason, --reviewed-by; model-safety flags:
                             --allow-smoke --allow-unstable --allow-risky)
  reject <id> --reason "…"   reject a candidate
  suite [--run-dir <dir>]    compile approved candidates into a versioned suite
  run [--mutation id]        replay the suite (exit 2 on failures)
  compare <base> <current>   diff two runs (exit 2 on regressions)
  mutate                     list available server mutations
  baseline [--mutation id]   run the schema-smoke proxy baseline
  experiment                 full end-to-end scripted experiment + report (unchanged)
  report                     print the latest experiment report
  clean [--include-live] [--include-external] [--include-model]
                             delete scripted contents; evidence roots require their
                             respective flag (or --all for all)

Isolated model runs (require OPENAI_API_KEY; write to ${DEFAULT_LIVE_RUNS_ROOT}/<run-id>/):
  model-smoke --model <name> --trials 3 --budget-usd 1
                             record smoke scenarios, verify, mine (advisory), summarise
  model-experiment --model <name> --trials 3 --budget-usd 5 --partition mining
                             larger controlled run (--partition smoke|mining|holdout|adversarial|all,
                             --max-scenarios N, --mine/--no-mine, --review/--no-review)
  model-replay --suite <path> --model <name> --trials 3 --budget-usd 5
                             replay an approved suite under a model policy

Filesystem validation target (Phase 4, docs/26 — second MCP-like server, sandboxed):
  fs-inspect                 list the filesystem server's tools
  fs-scenarios               list the filesystem scenario catalogue
  fs-mutate                  list the induced filesystem regressions
  fs-smoke [--mutation id]   record+verify the fs smoke scenarios (scripted; writes to .oculory-fs)
  fs-experiment              full scripted fs experiment + induced-regression comparison + report
  fs-report                  print the latest fs experiment report
  fs-model-smoke --model <name> --trials 3 --budget-usd 1
                             isolated model smoke over fs smoke scenarios (needs OPENAI_API_KEY)
  fs-model-experiment --model <name> --trials 3 --budget-usd 5 --partition mining
                             isolated fs model experiment (same partitions/flags as model-experiment)
  fs-model-replay --suite <path> --model <name> --trials 3 --budget-usd 5
                             replay an approved fs suite under a model policy
  (review/approve/suite accept --run-dir <dir> for fs runs too — those commands are server-agnostic)

Issue-tracker validation target (Phase 5, docs/28 — third MCP-like server, local & deterministic):
  issue-inspect              list the issue tracker's tools
  issue-scenarios            list the issue-tracker scenario catalogue
  issue-mutate               list the induced issue-tracker regressions
  issue-smoke [--mutation id]  record+verify the issue smoke scenarios (scripted; writes to .oculory-issues)
  issue-experiment           full scripted issue experiment + induced-regression comparison + report
  issue-report               print the latest issue-tracker experiment report
  issue-model-smoke --model <name> --trials 3 --budget-usd 1
                             isolated model smoke over issue smoke scenarios (needs OPENAI_API_KEY)
  issue-model-experiment --model <name> --trials 3 --budget-usd 5 --partition mining
                             isolated issue model experiment (same partitions/flags as model-experiment)
  issue-model-replay --suite <path> --model <name> --trials 3 --budget-usd 5
                             replay an approved issue suite under a model policy
  (this is a LOCAL simulation — NOT a real GitHub/Linear integration)

Run-isolation flags (model-* commands): --out-dir <path> --run-id <id> --clean --append --force
Global flags: --store <dir> --fixture <path> --json
Exit codes: 0 ok · 1 usage error · 2 regression · 3 internal error
`);
}
