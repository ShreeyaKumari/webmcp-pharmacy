// /api/approval-status
//
//   GET  ?requestId=<id>  -> the stored record for that request
//   GET  (no requestId)   -> { pending: [...] }, every record still pending
//   POST { requestId, decision: "approved" | "denied" }
//                         -> updates the record and returns it
//
// The WebMCP refill_prescription tool polls the GET form; the caregiver
// dashboard polls the list form and calls the POST form on Approve / Deny.
//
// Plain Vercel Node.js serverless function (module.exports), not Next.js.
// Deliberately self-contained — no shared local require — so the function
// bundles cleanly with zero build configuration.

const { Redis } = require("@upstash/redis");

// Redis keys — must match /api/request-approval.js
const APPROVAL_KEY_PREFIX = "approval:";
const PENDING_SET_KEY = "pending-approvals";

const RECORD_TTL_SECONDS = 60 * 60 * 24;
const VALID_DECISIONS = ["approved", "denied"];

// Decision history for the Activity log page.
//
// Decided approval records survive at approval:<id> for 24h, but they are
// removed from the pending set, so nothing could enumerate past decisions.
// This append-only list is that history. Appended with rpush (newest at the
// tail) and capped the same way as the approved-prescriptions log, so the
// reader trims from the tail: LTRIM key -20 -1.
const DECISIONS_LIST_KEY = "refill-decisions";
const DECISIONS_LIST_MAX = 20;

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

// Upstash deserializes JSON automatically, but tolerate a raw string in case a
// record was ever written by another client.
function normalizeRecord(raw) {
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
  return raw;
}

async function readRecord(redis, requestId) {
  return normalizeRecord(await redis.get(APPROVAL_KEY_PREFIX + requestId));
}

// Returns every still-pending record. Ids whose record has expired or been
// decided are pruned from the set so it does not grow unbounded.
async function listPending(redis) {
  const ids = (await redis.smembers(PENDING_SET_KEY)) || [];
  if (ids.length === 0) {
    return [];
  }

  const records = await Promise.all(ids.map((id) => readRecord(redis, id)));

  const pending = [];
  const stale = [];

  ids.forEach((id, index) => {
    const record = records[index];
    if (!record || record.status !== "pending") {
      stale.push(id);
    } else {
      pending.push(record);
    }
  });

  if (stale.length > 0) {
    await redis.srem(PENDING_SET_KEY, ...stale);
  }

  // Oldest request first, so the caregiver works through a stable queue.
  pending.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));

  return pending;
}

async function handleGet(req, res, redis) {
  const rawId = req.query ? req.query.requestId : undefined;
  const requestId = Array.isArray(rawId) ? rawId[0] : rawId;

  if (!requestId) {
    const pending = await listPending(redis);
    return res.status(200).json({ pending, count: pending.length });
  }

  const record = await readRecord(redis, requestId);
  if (!record) {
    return res.status(404).json({
      error:
        'No approval request found with id "' +
        requestId +
        '". It may have expired.'
    });
  }

  return res.status(200).json(record);
}

async function handlePost(req, res, redis) {
  let body;
  try {
    body = parseBody(req);
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }

  const requestId = typeof body.requestId === "string" ? body.requestId.trim() : "";
  const decision = typeof body.decision === "string" ? body.decision.trim() : "";

  if (!requestId) {
    return res.status(400).json({
      error: 'Missing or invalid "requestId": expected a non-empty string.'
    });
  }

  if (VALID_DECISIONS.indexOf(decision) === -1) {
    return res.status(400).json({
      error:
        'Invalid "decision": expected one of ' +
        VALID_DECISIONS.join(", ") +
        ' but received "' +
        decision +
        '".'
    });
  }

  const record = await readRecord(redis, requestId);
  if (!record) {
    return res.status(404).json({
      error:
        'No approval request found with id "' +
        requestId +
        '". It may have expired.'
    });
  }

  // Already decided: report the existing decision rather than overwriting it,
  // so two caregiver tabs clicking at once cannot flip an outcome.
  if (record.status !== "pending") {
    await redis.srem(PENDING_SET_KEY, requestId);
    return res.status(200).json(record);
  }

  const updated = Object.assign({}, record, {
    status: decision,
    decidedAt: new Date().toISOString()
  });

  await redis.set(APPROVAL_KEY_PREFIX + requestId, updated, {
    ex: RECORD_TTL_SECONDS
  });
  await redis.srem(PENDING_SET_KEY, requestId);

  // Record the decision for the Activity log. Only fresh decisions are logged
  // — the already-decided branch above returns before reaching here, so a
  // second click cannot create a duplicate history entry.
  try {
    await redis.rpush(DECISIONS_LIST_KEY, {
      requestId: updated.requestId,
      medicationId: updated.medicationId,
      medicationName: updated.medicationName,
      patientName: updated.patientName,
      status: updated.status,
      requestedAt: updated.createdAt,
      decidedAt: updated.decidedAt
    });
    await redis.ltrim(DECISIONS_LIST_KEY, -DECISIONS_LIST_MAX, -1);
  } catch (error) {
    // History is a nice-to-have; never fail the decision itself over it.
    console.error("[approval-status] Could not append to the decision log:", error);
  }

  return res.status(200).json(updated);
}

module.exports = async (req, res) => {
  // Never let a browser or agent cache a status poll.
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "GET" && req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({
      error: "Method not allowed. Use GET to read status or POST to decide."
    });
  }

  try {
    const redis = getRedis();
    if (req.method === "GET") {
      return await handleGet(req, res, redis);
    }
    return await handlePost(req, res, redis);
  } catch (error) {
    console.error("[approval-status] failed:", error);
    return res.status(500).json({
      error: "Approval status request failed: " + error.message
    });
  }
};
