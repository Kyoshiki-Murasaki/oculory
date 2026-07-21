export const TASK_SCHEMA_VERSION = 'oculory-task-v1' as const;
export const CONTRACT_SCHEMA_VERSION = 'oculory-contract-v1' as const;

export const PROFILE_PLACEHOLDERS = [
  '{prompt}',
  '{prompt_file}',
  '{mcp_config}',
  '{workspace}',
  '{model}',
  '{run_id}',
] as const;

export const DEFAULT_CONTRACT_TOLERANCE = {
  runs: 12,
  min_pass: 10,
} as const;

export type Json = null | boolean | number | string | Json[] | JsonObject;
export interface JsonObject {
  [key: string]: Json;
}

export interface AgentProfileConfig {
  argv: string[];
  env_allowlist: string[];
  model?: string;
}

export interface McpServerConfig {
  command: string;
  arguments: string[];
  env_allowlist: string[];
}

export type WorkspaceConfig =
  | {
      strategy: 'git-worktree';
      repository: string;
      base_ref?: string;
    }
  | {
      strategy: 'command';
      setup: string[];
      reset: string[];
      cleanup: string[];
    };

export interface TargetConfig {
  id: string;
  adapter: string;
  configuration: JsonObject;
  watch: JsonObject;
}

export type ClaimExtractionConfig =
  | { type: 'stdout-final' }
  | { type: 'json-field'; field: string }
  | { type: 'line-prefix'; prefix: string }
  | { type: 'regex'; pattern: string; max_bytes: number }
  | { type: 'output-file'; path: string; max_bytes: number };

export interface OculoryTaskConfig {
  version: typeof TASK_SCHEMA_VERSION;
  task_id: string;
  prompt: string;
  agent_profiles: Record<string, AgentProfileConfig>;
  mcp_server: McpServerConfig;
  workspace: WorkspaceConfig;
  targets: TargetConfig[];
  claim_extraction: ClaimExtractionConfig;
}

export type ContractOperator = 'exists' | 'equals' | 'count' | 'unchanged' | 'none' | 'subset';
export type EvaluationMode = 'exact' | 'subset' | 'ignore';

export interface ContractTolerance {
  runs: number;
  min_pass: number;
}

export interface ContractAssertion {
  id: string;
  target: string;
  selector: JsonObject;
  operator: ContractOperator;
  expected: Json;
  evaluation: EvaluationMode;
}

export interface OculoryContractConfig {
  version: typeof CONTRACT_SCHEMA_VERSION;
  task: string;
  tolerance: ContractTolerance;
  assertions: ContractAssertion[];
}
