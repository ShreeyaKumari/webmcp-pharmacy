// Shared caregiver-approval client.
//
// One implementation of the request/poll/decide HTTP calls, used by all three
// surfaces so their behaviour can never drift apart:
//   - tools.js       (WebMCP refill_prescription, capped at 15 polls)
//   - app.js         (the Refill button, polls until a decision arrives)
//   - caregiver.html (the dashboard list and Approve / Deny buttons)
//
// Plain script, no modules: attaches window.ApprovalClient.

(function () {
  "use strict";

  var LOG_PREFIX = "[WebMCP Pharmacy]";
  var DEFAULT_POLL_INTERVAL_MS = 2000;

  function delay(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
    });
  }

  // Reads a JSON error message out of a failed response body when there is
  // one, so callers can surface the server's own explanation.
  async function readErrorMessage(response) {
    try {
      var payload = await response.json();
      if (payload && payload.error) {
        return payload.error;
      }
    } catch (error) {
      // Body was not JSON; fall through to the status text.
    }
    return "HTTP " + response.status + " " + (response.statusText || "");
  }

  async function fetchJSON(url, options) {
    var response;
    try {
      response = await fetch(url, options);
    } catch (error) {
      // Network-level failure: offline, DNS, CORS, aborted request.
      throw new Error(
        "Could not reach " + url + " (" + (error && error.message ? error.message : error) + ")."
      );
    }

    if (!response.ok) {
      throw new Error("Request to " + url + " failed: " + (await readErrorMessage(response)));
    }

    try {
      return await response.json();
    } catch (error) {
      throw new Error("Response from " + url + " was not valid JSON.");
    }
  }

  // Creates a pending approval record and returns its requestId.
  async function requestApproval(details) {
    var payload = await fetchJSON("/api/request-approval", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        medicationId: details.medicationId,
        medicationName: details.medicationName,
        patientName: details.patientName
      })
    });

    if (!payload || typeof payload.requestId !== "string") {
      throw new Error("/api/request-approval did not return a requestId.");
    }

    return payload.requestId;
  }

  function getApprovalStatus(requestId) {
    return fetchJSON("/api/approval-status?requestId=" + encodeURIComponent(requestId), {
      method: "GET",
      headers: { Accept: "application/json" }
    });
  }

  async function listPendingApprovals() {
    var payload = await fetchJSON("/api/approval-status", {
      method: "GET",
      headers: { Accept: "application/json" }
    });
    return payload && Array.isArray(payload.pending) ? payload.pending : [];
  }

  function submitDecision(requestId, decision) {
    return fetchJSON("/api/approval-status", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requestId: requestId, decision: decision })
    });
  }

  // Polls until the caregiver decides, or until maxPolls is exhausted.
  //
  // options.intervalMs   delay between polls (default 2000)
  // options.maxPolls     poll budget; Infinity waits indefinitely, which is
  //                      what the UI uses since a human is watching the page
  // options.onPoll       called after each attempt with { attempt, status } or
  //                      { attempt, error } so callers can update their UI
  //
  // Resolves to { status: "approved" | "denied", record } or
  // { status: "timeout", lastError }. A failed poll never aborts the wait: the
  // error is reported through onPoll and polling continues.
  async function waitForDecision(requestId, options) {
    var settings = options || {};
    var intervalMs = settings.intervalMs || DEFAULT_POLL_INTERVAL_MS;
    var maxPolls = settings.maxPolls == null ? Infinity : settings.maxPolls;
    var onPoll = typeof settings.onPoll === "function" ? settings.onPoll : null;
    var lastError = null;

    for (var attempt = 1; attempt <= maxPolls; attempt++) {
      await delay(intervalMs);

      // Lets a caller abandon a wait (e.g. the card was reset).
      if (typeof settings.isCancelled === "function" && settings.isCancelled()) {
        return { status: "cancelled", lastError: lastError };
      }

      try {
        var record = await getApprovalStatus(requestId);
        var status = record && record.status;

        console.log(LOG_PREFIX, "approval poll " + attempt + ":", status);

        if (status === "approved" || status === "denied") {
          return { status: status, record: record };
        }

        if (onPoll) {
          onPoll({ attempt: attempt, status: status || "pending" });
        }
      } catch (error) {
        lastError = error;
        console.warn(LOG_PREFIX, "approval poll " + attempt + " failed:", error.message);
        if (onPoll) {
          onPoll({ attempt: attempt, error: error });
        }
      }
    }

    return { status: "timeout", lastError: lastError };
  }

  // -------------------------------------------------------------------
  // Prescription uploads (Gemini extraction + caregiver review)
  // -------------------------------------------------------------------

  // Submits an image for extraction. Resolves to
  // { requestId, extracted, status, message }; the record is pending review,
  // never applied automatically.
  async function analyzePrescription(details) {
    var payload = await fetchJSON("/api/analyze-prescription", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        imageBase64: details.imageBase64,
        mimeType: details.mimeType
      })
    });

    if (!payload || typeof payload.requestId !== "string") {
      throw new Error("/api/analyze-prescription did not return a requestId.");
    }

    return payload;
  }

  async function listPendingUploads() {
    var payload = await fetchJSON("/api/prescription-uploads", {
      method: "GET",
      headers: { Accept: "application/json" }
    });
    return payload && Array.isArray(payload.pending) ? payload.pending : [];
  }

  function submitUploadDecision(requestId, decision) {
    return fetchJSON("/api/prescription-uploads", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requestId: requestId, decision: decision })
    });
  }

  window.ApprovalClient = {
    fetchJSON: fetchJSON,
    requestApproval: requestApproval,
    getApprovalStatus: getApprovalStatus,
    listPendingApprovals: listPendingApprovals,
    submitDecision: submitDecision,
    waitForDecision: waitForDecision,
    analyzePrescription: analyzePrescription,
    listPendingUploads: listPendingUploads,
    submitUploadDecision: submitUploadDecision,
    DEFAULT_POLL_INTERVAL_MS: DEFAULT_POLL_INTERVAL_MS
  };
})();
