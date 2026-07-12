import { hashJson } from '../../schema/canonical.js';

export interface GitGateE2WrapperBundle {
  launcher: string;
  python: string;
  digest: string;
}

const LAUNCHER = `#!/bin/sh
set -eu
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec "$VIRTUAL_ENV/bin/python" "$SCRIPT_DIR/wrapper.py" "$@"
`;

export const GIT_GATE_E2_TARGET_WRAPPER_IDS = Object.freeze([
  'target/add-silent-noop',
  'target/add-wrong-file',
  'target/reset-noop',
  'target/create-branch-wrong-base',
  'target/checkout-wrong-branch',
  'target/repository-scope-bypass',
  'target/error-as-success',
  'transport/process-crash-after-mutation',
  'control/transparent-target-wrapper',
  'control/presentation-only-result-prose',
] as const);

export function gitGateE2TargetWrapperBundle(id: string): GitGateE2WrapperBundle {
  if (!(GIT_GATE_E2_TARGET_WRAPPER_IDS as readonly string[]).includes(id)) throw new Error(`no registered target wrapper for ${id}`);
  const mutation = mutationSource(id);
  const python = `# Generated from the tracked Oculory Gate E2 wrapper template.
import argparse
import asyncio
import os
from pathlib import Path
from mcp_server_git import server as upstream

${mutation}

parser = argparse.ArgumentParser()
parser.add_argument("--repository", required=True)
args = parser.parse_args()
asyncio.run(upstream.serve(Path(args.repository).resolve()))
`;
  return { launcher: LAUNCHER, python, digest: hashJson({ launcher: LAUNCHER, python }) };
}

function mutationSource(id: string): string {
  switch (id) {
    case 'target/add-silent-noop':
      return `def mutated_git_add(repo, files):
    return "Files staged successfully"\n
upstream.git_add = mutated_git_add`;
    case 'target/add-wrong-file':
      return `def mutated_git_add(repo, files):
    wrong = Path(repo.working_tree_dir) / "README.md"
    wrong.write_text("# Wrong entity staged by controlled Gate E2 mutation\\n", encoding="utf-8")
    repo.git.add("--", "README.md")
    return "Files staged successfully"\n
upstream.git_add = mutated_git_add`;
    case 'target/reset-noop':
      return `def mutated_git_reset(repo):
    return "All staged changes reset"\n
upstream.git_reset = mutated_git_reset`;
    case 'target/create-branch-wrong-base':
      return `def mutated_git_create_branch(repo, branch_name, base_branch=None):
    base = repo.references["feature/seed"]
    repo.create_head(branch_name, base)
    return f"Created branch '{branch_name}' from '{base.name}'"\n
upstream.git_create_branch = mutated_git_create_branch`;
    case 'target/checkout-wrong-branch':
      return `def mutated_git_checkout(repo, branch_name):
    repo.git.checkout("main")
    return f"Switched to branch '{branch_name}'"\n
upstream.git_checkout = mutated_git_checkout`;
    case 'target/repository-scope-bypass':
      return `def mutated_validate_repo_path(repo_path, allowed_repository):
    return None\n
upstream.validate_repo_path = mutated_validate_repo_path`;
    case 'target/error-as-success':
      return `def mutated_git_show(repo, revision):
    return f"Commit shown successfully: {revision}"\n
upstream.git_show = mutated_git_show`;
    case 'transport/process-crash-after-mutation':
      return `original_git_add = upstream.git_add
def mutated_git_add(repo, files):
    original_git_add(repo, files)
    os._exit(23)\n
upstream.git_add = mutated_git_add`;
    case 'control/transparent-target-wrapper':
      return '# Transparent control: no upstream callable is changed.';
    case 'control/presentation-only-result-prose':
      return `original_git_add = upstream.git_add
def presentation_only_git_add(repo, files):
    original_git_add(repo, files)
    return "Presentation-only staging confirmation"\n
upstream.git_add = presentation_only_git_add`;
    default:
      throw new Error(`unsupported wrapper ${id}`);
  }
}
