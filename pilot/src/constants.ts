export const PILOT_DOCTOR_SCHEMA_VERSION = 'oculory-pilot-doctor-v1' as const;
export const PILOT_REPORT_SCHEMA_VERSION = 'oculory-pilot-report-v1' as const;

export const PILOT_STAGE_IDS = Object.freeze([
  'install_check',
  'deterministic_session',
  'evidence_inspection',
  'candidate_review',
  'suite_compilation',
  'suite_replay',
  'controlled_regression',
  'cleanup',
  'report_export',
] as const);

export type PilotStageId = (typeof PILOT_STAGE_IDS)[number];

export const PROTECTED_EVIDENCE_ROOTS = Object.freeze([
  '.oculory/runs-live',
  '.oculory/runs-external',
  '.oculory/runs-model',
] as const);

export const PROVIDER_CONFIGURATION_NAMES = Object.freeze([
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'GOOGLE_API_KEY',
  'AZURE_OPENAI_API_KEY',
  'COHERE_API_KEY',
  'MISTRAL_API_KEY',
  'GROQ_API_KEY',
  'OPENROUTER_API_KEY',
  'PROVIDER_API_KEY',
  'PROVIDER_ENDPOINT',
] as const);

export const PILOT_TOTAL_TIMEOUT_MS = 10 * 60 * 1_000;
export const PILOT_COMMAND_TIMEOUT_MS = 5_000;
export const PILOT_CONTROLLED_REGRESSION_ID = 'adapter/files-array-stringified' as const;
