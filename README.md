# WebMCP Pharmacy Demo

A WebMCP-enabled pharmacy portal that demonstrates AI agent tool-calling for
prescription refills. The same site serves people and agents: a human clicks
through the UI, while an agent calls structured tools registered via
`document.modelContext.registerTool()`. Controlled-substance refills are gated
behind a real-time caregiver approval flow, so an agent cannot complete one on
its own — a human in a separate browser session has to approve it first.

**Live demo:** <https://webmcp-pharmacy.vercel.app/>

## WebMCP tools

Six tools are registered on the pharmacy page (`index.html`) by `tools.js`:

| Tool | What it does |
| --- | --- |
| `say_hello` | Connectivity check — returns a greeting with a random per-call verification code, proving a live tool invocation rather than a guessed answer. |
| `search_medications` | Searches the patient's medications by name and returns matching id, name, dosage and patient. |
| `check_refill_eligibility` | Reports whether one medication can be refilled now, the exact date it becomes eligible, and whether caregiver approval would be needed. |
| `refill_prescription` | Refills a medication when eligible. Controlled substances open a caregiver approval request and wait up to 30 seconds for a decision. |
| `check_drug_interactions` | Cross-references two or more medications against this pharmacy's interaction table, returning each interacting pair with severity and clinical note, most severe first. |
| `get_refill_summary` | Returns the computed refill status of every medication in one response — eligibility, eligibility dates, controlled-substance status, and approval requirements. |

Every tool feature-detects `document.modelContext` before registering, wraps
its `execute()` in try/catch, and returns a clear error message instead of
throwing. Tools call the same underlying JavaScript functions as the UI
(`window.PharmacyStore`), so an agent and a human always get identical results.

The last two exist to show a genuine capability difference rather than a
navigation shortcut. The interaction table is never rendered anywhere in the
UI, so a page-reading agent can only answer from its own training knowledge;
and "what can be refilled today?" requires date arithmetic across every card.
Both tools return deterministic computed answers instead.

## Caregiver approval flow

Controlled substances (Alprazolam, Oxycodone in the mock data) cannot be
refilled directly. When a refill is requested — by an agent through
`refill_prescription`, or by a human clicking Refill:

1. The page `POST`s to `/api/request-approval`, which stores a pending record
   in Upstash Redis under `approval:<requestId>` and adds the id to a
   `pending-approvals` set.
2. The **Caregiver Approval Dashboard** (`caregiver.html`) polls
   `GET /api/approval-status` every 2 seconds and renders each pending request
   with Approve / Deny buttons.
3. A decision `POST`s to `/api/approval-status`, which updates the record and
   removes it from the pending set.
4. The requesting page polls `GET /api/approval-status?requestId=…` and, on
   approval, completes the refill. The WebMCP tool gives up after 30 seconds
   (an agent tool call cannot hang forever) and reports the request id so it
   can be checked later; the UI keeps waiting, since a human is watching it.

Because the state lives in Redis rather than in the page, the approval can be
granted from a completely separate browser session, device or person — which is
the point of the demo. Open the pharmacy page and the caregiver dashboard side
by side to see it work.

## WebMCP on/off comparison

The same site can be served with tools enabled or disabled, to compare a
tool-driven agent against a UI-driven one:

- **<https://webmcp-pharmacy.vercel.app/?webmcp=on>** — all six tools are
  registered.
- **<https://webmcp-pharmacy.vercel.app/?webmcp=off>** — no tools are
  registered at all. The page remains a completely ordinary, fully functional
  website that an agent must read and click like a human would.

The mode resolves URL parameter first, then `localStorage`, then defaults to
`on`; the toggle in the page header writes both, so the current link is always
shareable. The URL takes precedence because `localStorage` does not carry over
between browser instances — ChatGPT's in-app browser is a separate session from
your own Chrome, so a link is the only way to hand another agent a specific
mode.

Two pieces of UI friction are **permanent features of the site** and apply
identically in both modes:

- **A confirmation modal** before any refill completes — a real DOM overlay,
  not `window.confirm()`, so a UI-driven agent has to locate it and click
  through it.
- **A full DOM re-render on every search keystroke** — `#med-list` is cleared
  and every card rebuilt as new elements, so any node reference or position an
  agent noted beforehand is stale afterwards.

Neither is gated on the WebMCP mode. A tool call bypasses them structurally
rather than by exemption: `refill_prescription` calls the underlying function
directly and never touches the button, the modal, or the DOM. That keeps the
comparison fair — same site, same friction, and the only variable is whether
tool access is available.

## Setup

This is no longer a purely static site: the caregiver approval flow depends on
two Vercel serverless functions in `/api` and an Upstash Redis database, so it
needs Vercel (or a linked local `vercel dev`) to run in full.

```bash
npm install
```

### Running locally with the API routes

The `/api` routes require `KV_REST_API_URL` and `KV_REST_API_TOKEN`, which come
from the Upstash Redis integration on the connected Vercel project. Link the
project and pull the environment variables, then run Vercel's local dev server:

```bash
vercel link          # once, to connect this directory to the Vercel project
vercel env pull      # writes .env.local with the KV_* variables
vercel dev           # serves the pages and the /api routes together
```

Without those variables the API routes return a clear
`Redis is not configured` error rather than failing silently.

### Running the pages only

A plain static server still renders both pages and all six WebMCP tools
register normally:

```bash
npx serve .
# or
python3 -m http.server 8000
```

In this mode `/api` does not exist, so the caregiver dashboard shows its error
banner and controlled-substance refills report that the approval request could
not be created. Everything else — search, eligibility, non-controlled refills,
interactions, the refill summary — works fully.

### Deployment

Pushing to `main` auto-deploys to Vercel, where the Upstash Redis environment
variables are already configured for Production and Preview.

## Project structure

```
index.html       Pharmacy portal (loads data.js, approval.js, tools.js, app.js)
caregiver.html   Caregiver approval dashboard
data.js          Mock medications and drug interaction table
app.js           UI logic + window.PharmacyStore (shared refill/eligibility logic)
tools.js         WebMCP tool registration (all six tools)
approval.js      Shared approval HTTP client used by tools.js, app.js, caregiver.html
style.css        Design system for both pages
api/             Vercel serverless functions (request-approval, approval-status)
```

## License

MIT — see the [LICENSE](LICENSE) file.
