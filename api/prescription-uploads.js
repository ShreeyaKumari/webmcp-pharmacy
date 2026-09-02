// /api/prescription-uploads
//
//   GET                    -> { pending: [...] }, every upload awaiting review
//   POST { requestId, decision: "approved" | "rejected" }
//                          -> updates the record and returns it
//
// The caregiver dashboard polls the GET form and calls the POST form from its
// Approve / Reject buttons. Mirrors approval-status.js.
//
// Plain Vercel Node.js serverless function (module.exports), not Next.js.
// Deliberately self-contained — no shared local require — so the function
// bundles cleanly with zero build configuration.

const { Redis } = require("@upstash/redis");

// Redis keys — must match /api/analyze-prescription.js
const UPLOAD_KEY_PREFIX = "prescription-upload:";
const PENDING_UPLOADS_KEY = "pending-uploads";
const APPROVED_LIST_KEY = "approved-prescriptions";

const RECORD_TTL_SECONDS = 60 * 60 * 24;
const VALID_DECISIONS = ["approved", "rejected"];

// The patient's current medications, for the duplicate check.
//
// data.js is client-side only, so a serverless function cannot read the live
// MEDICATIONS array; in a database-backed implementation both would query the
// same table. Kept as names only, and matched case-insensitively.
const KNOWN_MEDICATION_NAMES = [
  "Lisinopril",
  "Metformin",
  "Alprazolam",
  "Oxycodone",
  "Atorvastatin"
];

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
  return normalizeRecord(await redis.get(UPLOAD_KEY_PREFIX + requestId));
}

function findExistingMedication(medicationName) {
  var needle = String(medicationName === null || medicationName === undefined ? "" : medicationName)
    .trim()
    .toLowerCase();

  if (needle === "") {
    return null;
  }

  for (var i = 0; i < KNOWN_MEDICATION_NAMES.length; i++) {
    if (KNOWN_MEDICATION_NAMES[i].toLowerCase() === needle) {
      return KNOWN_MEDICATION_NAMES[i];
    }
  }

  return null;
}

// Every still-pending upload. Ids whose record expired or was already decided
// are pruned from the set so it does not grow unbounded.
async function listPending(redis) {
  const ids = (await redis.smembers(PENDING_UPLOADS_KEY)) || [];
  if (ids.length === 0) {
    return [];
  }

  const records = await Promise.all(ids.map((id) => readRecord(redis, id)));

  const pending = [];
  const stale = [];

  ids.forEach((id, index) => {
    const record = records[index];
    if (!record || record.status !== "pending_review") {
      stale.push(id);
    } else {
      pending.push(record);
    }
  });

  if (stale.length > 0) {
    await redis.srem(PENDING_UPLOADS_KEY, ...stale);
  }

  // Oldest first, so the caregiver works through a stable queue.
  pending.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));

  return pending;
}

async function handleGet(req, res, redis) {
  const rawId = req.query ? req.query.requestId : undefined;
  const requestId = Array.isArray(rawId) ? rawId[0] : rawId;

  // Not required by the dashboard, but useful for checking one upload.
  if (requestId) {
    const record = await readRecord(redis, requestId);
    if (!record) {
      return res.status(404).json({
        error:
          'No prescription upload found with id "' + requestId + '". It may have expired.'
      });
    }
    return res.status(200).json(record);
  }

  const pending = await listPending(redis);
  return res.status(200).json({ pending: pending, count: pending.length });
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
        'No prescription upload found with id "' + requestId + '". It may have expired.'
    });
  }

  // Already decided: report the standing decision rather than overwriting it,
  // so two caregiver tabs clicking at once cannot flip an outcome.
  if (record.status !== "pending_review") {
    await redis.srem(PENDING_UPLOADS_KEY, requestId);
    return res.status(200).json(record);
  }

  const decidedAt = new Date().toISOString();

  if (decision === "rejected") {
    const rejected = Object.assign({}, record, {
      status: "rejected",
      decidedAt: decidedAt,
      message:
        record.medicationName +
        " was rejected by the caregiver and was not added to the medication list."
    });

    await redis.set(UPLOAD_KEY_PREFIX + requestId, rejected, { ex: RECORD_TTL_SECONDS });
    await redis.srem(PENDING_UPLOADS_KEY, requestId);

    return res.status(200).json(rejected);
  }

  // Approved. A name that already exists is recorded as a duplicate and
  // nothing new is created.
  const existing = findExistingMedication(record.medicationName);

  const approved = Object.assign({}, record, {
    status: "approved",
    decidedAt: decidedAt,
    duplicate: Boolean(existing),
    matchedExistingMedication: existing,
    message: existing
      ? record.medicationName +
        " was approved, but it already exists in the patient's medication list (matched \"" +
        existing +
        '"). No new medication was created.'
      : record.medicationName +
        " was approved and recorded as a new prescription. In a full " +
        "implementation this would now be added to the patient's medication " +
        "list; this demo keeps the medication list static per session, so it " +
        "is stored in the approved-prescriptions log instead."
  });

  await redis.set(UPLOAD_KEY_PREFIX + requestId, approved, { ex: RECORD_TTL_SECONDS });

  if (!existing) {
    await redis.rpush(APPROVED_LIST_KEY, approved);
  }

  await redis.srem(PENDING_UPLOADS_KEY, requestId);

  return res.status(200).json(approved);
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "GET" && req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({
      error: "Method not allowed. Use GET to list uploads or POST to decide one."
    });
  }

  try {
    const redis = getRedis();
    if (req.method === "GET") {
      return await handleGet(req, res, redis);
    }
    return await handlePost(req, res, redis);
  } catch (error) {
    console.error("[prescription-uploads] failed:", error);
    return res.status(500).json({
      error: "Prescription upload request failed: " + error.message
    });
  }
};
