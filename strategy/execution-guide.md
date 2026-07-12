# Execution Guide: Oculory
### Prototype spec, target list, outreach, and the first 90 days

*Companion to the company thesis. The thesis says what and why; this says exactly what to do, in order. Everything here assumes you are solo, funded by the $10K grant, and building in public on GitHub.*

---

## Part 1 — The decisive experiment (Days 1–7)

The entire company rests on one falsifiable claim: **tests mined from real production traces catch regressions that schema-generated tests miss, at a false-positive rate low enough to gate releases.** Week one exists to answer that — not to build a product, not to do outreach. Build only what the experiment requires.

### Day 1–2: Build two real MCP servers and generate real traffic

You need servers whose traces you own, so you can test the miner without asking anyone for log access.

**Server 1 — read-only, retrieval-shaped:** a documentation/knowledge search server (e.g., wraps a docs corpus or a public API like arXiv/HN search). Read-only means no sandboxing problems. Include deliberate realism: 6–10 tools, at least two with overlapping purposes (e.g., `search_docs` vs `search_examples`) so tool-*selection* failures can actually occur, and at least one tool with 4+ parameters so argument-construction failures occur (developers report models start guessing above 3–4 params).

**Server 2 — stateful, workflow-shaped:** a task-tracker or notes server backed by SQLite. Create/update/list/complete operations. Stateful but idempotent-friendly, so deterministic environment-state assertions are possible (after "complete task 3," row 3's status column must equal `done` — checkable without any LLM judge).

**Instrument both with trace logging from the first request.** Define the trace schema now — it is the company's core data model:

```jsonl
{
  "session_id": "...",
  "timestamp": "...",
  "model": "provider/model-id",
  "client": "api|claude-code|cursor|unknown",
  "user_intent": "raw first user message if available, else null",
  "steps": [
    {"type": "tool_call", "tool": "search_docs",
     "args": {...}, "result_status": "ok|error",
     "result_digest": "hash or truncated payload", "latency_ms": 412}
  ],
  "outcome_signal": "explicit_success|explicit_failure|abandoned|unknown",
  "env": {"server_version": "...", "schema_hash": "...", "spec_version": "..."}
}
```

Then **generate traffic**: drive both servers through Claude Code / API-based agents on ~100–200 realistic sessions across at least two models. Vary phrasing, include ambiguous requests, include requests that should fail. This is synthetic traffic standing in for production traffic — a known limitation of week one, acceptable because the comparison is trace-derived-vs-schema-derived, and both sides see the same servers.

**While doing this, keep a pain journal.** Every friction point you hit testing your own servers is customer-discovery data you didn't have to interview anyone for.

### Day 2–4: Build the miner and the runner (the only novel code)

**The miner** (the differentiated piece — spend your quality here):

1. **Sessionize and cluster** traces by intent similarity and tool-sequence shape.
2. **From successful sessions, extract golden regression cases:** `(intent, expected_tool_sequence, argument_constraints, environment_postcondition)`. Argument constraints should be *stable* properties (required fields present; enum values; value equality where the value derives deterministically from the intent) — not brittle full-payload matching.
3. **From failed sessions, extract candidate bug reports:** the intent, the wrong path taken, and a minimal reproduction.
4. Emit both as a versioned YAML/JSON test suite with provenance (`derived_from: session_ids`), so every test is traceable to real behavior.

**The runner** (deliberately thin — the grading layer is commodity; do not gold-plate it):

- Replays mined intents against the live server via 2–3 models, N trials per case (start N=3).
- **Deterministic checks first**, mirroring the metric set GitHub validated internally: exact/acceptable tool selection, required-arguments present, argument-value match where the constraint is stable, forbidden-tool detection, environment postconditions (Server 2).
- **LLM judge only as fallback** for the residual (free-text answer quality), with every judge call logged so agreement stats can be computed later. In week one, keep judge usage near zero — the experiment should stand on deterministic results.
- Output: per-tool × per-model matrix, pass rates with trial counts, and a diff against the previous run.

Stack recommendation: **TypeScript** (matches the MCP ecosystem's center of gravity and the audience you'll show it to), official MCP SDK, plain JSONL storage, a single CLI (`oculory mine`, `oculory run`, `oculory diff`). No database, no dashboard, no hosted anything.

### Day 4–5: The head-to-head

1. Install an existing schema-driven OSS tool (lastmile's mcp-eval is the natural baseline; optionally also DeepEval's MCP metrics) and let it generate/run its suite against both of your servers, best-effort configured — steelman it, don't strawman it.
2. Run your trace-mined suite against the same servers.
3. **Introduce three realistic regressions** (rename a parameter, weaken a tool description, subtly change an enum) and one model swap. Run both suites again.
4. Score the comparison on four questions: What did each suite catch that the other missed? What did each falsely flag? Which failures correspond to things a real user actually experienced in the traces? What was the cost/runtime of each?

**Decision rule (pre-registered, from the thesis kill criteria):** if the trace-mined suite catches nothing the schema suite misses, the core hypothesis is false. Write that up honestly and pivot to the pre-identified alternatives (spec-to-eval compiler; model-regression watchdog; judge-audit library). If it catches real, user-visible failure modes the schema suite misses — you have the credibility artifact that powers everything in Part 2.

### Day 5–7: Write it up, ship the repo, first quiet outreach

- Publish the OSS repo (miner + runner + the two demo servers + the comparison harness — reproducible end to end).
- Write **"Schema-generated vs. trace-mined: what MCP test suites actually catch"** — a methodology-first engineering post, not a ranking, not a product pitch. Include the cases where the existing tools won; that honesty is the marketing.
- Post to HN, r/mcp, and the MCP community Discord. DM five maintainers you respect with the repo, not a pitch: "I compared test-generation approaches on MCP servers — curious if this matches your experience."

---

## Part 2 — Targets: who, why, and in what order

### Tier A — the commercial targets (mid-market agent-infrastructure publishers)

These companies' MCP servers are product surface consumed by paying customers' agents; they are big enough to have budget and small enough that a GitHub-internal-style eval pipeline is uneconomical. They are also all GitHub/Discord-native, so a solo founder with a strong repo has full credibility.

| Target | Why them specifically |
|---|---|
| **Firecrawl** | Scraping-for-agents; their MCP server *is* a revenue channel; complex parameterized tools |
| **Exa** | Search-for-agents; overlapping search tools = tool-selection failure surface |
| **Browserbase** | Browser infra for agents; stateful, failure-prone domain |
| **E2B** | Code-execution sandboxes for agents; destructive-adjacent tools make regression stakes high |
| **Apify** | Thousands of actors exposed to agents; scale makes hand-written suites impossible — trace mining is the only plausible coverage story |
| **Composio** | Tool-integration aggregator; hundreds of tools, the strongest "you cannot hand-author this suite" argument |
| **Neon** | Database MCP; environment-postcondition testing (your Server-2 muscle) maps directly |
| **Supabase** | Same shape as Neon; large community |
| **Linear** | Widely used MCP server; workflow-shaped tools |
| **Stainless / Speakeasy** (partnership, not customer) | They *generate* MCP servers for many companies; one integration = distribution to their whole customer base |
| **Smithery / Glama-class registries** (partnership) | They need quality signals for listings; a future scoring partner — approach only after pilots, per the thesis's certification caution |

### Tier B — learning and credibility only (do not build the revenue plan on them)

GitHub, Stripe, Notion, Sentry, Cloudflare, Microsoft (Playwright MCP). GitHub demonstrably builds this internally; assume the others at that scale do or will. Use them for: methodology conversations (their engineers respond to rigorous public work), a possible design-partner logo, and learning what internal pipelines cover — which tells you exactly what the mid-market lacks.

### Tier C — distribution (free tier)

Maintainers of trending open-source MCP servers each week on GitHub, the modelcontextprotocol org contributors, and the authors of the OSS eval tools themselves (lastmile, Confident AI/DeepEval, alpic) — the last group are competitors at the feature level but colleagues at the ecosystem level; interoperating with their suites (run ours and theirs side-by-side) is better positioning than ignoring them.

### Who NOT to target

Manufact/mcp-use (funded direct competitor — watch, don't feed); hobby-server maintainers as *revenue* (they're Tier C distribution); any enterprise requiring procurement/SSO/VPC in the first 90 days (that motion is stage two by design).

---

## Part 3 — Outreach mechanics

**The rule: every first contact contains a finding or a reproducible comparison, never a pitch.**

1. **Private disclosure first, always.** If your harness surfaces a real failure in someone's server, send it to the maintainer privately with a repro *before* any public mention. This converts outreach from marketing into responsible disclosure — the highest-status genre of developer contact — and directly avoids the adversarial-benchmark backfire.
2. **The ask escalation ladder:** (a) "does this match your experience?" → (b) "can I run the miner on a sample of your staging traces?" → (c) "four-week paid pilot, $500–1,000, outcome metrics agreed upfront" → (d) team-tier annual. Never skip a rung.
3. **Channel order:** GitHub issue/discussion on their repo (public, respectful, evidence-attached) → their community Discord → email to the DX/platform engineer identified from the repo's commit history. No LinkedIn, no cold enterprise email.
4. **The maintainer→buyer bridge (the explicitly designed step the thesis flags):** when a maintainer at a Tier-A company engages, the conversion question is: *"who at [company] would care if this had shipped to customers?"* — get the internal referral to the engineering manager; the maintainer becomes the champion, and the finding becomes the business case. Track this conversion rate from contact #1; it is the GTM's most important unknown.

**Discovery script (behavioral, run in every conversation):**
1. Tell me about the last time an agent used your server wrong — how did you find out?
2. Walk me through your release checklist for the server.
3. How long did that last incident take to diagnose, and who got pulled in?
4. What did you try that didn't work (Inspector? mcp-eval? asking Claude?)
5. Did the last model/client update change your server's behavior — how did you know?
6. Have you built or considered an internal eval pipeline? What stopped you or what did it cost?
7. Who owns "did our MCP server work correctly" as a metric today?
8. Would you grant sampled, redacted read access to production tool-call traces? What would you need to see first?
9. If I showed you a regression mined from your own traffic vs. one from a generated suite — different reaction?
10. What have you already paid for in testing/CI/monitoring here, and who approved it?

Banned: "would you use this?"

---

## Part 4 — What the prototype grows into (Days 8–30)

Build strictly in response to design-partner pull; the default answer to every feature idea is "not yet."

**Weeks 2–3 — design-partner loop:**
- Onboard 3–5 partners from Tier A responses (staging traces first; production samples when trust is earned). Track founder-hours per onboarding — if it exceeds ~4 hours/partner, that's the consulting-trap alarm.
- Ship the **GitHub Action** (`oculory/gate-action`): runs the mined suite on PR/release, posts the matrix + diff as a PR comment. **Shadow mode is the only mode** for the first two weeks per partner — report, never block — because one false build-block can end a relationship; the gate earns blocking rights with a demonstrated false-positive record.
- Add **severity tiers**: read-only tools get looser thresholds; anything state-mutating gets strict ones and minimum-effect-size rules (a 100%→98% drop on a destructive tool is an incident; 92%→87% on a search tool may be noise).
- Add **redaction/sampling controls** for trace ingestion (hash user content, keep structure) — this is what turns security teams from blockers into approvers.

**Week 4 — the money conversation:**
- With the 2–3 most engaged partners: paid pilot per the thesis's terms, outcome metrics agreed in writing (regression caught pre-release; diagnosis-time reduction; gate retained at week 8; fix merged because of a finding).
- Ask the pricing-metric question directly: "if this were priced per evaluated tool-call / per ingested trace volume, what number makes this an obvious yes and what makes it an obvious no?" Record answers verbatim — this replaces the analogy-derived price points.

**Deliberately not built before Day 30:** hosted dashboard, cross-client browser execution, destructive-tool sandboxing, synthetic task generation, certification/scoring, multi-tenant anything.

---

## Part 5 — Days 31–90

- **Retention is the product now.** Instrument unprompted second/third/fourth runs per team; the thesis's kill criterion (>80% of adopters never run it twice in 30 days) is evaluated here, on data.
- **Turn a model release into a distribution event:** when a major model ships, re-run every consenting partner's suite same-day and publish "what [new model] changed for MCP tool use" with per-category (not per-company) findings. This is the recurring-revenue argument made visible, and it recurs every release cycle for free.
- **Convert pilots:** target 2–4 paying teams by Day 90 at whatever the Week-4 conversations priced. One paying customer who converted *for the trace-mined value specifically* (ask them why in writing) is worth more evidentially than five who liked the founder.
- **Decide the three open structural questions with evidence in hand:** co-founder search (yes, if hosted-tier demand is real — the managed trace-infrastructure build is beyond sustained solo pace); YC application (yes, if you have the comparison publication + retained gates + first revenue — first-order facts, per the thesis's YC case); registry partnership exploration (only if ≥10 paying/committed orgs exist, per the certification cold-start caution).

---

## Part 6 — Budget and operating constraints

- **Inference:** the run matrix is the cost center. Controls from day one: adaptive sampling (re-run only statistically ambiguous cases at higher N), changed-tool targeting (a diff touching one tool doesn't re-run the world), caching by (case, model, server-schema-hash). Measure real cost per full suite in week one and publish it in the comparison post — cost transparency is itself differentiation.
- **Grant allocation (rough):** ~$2–3K inference/infra through Day 90, ~$0 salary (ramen), remainder reserved — the realistic case reaches sustainability without spending it all, and the reserve is pivot fuel.
- **Time allocation after week one:** ~50% partner-driven building, ~30% conversations, ~20% published measurement. If building crowds out conversations, the thesis's discovery obligations are being dodged — the pain journal from Day 1 does not substitute for ten real publishers describing incidents.

## Part 7 — The one-page checklist

- [ ] Day 2: two servers live, traces flowing, pain journal started
- [ ] Day 4: miner emits provenance-tagged regression suite from own traces
- [ ] Day 5: head-to-head vs mcp-eval complete — **go/no-go decision made and written down**
- [ ] Day 7: repo public, comparison post published, five maintainer DMs sent
- [ ] Day 14: ≥10 publisher conversations; ≥1 staging-trace grant
- [ ] Day 21: GitHub Action in ≥2 external repos, shadow mode
- [ ] Day 30: ≥1 paid pilot signed; pricing-metric answers collected; founder-hours/pilot known
- [ ] Day 60: first gate promoted from shadow to blocking by a customer's own choice
- [ ] Day 90: 2–4 paying; retention data in hand; co-founder/YC/registry decisions made on evidence

Every unchecked box past its date is information. The plan's job is not to be completed — it is to make the company falsifiable on a schedule.
