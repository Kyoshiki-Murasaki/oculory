# Company Thesis: Oculory
### Production-trace regression testing for MCP servers

*Evidence labels used throughout: **[cited]** = from primary/secondary sources found during research; **[GK]** = general knowledge, verify independently; **[assumption]** = untested belief that the validation plan must confirm or kill. Where a claim is a hypothesis, it says so. This thesis has survived one full adversarial review; its verdict reflects that honestly.*

---

## 1. One-sentence thesis

We help teams that publish MCP servers catch the agent-tool regressions that actually reach production, by mining their own real usage traces into a deterministic-first regression suite that gates releases — which is better because every existing evaluation tool generates tests from schemas or hand-written specs, while ground truth mined from a customer's own production behavior is more realistic, compounds with usage, and cannot be replicated by a competitor who lacks access to that data.

## 2. The problem

**What happens today.** A team ships an MCP server — the agent-facing front door to their product. It passes unit tests, works in MCP Inspector, works on the developer's machine with their model and client. In production, agents mis-select tools, pass malformed arguments, silently break when the schema or the underlying model changes, and behave differently across clients. The vendor's dashboards show nothing; the agent simply fails the user's task, and the user blames the product.

**Behavioral evidence:**

- When tool descriptions are imprecise, agents choose the wrong tool, skip a step, send arguments in the wrong format, or drop them entirely — GitHub built an entire internal offline-evaluation pipeline specifically to catch this before users see it. **[cited — GitHub engineering blog]**
- A scan of 500+ businesses found roughly 40% of deployed MCP servers had at least one broken tool, most commonly tools that work in development and break in production. **[cited — vendor-published; treat the magnitude as directional until independently measured, which the validation plan does]**
- Developers describe schema drift as "the silent killer": servers silently change tool signatures between versions, breaking agents with no visible error. Tools with more than 3–4 parameters cause models to start guessing. **[cited — developer discussions]**
- The same model behaves differently in different clients; local testing does not catch it. **[cited — Manufact engineering blog]**
- The spec itself is a moving target (auth and security especially), so teams cannot always tell whether a failure is their bug, an outdated assumption, or a client problem. **[cited — AAIF/MCP Debugger]**

**The ceiling on current approaches — the sharpest fact in this thesis:** GitHub, the best-resourced MCP publisher found in this research, runs a mature internal pipeline built on *curated* benchmarks with deterministic metrics — and publicly states that benchmark volume is its weak point and that it has not yet extended evaluation to real multi-tool execution flows. **[cited]** Hand-authored and schema-generated test suites hit a coverage ceiling even for the team with the most resources to push past it. That ceiling is what this company attacks.

**Frequency:** every server release, every model release, every client update, every spec revision. **Cost when ignored:** for commercial publishers, silent churn — the integration fails invisibly and the user attributes it to the product; for maintainers, hours of black-box debugging per incident because tracing what the LLM actually sent, and why, requires purpose-built logging. **[cited]**

## 3. The customer

The market splits into three tiers with different economics, and the thesis is a bet on the middle one:

- **Tier A — the target: mid-market publishers** (roughly 10–500 employees) whose MCP server is real product surface — agent-infrastructure and API-first companies whose customers increasingly *are* agents. Internal eval pipelines are uneconomical for them; failures are financially real. **The size of this tier is the single most important unestimated number in this thesis** — establishing it is a named goal of customer discovery, not an assumption.
- **Tier B — large publishers** (GitHub-, Stripe-class): can pay, but the most sophisticated already build internally (GitHub, confirmed **[cited]**). Useful for learning and credibility; not the revenue plan.
- **Tier C — indie OSS maintainers:** need it, mostly won't pay. Distribution and failure-data engine via the free tier.

**People, within a Tier-A company:** user = the engineer who owns the server (platform/DX/AI engineer); champion = whoever answers for "our integration broke inside ChatGPT/Claude"; buyer = engineering manager (self-serve to team-tier); blocker = security, since the product wants read access to production traces — mitigated by an auditable open-source core, sampled/redacted ingestion, and staging-first onboarding. **Open question carried into discovery:** no established job title owns "MCP quality" yet anywhere; diffuse ownership means diffuse budget, and finding where ownership actually sits is discovery question one.

## 4. What customers do today

In descending order of effort: (1) interactive Inspector sessions — official, free, dev-time only, no CI or history **[cited]**; (2) open-source eval frameworks (see Section 5) driven by schemas or hand-written specs; (3) hand-rolled JSON-RPC scripts and in-memory unit tests that validate business logic, not agent behavior **[cited]**; (4) "ask Claude to try it" — convenient, unrepeatable, unmeasured **[cited]**; (5) nothing — still the modal choice, per the 40% figure. The trigger that makes them search: a user-visible failure in a client they didn't test, or an app-store/connector publishing review they must pass. **[cited]**

## 5. Competitive landscape — mapped honestly

This category is **not** empty. It is an active, partly crowded, mostly open-source space, and this thesis is built on knowing exactly what already exists:

| Competitor | What it does | Pricing |
|---|---|---|
| **mcp-eval** (lastmile-ai) | Tool-use scoring, structural + LLM-judge assertions, path-efficiency validators, dataset-driven tests, GitHub Actions, regression detection **[cited]** | free/OSS |
| **DeepEval** (Confident AI) | Purpose-built `MCPUseMetric`, `MultiTurnMCPUseMetric`, `MCPTaskCompletionMetric` — primitive selection, argument generation, task completion **[cited]** | free core / hosted tier |
| **Salesforce MCPEval** | Automated task generation from servers, 5-dimension LLM judging, model-comparison dashboard with statistical testing **[cited]** | free/OSS |
| **alpic-ai/mcp-eval** | YAML suites with deterministic expected-tool-call/parameter matching, executed against real assistants (Claude, ChatGPT, Le Chat) **[cited]** | free/OSS |
| **MCPBench / MCPMark** | Cross-server benchmarks with verified tasks and isolated environments **[cited]** | free/OSS |
| **Manufact (mcp-use)** | Cross-client testing, production observability, session replay; YC-backed, funded **[cited]** | freemium/paid [GK] |
| **GitHub internal pipeline** | Curated benchmarks; deterministic tool-selection classification and argument-correctness metrics (hallucinated args, missing required args, exact-value match) **[cited]** | not sold |
| **Inspector / conformance suite** | Protocol correctness, interactive debugging **[cited]** | free/official |
| **Doing nothing** | The modal alternative | free |

Two conclusions follow. First, **the schema-generated, judge-scored evaluation layer is a commodity** — competing there means competing with multiple free tools on rigor alone, which is a feature war, not a company. Second, **a specific gap remains across all of them:** every tool above derives its tests from schemas, hand-written specs, or curated benchmarks. **None found mines the publisher's own production traffic into ground-truth regression cases.** And the grading hierarchy is inverted relative to best practice: the OSS tools lead with LLM judges (documented to carry systematic biases — length, position, self-preference — with practitioners reporting roughly one in ten judge evaluations producing garbage **[cited — bias survey, practitioner reports]**), while GitHub's more mature internal approach is deterministic-first. No third-party product found offers other publishers what GitHub built for itself.

## 6. The gap, precisely

Three linked insufficiencies, each evidence-backed:

1. **Ground truth is synthetic, not observed.** Schema-derived tests can verify that a model *can* invoke a tool syntactically while missing the workflows that actually matter — intended outcomes, correct ordering, environment state, domain edge cases. GitHub's unfinished multi-tool coverage is direct evidence the synthetic approach ceilings out. **[cited]**
2. **Judges are the default where they should be the fallback.** Deterministic checks (exact tool selection, required-argument presence, value match, forbidden calls) are trustworthy release-gate material; LLM judgments are not, unless their operating characteristics are measured and published — which no tool found does.
3. **Nobody sells a release gate with known error rates.** Existing tools emit scores. A gate that blocks builds must almost never cry wolf — developers tolerate noisy dashboards, not noisy build failures — and no product found makes, measures, or publishes that commitment.

**The company's bet, stated as the falsifiable hypothesis it is [assumption]:** regression tests mined from a server's real production traces catch failures that schema-generated suites miss, at a false-positive rate low enough that teams keep the gate enabled. If that's false, this company should not exist; the validation plan is built to answer it within days, not months.

## 7. Tarpit test

Applied honestly: many teams are active here (seven-plus tools, one internal build at a major publisher), which validates the problem and crowds the obvious approach. The obvious wedge — another schema-driven eval runner — **leans tarpit**: free incumbents, feature-level differentiation, and a plausible future where better models shrink tool-use error rates. The narrowed wedge is a genuine-opportunity candidate on the framework's own test — the enabling change is recent and real (MCP servers only began accumulating meaningful production traffic in the last ~12–18 months **[GK]**, so trace-mining only just became possible) — but it is unproven, and the honest classification is *conditionally genuine, pending the falsification test*.

## 8. The product

**First product: an open-source trace-mining regression harness + CI gate.**

- **Input:** the MCP server, plus read access to sampled production tool-call traces (or the team's own logged sessions pre-launch). This access requirement is deliberate: it is both the differentiator and the adoption risk, and discovery tests it explicitly.
- **What it does:** (1) mines traces for real intents, tool-call sequences, arguments, and outcomes; (2) converts observed *successes* into golden regression cases and observed *failures* into confirmed, reproducible bug reports; (3) grades new runs **deterministic-first** (exact tool selection, required-argument presence, argument-value match, forbidden-call detection — deliberately mirroring the metric set GitHub validated internally), with calibrated LLM judges only for the residual cases deterministic checks cannot cover, their agreement statistics measured and published; (4) gates releases with severity tiers (read-only vs. destructive tools carry different error budgets) and statistically-tested regression thresholds, shipping in **shadow mode by default** so trust is earned before blocking is enabled.
- **Test classes are explicitly separated,** because they carry different trust: production-trace-derived regression cases (the core asset, gate-eligible), human-authored golden tests (gate-eligible), deterministic environment-state assertions (gate-eligible), and generated smoke tests (onboarding convenience only, advisory, never blocking).
- **Deliberately not built initially:** schema-based synthetic task generation as a selling point (a commodity — interoperate with existing OSS for it, don't compete on it), cross-client browser automation (alpic-ai and Manufact territory; v1 is honest that it tests at the model/API level), sandboxing for destructive tools (v1 scope is read-only and idempotent tools), dashboards, certification.

## 9. Structural differentiator

Not rigor, not interface, not features — all of those are matchable by a pull request against existing OSS. The structural difference is **the data source and what it compounds into**:

- A schema is public and equally available to every competitor at once. A publisher's production traces are private, unique per customer, and grow continuously. A test suite derived from them tracks *what agents actually do with this server*, not what a generator imagines.
- To copy this, a competitor must rebuild not the grading logic (commodity) but the trace-ingestion, privacy-safe extraction, and case-mining pipeline — **and** obtain the customer trust required to access production logs at all. The second half is the harder half.
- Honest caveats, carried rather than hidden: customers may refuse trace access (kill-criterion #2), cross-customer transfer of mined patterns is unproven, and historical baselines are switching *friction*, not a moat. The trace pipeline is the only claimed durable asset in this document, and it is a hypothesis until a design partner grants access and the mined tests outperform synthetic ones on their server.

## 10. Why now

Three specific changes, none of which is "AI is growing":

1. **MCP standardized the agent-tool interface (late 2024–2025)** and every major client adopted it, turning tools-for-agents into a publishable product category. **[GK + cited]**
2. **Review gates emerged**: app-store-style publishing checks for ChatGPT apps and connectors mean servers must pass tests to ship — the first compliance-shaped demand for this QA. **[cited]**
3. **The data source just came into existence**: production MCP traffic at meaningful volume is roughly a year old **[GK]**, so trace-mined regression testing was not possible before now — a genuinely new input, not a reframing — while continuous spec and model churn converts the resulting test suite from a one-time artifact into a recurring workload. **[cited]**

The double edge is acknowledged: the same volatility that creates the recurring need also threatens MCP-specific products with obsolescence. The durable job being positioned around is *agent-tool release assurance*; MCP is the initial integration format, not the identity.

## 11. Founder-market fit

**Strengths:** the product's hardest components — calibrated grading, judge-bias measurement, statistical gating, harness engineering — are the founder's demonstrated portfolio (semantic-integrity harness, LLM-judge research, live fact-checking system, agent-reliability work), not skills to acquire. The customer lives on GitHub and Discord, where a solo recent-graduate founder's credibility is code and published measurements, not credentials — neutralizing the trust problem that disqualified every non-developer market examined in the broader research. Solo build speed matches a market where the first version must exist in weeks. A $10K grant covers the zero-infrastructure OSS phase.

**Weaknesses, stated plainly:** the founder has not operated a production MCP server at scale, and has not built production-trace mining or privacy-safe log extraction specifically — the exact skill the wedge leans on hardest. Mitigation is structural in the plan: week one builds two real servers, generates real traffic, and feels the extraction problem firsthand before any outreach. No B2B pricing or sales experience; pilot pricing is treated as an experiment with an explicit advisor gap flagged. Solo is sustainable for the OSS wedge; a co-founder becomes important at the hosted stage.

## 12. Market size — bottom-up, with the honest caveat first

The correct denominator is **not** "number of MCP servers" (registries mix hobby projects, duplicates, and abandoned wrappers) but *organizations with an agent-facing tool surface important enough to justify recurring QA spend*. That number has not been established from primary sources; obtaining a defensible estimate is a stated goal of the first 30 days. Placeholder logic, labeled as such: if ~2,000 such organizations exist within two years **[assumption]** at $2,400–6,000/year effective pricing, the initial market is **≈$5–12M ARR** — small, and explicitly the framework's "small but rapidly growing" bet. Expansion markets (Section 20) are where venture scale lives or dies: agent-tool QA spend tracking agent-tool commerce the way browser-testing spend tracked web complexity **[GK analogy]**, enterprise internal tool estates, and — much later, if earned — certification.

## 13. Business model and pricing

- **Free OSS core:** the miner and runner, local execution — the distribution engine, and the auditability that security blockers need.
- **Hosted tier:** managed, privacy-safe trace ingestion and storage, continuous mining, scheduled re-runs on model releases, history, and the CI gate service. The hosted value must be something a sophisticated team can't cheaply self-host; managed trace infrastructure is the candidate — a log-mining pipeline is much more work to self-host than a test runner **[assumption]**.
- **Pricing metric:** evaluated tool-calls / ingested trace volume — tracking both the cost driver (inference + storage) and the value driver (coverage of real usage). Explicitly **not** per-server, which punishes coverage and invites unit-gaming.
- **Price points:** deliberately unstated beyond an anchoring range (low hundreds/month for teams; five figures/year for enterprises) until paid design-partner conversations produce customer-economics evidence. All prior figures were analogy-derived guesses and are treated as such.
- **Margin:** software-shaped, but unverified — inference, trace storage, retention, and flaky-run support are real variable costs to be measured on actual test matrices before any margin claim is made.

## 14. Pilot design

3–5 Tier-A companies, four weeks each, one server per company, staging-first then sampled production traces, founder-assisted onboarding with **founder-hours-per-pilot tracked from day one** (to detect the consulting-in-disguise failure mode early). Paid at $500–$1,000 — payment as a demand filter — plus two free high-visibility OSS anchors for distribution.

**Success metrics are outcome-based, never count-based** (a "findings per server" metric rewards trivia and false positives): a real regression caught before a release that the customer confirms would have shipped; a customer-reported reduction in diagnosis time; the CI gate still enabled, unprompted, at week eight; a specific fix merged traceably because of a finding. Conversion target: team-tier annual on agreed metrics.

## 15. Go-to-market

Bottom-up open source plus published measurement, self-serve first, founder-led for team tier. The launch asset is **not** a public ranking: it is a private-disclosure-first comparison — trace-mined regression cases versus what existing schema-generated tools catch on the same servers — shared with each maintainer with reproduction steps before anything is published, converting outreach from pitch to disclosure. Maintainer adoption (Tier C) is explicitly top-of-funnel credibility, not pipeline; a separate, deliberate motion converts maintainer interest into commercial-org conversations, and designing that conversion is an open task, not an assumed inevitability. Named-target specifics live in the companion execution guide.

## 16. Customer discovery — what must be learned before heavy building

Behavioral questions only; the full script is in the execution guide. The four questions this thesis's survival depends on: Who in your org owns "did our MCP server work correctly," and who is angry when it doesn't? Have you built or considered an internal eval pipeline — what did it cost or what stopped you? Would you grant sampled, redacted read access to production tool-call traces, and what would you need to see first? Shown a regression mined from your own traffic next to one from a generated suite — do you treat them differently?

## 17. Validation status — the evidence ladder, honestly

Third-party problem evidence: strong (Sections 2, 5–6). First-party demand evidence: **none yet.** Evidence for the specific trace-mining hypothesis: **none yet — it is new.** People testing, returning, paying: unproven. This thesis is a hypothesis with a five-day fuse (Section 22), which is precisely what a thesis should be at day zero, and it does not pretend otherwise.

## 18. Technical feasibility

**Demonstrated technology:** MCP SDKs, tool-calling APIs, deterministic trace analysis, CI execution — all exist. **Plausible engineering (the real work):** privacy-safe trace extraction and redaction; mining stable assertions from noisy real sessions; keeping the run matrix affordable (tasks × models × trials × versions explodes fast — adaptive sampling, changed-tool targeting, and sequential testing are required, and the naive "<15 minutes, <$5" target is treated as optimistic until measured); model-version opacity handled by capturing all environment metadata and separating reproducible from non-reproducible runs rather than overclaiming attribution; failure *attribution* (what to change, not just that success declined) via counterfactual isolation on the roadmap. **Unproven research:** none required — deliberately. **Could kill it technically:** nothing identified; the failure mode is unconvincing measurements or inaccessible data, not infeasibility.

## 19. Defensibility

One claimed durable asset, three explicitly disclaimed. **Claimed:** the trace pipeline plus per-customer mined corpora, contingent on access rights and demonstrated superiority over synthetic tests. **Disclaimed:** historical baselines (switching friction, exportable, not a moat); "trust brand"/neutral-scorer positioning (a company selling optimization cannot credibly self-certify neutrality, and certification has a two-sided cold-start requiring a registry partner secured in advance — treated as a possible distant business, never a strategy); rigor features (matchable by any competitor's next release).

## 20. Expansion path

Wedge: trace-derived regression gating for MCP publishers. → Monitoring: continuous re-runs on every model/client release, alerting on drift against the mined baseline. → Enterprise internal tool estates (hundreds of internal tools exposed to internal agents; larger contracts; acknowledged as a different sales motion requiring SSO/VPC/procurement maturity — a stage-two business, not a stretch of stage one). → Protocol-portable agent-tool release assurance, if and when agent-tool interfaces outgrow or succeed MCP — with the honest caveat that a protocol shift would still cost a partial rewrite; the corpus and method survive, momentum only partly does. Each step is the same motion — turn real agent-tool behavior into release-grade assurance — for a wider surface.

## 21. Risks, ranked by danger

1. **The wedge is a feature, not a company:** an existing OSS tool or platform adds trace-mining, and the differentiator becomes a pull request. The counter-bet: the pipeline plus the trust required for log access is heavier than a feature — but this is the most dangerous assumption in the document.
2. **Willingness to pay never materializes:** devtools' classic loved-starred-unpaid failure; MCP servers maintained as marketing projects have no QA budget.
3. **Trace access is refused:** if customers won't share logs even sampled and redacted, the only durable asset evaporates and the company collapses into the commodity layer.
4. **Better models shrink the problem:** tool-selection and argument errors decline enough that specialized testing loses urgency; the durable residual (cross-version regression, destructive-operation safety, environment state) may or may not be enough.
5. **MCP becomes plumbing:** "MCP server quality" stops being a budget category and folds into general observability/API testing.
6. **Platform absorption:** Inspector's evolution or a foundation-blessed testing apparatus closes the free baseline higher.
7. **Founder gaps:** no production-server operating history, no trace-mining track record, no sales experience — all mitigable, none trivial.

## 22. Kill criteria — falsifiable, dated

- **The five-day test (decisive):** trace-mined regression cases, compared head-to-head against an existing schema-generated OSS suite on the same two servers, catch **nothing** the synthetic suite misses → the core hypothesis is false; stop or pivot.
- Fewer than 3 of the first 10 publisher conversations can articulate, unprompted and specifically, why this beats or complements mcp-eval/DeepEval/Manufact shown side-by-side (generic "yours seems more rigorous" answers do not count).
- No design partner grants any form of trace access within two weeks of a direct ask.
- Fewer than 5 of 20+ maintainer interviews describe a concrete, recent agent-usage failure.
- Users run it once and never again (no unprompted second run within 30 days for >80% of adopters); or zero of five pilot candidates accepts a paid pilot at even $500.
- Judge-fallback agreement with human labels cannot reach a credible pre-registered threshold on the residual (non-deterministic) cases — the trust claim would then be cosmetic.

Pre-identified pivot destinations within the same fertile, RFS-aligned space: spec-to-eval compilation for agent-built software; the model-version regression watchdog; the judge-audit library as a credibility engine.

## 23. Milestones

**Days 1–7:** build two real MCP servers, generate traffic, build the miner, run the head-to-head comparison, decide. **Days 8–30:** if alive — private disclosures, 20+ publisher conversations, 3–5 design partners, first regression caught in a real release, first paid pilot. **Days 31–90:** repeated unprompted usage at ≥5 orgs, 2–4 paying customers, pricing evidence, retention data, second published comparison timed to a major model release. **Year one:** $60–150K ARR range across conservative-to-realistic cases **[assumption]**, 20–50 paying orgs, co-founder and YC decisions made on usage evidence, not thesis quality.

## 24. Financial model

Solo founder, grant-funded, infra = inference + trace storage. Conservative / realistic / upside at month 12: ~12 / ~35 / ~90 paying orgs at $1,800–$4,500 average → **$22K / $105K / $465K ARR**, with two enterprise contracts only in the upside case. Every figure is an assumption whose purpose is to be exposed and corrected by pilots; margins are asserted as software-shaped but unmeasured. The realistic case reaches ramen-sustainability inside year one without external funding, which is what makes the "worth building even if YC says no" test pass on economics, not just sentiment.

## 25. The YC case

**Problem:** the agent economy runs on tool calls; failures are silent, common (40% of deployed servers per the best available scan), and — by the admission of the best-resourced publisher's own engineering blog — not fully solved even internally at GitHub. **Product:** not another eval runner in a crowded free category, but a specific bet the category hasn't made: ground truth mined from production traces, graded deterministically, gating releases with known error rates. **Progress by application time, if the plan holds:** the head-to-head comparison published, design partners with the gate live in CI, first revenue — first-order facts, not projections. **Founder:** the differentiating layer is calibrated evaluation, which is the founder's demonstrated specialty, deployed in a market where credibility is code. **Speed:** hypothesis to decisive experiment in five days, solo. **Market:** the trust layer for agent-tool interactions — small today, priced accordingly, and shaped to grow with agent commerce itself. **Commitment:** the economics stand without YC, and the technique and published measurements compound the founder's position in this space whatever the outcome.

**Framework verdict: Weak-to-Promising, pending one decisive experiment.** The problem is real and evidenced; the crowded layer is correctly avoided; the differentiator is genuine if true and cheaply falsifiable if not. The verdict upgrades to Promising the day the five-day comparison shows trace-mined tests catching what synthetic ones miss — and the company should not be started if it doesn't.
