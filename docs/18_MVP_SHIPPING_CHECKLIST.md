# 18 — MVP technical shipping checklist

| ✓ | Check | Command / evidence | Status in this environment |
|---|---|---|---|
| x | Fresh-copy install & build | copy repo → `npm run build` (validated in /tmp; `npm install` itself needs a networked machine for the two devDeps) | pass (offline-adjusted) |
| x | Supported Node documented | engines >=22.13; doctor checks it | pass |
|   | Dependency lockfile | `npm install` on a networked machine → commit package-lock.json | **blocked: no registry access** |
| x | Type checking (strict) | `npx tsc --noEmit` | pass |
|   | Formatting/linting config | prettier+eslint configs are intentionally deferred until installable; code style is uniform by construction | blocked (network) |
| x | Unit/integration/e2e tests | `npm test` → 26/26 | pass |
| x | Secrets scan | grep for key patterns; `.env`/`.oculory` gitignored; no secrets exist in repo | pass |
| x | CLI installation & help | `./bin/oculory help` exit 0 | pass |
| x | Quick-start validation | examples/quickstart.sh end-to-end | pass |
| x | Example + reproducibility run | `oculory experiment` ×2 identical (tested) | pass |
| x | Mutation comparison generated | `.oculory/reports/*` | pass |
| x | Documentation links/commands | docs/18 pass done; every command in docs runs verbatim | pass |
| x | LICENSE / CHANGELOG / version | MIT, 0.1.0 | pass |
|   | Git tag + GitHub Actions green | needs a pushed repo | blocked (no git remote here) |
| x | Known limitations stated | docs/21, docs/22, README | pass |
| x | Rollback instructions | releases are tags; roll back = check out previous tag; stores are per-directory and disposable (`oculory clean`) | pass |

Ship gate: all rows pass except the three explicitly network/remote-blocked ones, which are the first actions on a networked machine (docs/19 M-4).
