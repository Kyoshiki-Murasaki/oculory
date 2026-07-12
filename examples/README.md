# Examples

## 1. Talk to the demo MCP server over stdio (any MCP client)
```sh
npm run build
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"search_tasks","arguments":{"query":"login"}}}' \
  | node --experimental-sqlite --no-warnings dist/src/server/main.js
```

## 2. Run with an injected defect
```sh
OCULORY_MUTATION=silent_write_failure node --experimental-sqlite dist/src/server/main.js
```

## 3. Sample artifacts
Run `./bin/oculory experiment`, then inspect:
- `.oculory/traces/normalized.jsonl` — one JSON trace per line (schema: docs/04)
- `.oculory/candidates.json` — the review table the human approves
- `.oculory/suite.json` — the versioned, hashed approved suite
- `.oculory/reports/experiment-report.md` — the detection matrix
