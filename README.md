# WebMCP Pharmacy Demo

An agent-assisted pharmacy portal that exposes its functionality to AI agents as
WebMCP tools (`document.modelContext.registerTool`) — including a caregiver
approval flow, so a caregiver can review and approve actions an agent takes on a
patient's behalf.

## Status

**Stage 0 skeleton.** This is currently just the project scaffold: a static page
shell plus a single placeholder WebMCP tool (`say_hello`) used to verify that
tool registration and tool-calling actually work in the target browsers
(ChatGPT's in-app browser, and Chrome with WebMCP enabled). No real pharmacy
functionality, data, or UI exists yet.

## Setup

This is a plain static site — no build step and no dependencies. Serve the
project root with any static file server:

```bash
npx serve .
```

or:

```bash
python3 -m http.server 8000
```

Then open the printed URL (e.g. <http://localhost:8000>) in your browser. Open
the devtools console to confirm the WebMCP registration message.

Opening `index.html` directly from the filesystem mostly works, but a real
server is recommended so the page runs on an `http(s)` origin.

Deployment for judging is via **Vercel**, which serves the repository root as a
static site.

## Live Demo

TODO: add the Vercel URL here once deployed.

## License

MIT — see the [LICENSE](LICENSE) file.
