import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { sanitizeDiagnostic } from './redact.js';

export interface BoundedProcessOptions {
  argv: readonly [string, ...string[]];
  cwd: string;
  env: Readonly<Record<string, string>>;
  timeoutMs?: number;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
  privateRoots?: readonly string[];
  signal?: AbortSignal;
}

export interface ProcessEvent {
  kind: 'spawned' | 'timeout' | 'cancellation' | 'output_limit' | 'exit' | 'termination';
  monotonic_ms: number;
  detail: string;
}

export interface BoundedProcessResult {
  stdout: string;
  stderr: string;
  stdout_truncated: boolean;
  stderr_truncated: boolean;
  exit_code: number | null;
  signal: NodeJS.Signals | null;
  timed_out: boolean;
  cancelled: boolean;
  output_limit_exceeded: boolean;
  events: ProcessEvent[];
  cleanup: {
    child_exited: boolean;
    process_group_managed: boolean;
    process_group_absent: boolean;
  };
}

export function assertPublicMlpExecutionSupported(platform: NodeJS.Platform = process.platform): void {
  if (platform === 'win32') {
    throw new Error('public MLP execution is unavailable on Windows because descendant process-group cleanup cannot be proven; no child process was started');
  }
}

export async function runBoundedProcess(options: BoundedProcessOptions): Promise<BoundedProcessResult> {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const maxStdoutBytes = options.maxStdoutBytes ?? 64 * 1024;
  const maxStderrBytes = options.maxStderrBytes ?? 64 * 1024;
  assertPositive(timeoutMs, 'timeoutMs');
  assertPositive(maxStdoutBytes, 'maxStdoutBytes');
  assertPositive(maxStderrBytes, 'maxStderrBytes');

  const started = process.hrtime.bigint();
  const events: ProcessEvent[] = [];
  const managedGroup = process.platform !== 'win32';
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(options.argv[0], options.argv.slice(1), {
      cwd: options.cwd,
      env: { ...options.env },
      shell: false,
      detached: managedGroup,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (error) {
    throw new Error(`process spawn failed: ${sanitizeDiagnostic(errorMessage(error), options.privateRoots)}`);
  }

  const addEvent = (kind: ProcessEvent['kind'], detail: string): void => {
    const elapsed = Number((process.hrtime.bigint() - started) / 1_000_000n);
    events.push({ kind, monotonic_ms: elapsed, detail: sanitizeDiagnostic(detail, options.privateRoots) });
  };
  addEvent('spawned', `pid ${child.pid ?? 'unavailable'}`);

  let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  let stdoutTruncated = false;
  let stderrTruncated = false;
  let timedOut = false;
  let cancelled = false;
  let outputLimitExceeded = false;
  let terminating = false;

  const append = (current: Buffer<ArrayBufferLike>, chunk: Buffer<ArrayBufferLike>, limit: number): [Buffer<ArrayBufferLike>, boolean] => {
    if (current.length >= limit) return [current, true];
    const remaining = limit - current.length;
    return [Buffer.concat([current, chunk.subarray(0, remaining)]), chunk.length > remaining];
  };
  const terminate = (reason: 'timeout' | 'cancellation' | 'output_limit'): void => {
    if (terminating) return;
    terminating = true;
    if (reason === 'timeout') {
      timedOut = true;
      addEvent('timeout', `deadline ${timeoutMs}ms exceeded`);
    } else if (reason === 'cancellation') {
      cancelled = true;
      addEvent('cancellation', 'execution cancelled');
    } else {
      outputLimitExceeded = true;
      addEvent('output_limit', 'bounded output limit exceeded');
    }
    signalChild(child, managedGroup, 'SIGTERM');
  };

  child.stdout.on('data', (chunk: Buffer) => {
    [stdout, stdoutTruncated] = append(stdout, chunk, maxStdoutBytes);
    if (stdoutTruncated) terminate('output_limit');
  });
  child.stderr.on('data', (chunk: Buffer) => {
    [stderr, stderrTruncated] = append(stderr, chunk, maxStderrBytes);
    if (stderrTruncated) terminate('output_limit');
  });
  child.stdin.end();

  const timer = setTimeout(() => terminate('timeout'), timeoutMs);
  const onAbort = (): void => terminate('cancellation');
  if (options.signal?.aborted === true) onAbort();
  else options.signal?.addEventListener('abort', onAbort, { once: true });
  let forcedTimer: NodeJS.Timeout | null = null;
  const terminationWatcher = setInterval(() => {
    if (terminating && forcedTimer === null) {
      forcedTimer = setTimeout(() => signalChild(child, managedGroup, 'SIGKILL'), 1_000);
    }
  }, 25);

  let exitCode: number | null = null;
  let signal: NodeJS.Signals | null = null;
  try {
    const [code, exitSignal] = await once(child, 'exit') as [number | null, NodeJS.Signals | null];
    exitCode = code;
    signal = exitSignal;
  } catch (error) {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
    clearInterval(terminationWatcher);
    throw new Error(`process execution failed: ${sanitizeDiagnostic(errorMessage(error), options.privateRoots)}`);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
    clearInterval(terminationWatcher);
    if (forcedTimer !== null) clearTimeout(forcedTimer);
  }

  if (managedGroup && child.pid !== undefined && processGroupAlive(child.pid)) {
    signalChild(child, true, 'SIGKILL');
    await delay(50);
  }
  const groupAbsent = managedGroup && child.pid !== undefined && !processGroupAlive(child.pid);
  addEvent('exit', `code ${exitCode ?? 'null'}, signal ${signal ?? 'none'}`);
  addEvent('termination', groupAbsent ? 'process group absent' : 'process group still live');

  return {
    stdout: stdout.toString('utf8'),
    stderr: stderr.toString('utf8'),
    stdout_truncated: stdoutTruncated,
    stderr_truncated: stderrTruncated,
    exit_code: exitCode,
    signal,
    timed_out: timedOut,
    cancelled,
    output_limit_exceeded: outputLimitExceeded,
    events,
    cleanup: {
      child_exited: child.exitCode !== null || child.signalCode !== null,
      process_group_managed: managedGroup,
      process_group_absent: groupAbsent,
    },
  };
}

function signalChild(child: ChildProcessWithoutNullStreams, group: boolean, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    process.kill(group ? -child.pid : child.pid, signal);
  } catch (error) {
    if (!isNoSuchProcess(error)) throw error;
  }
}

function processGroupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return !isNoSuchProcess(error);
  }
}

function isNoSuchProcess(error: unknown): boolean {
  return error !== null && typeof error === 'object' && 'code' in error && error.code === 'ESRCH';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function assertPositive(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
