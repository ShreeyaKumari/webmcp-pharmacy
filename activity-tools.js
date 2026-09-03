// WebMCP tool registration for the Activity Log page.
//
// Loaded only by activity.html. One tool, exposing the same two histories the
// page renders — approved prescription uploads and past caregiver decisions on
// refill requests — as a single structured response, so an agent can answer
// "what has happened so far?" in one call instead of reading two lists off the
// DOM and merging them by eye.
//
// The API is very new and not uniformly shipped, so nothing here assumes it
// exists: we feature-detect `document.modelContext` and its `registerTool`
// method, and fall back to a loud console message instead of throwing.

(function registerActivityTools() {
  "use strict";

  var LOG_PREFIX = "[WebMCP Pharmacy]";

  var modelContext = typeof document !== "undefined" ? document.modelContext : undefined;

  if (!modelContext) {
    console.warn(
      LOG_PREFIX,
      "document.modelContext is not available in this browser. " +
        "Activity log WebMCP tools were NOT registered. The page still works " +
        "as a normal web app. If you expected tool-calling to work, check that " +
        "you are in an agent browser with WebMCP enabled, and note that the " +
        "global may be exposed under a different name in this implementation."
    );
    return;
  }

  if (typeof modelContext.registerTool !== "function") {
    console.warn(
      LOG_PREFIX,
      "document.modelContext exists but has no registerTool() method. " +
        "This implementation may use a different registration API " +
        "(e.g. provideContext). Available keys:",
      Object.keys(modelContext)
    );
    return;
  }

  // Every registration goes through this helper so each tool repeats the same
  // defensive contract: re-check that the API is still there, and never let a
  // registration failure take down the rest of the page.
  function safeRegister(definition) {
    if (!modelContext || typeof modelContext.registerTool !== "function") {
      console.warn(
        LOG_PREFIX,
        "Skipped registering tool '" + definition.name + "': " +
          "document.modelContext.registerTool() is not available."
      );
      return false;
    }

    try {
      modelContext.registerTool(definition);
      console.log(
        LOG_PREFIX,
        'WebMCP tool "' + definition.name +
          '" registered successfully via document.modelContext.registerTool().'
      );
      return true;
    } catch (error) {
      console.error(
        LOG_PREFIX,
        "Failed to register WebMCP tool '" + definition.name + "':",
        error
      );
      return false;
    }
  }

  function textResult(text, isError) {
    var result = { content: [{ type: "text", text: text }] };
    if (isError) {
      result.isError = true;
    }
    return result;
  }

  function jsonResult(payload) {
    return textResult(JSON.stringify(payload, null, 2), false);
  }

  // approval.js loads before this file, but resolve it lazily anyway so a
  // missing script produces a clear tool error instead of a crash.
  function getApprovalClient() {
    var client = window.ApprovalClient;
    if (
      !client ||
      typeof client.listApprovedPrescriptions !== "function" ||
      typeof client.listRefillDecisions !== "function"
    ) {
      throw new Error(
        "The approval client is unavailable (window.ApprovalClient is not " +
          "loaded). Check that approval.js is included on the page."
      );
    }
    return client;
  }

  // Optional positive integer; anything else is rejected rather than guessed.
  function optionalLimit(args, field) {
    var value = args && args[field];
    if (value === undefined || value === null) {
      return null;
    }
    if (typeof value !== "number" || !isFinite(value) || value < 1 || value % 1 !== 0) {
      throw new Error(
        'Invalid "' + field + '": expected a positive whole number, but received ' +
          JSON.stringify(value) +
          "."
      );
    }
    return value;
  }

  function applyLimit(entries, limit) {
    return limit === null ? entries : entries.slice(0, limit);
  }

  safeRegister({
    name: "get_activity_log",
    description:
      "Get the pharmacy's decision history in one call: prescription uploads a " +
      "caregiver approved, and caregiver decisions on controlled-substance " +
      "refill requests. Both lists are newest first. Note that refills of " +
      "non-controlled medications are not recorded here, because they never " +
      "reach the server.",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "number",
          minimum: 1,
          description:
            "Optional. Return at most this many entries from each history. " +
            "Omit for everything retained (each history keeps its 20 most " +
            "recent entries)."
        }
      },
      required: []
    },
    async execute(args) {
      try {
        var limit = optionalLimit(args, "limit");
        var client = getApprovalClient();

        console.log(LOG_PREFIX, "get_activity_log invoked", limit ? "(limit " + limit + ")" : "");

        // Both histories are independent reads, so fetch them together.
        var results = await Promise.all([
          client.listApprovedPrescriptions(),
          client.listRefillDecisions()
        ]);

        var approvedPrescriptions = applyLimit(results[0], limit);
        var refillDecisions = applyLimit(results[1], limit);

        var approvedRefills = refillDecisions.filter(function (entry) {
          return entry.status === "approved";
        }).length;
        var deniedRefills = refillDecisions.filter(function (entry) {
          return entry.status === "denied";
        }).length;

        return jsonResult({
          limit: limit,
          approvedPrescriptions: {
            count: approvedPrescriptions.length,
            entries: approvedPrescriptions.map(function (entry) {
              return {
                requestId: entry.requestId,
                medicationName: entry.medicationName,
                dosage: entry.dosage,
                patientName: entry.patientName,
                prescriberName: entry.prescriberName,
                confidence: entry.confidence,
                approvedAt: entry.decidedAt,
                duplicate: Boolean(entry.duplicate),
                matchedExistingMedication: entry.matchedExistingMedication || null
              };
            })
          },
          refillDecisions: {
            count: refillDecisions.length,
            approved: approvedRefills,
            denied: deniedRefills,
            entries: refillDecisions.map(function (entry) {
              return {
                requestId: entry.requestId,
                medicationId: entry.medicationId,
                medicationName: entry.medicationName,
                patientName: entry.patientName,
                decision: entry.status,
                requestedAt: entry.requestedAt,
                decidedAt: entry.decidedAt
              };
            })
          },
          summary:
            approvedPrescriptions.length +
            (approvedPrescriptions.length === 1
              ? " approved prescription upload and "
              : " approved prescription uploads and ") +
            refillDecisions.length +
            (refillDecisions.length === 1 ? " refill decision" : " refill decisions") +
            (refillDecisions.length > 0
              ? " (" + approvedRefills + " approved, " + deniedRefills + " denied)."
              : "."),
          note:
            "Refills of non-controlled medications complete in the pharmacy " +
            "page's in-memory state and are not part of this history."
        });
      } catch (error) {
        console.error(LOG_PREFIX, "get_activity_log failed:", error);
        return textResult("get_activity_log failed: " + error.message, true);
      }
    }
  });
})();
