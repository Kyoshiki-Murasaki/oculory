import { spawn, spawnSync } from 'node:child_process';

export async function runBoundedCommand(command, args, options) {
  const outputMode = options.output ?? 'pipe';
  const grouped = process.platform !== 'win32';
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    detached: grouped,
    shell: false,
    windowsHide: true,
    stdio: outputMode === 'inherit' ? 'inherit' : outputMode === 'ignore' ? 'ignore' : ['ignore', 'pipe', 'pipe'],
  });
  const maximum = options.maxOutputBytes ?? 16 * 1024 * 1024;
  const stdout = [];
  const stderr = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let timedOut = false;
  let outputLimitExceeded = false;
  let terminating = false;
  let forceTimer;

  const terminate = () => {
    if (terminating) return;
    terminating = true;
    signalTree(child.pid, grouped, 'SIGTERM');
    forceTimer = setTimeout(() => signalTree(child.pid, grouped, 'SIGKILL'), 1000);
  };
  const append = (target, chunk, stream) => {
    const current = stream === 'stdout' ? stdoutBytes : stderrBytes;
    const remaining = maximum - current;
    if (remaining > 0) target.push(chunk.subarray(0, remaining));
    if (stream === 'stdout') stdoutBytes += Math.min(chunk.length, Math.max(remaining, 0));
    else stderrBytes += Math.min(chunk.length, Math.max(remaining, 0));
    if (chunk.length > remaining) {
      outputLimitExceeded = true;
      terminate();
    }
  };
  child.stdout?.on('data', (chunk) => append(stdout, chunk, 'stdout'));
  child.stderr?.on('data', (chunk) => append(stderr, chunk, 'stderr'));

  const timer = setTimeout(() => {
    timedOut = true;
    terminate();
  }, options.timeoutMs);
  let status;
  let signal;
  try {
    [status, signal] = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, exitSignal) => resolve([code, exitSignal]));
    });
  } finally {
    clearTimeout(timer);
    if (forceTimer !== undefined) clearTimeout(forceTimer);
  }

  const processGroupAbsent = await removeRemainingTree(child.pid, grouped);
  if (!processGroupAbsent) throw new Error('bounded command left a live process group');
  return {
    status,
    signal,
    stdout: Buffer.concat(stdout).toString('utf8'),
    stderr: Buffer.concat(stderr).toString('utf8'),
    timedOut,
    outputLimitExceeded,
    processGroupAbsent,
  };
}

async function removeRemainingTree(pid, grouped) {
  if (pid === undefined || !grouped) return false;
  if (!groupAlive(pid)) return true;
  signalTree(pid, true, 'SIGKILL');
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    if (!groupAlive(pid)) return true;
  }
  return false;
}

function signalTree(pid, grouped, signal) {
  if (pid === undefined) return;
  if (process.platform === 'win32') {
    if (signal === 'SIGKILL') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    else {
      try { process.kill(pid, signal); } catch (error) { if (!noSuchProcess(error)) throw error; }
    }
    return;
  }
  try {
    process.kill(grouped ? -pid : pid, signal);
  } catch (error) {
    if (!noSuchProcess(error)) throw error;
  }
}

function groupAlive(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return !noSuchProcess(error);
  }
}

function noSuchProcess(error) {
  return error !== null && typeof error === 'object' && 'code' in error && error.code === 'ESRCH';
}
