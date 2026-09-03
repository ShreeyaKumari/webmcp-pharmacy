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
  // Resolution: an explicit ?webmcp=on|off in this page's own URL decides the
  // mode. A bare URL with no parameter ALWAYS means 'on', and resets storage
  // to 'on' as it goes.
  //
  // The URL is the only source of truth because localStorage does not travel
  // between browser instances — ChatGPT's cloud browser is a separate session
  // from the user's own Chrome — and because a stored 'off' left over from an
  // earlier session must not silently leave a visitor with a tool-free site
  // they never asked for. Storage is still written so the toggle and the other
  // pages agree, but it is never read as authority.
  //
  // With the mode off, NO tools are registered at all — the page stays a
  // completely ordinary website, which is the whole point: it shows what an
  // agent has to fall back to when a site exposes no structured tools.
  //
  // localStorage throws in some privacy modes, so every access is guarded.
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

  // data.js exposes the interaction table as a global; resolve it lazily with
  // the same defensive contract as getStore().
  function getDrugInteractions() {
    var interactions = window.DRUG_INTERACTIONS;
    if (!Array.isArray(interactions)) {
      throw new Error(
        "The drug interaction table is unavailable (window.DRUG_INTERACTIONS " +
          "is not loaded). Check that data.js is included on the page."
      );
    }
    return interactions;
  }

  function requireIdArray(args, field, minItems) {
    var value = args && args[field];
    if (!Array.isArray(value)) {
      throw new Error(
        'Missing or invalid required argument "' + field + '": expected an array of strings.'
      );
    }

    var ids = [];
    value.forEach(function (item) {
      if (typeof item !== "string" || item.trim() === "") {
        throw new Error(
          'Invalid entry in "' + field + '": every id must be a non-empty string.'
        );
      }
      var id = item.trim();
      // Duplicates would otherwise produce meaningless self-pairs.
      if (ids.indexOf(id) === -1) {
        ids.push(id);
      }
    });

    if (ids.length < minItems) {
      throw new Error(
        '"' + field + '" needs at least ' + minItems + ' distinct medication ids, but received ' +
          ids.length + "."
      );
    }

    return ids;
  }

  // Severity ordering so the most dangerous interaction is reported first
  // rather than in table order.
  var SEVERITY_RANK = { severe: 3, moderate: 2, minor: 1 };

  function severityRank(severity) {
    return SEVERITY_RANK[String(severity).toLowerCase()] || 0;
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

  // Exists specifically to demonstrate a task a UI-reading agent has to guess
  // at. Nothing on the page states which medications interact — the data is
  // never rendered — so an agent reading the DOM must fall back on its own
  // pharmacological knowledge and infer a plausible-sounding answer, which may
  // be subtly wrong, incomplete, or invented. This tool cross-references the
  // site's actual interaction table and returns exactly what it contains.
  safeRegister({
    name: "check_drug_interactions",
    description:
      "Check the patient's medications against this pharmacy's drug " +
      "interaction table. Give two or more medication ids and it returns every " +
      "known interacting pair among them with its severity and clinical note, " +
      "most severe first. Use this instead of reasoning about interactions " +
      "from memory: it reports only what this pharmacy's records actually say.",
    inputSchema: {
      type: "object",
      properties: {
        medication_ids: {
          type: "array",
          items: { type: "string" },
          minItems: 2,
          description:
            "Two or more medication ids to check against each other, e.g. " +
            "[\"med-003\", \"med-004\"]. Use search_medications to find ids."
        }
      },
      required: ["medication_ids"]
    },
    async execute(args) {
      try {
        var medicationIds = requireIdArray(args, "medication_ids", 2);
        var store = getStore();
        var interactions = getDrugInteractions();

        console.log(LOG_PREFIX, "check_drug_interactions invoked with:", args);

        // Resolve names up front, and fail clearly on any unknown id rather
        // than silently reporting "no interactions" for a typo.
        var namesById = {};
        var unknown = [];

        medicationIds.forEach(function (id) {
          var eligibility = store.checkRefillEligibility(id);
          if (eligibility.found) {
            namesById[id] = eligibility.name;
          } else {
            unknown.push(id);
          }
        });

        if (unknown.length > 0) {
          return textResult(
            "Unknown medication id(s): " +
              unknown.join(", ") +
              ". Known ids: " +
              store
                .getAllMedications()
                .map(function (med) {
                  return med.id;
                })
                .join(", ") +
              ".",
            true
          );
        }

        var found = [];

        for (var i = 0; i < medicationIds.length; i++) {
          for (var j = i + 1; j < medicationIds.length; j++) {
            var a = medicationIds[i];
            var b = medicationIds[j];

            interactions.forEach(function (entry) {
              var matches =
                (entry.medA === a && entry.medB === b) ||
                (entry.medA === b && entry.medB === a);

              if (matches) {
                found.push({
                  medicationIds: [a, b],
                  medications: [namesById[a], namesById[b]],
                  severity: entry.severity,
                  note: entry.note
                });
              }
            });
          }
        }

        found.sort(function (x, y) {
          return severityRank(y.severity) - severityRank(x.severity);
        });

        if (found.length === 0) {
          return jsonResult({
            checked: medicationIds.map(function (id) {
              return { id: id, name: namesById[id] };
            }),
            pairsChecked: (medicationIds.length * (medicationIds.length - 1)) / 2,
            interactionCount: 0,
            interactions: [],
            summary:
              "No known interactions between " +
              medicationIds
                .map(function (id) {
                  return namesById[id];
                })
                .join(", ") +
              " in this pharmacy's interaction table."
          });
        }

        return jsonResult({
          checked: medicationIds.map(function (id) {
            return { id: id, name: namesById[id] };
          }),
          pairsChecked: (medicationIds.length * (medicationIds.length - 1)) / 2,
          interactionCount: found.length,
          highestSeverity: found[0].severity,
          interactions: found,
          summary:
            found.length +
            (found.length === 1 ? " interaction" : " interactions") +
            " found; highest severity: " +
            found[0].severity +
            "."
        });
      } catch (error) {
        console.error(LOG_PREFIX, "check_drug_interactions failed:", error);
        return textResult("check_drug_interactions failed: " + error.message, true);
      }
    }
  });

  // Exists specifically to demonstrate a task a UI-reading agent has to
  // reason its way through. The page shows each medication's last-filled date
  // and a human-worded badge, so answering "what can be refilled today?"
  // means doing date arithmetic across five cards from rendered text — easy to
  // get subtly wrong, and worse once a search has filtered the list. This tool
  // computes every answer from the same eligibility logic the UI uses and
  // returns the whole picture in one deterministic response.
  safeRegister({
    name: "get_refill_summary",
    description:
      "Get the refill status of every medication for this patient in one " +
      "call: whether each is eligible right now, the exact date it becomes " +
      "eligible if not, whether it is a controlled substance, and whether " +
      "completing its refill would require caregiver approval. Use this " +
      "instead of computing eligibility dates yourself — the dates are " +
      "calculated, not estimated.",
    inputSchema: {
      type: "object",
      properties: {},
      required: []
    },
    async execute(args) {
      try {
        var store = getStore();

        console.log(LOG_PREFIX, "get_refill_summary invoked");

        var all = store.getAllMedications();
        var asOf = null;
        var patientName = null;

        // Reuses checkRefillEligibility() — the same shared function behind
        // the check_refill_eligibility tool and the UI badges — so the date
        // math exists in exactly one place.
        var medications = all.map(function (med) {
          var eligibility = store.checkRefillEligibility(med.id);

          asOf = eligibility.today;
          patientName = eligibility.patientName;

          var entry = {
            id: eligibility.medicationId,
            name: eligibility.name,
            dosage: eligibility.dosage,
            eligible: eligibility.isEligible,
            isControlledSubstance: eligibility.isControlledSubstance
          };

          if (!eligibility.isEligible) {
            entry.eligibleOn = eligibility.eligibleOn;
          }

          if (eligibility.isControlledSubstance) {
            entry.requiresCaregiverApproval = eligibility.requiresCaregiverApproval;
          }

          return entry;
        });

        var eligibleNow = medications.filter(function (med) {
          return med.eligible;
        });
        var needsApproval = eligibleNow.filter(function (med) {
          return med.requiresCaregiverApproval === true;
        });

        return jsonResult({
          patientName: patientName,
          asOf: asOf,
          medicationCount: medications.length,
          eligibleCount: eligibleNow.length,
          awaitingCaregiverApprovalCount: needsApproval.length,
          medications: medications,
          summary:
            eligibleNow.length +
            " of " +
            medications.length +
            " medications can be refilled now" +
            (needsApproval.length > 0
              ? ", " +
                needsApproval.length +
                " of which require caregiver approval to complete."
              : ".")
        });
      } catch (error) {
        console.error(LOG_PREFIX, "get_refill_summary failed:", error);
        return textResult("get_refill_summary failed: " + error.message, true);
      }
    }
  });

  // Lets an agent hand a photographed prescription to the site's own vision
  // pipeline rather than transcribing it by eye. The extraction is advisory,
  // not authoritative: the result becomes a pending_review record that a
  // caregiver must approve, mirroring the controlled-substance refill gate.
  // An agent cannot add a medication to this patient on its own.
  safeRegister({
    name: "upload_prescription",
    description:
      "Submit a photographed prescription for AI-assisted extraction and " +
      "caregiver review. The image is analysed to pull out the medication " +
      "name, dosage, patient, prescriber and a legibility confidence rating, " +
      "and the result is queued for a caregiver to approve or reject. This " +
      "does NOT add the medication to the patient's list — approval by a human " +
      "caregiver is always required first.",
    inputSchema: {
      type: "object",
      properties: {
        imageBase64: {
          type: "string",
          description:
            "The prescription photo as base64-encoded image data (a data: URL " +
            "is also accepted). Maximum 4MB decoded."
        },
        mimeType: {
          type: "string",
          description:
            'The image MIME type, e.g. "image/jpeg" or "image/png".'
        }
      },
      required: ["imageBase64", "mimeType"]
    },
    async execute(args) {
      try {
        var imageBase64 = requireString(args, "imageBase64");
        var mimeType = requireString(args, "mimeType");
        var client = getApprovalClient();

        console.log(
          LOG_PREFIX,
          "upload_prescription invoked (" + mimeType + ", " + imageBase64.length + " base64 chars)"
        );

        var payload = await client.analyzePrescription({
          imageBase64: imageBase64,
          mimeType: mimeType
        });

        var extracted = payload.extracted || {};

        return jsonResult({
          requestId: payload.requestId,
          status: payload.status || "pending_review",
          extracted: {
            medicationName: extracted.medicationName,
            dosage: extracted.dosage,
            patientName: extracted.patientName,
            prescriberName: extracted.prescriberName,
            confidence: extracted.confidence
          },
          addedToMedicationList: false,
          message:
            "Prescription analysed and submitted for caregiver review as " +
            payload.requestId +
            ". It is PENDING caregiver review and has NOT been added to the " +
            "patient's medication list. A caregiver must approve it on the " +
            "caregiver dashboard first." +
            (extracted.confidence === "low"
              ? " Extraction confidence is LOW — the image may be hard to read, " +
                "so the caregiver should check the details carefully."
              : "")
        });
      } catch (error) {
        console.error(LOG_PREFIX, "upload_prescription failed:", error);
        return textResult("upload_prescription failed: " + error.message, true);
      }
    }
  });

})();
