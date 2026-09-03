// WebMCP tool registration for the Caregiver Approval Dashboard.
//
// Loaded only by caregiver.html. These tools let an authorized agent — one
// acting on the caregiver's behalf — review and decide pending requests
// programmatically, without clicking the Approve / Deny buttons. They call the
// same API routes the buttons call, so a tool-driven decision is
// indistinguishable from a hand-clicked one, and the dashboard's own 2-second
// poll reflects it on screen immediately.
//
// The API is very new and not uniformly shipped, so nothing here assumes it
// exists: we feature-detect `document.modelContext` and its `registerTool`
// method, and fall back to a loud console message instead of throwing.

(function registerCaregiverTools() {
  "use strict";

  var LOG_PREFIX = "[WebMCP Pharmacy]";

  // -------------------------------------------------------------------
  // Demo mode gate — identical to tools.js on the pharmacy page.
  //
  // Resolution: an explicit ?webmcp=on|off in this page's own URL decides the
  // mode. A bare URL with no parameter ALWAYS means 'on', and resets storage
  // to 'on' as it goes.
  //
  // localStorage is written so the toggle and the pages agree, but it is never
  // read as a source of truth: a stored 'off' from an earlier session must not
  // silently leave a visitor — a judge opening the plain link — with a
  // tool-free site they never asked for. Turning tools off is therefore always
  // deliberate and always visible in the address bar.
  //
  // With the mode off, NO tools are registered at all — the page stays a
  // completely ordinary website.
  // -------------------------------------------------------------------

  function getWebMCPMode() {
    var params = null;

    try {
      params = new URLSearchParams(window.location.search);
    } catch (error) {
      console.warn(LOG_PREFIX, "Could not read the WebMCP mode from the URL:", error.message);
    }

    // An explicit ?webmcp= value is the ONLY way to turn tools off. It is
    // seeded into storage so the toggle and the other pages agree on it.
    if (params && params.has("webmcp")) {
      var mode = params.get("webmcp");
      try {
        localStorage.setItem("webmcpDemoMode", mode);
      } catch (storageError) {
        console.warn(
          LOG_PREFIX,
          "Could not persist the WebMCP mode:",
          storageError.message
        );
      }
      return mode; // 'on' or 'off'
    }

    // No ?webmcp= parameter at all — a bare URL. Force ON and reset storage,
    // so a stored 'off' left behind by an earlier session can never leave a
    // visitor with a silently tool-free site they did not ask for.
    try {
      localStorage.setItem("webmcpDemoMode", "on");
    } catch (storageError) {
      console.warn(LOG_PREFIX, "Could not reset the WebMCP mode:", storageError.message);
    }
    return "on";
  }

  var webmcpDemoMode = getWebMCPMode();

  if (webmcpDemoMode === "off") {
    console.log(
      LOG_PREFIX,
      "Demo mode is OFF — tools are intentionally not registered to " +
        "demonstrate the fallback experience."
    );
    return;
  }

  var modelContext = typeof document !== "undefined" ? document.modelContext : undefined;

  if (!modelContext) {
    console.warn(
      LOG_PREFIX,
      "document.modelContext is not available in this browser. " +
        "Caregiver WebMCP tools were NOT registered. The page still works as a " +
        "normal web app. If you expected tool-calling to work, check that you " +
        "are in an agent browser with WebMCP enabled, and note that the global " +
        "may be exposed under a different name in this implementation."
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

  // Tool responses are plain MCP-style text content. Structured payloads are
  // returned as pretty-printed JSON so an agent can parse them reliably rather
  // than having to interpret prose.
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
    if (!client || typeof client.listPendingApprovals !== "function") {
      throw new Error(
        "The caregiver approval client is unavailable (window.ApprovalClient " +
          "is not loaded). Check that approval.js is included on the page."
      );
    }
    return client;
  }

  function requireString(args, field) {
    var value = args && args[field];
    if (typeof value !== "string" || value.trim() === "") {
      throw new Error(
        'Missing or invalid required argument "' + field + '": expected a non-empty string.'
      );
    }
    return value.trim();
  }

  function requireDecision(args, field, allowed) {
    var value = requireString(args, field).toLowerCase();
    if (allowed.indexOf(value) === -1) {
      throw new Error(
        'Invalid "' + field + '": expected one of ' +
          allowed.join(", ") +
          ' but received "' +
          value +
          '".'
      );
    }
    return value;
  }

  safeRegister({
    name: "list_pending_approvals",
    description:
      "List the controlled-substance refill requests currently awaiting a " +
      "caregiver decision, oldest first. Each entry includes the requestId " +
      "needed by decide_pending_approval, the medication, the patient, and " +
      "when it was requested. Returns an empty list when nothing is pending.",
    inputSchema: {
      type: "object",
      properties: {},
      required: []
    },
    async execute(args) {
      try {
        var client = getApprovalClient();
        var pending = await client.listPendingApprovals();

        console.log(LOG_PREFIX, "list_pending_approvals invoked:", pending.length, "pending");

        return jsonResult({
          pendingCount: pending.length,
          requests: pending.map(function (request) {
            return {
              requestId: request.requestId,
              medicationId: request.medicationId,
              medicationName: request.medicationName,
              patientName: request.patientName,
              status: request.status,
              requestedAt: request.createdAt
            };
          }),
          summary:
            pending.length === 0
              ? "No refill requests are awaiting caregiver approval."
              : pending.length +
                (pending.length === 1 ? " request is" : " requests are") +
                " awaiting a caregiver decision."
        });
      } catch (error) {
        console.error(LOG_PREFIX, "list_pending_approvals failed:", error);
        return textResult("list_pending_approvals failed: " + error.message, true);
      }
    }
  });

  safeRegister({
    name: "decide_pending_approval",
    description:
      "Approve or deny a pending controlled-substance refill request on the " +
      "caregiver's behalf — the same action as clicking Approve or Deny on the " +
      "caregiver dashboard. Approving allows the requester to complete the " +
      "refill; denying blocks it. Use list_pending_approvals to get the " +
      "requestId first. A request that was already decided keeps its original " +
      "decision.",
    inputSchema: {
      type: "object",
      properties: {
        requestId: {
          type: "string",
          description:
            "The approval request id, from list_pending_approvals."
        },
        decision: {
          type: "string",
          enum: ["approved", "denied"],
          description: 'Either "approved" or "denied".'
        }
      },
      required: ["requestId", "decision"]
    },
    async execute(args) {
      try {
        var requestId = requireString(args, "requestId");
        var decision = requireDecision(args, "decision", ["approved", "denied"]);
        var client = getApprovalClient();

        console.log(LOG_PREFIX, "decide_pending_approval invoked:", requestId, decision);

        var record = await client.submitDecision(requestId, decision);

        // The server refuses to flip an already-decided request, so report
        // what actually stands rather than what was asked for.
        var applied = record && record.status === decision;

        return jsonResult({
          requestId: record.requestId,
          medicationName: record.medicationName,
          patientName: record.patientName,
          decision: record.status,
          decidedAt: record.decidedAt,
          decisionApplied: applied,
          message: applied
            ? record.medicationName +
              " was " +
              record.status +
              " on the caregiver's behalf." +
              (record.status === "approved"
                ? " The requester can now complete the refill."
                : " The refill will not be completed.")
            : "This request had already been " +
              record.status +
              "; that decision stands and was not changed."
        });
      } catch (error) {
        console.error(LOG_PREFIX, "decide_pending_approval failed:", error);
        return textResult("decide_pending_approval failed: " + error.message, true);
      }
    }
  });

  safeRegister({
    name: "list_pending_uploads",
    description:
      "List the photographed prescriptions awaiting caregiver review, oldest " +
      "first. Each entry includes the requestId needed by " +
      "decide_pending_upload, the fields extracted from the image, and the " +
      "extraction confidence — a low confidence means the photo was hard to " +
      "read and the details deserve closer checking.",
    inputSchema: {
      type: "object",
      properties: {},
      required: []
    },
    async execute(args) {
      try {
        var client = getApprovalClient();
        var pending = await client.listPendingUploads();

        console.log(LOG_PREFIX, "list_pending_uploads invoked:", pending.length, "pending");

        return jsonResult({
          pendingCount: pending.length,
          uploads: pending.map(function (upload) {
            return {
              requestId: upload.requestId,
              medicationName: upload.medicationName,
              dosage: upload.dosage,
              patientName: upload.patientName,
              prescriberName: upload.prescriberName,
              confidence: upload.confidence,
              status: upload.status,
              uploadedAt: upload.createdAt
            };
          }),
          summary:
            pending.length === 0
              ? "No prescription uploads are awaiting caregiver review."
              : pending.length +
                (pending.length === 1 ? " upload is" : " uploads are") +
                " awaiting caregiver review."
        });
      } catch (error) {
        console.error(LOG_PREFIX, "list_pending_uploads failed:", error);
        return textResult("list_pending_uploads failed: " + error.message, true);
      }
    }
  });

  safeRegister({
    name: "decide_pending_upload",
    description:
      "Approve or reject a pending prescription upload on the caregiver's " +
      "behalf — the same action as clicking Approve or Reject on the caregiver " +
      "dashboard. Approving records the prescription (and flags it as a " +
      "duplicate if the medication already exists); rejecting discards it. Use " +
      "list_pending_uploads to get the requestId first.",
    inputSchema: {
      type: "object",
      properties: {
        requestId: {
          type: "string",
          description: "The upload request id, from list_pending_uploads."
        },
        decision: {
          type: "string",
          enum: ["approved", "rejected"],
          description: 'Either "approved" or "rejected".'
        }
      },
      required: ["requestId", "decision"]
    },
    async execute(args) {
      try {
        var requestId = requireString(args, "requestId");
        var decision = requireDecision(args, "decision", ["approved", "rejected"]);
        var client = getApprovalClient();

        console.log(LOG_PREFIX, "decide_pending_upload invoked:", requestId, decision);

        var record = await client.submitUploadDecision(requestId, decision);
        var applied = record && record.status === decision;

        return jsonResult({
          requestId: record.requestId,
          medicationName: record.medicationName,
          dosage: record.dosage,
          decision: record.status,
          decidedAt: record.decidedAt,
          duplicate: Boolean(record.duplicate),
          matchedExistingMedication: record.matchedExistingMedication || null,
          decisionApplied: applied,
          message: applied
            ? record.message ||
              record.medicationName + " was " + record.status + " on the caregiver's behalf."
            : "This upload had already been " +
              record.status +
              "; that decision stands and was not changed."
        });
      } catch (error) {
        console.error(LOG_PREFIX, "decide_pending_upload failed:", error);
        return textResult("decide_pending_upload failed: " + error.message, true);
      }
    }
  });
})();
