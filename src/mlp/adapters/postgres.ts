import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import {
  assertSupportedMode,
  evaluateObserved,
  equalJson,
  isSecretShapedName,
  redactSecrets,
  rejectUnknownKeys,
  requireBoundedInteger,
  requireObject,
  requireString,
  requireStringArray,
  toAdapterJson,
} from './shared.js';
import type {
  AdapterAssertion,
  AdapterAssertionResult,
  AdapterJson,
  AdapterOperationResult,
  AdapterPrepareContext,
  OculoryAdapter,
} from './types.js';

export const POSTGRES_ADAPTER_ID = 'postgres';
export const POSTGRES_ADAPTER_VERSION = '1.0.0';

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
const ENVIRONMENT_NAME = /^[A-Z][A-Z0-9_]{0,127}$/;
const MAX_SNAPSHOT_ROW_BYTES = 16 * 1024 * 1024;

export interface PostgresTableConfiguration {
  name: string;
  columns: string[];
  orderBy: string[];
}

export interface PostgresAdapterConfiguration {
  connectionEnv: string;
  sourceSchema: string;
  tables: PostgresTableConfiguration[];
  rowLimit: number;
  queryTimeoutMs: number;
}

export interface PostgresPrepared {
  readonly configuration: PostgresAdapterConfiguration;
  readonly workspaceSchema: string;
  readonly pool: Pool;
  baseline: NormalizedPostgresSnapshot | null;
  created: boolean;
  cleaned: boolean;
}

export interface PostgresColumnSnapshot {
  name: string;
  dataType: string;
  nullable: boolean;
  ordinal: number;
}

export interface PostgresTableSnapshot {
  exists: boolean;
  columns: PostgresColumnSnapshot[];
  rows: Array<Record<string, AdapterJson>>;
}

export interface PostgresSnapshot {
  schema: string;
  tables: Record<string, PostgresTableSnapshot>;
}

export type NormalizedPostgresSnapshot = PostgresSnapshot;

export interface PostgresDiff {
  changed: boolean;
  changedTables: string[];
  missingTables: string[];
  rowCountChanges: Record<string, { before: number; after: number }>;
}

export function createPostgresAdapter(): OculoryAdapter<
  PostgresAdapterConfiguration,
  PostgresPrepared,
  PostgresSnapshot,
  NormalizedPostgresSnapshot,
  PostgresDiff
> {
  return {
    validateConfiguration,
    prepare,
    snapshotBefore,
    snapshotAfter: capture,
    normalizeSnapshot,
    diff,
    evaluateAssertion,
    reset,
    cleanup,
    describeViolation,
    redact: redactSecrets,
  };
}

export function postgresRuntimeEnvironment(
  prepared: unknown,
  upstreamEnvironmentAllowlist: readonly string[],
): Readonly<Record<string, string>> {
  if (prepared === null || typeof prepared !== 'object' || Array.isArray(prepared)) {
    throw new Error('Postgres disposable schema routing is unavailable');
  }
  const candidate = prepared as Partial<PostgresPrepared>;
  if (candidate.created !== true || candidate.cleaned === true || typeof candidate.workspaceSchema !== 'string') {
    throw new Error('Postgres disposable schema routing is unavailable');
  }
  if (
    candidate.configuration === undefined ||
    typeof candidate.configuration.connectionEnv !== 'string' ||
    !upstreamEnvironmentAllowlist.includes(candidate.configuration.connectionEnv)
  ) throw new Error('Postgres connection environment variable is not allowlisted for the MCP server');
  assertWorkspaceSchema(candidate.workspaceSchema);
  return Object.freeze({
    OCULORY_POSTGRES_SCHEMA: candidate.workspaceSchema,
    PGOPTIONS: `-c search_path=${candidate.workspaceSchema}`,
  });
}

function validateConfiguration(value: unknown): PostgresAdapterConfiguration {
  const input = requireObject(value, 'Postgres adapter configuration');
  rejectUnknownKeys(input, ['connectionEnv', 'sourceSchema', 'tables', 'rowLimit', 'queryTimeoutMs'], 'Postgres adapter configuration');
  const connectionEnv = requireString(input.connectionEnv, 'connectionEnv', ENVIRONMENT_NAME);
  const sourceSchema = identifier(input.sourceSchema, 'sourceSchema');
  if (!Array.isArray(input.tables) || input.tables.length === 0 || input.tables.length > 64) {
    throw new Error('tables must contain 1-64 table allowlist entries');
  }
  const tables = input.tables.map((entry, index) => {
    const table = requireObject(entry, `tables[${index}]`);
    rejectUnknownKeys(table, ['name', 'columns', 'orderBy'], `tables[${index}]`);
    const name = identifier(table.name, `tables[${index}].name`);
    const columns = requireStringArray(table.columns, `tables[${index}].columns`, 128).map((column) => identifier(column, 'column'));
    if (columns.some(isSecretShapedName)) throw new Error(`columns for ${name} contain a secret-shaped name`);
    const orderBy = requireStringArray(table.orderBy, `tables[${index}].orderBy`, 16).map((column) => identifier(column, 'orderBy column'));
    if (orderBy.some((column) => !columns.includes(column))) throw new Error(`orderBy for ${name} must use allowlisted columns`);
    return { name, columns: [...columns].sort(), orderBy };
  });
  if (new Set(tables.map((table) => table.name)).size !== tables.length) throw new Error('table allowlist contains duplicate names');
  return {
    connectionEnv,
    sourceSchema,
    tables: [...tables].sort((left, right) => left.name.localeCompare(right.name)),
    rowLimit: input.rowLimit === undefined ? 500 : requireBoundedInteger(input.rowLimit, 'rowLimit', 1, 5_000),
    queryTimeoutMs: input.queryTimeoutMs === undefined ? 5_000 : requireBoundedInteger(input.queryTimeoutMs, 'queryTimeoutMs', 100, 30_000),
  };
}

async function prepare(configuration: PostgresAdapterConfiguration, context: AdapterPrepareContext): Promise<PostgresPrepared> {
  if (context.signal?.aborted === true) throw new Error('adapter preparation cancelled');
  requireString(context.runId, 'runId', /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
  configuration = validateConfiguration(configuration);
  for (const table of configuration.tables) {
    Object.freeze(table.columns);
    Object.freeze(table.orderBy);
    Object.freeze(table);
  }
  Object.freeze(configuration.tables);
  Object.freeze(configuration);
  let connectionString: string | undefined = process.env[configuration.connectionEnv];
  if (connectionString === undefined || connectionString.length === 0) {
    throw new Error(`Postgres connection environment variable is unavailable: ${configuration.connectionEnv}`);
  }
  const pool = new Pool({
    connectionString,
    max: 1,
    connectionTimeoutMillis: configuration.queryTimeoutMs,
    idleTimeoutMillis: configuration.queryTimeoutMs,
    query_timeout: configuration.queryTimeoutMs,
    statement_timeout: configuration.queryTimeoutMs,
    application_name: 'oculory-adapter',
  });
  connectionString = undefined;
  const workspaceSchema = `oculory_${randomUUID().replaceAll('-', '').slice(0, 24)}`;
  const prepared: PostgresPrepared = { configuration, workspaceSchema, pool, baseline: null, created: false, cleaned: false };
  try {
    await withClient(prepared, async (client) => {
      await validateSource(client, configuration);
      await createWorkspace(client, prepared);
    });
    prepared.baseline = normalizeSnapshot(await capture(prepared));
    return prepared;
  } catch {
    let cleanupVerified = !prepared.created;
    if (prepared.created) {
      try {
        await dropWorkspace(prepared);
        cleanupVerified = true;
      } catch {
        cleanupVerified = false;
      }
    }
    await pool.end().catch(() => undefined);
    throw new Error(cleanupVerified
      ? 'Postgres adapter preparation failed'
      : 'Postgres adapter preparation failed and cleanup could not be verified');
  }
}

async function snapshotBefore(prepared: PostgresPrepared): Promise<PostgresSnapshot> {
  const value = await capture(prepared);
  const normalized = normalizeSnapshot(value);
  if (prepared.baseline !== null && !equalJson(
    prepared.baseline as unknown as AdapterJson,
    normalized as unknown as AdapterJson,
  )) {
    throw new Error('Postgres workspace changed before baseline registration');
  }
  prepared.baseline = normalized;
  return value;
}

async function capture(prepared: PostgresPrepared): Promise<PostgresSnapshot> {
  assertPrepared(prepared);
  return withClient(prepared, async (client) => {
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    try {
      const snapshot = await captureTransaction(prepared, client);
      await client.query('COMMIT');
      return snapshot;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    }
  });
}

async function captureTransaction(prepared: PostgresPrepared, client: PoolClient): Promise<PostgresSnapshot> {
  const tables: Record<string, PostgresTableSnapshot> = {};
  const existence = new Map<string, boolean>();
  let selectedRowBytes = 0n;
  for (const table of prepared.configuration.tables) {
    const existsResult = await client.query<{ exists: boolean }>(
      'SELECT to_regclass($1) IS NOT NULL AS exists',
      [`${prepared.workspaceSchema}.${table.name}`],
    );
    const exists = existsResult.rows[0]?.exists === true;
    existence.set(table.name, exists);
    if (!exists) continue;
    const bounds = await selectedRowBounds(client, prepared.workspaceSchema, table);
    if (bounds.rows > BigInt(prepared.configuration.rowLimit)) throw new Error('Postgres snapshot row limit exceeded');
    selectedRowBytes += bounds.bytes;
    if (selectedRowBytes > BigInt(MAX_SNAPSHOT_ROW_BYTES)) throw new Error('Postgres snapshot selected-row byte limit exceeded');
  }
  for (const table of prepared.configuration.tables) {
    if (existence.get(table.name) !== true) {
      tables[table.name] = { exists: false, columns: [], rows: [] };
      continue;
    }
    const columnResult = await client.query<{
      column_name: string;
      data_type: string;
      is_nullable: 'YES' | 'NO';
      ordinal_position: number;
    }>(
      `SELECT column_name, data_type, is_nullable, ordinal_position
           FROM information_schema.columns
          WHERE table_schema = $1 AND table_name = $2
          ORDER BY ordinal_position`,
      [prepared.workspaceSchema, table.name],
    );
    const columns = columnResult.rows
      .filter((column) => table.columns.includes(column.column_name))
      .map((column) => ({
        name: column.column_name,
        dataType: column.data_type,
        nullable: column.is_nullable === 'YES',
        ordinal: column.ordinal_position,
      }));
    const rowsResult = await client.query<QueryResultRow>(
      `SELECT ${table.columns.map(quote).join(', ')} FROM ${qualified(prepared.workspaceSchema, table.name)} ORDER BY ${table.orderBy.map(quote).join(', ')} LIMIT $1`,
      [prepared.configuration.rowLimit + 1],
    );
    if (rowsResult.rows.length > prepared.configuration.rowLimit) throw new Error('Postgres snapshot row limit exceeded');
    tables[table.name] = {
      exists: true,
      columns,
      rows: rowsResult.rows.map((row) => Object.fromEntries(table.columns.map((column) => [column, redactSecrets(row[column])]))),
    };
  }
  return { schema: prepared.configuration.sourceSchema, tables };
}

function normalizeSnapshot(snapshot: PostgresSnapshot): NormalizedPostgresSnapshot {
  return {
    schema: snapshot.schema,
    tables: Object.fromEntries(
      Object.entries(snapshot.tables)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([name, table]) => [name, {
          exists: table.exists,
          columns: [...table.columns].sort((left, right) => left.ordinal - right.ordinal || left.name.localeCompare(right.name)),
          rows: table.rows
            .map((row) => Object.fromEntries(Object.entries(row).sort(([left], [right]) => left.localeCompare(right))))
            .sort(compareRows),
        }]),
    ),
  };
}

function diff(before: NormalizedPostgresSnapshot, after: NormalizedPostgresSnapshot): PostgresDiff {
  const names = [...new Set([...Object.keys(before.tables), ...Object.keys(after.tables)])].sort();
  const changedTables = names.filter((name) => !equalJson(before.tables[name] as unknown as AdapterJson ?? null, after.tables[name] as unknown as AdapterJson ?? null));
  const missingTables = names.filter((name) => before.tables[name]?.exists === true && after.tables[name]?.exists !== true);
  const rowCountChanges = Object.fromEntries(names
    .filter((name) => (before.tables[name]?.rows.length ?? 0) !== (after.tables[name]?.rows.length ?? 0))
    .map((name) => [name, { before: before.tables[name]?.rows.length ?? 0, after: after.tables[name]?.rows.length ?? 0 }]));
  return { changed: changedTables.length > 0, changedTables, missingTables, rowCountChanges };
}

function evaluateAssertion(
  assertion: AdapterAssertion,
  before: NormalizedPostgresSnapshot,
  after: NormalizedPostgresSnapshot,
  _diff: PostgresDiff,
): AdapterAssertionResult {
  assertSupportedMode(assertion.evaluationMode);
  validateLogicalSchema(assertion, after.schema);
  return evaluateObserved(assertion, selectedValue(assertion, before), selectedValue(assertion, after));
}

async function reset(prepared: PostgresPrepared, expected: NormalizedPostgresSnapshot): Promise<AdapterOperationResult> {
  assertPrepared(prepared);
  const baseline = prepared.baseline;
  if (baseline === null || !equalJson(
    expected as unknown as AdapterJson,
    baseline as unknown as AdapterJson,
  )) {
    return { passed: false, detail: 'reset refused because the requested baseline was not registered' };
  }
  try {
    await dropWorkspace(prepared);
    prepared.created = false;
    await withClient(prepared, (client) => createWorkspace(client, prepared));
    prepared.created = true;
    const observed = normalizeSnapshot(await capture(prepared));
    const passed = equalJson(baseline as unknown as AdapterJson, observed as unknown as AdapterJson);
    return { passed, detail: passed ? 'disposable schema reset verified' : 'reset schema differs from registered baseline' };
  } catch {
    return { passed: false, detail: 'disposable schema reset could not be verified' };
  }
}

async function cleanup(prepared: PostgresPrepared): Promise<AdapterOperationResult> {
  if (prepared.cleaned) return { passed: !prepared.created, detail: 'cleanup already attempted' };
  let passed = false;
  try {
    if (prepared.created) await dropWorkspace(prepared);
    const result = await prepared.pool.query<{ absent: boolean }>('SELECT to_regnamespace($1) IS NULL AS absent', [prepared.workspaceSchema]);
    passed = result.rows[0]?.absent === true;
    prepared.created = !passed;
  } catch {
    passed = false;
  } finally {
    prepared.cleaned = true;
    await prepared.pool.end().catch(() => undefined);
  }
  return { passed, detail: passed ? 'disposable schema removal verified' : 'disposable schema cleanup failed' };
}

function describeViolation(assertion: AdapterAssertion, result: AdapterAssertionResult): string {
  const table = typeof assertion.selector.table === 'string' ? assertion.selector.table : 'selected table';
  return `${table} violated: ${result.detail}`;
}

function selectedValue(assertion: AdapterAssertion, snapshot: NormalizedPostgresSnapshot): AdapterJson | null {
  const selector = assertion.selector;
  const kind = requireString(selector.kind, 'selector.kind');
  const tableName = identifier(selector.table, 'selector.table');
  if (!Object.prototype.hasOwnProperty.call(snapshot.tables, tableName)) {
    throw new Error('selector table is outside the configured allowlist');
  }
  const table = snapshot.tables[tableName];
  if (kind === 'table') return table?.exists === true ? { name: tableName } : null;
  if (table === undefined || !table.exists) return null;
  switch (kind) {
    case 'row_count':
      return filteredRows(selector, table).length;
    case 'rows':
    case 'unexpected_rows':
      return filteredRows(selector, table);
    case 'cell': {
      const rows = filteredRows(selector, table);
      const column = identifier(selector.column, 'selector.column');
      if (!table.columns.some((entry) => entry.name === column)) throw new Error('cell uses a non-allowlisted column');
      if (rows.length !== 1) throw new Error(`cell selector requires exactly one matching row; observed ${rows.length}`);
      return rows[0]![column] ?? null;
    }
    case 'columns': {
      const selected = selector.columns === undefined ? null : requireStringArray(selector.columns, 'selector.columns', 128).map((column) => identifier(column, 'column'));
      if (selected?.some((column) => !table.columns.some((entry) => entry.name === column)) === true) {
        throw new Error('columns selector uses a non-allowlisted column');
      }
      return table.columns.filter((column) => selected === null || selected.includes(column.name)) as unknown as AdapterJson;
    }
    default:
      throw new Error(`unsupported Postgres selector: ${kind}`);
  }
}

function filteredRows(
  selector: Readonly<Record<string, AdapterJson>>,
  table: PostgresTableSnapshot,
): Array<Record<string, AdapterJson>> {
  const where = selector.where === undefined ? {} : requireObject(selector.where, 'selector.where');
  const knownColumns = new Set(table.columns.map((column) => column.name));
  for (const column of Object.keys(where)) if (!knownColumns.has(identifier(column, 'where column'))) throw new Error('where uses a non-allowlisted column');
  const columns = selector.columns === undefined
    ? [...knownColumns]
    : requireStringArray(selector.columns, 'selector.columns', 128).map((column) => identifier(column, 'selected column'));
  for (const column of columns) if (!knownColumns.has(column)) throw new Error('selector uses a non-allowlisted column');
  return table.rows
    .filter((row) => Object.entries(where).every(([column, expected]) => equalJson(row[column] ?? null, toAdapterJson(expected))))
    .map((row) => Object.fromEntries(columns.sort().map((column) => [column, row[column] ?? null])));
}

async function validateSource(client: PoolClient, configuration: PostgresAdapterConfiguration): Promise<void> {
  let selectedRowBytes = 0n;
  for (const table of configuration.tables) {
    const result = await client.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = $2
        ORDER BY ordinal_position`,
      [configuration.sourceSchema, table.name],
    );
    const available = new Set(result.rows.map((row) => row.column_name));
    if (table.columns.some((column) => !available.has(column))) throw new Error('Postgres table allowlist does not match source columns');
    const bounds = await selectedRowBounds(client, configuration.sourceSchema, table);
    if (bounds.rows > BigInt(configuration.rowLimit)) throw new Error('Postgres source exceeds configured row limit');
    selectedRowBytes += bounds.bytes;
    if (selectedRowBytes > BigInt(MAX_SNAPSHOT_ROW_BYTES)) throw new Error('Postgres source exceeds selected-row byte limit');
  }
}

async function selectedRowBounds(
  client: PoolClient,
  schema: string,
  table: PostgresTableConfiguration,
): Promise<{ rows: bigint; bytes: bigint }> {
  const result = await client.query<{ row_count: string; selected_bytes: string }>(
    `SELECT count(*)::text AS row_count,
            COALESCE(sum(octet_length(row_to_json(selected_row)::text)), 0)::text AS selected_bytes
       FROM (SELECT ${table.columns.map(quote).join(', ')} FROM ${qualified(schema, table.name)}) AS selected_row`,
  );
  return {
    rows: nonNegativeBigInt(result.rows[0]?.row_count, 'row count'),
    bytes: nonNegativeBigInt(result.rows[0]?.selected_bytes, 'selected-row bytes'),
  };
}

function nonNegativeBigInt(value: unknown, label: string): bigint {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) throw new Error(`Postgres ${label} is invalid`);
  return BigInt(value);
}

function compareRows(left: Record<string, AdapterJson>, right: Record<string, AdapterJson>): number {
  return Buffer.compare(Buffer.from(JSON.stringify(left)), Buffer.from(JSON.stringify(right)));
}

async function createWorkspace(client: PoolClient, prepared: PostgresPrepared): Promise<void> {
  assertWorkspaceSchema(prepared.workspaceSchema);
  await client.query(`CREATE SCHEMA ${quote(prepared.workspaceSchema)}`);
  prepared.created = true;
  for (const table of prepared.configuration.tables) {
    await client.query(
      `CREATE TABLE ${qualified(prepared.workspaceSchema, table.name)} AS SELECT ${table.columns.map(quote).join(', ')} FROM ${qualified(prepared.configuration.sourceSchema, table.name)}`,
    );
  }
}

async function dropWorkspace(prepared: PostgresPrepared): Promise<void> {
  assertWorkspaceSchema(prepared.workspaceSchema);
  await prepared.pool.query(`DROP SCHEMA ${quote(prepared.workspaceSchema)} CASCADE`);
  prepared.created = false;
}

async function withClient<T>(prepared: PostgresPrepared, run: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await prepared.pool.connect();
  try {
    return await run(client);
  } finally {
    client.release();
  }
}

function validateLogicalSchema(assertion: AdapterAssertion, schema: string): void {
  const selected = assertion.selector.schema;
  if (selected !== undefined && selected !== schema) throw new Error('selector schema is outside the configured allowlist');
}

function assertPrepared(prepared: PostgresPrepared): void {
  if (prepared.cleaned || !prepared.created) throw new Error('Postgres disposable schema is unavailable');
  assertWorkspaceSchema(prepared.workspaceSchema);
}

function assertWorkspaceSchema(schema: string): void {
  if (!/^oculory_[a-f0-9]{24}$/.test(schema)) throw new Error('refusing operation on a non-disposable schema');
}

function identifier(value: unknown, label: string): string {
  return requireString(value, label, IDENTIFIER);
}

function quote(identifierValue: string): string {
  if (!IDENTIFIER.test(identifierValue)) throw new Error('unsafe SQL identifier');
  return `"${identifierValue}"`;
}

function qualified(schema: string, table: string): string {
  return `${quote(schema)}.${quote(table)}`;
}
