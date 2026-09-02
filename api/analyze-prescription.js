// POST /api/analyze-prescription
//
// Takes a photographed prescription, asks Gemini to extract the medication
// details as strict JSON, and files the result as a pending_review record in
// Redis. Nothing is ever added to the patient's medications by this endpoint —
// a caregiver has to approve it through /api/prescription-uploads first.
//
// Plain Vercel Node.js serverless function (module.exports), not Next.js.
// Deliberately self-contained — no shared local require — so the function
// bundles cleanly with zero build configuration.

const { Redis } = require("@upstash/redis");
const { randomUUID } = require("crypto");

// Redis keys
const UPLOAD_KEY_PREFIX = "prescription-upload:";
const PENDING_UPLOADS_KEY = "pending-uploads";
const RECORD_TTL_SECONDS = 60 * 60 * 24;

// Gemini
const GEMINI_ENDPOINT =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent";
const GEMINI_TIMEOUT_MS = 25000;

// ~4MB of decoded image data.
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

const ALLOWED_MIME_TYPES = [
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif"
];

const VALID_CONFIDENCE = ["high", "medium", "low"];

// Never leaks provider detail or key state to the client.
const FRIENDLY_FAILURE =
  "Prescription analysis is temporarily unavailable. Please try again in a moment.";

const EXTRACTION_PROMPT =
  "You are reading a photograph of a medical prescription. Extract the " +
  "following fields and respond with a single JSON object and nothing else — " +
  "no markdown, no code fences, no commentary.\n\n" +
  "Fields:\n" +
  '- "medicationName": the medication name as a string.\n' +
  '- "dosage": the dosage and frequency as a string (e.g. "10mg, once daily").\n' +
  '- "patientName": the patient name if visible, otherwise null.\n' +
  '- "prescriberName": the prescriber or doctor name if visible, otherwise null.\n' +
  '- "confidence": "high", "medium", or "low", reflecting how legible the ' +
  "image was and how certain you are of the extracted values.\n\n" +
  "Use null for any field you cannot read. Do not invent values.";

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

// Accepts either raw base64 or a full data: URL, and returns the raw base64.
function normalizeBase64(value) {
  var cleaned = String(value).trim();
  var dataUrl = /^data:([^;]+);base64,(.*)$/i.exec(cleaned);
  if (dataUrl) {
    cleaned = dataUrl[2];
  }
  return cleaned.replace(/\s/g, "");
}

// Decoded byte length of a base64 string, without allocating a Buffer.
function base64ByteLength(base64) {
  var padding = 0;
  if (base64.endsWith("==")) {
    padding = 2;
  } else if (base64.endsWith("=")) {
    padding = 1;
  }
  return Math.floor((base64.length * 3) / 4) - padding;
}

// Models sometimes wrap JSON in ```json fences despite instructions.
function stripCodeFences(text) {
  var trimmed = String(text).trim();
  var fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  if (fenced) {
    return fenced[1].trim();
  }
  return trimmed;
}

function cleanField(value) {
  if (value === null || value === undefined) {
    return null;
  }
  var text = String(value).trim();
  if (text === "" || text.toLowerCase() === "null" || text.toLowerCase() === "n/a") {
    return null;
  }
  return text;
}

function normalizeConfidence(value) {
  var confidence = String(value === null || value === undefined ? "" : value)
    .trim()
    .toLowerCase();
  // An unrecognised or missing confidence is treated as the least trustworthy
  // value rather than silently claiming certainty.
  return VALID_CONFIDENCE.indexOf(confidence) === -1 ? "low" : confidence;
}

async function callGemini(apiKey, imageBase64, mimeType) {
  var controller = new AbortController();
  var timer = setTimeout(function () {
    controller.abort();
  }, GEMINI_TIMEOUT_MS);

  try {
    var response = await fetch(GEMINI_ENDPOINT + "?key=" + encodeURIComponent(apiKey), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        contents: [
          {
            parts: [
              { text: EXTRACTION_PROMPT },
              { inline_data: { mime_type: mimeType, data: imageBase64 } }
            ]
          }
        ],
        generationConfig: {
          temperature: 0,
          responseMimeType: "application/json"
        }
      })
    });

    if (!response.ok) {
      var detail = "";
      try {
        detail = (await response.text()).slice(0, 500);
      } catch (readError) {
        detail = "(response body unreadable)";
      }
      // Logged server-side only; the client gets FRIENDLY_FAILURE.
      throw new Error("Gemini returned HTTP " + response.status + ": " + detail);
    }

    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

function extractModelText(payload) {
  var candidates = payload && payload.candidates;
  if (!Array.isArray(candidates) || candidates.length === 0) {
    // Safety blocks and empty completions land here.
    throw new Error(
      "Gemini returned no candidates: " + JSON.stringify(payload).slice(0, 500)
    );
  }

  var parts = candidates[0].content && candidates[0].content.parts;
  if (!Array.isArray(parts) || parts.length === 0) {
    throw new Error("Gemini candidate contained no parts.");
  }

  var text = parts
    .map(function (part) {
      return part && typeof part.text === "string" ? part.text : "";
    })
    .join("")
    .trim();

  if (text === "") {
    throw new Error("Gemini candidate contained no text.");
  }

  return text;
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({
      error: "Method not allowed. Use POST to submit a prescription image."
    });
  }

  // ---- Validate the request before spending an API call on it ----

  var imageBase64;
  var mimeType;

  try {
    var body = parseBody(req);

    if (typeof body.imageBase64 !== "string" || body.imageBase64.trim() === "") {
      throw new Error('Missing or invalid "imageBase64": expected a base64-encoded image.');
    }

    if (typeof body.mimeType !== "string" || body.mimeType.trim() === "") {
      throw new Error('Missing or invalid "mimeType": expected an image MIME type.');
    }

    mimeType = body.mimeType.trim().toLowerCase();
    if (ALLOWED_MIME_TYPES.indexOf(mimeType) === -1) {
      throw new Error(
        'Unsupported "mimeType": ' +
          mimeType +
          ". Supported types: " +
          ALLOWED_MIME_TYPES.join(", ") +
          "."
      );
    }

    imageBase64 = normalizeBase64(body.imageBase64);
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(imageBase64)) {
      throw new Error('"imageBase64" is not valid base64 data.');
    }

    var byteLength = base64ByteLength(imageBase64);
    if (byteLength > MAX_IMAGE_BYTES) {
      throw new Error(
        "Image is too large: " +
          Math.round(byteLength / 1024) +
          "KB. The maximum is " +
          MAX_IMAGE_BYTES / (1024 * 1024) +
          "MB. Resize or recompress the photo and try again."
      );
    }
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }

  // ---- Analyse, then file for caregiver review ----

  var apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error("[analyze-prescription] GEMINI_API_KEY is not set.");
    return res.status(500).json({ error: FRIENDLY_FAILURE });
  }

  var modelText;

  try {
    var payload = await callGemini(apiKey, imageBase64, mimeType);
    modelText = extractModelText(payload);
  } catch (error) {
    console.error("[analyze-prescription] Gemini call failed:", error);
    return res.status(502).json({ error: FRIENDLY_FAILURE });
  }

  var parsed;
  try {
    parsed = JSON.parse(stripCodeFences(modelText));
  } catch (error) {
    console.error(
      "[analyze-prescription] Model did not return valid JSON:",
      modelText.slice(0, 500)
    );
    return res.status(502).json({
      error:
        "The prescription could not be read as structured data. Try a clearer, " +
        "well-lit photo of the whole prescription."
    });
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return res.status(502).json({
      error:
        "The prescription could not be read as structured data. Try a clearer, " +
        "well-lit photo of the whole prescription."
    });
  }

  var extracted = {
    medicationName: cleanField(parsed.medicationName),
    dosage: cleanField(parsed.dosage),
    patientName: cleanField(parsed.patientName),
    prescriberName: cleanField(parsed.prescriberName),
    confidence: normalizeConfidence(parsed.confidence)
  };

  // A record with no medication name is useless to a caregiver, so it is
  // reported as a failure instead of being filed for review.
  if (!extracted.medicationName) {
    return res.status(422).json({
      error:
        "No medication name could be identified in this image. Try a clearer " +
        "photo, or make sure the whole prescription is in frame."
    });
  }

  try {
    var redis = getRedis();
    var requestId = randomUUID();

    var record = {
      requestId: requestId,
      type: "prescription_upload",
      status: "pending_review",
      createdAt: new Date().toISOString(),
      mimeType: mimeType,
      medicationName: extracted.medicationName,
      dosage: extracted.dosage,
      patientName: extracted.patientName,
      prescriberName: extracted.prescriberName,
      confidence: extracted.confidence
    };

    // The image itself is deliberately not stored — only the extracted fields.
    await redis.set(UPLOAD_KEY_PREFIX + requestId, record, { ex: RECORD_TTL_SECONDS });
    await redis.sadd(PENDING_UPLOADS_KEY, requestId);

    return res.status(201).json({
      requestId: requestId,
      extracted: extracted,
      status: "pending_review",
      message:
        "Extracted successfully and submitted for caregiver review. It is NOT " +
        "yet part of the patient's medication list."
    });
  } catch (error) {
    console.error("[analyze-prescription] Could not store the upload:", error);
    return res.status(500).json({
      error:
        "The prescription was analysed but could not be saved for review: " +
        error.message
    });
  }
};
