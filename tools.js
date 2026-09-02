// WebMCP tool registration.
//
// Stage 0: a single placeholder tool ("say_hello") whose only job is to prove
// that the WebMCP surface is reachable from an agent (ChatGPT's in-app browser,
// Chrome with WebMCP enabled, etc.) before any real pharmacy tools are built.
//
// The API is very new and not uniformly shipped, so nothing here assumes it
// exists: we feature-detect `document.modelContext` and its `registerTool`
// method, and fall back to a loud console message instead of throwing.

(function registerWebMCPTools() {
  "use strict";

  var LOG_PREFIX = "[WebMCP Pharmacy]";

  // -------------------------------------------------------------------
  // Demo mode gate
  //
  // Resolution order: ?webmcp=on|off in the URL, then localStorage, then 'on'.
  //
  // The URL takes precedence because localStorage does not travel between
  // browser instances — ChatGPT's cloud browser is a separate session from the
  // user's own Chrome, so a shared link is the only way to hand a specific
  // mode to another agent. The toggle writes both.
  //
  // With the mode off, NO tools are registered at all — the page stays a
  // completely ordinary website, which is the whole point: it shows what an
  // agent has to fall back to when a site exposes no structured tools.
  //
  // localStorage throws in some privacy modes, so a failed read falls through
  // to the default rather than breaking the page.
  // -------------------------------------------------------------------

  function getWebMCPMode() {
    try {
      var params = new URLSearchParams(window.location.search);
      if (params.has("webmcp")) {
        return params.get("webmcp"); // 'on' or 'off'
      }
    } catch (error) {
      console.warn(LOG_PREFIX, "Could not read the WebMCP mode from the URL:", error.message);
    }

    try {
      return localStorage.getItem("webmcpDemoMode") || "on";
    } catch (error) {
      console.warn(LOG_PREFIX, "Could not read the WebMCP demo mode setting:", error.message);
      return "on";
    }
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
        "WebMCP tools were NOT registered. The page still works as a normal " +
        "web app. If you expected tool-calling to work, check that you are in " +
        "an agent browser with WebMCP enabled, and note that the global may be " +
        "exposed under a different name in this implementation."
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
  // defensive contract as say_hello: re-check that the API is still there, and
  // never let a registration failure take down the rest of the page.
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

  // app.js loads after this file, so the shared store is resolved lazily at
  // invocation time rather than at registration time.
  function getStore() {
    var store = window.PharmacyStore;
    if (!store || typeof store.searchMedications !== "function") {
      throw new Error(
        "The pharmacy page has not finished loading (window.PharmacyStore is " +
          "unavailable). Please retry in a moment."
      );
    }
    return store;
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

  // -------------------------------------------------------------------
  // Caregiver approval (Stage 4)
  //
  // Controlled-substance refills are gated on a caregiver decision that is
  // stored server-side in Redis, so the approval can be granted from a
  // completely separate browser session (caregiver.html).
  //
  // The HTTP request/poll logic lives in approval.js and is shared with the
  // Refill button in app.js. The only difference here is the poll budget: an
  // agent tool call cannot hang forever, so it gives up after 30 seconds,
  // whereas the UI keeps waiting because a human is watching it.
  // -------------------------------------------------------------------

  var APPROVAL_POLL_INTERVAL_MS = 2000;
  var APPROVAL_MAX_POLLS = 15; // 15 polls x 2s = 30s

  // approval.js loads before this file, but resolve it lazily anyway so a
  // missing script produces a clear tool error instead of a crash.
  function getApprovalClient() {
    var client = window.ApprovalClient;
    if (!client || typeof client.requestApproval !== "function") {
      throw new Error(
        "The caregiver approval client is unavailable (window.ApprovalClient " +
          "is not loaded). Check that approval.js is included on the page."
      );
    }
    return client;
  }

  // The full controlled-substance path: request approval, wait, then complete
  // the refill through the same shared refillPrescription() the UI uses.
  async function refillWithCaregiverApproval(store, eligibility) {
    var client = getApprovalClient();

    var requestId = await client.requestApproval({
      medicationId: eligibility.medicationId,
      medicationName: eligibility.name,
      patientName: eligibility.patientName
    });

    console.log(
      LOG_PREFIX,
      "caregiver approval requested for " + eligibility.medicationId + ":",
      requestId
    );

    var outcome = await client.waitForDecision(requestId, {
      intervalMs: APPROVAL_POLL_INTERVAL_MS,
      maxPolls: APPROVAL_MAX_POLLS
    });

    if (outcome.status === "denied") {
      return textResult(
        "The caregiver DENIED the refill request for " +
          eligibility.name +
          ". The prescription was not refilled. (Request id: " +
          requestId +
          ")",
        false
      );
    }

    if (outcome.status === "timeout") {
      var timeoutMessage =
        "The approval request for " +
          eligibility.name +
          " is still pending caregiver review after " +
          (APPROVAL_MAX_POLLS * APPROVAL_POLL_INTERVAL_MS) / 1000 +
          " seconds. It has NOT been approved and the refill was NOT completed. " +
          "Request id: " +
          requestId +
          " — this request stays open and can be checked again later.";

      if (outcome.lastError) {
        timeoutMessage +=
          " Note: at least one status check failed (" + outcome.lastError.message + ")";
      }

      return textResult(timeoutMessage, false);
    }

    // Approved — complete the refill via the shared function, passing the
    // caregiver approval so the controlled-substance block is satisfied.
    var result = store.refillPrescription(eligibility.medicationId, {
      caregiverApproved: true
    });

    if (result.status !== "refilled") {
      return textResult(
        "The caregiver approved the request, but the refill could not be " +
          "completed: " +
          result.message +
          " (Request id: " +
          requestId +
          ")",
        true
      );
    }

    return jsonResult(
      Object.assign({}, result, {
        approvalRequestId: requestId,
        approvedAt: outcome.record ? outcome.record.decidedAt : undefined,
        message:
          result.message +
          " This controlled substance was refilled after caregiver approval."
      })
    );
  }

  safeRegister({
    name: "say_hello",
    description:
      "Placeholder connectivity check for the WebMCP Pharmacy Demo. " +
      "Returns a greeting confirming that WebMCP tool-calling is working.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "The name of the person to greet."
        }
      },
      required: ["name"]
    },
    async execute(args) {
      var name = (args && args.name) || "there";

      // Random per-invocation token: proves this exact response was
      // generated by a live execution of this function at call time,
      // not guessed or paraphrased from reading the source code.
      var verificationCode = Math.floor(100000 + Math.random() * 900000);

      var text =
        "Hello, " +
        name +
        "! WebMCP is working. Verification code: " +
        verificationCode;

      console.log(LOG_PREFIX, "say_hello invoked with:", args, "code:", verificationCode);

      return {
        content: [{ type: "text", text: text }]
      };
    }
  });

  safeRegister({
    name: "search_medications",
    description:
      "Search the patient's medication list by medication name. Returns the " +
      "matching medications with their id, name, dosage and patient name. " +
      "Use the returned id with check_refill_eligibility or refill_prescription.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Medication name or partial name to search for, e.g. \"lisin\". " +
            "Matching is case-insensitive."
        }
      },
      required: ["query"]
    },
    async execute(args) {
      try {
        var query = requireString(args, "query");
        var matches = getStore().searchMedications(query);

        console.log(LOG_PREFIX, "search_medications invoked with:", args);

        if (matches.length === 0) {
          return textResult(
            'No matches found for "' + query + '". Try a shorter or different ' +
              "medication name.",
            false
          );
        }

        return jsonResult({
          query: query,
          matchCount: matches.length,
          medications: matches.map(function (med) {
            return {
              id: med.id,
              name: med.name,
              dosage: med.dosage,
              patientName: med.patientName
            };
          })
        });
      } catch (error) {
        console.error(LOG_PREFIX, "search_medications failed:", error);
        return textResult("search_medications failed: " + error.message, true);
      }
    }
  });

  safeRegister({
    name: "check_refill_eligibility",
    description:
      "Check whether a specific medication can be refilled right now. Returns " +
      "a structured answer including the eligibility date, whether the " +
      "medication is a controlled substance, and whether caregiver approval " +
      "would be required to complete the refill.",
    inputSchema: {
      type: "object",
      properties: {
        medication_id: {
          type: "string",
          description:
            "The medication id, e.g. \"med-001\". Use search_medications to find it."
        }
      },
      required: ["medication_id"]
    },
    async execute(args) {
      try {
        var medicationId = requireString(args, "medication_id");
        var eligibility = getStore().checkRefillEligibility(medicationId);

        console.log(LOG_PREFIX, "check_refill_eligibility invoked with:", args);

        if (!eligibility.found) {
          return textResult(eligibility.message, true);
        }

        return jsonResult({
          medicationId: eligibility.medicationId,
          name: eligibility.name,
          patientName: eligibility.patientName,
          eligible: eligibility.isEligible,
          today: eligibility.today,
          lastFilledDate: eligibility.lastFilledDate,
          refillEligibleAfterDays: eligibility.refillEligibleAfterDays,
          eligibleOn: eligibility.eligibleOn,
          isControlledSubstance: eligibility.isControlledSubstance,
          requiresCaregiverApproval: eligibility.requiresCaregiverApproval,
          summary: eligibility.message
        });
      } catch (error) {
        console.error(LOG_PREFIX, "check_refill_eligibility failed:", error);
        return textResult("check_refill_eligibility failed: " + error.message, true);
      }
    }
  });

  safeRegister({
    name: "refill_prescription",
    description:
      "Request a refill for a specific medication. Non-controlled medications " +
      "are refilled immediately when eligible. Controlled substances open a " +
      "caregiver approval request and wait up to 30 seconds for the caregiver " +
      "to approve or deny it on the caregiver dashboard; the refill only " +
      "completes on approval. On success the page's medication list updates " +
      "immediately.",
    inputSchema: {
      type: "object",
      properties: {
        medication_id: {
          type: "string",
          description:
            "The medication id to refill, e.g. \"med-002\". Use search_medications to find it."
        }
      },
      required: ["medication_id"]
    },
    async execute(args) {
      try {
        var medicationId = requireString(args, "medication_id");
        var store = getStore();

        // Eligibility is checked first so a controlled substance that is not
        // yet due never bothers the caregiver with an approval request.
        var eligibility = store.checkRefillEligibility(medicationId);

        console.log(LOG_PREFIX, "refill_prescription invoked with:", args);

        if (!eligibility.found) {
          return textResult(eligibility.message, true);
        }

        if (!eligibility.isEligible) {
          return textResult(
            eligibility.name +
              " cannot be refilled yet. Last filled " +
              eligibility.lastFilledDate +
              "; it becomes eligible on " +
              eligibility.eligibleOn +
              ".",
            true
          );
        }

        if (eligibility.isControlledSubstance) {
          return await refillWithCaregiverApproval(store, eligibility);
        }

        var result = store.refillPrescription(medicationId);

        console.log(LOG_PREFIX, "refill_prescription result:", result.status);

        if (result.status !== "refilled") {
          return textResult(result.message, true);
        }

        return jsonResult(result);
      } catch (error) {
        console.error(LOG_PREFIX, "refill_prescription failed:", error);
        return textResult("refill_prescription failed: " + error.message, true);
      }
    }
  });

})();
