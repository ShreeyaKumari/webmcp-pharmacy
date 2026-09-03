// GET /api/refill-decisions
//
// Read-only history of caregiver decisions on controlled-substance refill
// requests, newest first. Written by /api/approval-status.js when a decision
// is recorded.
//
// Note on coverage: this logs the caregiver decision, which is the only part
// of a refill that touches the server. Refills of non-controlled medications
// complete entirely in the page's in-memory state and are not represented
// here — see the Activity log page's note.
//
// Plain Vercel Node.js serverless function (module.exports), not Next.js.
// Deliberately self-contained — no shared local require — so the function
// bundles cleanly with zero build configuration.

const { Redis } = require("@upstash/redis");

// Must match the key written by /api/approval-status.js
const DECISIONS_LIST_KEY = "refill-decisions";

function getRedis() {
  try {
    return Redis.fromEnv();
  } catch (error) {
    throw new Error(
      "Redis is not configured: " +
        error.message +
        ". Expected KV_REST_API_URL and KV_REST_API_TOKEN in the environment."
    );
  }
}

function normalizeEntry(raw) {
  if (!raw) {
    return null;
  }
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch (error) {
      return null;
    }
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  return raw;
}

function publicView(entry) {
  return {
    requestId: entry.requestId || null,
    medicationId: entry.medicationId || null,
    medicationName: entry.medicationName || null,
    patientName: entry.patientName || null,
    status: entry.status || null,
    requestedAt: entry.requestedAt || null,
    decidedAt: entry.decidedAt || null
  };
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({
      error: "Method not allowed. This endpoint is read-only; use GET."
    });
  }

  try {
    const redis = getRedis();

    // Appended with rpush (oldest first), so reverse for newest-first display.
    const raw = (await redis.lrange(DECISIONS_LIST_KEY, 0, -1)) || [];

    const decisions = raw
      .map(normalizeEntry)
      .filter(Boolean)
      .map(publicView)
      .reverse();

    return res.status(200).json({ decisions: decisions, count: decisions.length });
  } catch (error) {
    console.error("[refill-decisions] failed:", error);
    return res.status(500).json({
      error: "Could not load the refill decision history: " + error.message
    });
  }
};
