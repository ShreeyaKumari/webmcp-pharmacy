// POST /api/request-approval
//
// Creates a pending caregiver-approval request for a controlled-substance
// refill and returns its requestId. The WebMCP refill_prescription tool calls
// this, then polls /api/approval-status until a caregiver decides.
//
// Plain Vercel Node.js serverless function (module.exports), not Next.js.
// Deliberately self-contained — no shared local require — so the function
// bundles cleanly with zero build configuration.

const { Redis } = require("@upstash/redis");
const { randomUUID } = require("crypto");

// Redis keys
const APPROVAL_KEY_PREFIX = "approval:";
const PENDING_SET_KEY = "pending-approvals";

// Approval records expire after 24h so the demo database never accumulates
// stale requests.
const RECORD_TTL_SECONDS = 60 * 60 * 24;

// Reads KV_REST_API_URL / KV_REST_API_TOKEN from the environment. Uses the
// REST client, which is the only kind safe for serverless (no TCP pooling).
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

// Vercel parses JSON bodies automatically, but be tolerant of a raw string
// body (e.g. when the content-type header is missing).
function parseBody(req) {
  if (!req.body) {
    return {};
  }
  if (typeof req.body === "string") {
    try {
      return JSON.parse(req.body);
    } catch (error) {
      throw new Error("Request body is not valid JSON.");
    }
  }
  return req.body;
}

function requireString(body, field) {
  const value = body[field];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error('Missing or invalid "' + field + '": expected a non-empty string.');
  }
  return value.trim();
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({
      error: "Method not allowed. Use POST to create an approval request."
    });
  }

  let body;
  let medicationId;
  let medicationName;
  let patientName;

  try {
    body = parseBody(req);
    medicationId = requireString(body, "medicationId");
    medicationName = requireString(body, "medicationName");
    patientName = requireString(body, "patientName");
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }

  try {
    const redis = getRedis();

    const requestId = randomUUID();
    const record = {
      requestId,
      medicationId,
      medicationName,
      patientName,
      status: "pending",
      createdAt: new Date().toISOString()
    };

    // Store the record, then advertise it in the pending set so the caregiver
    // dashboard can discover it without knowing the id in advance.
    await redis.set(APPROVAL_KEY_PREFIX + requestId, record, {
      ex: RECORD_TTL_SECONDS
    });
    await redis.sadd(PENDING_SET_KEY, requestId);

    return res.status(201).json({ requestId, approval: record });
  } catch (error) {
    console.error("[request-approval] failed:", error);
    return res.status(500).json({
      error: "Could not create the approval request: " + error.message
    });
  }
};
