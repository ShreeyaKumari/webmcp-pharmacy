# WebMCP Pharmacy Demo

A WebMCP-enabled pharmacy portal that demonstrates AI agent tool-calling for
prescription refills. The same site serves people and agents: a human clicks
through the UI, while an agent calls structured tools registered via
`document.modelContext.registerTool()`. Controlled-substance refills are gated
behind a real-time caregiver approval flow, and photographed prescriptions are
read by Gemini and queued for caregiver review — so an agent can do the work,
but a human still makes the decisions that matter.

**Live demo:** <https://webmcp-pharmacy.vercel.app/>

## Pages

Three pages, sharing one top navigation bar:

| Page | What it does |
| --- | --- |
| **Pharmacy** (`index.html`) | The patient-facing portal: search, the medication list with live refill-eligibility badges, refill buttons, and smart prescription upload. This is the page that registers the WebMCP tools. |
| **Caregiver** (`caregiver.html`) | The approval desk: controlled-substance refill requests and prescription uploads awaiting review, each with Approve / Deny buttons. Polls every 2 seconds. |
| **Activity log** (`activity.html`) | The history: prescription uploads a caregiver approved, and past caregiver decisions on refill requests. Polls every 5 seconds. |

They connect through Upstash Redis rather than through the page: a refill
requested on the Pharmacy page (or by an agent) appears on the Caregiver page
within two seconds, in a different browser session or on a different device.
Once decided, it lands on the Activity log.

## WebMCP tools

Seven tools are registered on the Pharmacy page by `tools.js`:

| Tool | What it does |
| --- | --- |
| `say_hello` | Connectivity check — returns a greeting with a random per-call verification code, proving a live tool invocation rather than a guessed answer. |
| `search_medications` | Searches the patient's medications by name and returns matching id, name, dosage and patient. |
| `check_refill_eligibility` | Reports whether one medication can be refilled now, the exact date it becomes eligible, and whether caregiver approval would be needed. |
| `refill_prescription` | Refills a medication when eligible. Controlled substances open a caregiver approval request and wait up to 30 seconds for a decision. |
| `check_drug_interactions` | Cross-references two or more medications against this pharmacy's interaction table, returning each interacting pair with severity and clinical note, most severe first. |
| `get_refill_summary` | Returns the computed refill status of every medication in one response — eligibility, eligibility dates, controlled-substance status, and approval requirements. |
| `upload_prescription` | Submits a photographed prescription for Gemini extraction and caregiver review. Never adds a medication directly. |

Every tool feature-detects `document.modelContext` before registering, wraps
its `execute()` in try/catch, and returns a clear error message instead of
throwing. Tools call the same underlying JavaScript functions as the UI
(`window.PharmacyStore`), so an agent and a human always get identical results.

The last three exist to show a genuine capability difference rather than a
navigation shortcut. The interaction table is never rendered anywhere in the
UI, so a page-reading agent can only answer from its own training knowledge;
"what can be refilled today?" requires date arithmetic across every card; and
reading a prescription photo is not something a DOM-reading agent can do at
all.

## API routes

Six plain Vercel Node.js serverless functions, all backed by Upstash Redis:

| Route | Method | Purpose |
| --- | --- | --- |
| `/api/request-approval` | POST | Creates a pending caregiver-approval request for a controlled-substance refill and returns its `requestId`. |
| `/api/approval-status` | GET / POST | GET lists pending requests, or reads one by `requestId`; POST records a caregiver's `approved` / `denied` decision and appends it to the refill-decision history. |
| `/api/analyze-prescription` | POST | Sends a base64 prescription image to Gemini, extracts the fields as strict JSON, and files the result for caregiver review. |
| `/api/prescription-uploads` | GET / POST | GET lists uploads awaiting review; POST approves (with case-insensitive duplicate detection) or rejects one. |
| `/api/approved-prescriptions` | GET | Read-only log of approved uploads, newest first. |
| `/api/refill-decisions` | GET | Read-only history of caregiver decisions on refill requests, newest first. |

Both history lists are capped at the 20 most recent entries; pending records
carry a 24-hour TTL.

## Caregiver approval flow

Controlled substances (Alprazolam, Oxycodone in the mock data) cannot be
refilled directly. When a refill is requested — by an agent through
`refill_prescription`, or by a human clicking Refill:

1. The page `POST`s to `/api/request-approval`, which stores a pending record
   in Upstash Redis under `approval:<requestId>` and adds the id to a
   `pending-approvals` set.
2. The Caregiver page polls `GET /api/approval-status` every 2 seconds and
   renders each pending request with Approve / Deny buttons.
3. A decision `POST`s to `/api/approval-status`, which updates the record,
   removes it from the pending set, and appends it to the `refill-decisions`
   history.
4. The requesting page polls until the decision arrives and, on approval,
   completes the refill. The WebMCP tool gives up after 30 seconds (an agent
   tool call cannot hang forever) and reports the request id so it can be
   checked later; the UI keeps waiting, since a human is watching it.

Because the state lives in Redis rather than in the page, the approval can be
granted from a completely separate browser session, device or person. Open the
Pharmacy page and the Caregiver dashboard side by side to see it work.

## Smart prescription upload

The Pharmacy page accepts a photo of a prescription, by file picker or
drag-and-drop:

1. The image is resized client-side (1600px long edge, JPEG quality 0.8) to
   keep the payload small, then `POST`ed to `/api/analyze-prescription`.
2. That route calls Google's Gemini vision API and asks for strict JSON:
   `medicationName`, `dosage`, `patientName`, `prescriberName`, and a
   `confidence` rating reflecting how legible the image was. The response is
   parsed defensively — code fences stripped, unrecognised confidence values
   downgraded, and a friendly error returned if the model does not produce
   usable JSON.
3. The extracted fields are stored as a `pending_review` record and queued for
   the caregiver. **Nothing is added to the medication list automatically.**
4. The Caregiver page shows the extracted details with a confidence badge and
   Approve / Reject buttons. Approving a medication that already exists is
   flagged as a duplicate and creates nothing new.
5. The upload card on the Pharmacy page polls for the decision and updates in
   place when it arrives; the outcome is recorded on the Activity log.

This requires `GEMINI_API_KEY` (see Setup). The image itself is never stored —
only the extracted fields.

## Activity log

`activity.html` consolidates the two histories in one place: **approved
prescription uploads** (from `/api/approved-prescriptions`) and **refill
decisions** (from `/api/refill-decisions`), each newest first, with approved
and denied outcomes colour-coded.

One deliberate gap, noted on the page itself: refills of non-controlled
medications complete in the page's own in-memory state and never touch the
server, so they do not appear in the history. Only controlled-substance
decisions — the ones that require a caregiver — are recorded.

## WebMCP on/off comparison

The same site can be served with tools enabled or disabled, to compare a
tool-driven agent against a UI-driven one:

- **<https://webmcp-pharmacy.vercel.app/?webmcp=on>** — all seven tools are
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
- **A full DOM re-render on every search keystroke** — the medication list is
  cleared and every card rebuilt as new elements, so any node reference or
  position an agent noted beforehand is stale afterwards.

Neither is gated on the WebMCP mode. A tool call bypasses them structurally
rather than by exemption: `refill_prescription` calls the underlying function
directly and never touches the button, the modal, or the DOM. That keeps the
comparison fair — same site, same friction, and the only variable is whether
tool access is available.

## Setup

This is not a purely static site: the approval and upload flows depend on six
Vercel serverless functions in `/api`, an Upstash Redis database, and the
Gemini API.

```bash
npm install
```

### Environment variables

| Variable | Used for |
| --- | --- |
| `KV_REST_API_URL` | Upstash Redis REST endpoint. Read automatically by `Redis.fromEnv()` in every API route. |
| `KV_REST_API_TOKEN` | Upstash Redis REST token, likewise read by `Redis.fromEnv()`. |
| `GEMINI_API_KEY` | Google Gemini API key, used only by `/api/analyze-prescription`. |

The Upstash integration also provisions `KV_URL` and `REDIS_URL`; these are
TCP-style connection strings and are **not** used, because serverless functions
need the REST-based client.

Without the KV variables, the API routes return a clear `Redis is not
configured` error. Without `GEMINI_API_KEY`, prescription upload returns
"Prescription analysis is temporarily unavailable" and the real cause is logged
server-side.

### Running locally with the API routes

Link the project and pull the environment variables, then run Vercel's local
dev server:

```bash
vercel link          # once, to connect this directory to the Vercel project
vercel env pull      # writes .env.local with the KV_* and GEMINI_API_KEY values
vercel dev           # serves the pages and the /api routes together
```

### Running the pages only

A plain static server still renders all three pages and registers all seven
WebMCP tools:

```bash
npx serve .
# or
python3 -m http.server 8000
```

In this mode `/api` does not exist, so the caregiver dashboard and activity log
show their error banners, and controlled-substance refills and uploads report
that the request could not be created. Everything else — search, eligibility,
non-controlled refills, interactions, the refill summary — works fully.

### Deployment

Pushing to `main` auto-deploys to Vercel, where the Upstash Redis and Gemini
environment variables are already configured. `vercel.json` raises
`maxDuration` to 60s for `/api/analyze-prescription`, since the vision model
can take considerably longer than a normal request.

## Project structure

```
index.html         Pharmacy portal — medication list, search, prescription upload
caregiver.html     Caregiver dashboard — pending refill approvals and uploads
activity.html      Activity log — approved uploads and past refill decisions
data.js            Mock medications and drug interaction table
app.js             UI logic + window.PharmacyStore (shared refill/eligibility logic)
tools.js           WebMCP tool registration (all seven tools)
approval.js        Shared HTTP client for every /api call
list-diff.js       Keyed list diff, so polling lists update without flicker
activity-log.js    Activity log rendering
style.css          Design system for all three pages
api/               Six Vercel serverless functions
vercel.json        Function configuration (maxDuration for the Gemini route)
```

## License

MIT — see the [LICENSE](LICENSE) file.
