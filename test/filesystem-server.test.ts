import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { relative } from 'node:path';
import { FsServer, fsSnapshot, resolveInside } from '../src/examples/filesystem/server.js';
import { fsFlagsFor } from '../src/examples/filesystem/mutations.js';
import { createSandbox, destroySandbox } from '../src/examples/filesystem/fixtures.js';

function withSandbox(fn: (root: string, server: FsServer) => void, mutationId: string | null = null): void {
  const root = createSandbox();
  try {
    fn(root, new FsServer(root, fsFlagsFor(mutationId)));
  } finally {
    destroySandbox(root);
  }
}

/* ------------------------------- safety --------------------------------- */

test('fs-server: rejects ../ traversal and does NOT read outside the sandbox', () => {
  withSandbox((root, server) => {
    const before = fsSnapshot(root).state_hash;
    const r = server.callTool('read_file', { path: '../secrets.txt' });
    assert.equal(r.status, 'error');
    assert.equal(r.error_code, 'PATH_TRAVERSAL');
    assert.equal(fsSnapshot(root).state_hash, before, 'state unchanged on rejection');
  });
});

test('fs-server: rejects absolute paths', () => {
  withSandbox((_root, server) => {
    const r = server.callTool('read_file', { path: '/etc/hosts' });
    assert.equal(r.status, 'error');
    assert.equal(r.error_code, 'PATH_TRAVERSAL');
  });
});

test('fs-server: rejects writes outside the sandbox and mutates nothing', () => {
  withSandbox((root, server) => {
    const before = fsSnapshot(root).state_hash;
    const r = server.callTool('write_file', { path: '../escape.txt', content: 'x' });
    assert.equal(r.status, 'error');
    assert.equal(r.error_code, 'PATH_TRAVERSAL');
    assert.equal(existsSync(join(root, '..', 'escape.txt')), false, 'nothing written outside root');
    assert.equal(fsSnapshot(root).state_hash, before);
  });
});

test('fs-server: under path_traversal_allowed, resolveInside clamps EVERY input inside the root (incl. mid-path ..)', () => {
  const root = createSandbox();
  try {
    for (const probe of ['../secrets.txt', 'notes/../../secrets.txt', '/etc/hosts', 'a/b/../../../../c.txt', '../'.repeat(6) + 'x']) {
      const abs = resolveInside(root, probe, /* allowTraversal */ true);
      const rel = relative(root, abs);
      assert.ok(rel !== '..' && !rel.startsWith('..') && rel !== '', `'${probe}' clamped to '${rel}' escaped the sandbox`);
    }
  } finally {
    destroySandbox(root);
  }
});

test('fs-server: fsSnapshot never follows a symlink out of the sandbox (no external content)', () => {
  const root = createSandbox();
  const outside = mkdtempSync(join(tmpdir(), 'oculory-fs-outside-'));
  try {
    const outsideFile = join(outside, 'external.txt');
    writeFileSync(outsideFile, 'external content must not be captured\n', 'utf8');
    symlinkSync(outsideFile, join(root, 'linked-external'), 'file');
    const rows = fsSnapshot(root).rows as { path: string; type: string; content?: string }[];
    const link = rows.find((r) => r.path === 'linked-external');
    assert.ok(link, 'symlink appears in the snapshot');
    assert.equal(link!.type, 'symlink', 'recorded as a symlink, not a file');
    assert.equal(link!.content, undefined, 'no external file content is read into the snapshot');
  } finally {
    destroySandbox(root);
    rmSync(outside, { recursive: true, force: true });
  }
});

test('fs-server: rejects a symlink that escapes the sandbox', () => {
  const outside = mkdtempSync(join(tmpdir(), 'oculory-fs-outside-'));
  try {
    writeFileSync(join(outside, 'external.txt'), 'external content must not be read\n', 'utf8');
    withSandbox((root, server) => {
      // A symlink INSIDE the sandbox pointing OUTSIDE it must not be followed.
      symlinkSync(outside, join(root, 'escape-link'), process.platform === 'win32' ? 'junction' : 'dir');
      const r = server.callTool('read_file', { path: 'escape-link/external.txt' });
      assert.equal(r.status, 'error');
      assert.equal(r.error_code, 'PATH_TRAVERSAL');
    });
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

test('fs-server: missing file yields a structured NOT_FOUND, state unchanged', () => {
  withSandbox((root, server) => {
    const before = fsSnapshot(root).state_hash;
    const r = server.callTool('read_file', { path: 'notes/nope.txt' });
    assert.equal(r.status, 'error');
    assert.equal(r.error_code, 'NOT_FOUND');
    assert.equal(fsSnapshot(root).state_hash, before);
  });
});

/* ------------------------------ semantics ------------------------------- */

test('fs-server: copy preserves the source and duplicates content', () => {
  withSandbox((root, server) => {
    const r = server.callTool('copy_file', { from: 'notes/todo.txt', to: 'archive/todo-backup.txt' });
    assert.equal(r.status, 'ok');
    assert.equal(existsSync(join(root, 'notes/todo.txt')), true, 'source kept');
    assert.equal(readFileSync(join(root, 'archive/todo-backup.txt'), 'utf8'), readFileSync(join(root, 'notes/todo.txt'), 'utf8'));
  });
});

test('fs-server: move removes the source and preserves content at the destination', () => {
  withSandbox((root, server) => {
    const original = readFileSync(join(root, 'drafts/plan.md'), 'utf8');
    const r = server.callTool('move_file', { from: 'drafts/plan.md', to: 'archive/plan.md' });
    assert.equal(r.status, 'ok');
    assert.equal(existsSync(join(root, 'drafts/plan.md')), false, 'source removed');
    assert.equal(readFileSync(join(root, 'archive/plan.md'), 'utf8'), original);
  });
});

test('fs-server: append preserves prior content instead of overwriting', () => {
  withSandbox((root, server) => {
    const prior = readFileSync(join(root, 'notes/todo.txt'), 'utf8');
    const r = server.callTool('append_file', { path: 'notes/todo.txt', content: 'Follow up tomorrow.' });
    assert.equal(r.status, 'ok');
    const after = readFileSync(join(root, 'notes/todo.txt'), 'utf8');
    assert.ok(after.startsWith(prior), 'prior content preserved');
    assert.ok(after.includes('Follow up tomorrow.'), 'appended content present');
  });
});

test('fs-server: delete removes only the requested file', () => {
  withSandbox((root, server) => {
    const r = server.callTool('delete_file', { path: 'tmp/old.txt' });
    assert.equal(r.status, 'ok');
    assert.equal(existsSync(join(root, 'tmp/old.txt')), false, 'requested file removed');
    assert.equal(existsSync(join(root, 'tmp/keep.txt')), true, 'sibling untouched');
  });
});

test('fs-server: write overwrites an existing file (default policy)', () => {
  withSandbox((root, server) => {
    const r = server.callTool('write_file', { path: 'reports/q1.txt', content: 'Q1 revised' });
    assert.equal(r.status, 'ok');
    assert.equal(readFileSync(join(root, 'reports/q1.txt'), 'utf8'), 'Q1 revised');
  });
});

test('fs-server: search returns every filename match', () => {
  withSandbox((_root, server) => {
    const r = server.callTool('search_files', { query: 'plan' });
    assert.equal(r.status, 'ok');
    const matches = (r.payload as { matches: string[] }).matches;
    assert.ok(matches.includes('drafts/plan.md') && matches.includes('drafts/plan-archive.md'), `got ${matches.join(', ')}`);
  });
});

/* -------------------------- induced regressions ------------------------- */

test('fs-server: write_silent_noop reports ok but does not write', () => {
  withSandbox((root, server) => {
    const r = server.callTool('write_file', { path: 'notes/meeting.txt', content: 'hello' });
    assert.equal(r.status, 'ok', 'reports success (the defect)');
    assert.equal(existsSync(join(root, 'notes/meeting.txt')), false, 'but nothing is written');
  }, 'write_silent_noop');
});

test('fs-server: move_copies_instead leaves the source behind', () => {
  withSandbox((root, server) => {
    const r = server.callTool('move_file', { from: 'drafts/plan.md', to: 'archive/plan.md' });
    assert.equal(r.status, 'ok');
    assert.equal(existsSync(join(root, 'drafts/plan.md')), true, 'source wrongly left behind');
    assert.equal(existsSync(join(root, 'archive/plan.md')), true);
  }, 'move_copies_instead');
});

test('fs-server: path_traversal_allowed removes the rejection but never leaves the sandbox', () => {
  withSandbox((root, server) => {
    const r = server.callTool('read_file', { path: '../secrets.txt' });
    // The regression is that it no longer REJECTS. It clamps into the sandbox
    // (reads the decoy root/secrets.txt) rather than any real external file.
    assert.equal(r.status, 'ok', 'rejection wrongly removed (the defect)');
    const content = (r.payload as { content: string }).content;
    assert.equal(content, readFileSync(join(root, 'secrets.txt'), 'utf8'), 'clamped inside the sandbox');
  }, 'path_traversal_allowed');
});

test('fs-server: overwrite_policy_changed refuses to overwrite an existing file', () => {
  withSandbox((_root, server) => {
    const r = server.callTool('write_file', { path: 'reports/q1.txt', content: 'x' });
    assert.equal(r.status, 'error');
    assert.equal(r.error_code, 'ALREADY_EXISTS');
  }, 'overwrite_policy_changed');
});

test('fs-server: tool_order_changed reverses tool order but keeps content identical', () => {
  withSandbox((_root, plain) => {
    const mutated = new FsServer('.', fsFlagsFor('tool_order_changed'));
    const plainNames = plain.toolSpecs().map((t) => t.name);
    const mutNames = mutated.toolSpecs().map((t) => t.name);
    assert.notDeepEqual(mutNames, plainNames, 'order differs');
    assert.deepEqual([...mutNames].sort(), [...plainNames].sort(), 'same set of tools');
  });
});
