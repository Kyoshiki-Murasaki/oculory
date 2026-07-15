# Track B — bring-your-own-server readiness assessment

This is a structured conversation, not an integration generator. Do not run the server, open its repository, ingest private data, or paste tool schemas/payloads into the form. Use counts and bounded descriptions only.

## Server boundary

- Transport: stdio / another transport
- Tool catalogue size (count only): ____
- Can a fresh isolated server process be started per trial? yes / no / unknown
- Can a disposable fixture be created without production data? yes / no / unknown
- Is there a deterministic reset between trials? yes / no / partial / unknown
- What state can be observed independently of server responses? bounded description:
- Can intended entities and postconditions be identified without raw private content? yes / no / unknown
- Are intermediate mutations observable, or only final state? intermediate / final only / unknown

## Cleanup and safety

- Required cleanup actions (bounded description):
- Can cleanup completion be proven independently? yes / no / unknown
- Could a fixture reach a network, remote Git repository, shared database, or production service? yes / no / unknown
- Sensitive-data concerns by category only: credentials / personal data / source code / customer data / regulated data / none known / unknown
- Can all such data be replaced by synthetic fixtures? yes / no / partial / unknown

## Expected integration work

- Expected blockers: transport / fixture / reset / observability / tool schema / process lifecycle / privacy / platform / other
- Would a custom verifier be required? yes / no / unknown
- If yes, what independent state would it need to inspect?
- Is a deterministic scripted policy possible before any model use? yes / no / unknown
- What evidence would be needed before a controlled integration attempt?

## Readiness outcome

Choose one:

- Ready for a separately scoped synthetic-fixture design review.
- Potentially ready after named blockers are resolved.
- Not currently suitable because independent verification or safe isolation is unavailable.
- Insufficient information; no integration claim.

This outcome does not establish arbitrary-server support, MCP conformance, security, production safety, or permission to ingest the server/repository.
