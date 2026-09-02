// GET /api/approved-prescriptions
//
// Read-only view of the "approved-prescriptions" Redis list that
// /api/prescription-uploads.js appends to when a caregiver approves an upload.
// Entries are returned most recent first.
//
// No auth: this is read-only demo data, and the records hold only the fields
// extracted from a prescription photo — never the image itself.
//
// Plain Vercel Node.js serverless function (module.exports), not Next.js.
// Deliberately self-contained — no shared local require — so the function
// bundles cleanly with zero build configuration.

const { Redis } = require("@upstash/redis");

// Must match the key written by /api/prescription-uploads.js
const APPROVED_LIST_KEY = "approved-prescriptions";

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

// Upstash deserializes JSON automatically, but tolerate a raw string in case an
// entry was ever written by another client.
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

// Only the fields the log displays, so nothing unexpected is exposed.
function publicView(entry) {
  return {
    requestId: entry.requestId || null,
    medicationName: entry.medicationName || null,
    dosage: entry.dosage || null,
    patientName: entry.patientName || null,
    prescriberName: entry.prescriberName || null,
    confidence: entry.confidence || null,
    decidedAt: entry.decidedAt || null,
    duplicate: Boolean(entry.duplicate),
    matchedExistingMedication: entry.matchedExistingMedication || null
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

    // The list is appended with rpush, so it reads oldest-first; reverse it so
    // the newest approval is at the top of the log.
    const raw = (await redis.lrange(APPROVED_LIST_KEY, 0, -1)) || [];

    const approved = raw
      .map(normalizeEntry)
      .filter(Boolean)
      .map(publicView)
      .reverse();

    return res.status(200).json({ approved: approved, count: approved.length });
  } catch (error) {
    console.error("[approved-prescriptions] failed:", error);
    return res.status(500).json({
      error: "Could not load the approved prescriptions log: " + error.message
    });
  }
};
