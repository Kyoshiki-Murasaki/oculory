// Test-only bootstrap for exercising the REAL `oculory` CLI entrypoint end to
// end (including module-load order) without ever calling the real OpenAI
// API. It monkey-patches the global `fetch` BEFORE importing the compiled
// CLI, so the real `OpenAiClient.complete()` receives a canned, valid-shaped
// chat completion instead of touching the network. Spawned as a child
// process by test/model-smoke-manifest.test.ts as:
//   node <this-file> model-smoke --model ... --out-dir ...
// main.ts reads `process.argv.slice(2)`, which — for this process — is
// exactly the CLI args after this file's own path, same as a normal
// `node dist/src/cli/main.js model-smoke ...` invocation.
globalThis.fetch = async () =>
  new Response(
    JSON.stringify({
      choices: [{ message: { content: 'ok', tool_calls: [] } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

await import('../../dist/src/cli/main.js');
