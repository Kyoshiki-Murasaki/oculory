export type {
  AdapterAssertion,
  AdapterAssertionResult,
  AdapterEvaluationMode,
  AdapterJson,
  AdapterOperationResult,
  AdapterOperator,
  AdapterPrepareContext,
  AdapterRegistration,
  AnyOculoryAdapter,
  OculoryAdapter,
} from './types.js';
export {
  AdapterRegistry,
  createAdapterRegistry,
  listAdapters,
  registerAdapter,
  resolveAdapter,
} from './registry.js';
export {
  GIT_FILESYSTEM_ADAPTER_ID,
  GIT_FILESYSTEM_ADAPTER_VERSION,
  createGitFilesystemAdapter,
} from './git-filesystem.js';
export type {
  GitFilesystemAdapterConfiguration,
  GitFilesystemDiff,
  GitFilesystemFileEntry,
  GitFilesystemPrepared,
  GitFilesystemSnapshot,
  NormalizedGitFilesystemSnapshot,
} from './git-filesystem.js';
export {
  POSTGRES_ADAPTER_ID,
  POSTGRES_ADAPTER_VERSION,
  createPostgresAdapter,
} from './postgres.js';
export type {
  NormalizedPostgresSnapshot,
  PostgresAdapterConfiguration,
  PostgresColumnSnapshot,
  PostgresDiff,
  PostgresPrepared,
  PostgresSnapshot,
  PostgresTableConfiguration,
  PostgresTableSnapshot,
} from './postgres.js';
export {
  GITHUB_API_ADAPTER_ID,
  GITHUB_API_ADAPTER_VERSION,
  GitHubAdapterError,
  createGitHubApiAdapter,
} from './github.js';
export type {
  GitHubAdapterFailureKind,
  GitHubApiAdapterConfiguration,
  GitHubApiDiff,
  GitHubApiPrepared,
  GitHubApiSnapshot,
  GitHubApiSnapshotScope,
  GitHubCommentMode,
  GitHubResetMode,
  NormalizedGitHubApiSnapshot,
  NormalizedGitHubBranch,
  NormalizedGitHubComments,
  NormalizedGitHubResource,
} from './github.js';

import {
  GIT_FILESYSTEM_ADAPTER_ID,
  GIT_FILESYSTEM_ADAPTER_VERSION,
  createGitFilesystemAdapter,
} from './git-filesystem.js';
import {
  GITHUB_API_ADAPTER_ID,
  GITHUB_API_ADAPTER_VERSION,
  createGitHubApiAdapter,
} from './github.js';
import {
  POSTGRES_ADAPTER_ID,
  POSTGRES_ADAPTER_VERSION,
  createPostgresAdapter,
} from './postgres.js';
import { AdapterRegistry } from './registry.js';

export function createBuiltinAdapterRegistry(): AdapterRegistry {
  const registry = new AdapterRegistry();
  registry.register({ id: GIT_FILESYSTEM_ADAPTER_ID, version: GIT_FILESYSTEM_ADAPTER_VERSION, adapter: createGitFilesystemAdapter() });
  registry.register({ id: POSTGRES_ADAPTER_ID, version: POSTGRES_ADAPTER_VERSION, adapter: createPostgresAdapter() });
  registry.register({ id: GITHUB_API_ADAPTER_ID, version: GITHUB_API_ADAPTER_VERSION, adapter: createGitHubApiAdapter() });
  return registry;
}
