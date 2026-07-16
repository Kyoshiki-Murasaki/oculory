import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PILOT_REPORT_SCHEMA_VERSION } from './constants.js';
import { renderPilotDoctorText, runPilotDoctor } from './doctor.js';
import { loadAndValidatePilotReport, sanitizePilotMessage } from './report.js';
import { runPilotWorkflow } from './workflow.js';

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  const repositoryRoot = process.cwd();
  if (command === 'doctor') {
    const outputDirectory = resolve(value(args, '--output') ?? join(tmpdir(), 'oculory pilot doctor output'));
    const result = await runPilotDoctor({
      repositoryRoot,
      outputDirectory,
      ...runtimeOptions(args),
    });
    process.stdout.write(has(args, '--json') ? `${JSON.stringify(result.report, null, 2)}\n` : renderPilotDoctorText(result.report));
    if (!result.report.ok) process.exitCode = 1;
    return;
  }

  if (command === 'run') {
    const outputDirectory = resolve(value(args, '--output') ?? join(tmpdir(), `oculory-pilot-output-${Date.now()}`));
    const controller = cancellationController();
    const result = await runPilotWorkflow({
      repositoryRoot,
      outputDirectory,
      signal: controller.signal,
      ...runtimeOptions(args),
    });
    process.stdout.write(`${JSON.stringify(summary(result.report))}\n`);
    if (result.report.overallResult !== 'passed') process.exitCode = 1;
    return;
  }

  if (command === 'verify-report') {
    const reportPath = value(args, '--report');
    if (reportPath === null) throw new Error('--report is required');
    const report = loadAndValidatePilotReport(resolve(reportPath));
    process.stdout.write(`${JSON.stringify({ valid: true, schemaVersion: report.schemaVersion, overallResult: report.overallResult })}\n`);
    return;
  }

  if (command === 'smoke') {
    await smoke(repositoryRoot, args);
    return;
  }

  throw new Error('usage: pilot <doctor|run|verify-report|smoke>');
}

async function smoke(repositoryRoot: string, args: string[]): Promise<void> {
  const spaces = has(args, '--spaces');
  const base = mkdtempSync(join(tmpdir(), spaces ? 'oculory pilot smoke ' : 'oculory-pilot-smoke-'));
  const outputDirectory = join(base, spaces ? 'output with spaces' : 'output');
  let reportSummary: ReturnType<typeof summary> | null = null;
  try {
    const result = await runPilotWorkflow({
      repositoryRoot,
      outputDirectory,
      ...runtimeOptions(args),
    });
    const verified = loadAndValidatePilotReport(result.reportPath);
    if (verified.overallResult !== 'passed') throw new Error('pilot smoke produced a non-passing report');
    reportSummary = summary(verified);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
  if (existsSync(base)) throw new Error('pilot smoke temporary output was not removed');
  process.stdout.write(`${JSON.stringify({
    smoke: 'passed',
    pathWithSpaces: spaces,
    temporaryOutputsRemoved: true,
    ...reportSummary,
  })}\n`);
}

function runtimeOptions(args: string[]): {
  pythonExecutable?: string;
  targetExecutable?: string;
  gitExecutable?: string;
} {
  const pythonExecutable = value(args, '--python');
  const targetExecutable = value(args, '--target');
  const gitExecutable = value(args, '--git');
  return {
    ...(pythonExecutable === null ? {} : { pythonExecutable: resolve(pythonExecutable) }),
    ...(targetExecutable === null ? {} : { targetExecutable: resolve(targetExecutable) }),
    ...(gitExecutable === null ? {} : { gitExecutable: resolve(gitExecutable) }),
  };
}

function summary(report: ReturnType<typeof loadAndValidatePilotReport> | Awaited<ReturnType<typeof runPilotWorkflow>>['report']) {
  return {
    schemaVersion: PILOT_REPORT_SCHEMA_VERSION,
    overallResult: report.overallResult,
    targetSessions: report.metrics.targetSessions,
    mockProviderSessions: report.metrics.mockProviderSessions,
    mockProviderTurns: report.metrics.mockProviderTurns,
    mcpToolCalls: report.metrics.mcpToolCalls,
    candidates: report.metrics.candidates.total,
    approved: report.metrics.candidates.approved,
    rejected: report.metrics.candidates.rejected,
    replayPassed: report.metrics.replay.passed,
    replaySessions: report.metrics.replay.sessions,
    controlledRegressionDetected: report.metrics.controlledRegression.detected,
    providerCalls: report.providerAccounting.providerCalls,
    providerNetworkCalls: report.providerAccounting.providerNetworkCalls,
    providerCredentialsRead: report.providerAccounting.providerCredentialsRead,
  };
}

function cancellationController(): AbortController {
  const controller = new AbortController();
  process.once('SIGINT', () => controller.abort());
  process.once('SIGTERM', () => controller.abort());
  return controller;
}

function value(args: readonly string[], name: string): string | null {
  const index = args.indexOf(name);
  if (index < 0) return null;
  const result = args[index + 1];
  if (result === undefined || result.startsWith('--')) throw new Error(`${name} requires a value`);
  return result;
}

function has(args: readonly string[], name: string): boolean {
  return args.includes(name);
}

void main().catch((error) => {
  process.stderr.write(`${sanitizePilotMessage(error)}\n`);
  process.exitCode = 1;
});
