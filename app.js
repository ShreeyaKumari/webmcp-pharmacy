// UI logic and shared pharmacy state for the WebMCP Pharmacy Demo.
//
// The three functions searchMedications / checkRefillEligibility /
// refillPrescription are the single source of truth for behaviour: the UI
// buttons call them, and the WebMCP tools in tools.js call the exact same
// functions through `window.PharmacyStore`. Nothing is duplicated between the
// two surfaces, so an agent and a human always get identical results.

(function () {
  "use strict";

  // ---------------------------------------------------------------------
  // In-memory state (a mutable copy of the mock data; no backend, no storage)
  // ---------------------------------------------------------------------

  var medications = (window.MEDICATIONS || []).map(function (med) {
    return Object.assign({}, med);
  });

  // Per-medication inline UI messages, keyed by medication id.
  var messages = {};

  // Medications with a caregiver-approval request in flight, keyed by
  // medication id -> { requestId }. Used to disable the Refill button and to
  // keep a second click from opening a duplicate request.
  var pendingApprovals = {};

  // ---------------------------------------------------------------------
  // Date helpers — all arithmetic is done in UTC on YYYY-MM-DD strings so
  // results never shift with the viewer's timezone or DST.
  // ---------------------------------------------------------------------

  function toUTCDate(isoDate) {
    var parts = String(isoDate).split("-");
    return new Date(
      Date.UTC(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]))
    );
  }

  function toISODate(date) {
    return date.toISOString().slice(0, 10);
  }

  function addDays(isoDate, days) {
    var date = toUTCDate(isoDate);
    date.setUTCDate(date.getUTCDate() + days);
    return toISODate(date);
  }

  function todayISO() {
    var now = new Date();
    return toISODate(
      new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()))
    );
  }

  function formatDate(isoDate) {
    return toUTCDate(isoDate).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      timeZone: "UTC"
    });
  }

  // ---------------------------------------------------------------------
  // Shared logic — used by BOTH the UI and the WebMCP tools
  // ---------------------------------------------------------------------

  function getMedication(medicationId) {
    for (var i = 0; i < medications.length; i++) {
      if (medications[i].id === medicationId) {
        return medications[i];
      }
    }
    return null;
  }

  function publicView(med) {
    return {
      id: med.id,
      name: med.name,
      dosage: med.dosage,
      patientName: med.patientName,
      lastFilledDate: med.lastFilledDate,
      isControlledSubstance: med.isControlledSubstance,
      pharmacyLocation: med.pharmacyLocation
    };
  }

  // Returns every medication whose name matches `query` (case-insensitive
  // substring). An empty or missing query returns the full list.
  function searchMedications(query) {
    var needle = String(query == null ? "" : query).trim().toLowerCase();
    var matches = medications.filter(function (med) {
      return needle === "" || med.name.toLowerCase().indexOf(needle) !== -1;
    });
    return matches.map(publicView);
  }

  // Returns a structured eligibility answer for one medication.
  function checkRefillEligibility(medicationId) {
    var med = getMedication(medicationId);

    if (!med) {
      return {
        found: false,
        medicationId: medicationId,
        message:
          'No medication found with id "' +
          medicationId +
          '". Known ids: ' +
          medications
            .map(function (m) {
              return m.id;
            })
            .join(", ") +
          "."
      };
    }

    var today = todayISO();
    var eligibleOn = addDays(med.lastFilledDate, med.refillEligibleAfterDays);
    var isEligible = today >= eligibleOn; // ISO dates compare correctly as strings

    return {
      found: true,
      medicationId: med.id,
      name: med.name,
      dosage: med.dosage,
      patientName: med.patientName,
      isEligible: isEligible,
      today: today,
      lastFilledDate: med.lastFilledDate,
      refillEligibleAfterDays: med.refillEligibleAfterDays,
      eligibleOn: eligibleOn,
      isControlledSubstance: med.isControlledSubstance,
      requiresCaregiverApproval: isEligible && med.isControlledSubstance,
      message: isEligible
        ? med.name + " is eligible for refill as of " + eligibleOn + "."
        : med.name +
          " is not yet eligible for refill. It becomes eligible on " +
          eligibleOn +
          "."
    };
  }

  // Attempts a refill. Mutates in-memory state only on success.
  // status is one of: not_found | not_eligible | requires_caregiver_approval | refilled
  //
  // options.caregiverApproved lets a caller complete a controlled-substance
  // refill that a caregiver has already approved (see the approval flow in
  // tools.js). Without it, controlled substances are always blocked — so the
  // approved and unapproved paths share this one function rather than
  // duplicating the refill logic.
  function refillPrescription(medicationId, options) {
    var caregiverApproved = Boolean(options && options.caregiverApproved);
    var eligibility = checkRefillEligibility(medicationId);

    if (!eligibility.found) {
      return {
        status: "not_found",
        refilled: false,
        medicationId: medicationId,
        message: eligibility.message
      };
    }

    var med = getMedication(medicationId);

    if (!eligibility.isEligible) {
      return {
        status: "not_eligible",
        refilled: false,
        medicationId: med.id,
        name: med.name,
        eligibleOn: eligibility.eligibleOn,
        message:
          med.name +
          " cannot be refilled yet. Last filled " +
          med.lastFilledDate +
          "; it becomes eligible on " +
          eligibility.eligibleOn +
          "."
      };
    }

    if (med.isControlledSubstance && !caregiverApproved) {
      return {
        status: "requires_caregiver_approval",
        refilled: false,
        medicationId: med.id,
        name: med.name,
        message:
          med.name +
          " is a controlled substance and requires caregiver approval. " +
          "It was NOT refilled. (The caregiver approval flow arrives in a " +
          "later stage of this demo.)"
      };
    }

    med.lastFilledDate = todayISO();
    var nextEligibleOn = addDays(med.lastFilledDate, med.refillEligibleAfterDays);

    render();

    return {
      status: "refilled",
      refilled: true,
      caregiverApproved: caregiverApproved,
      medicationId: med.id,
      name: med.name,
      dosage: med.dosage,
      filledOn: med.lastFilledDate,
      pharmacyLocation: med.pharmacyLocation,
      nextEligibleOn: nextEligibleOn,
      message:
        med.name +
        " was refilled on " +
        med.lastFilledDate +
        " at " +
        med.pharmacyLocation +
        ". Next refill available on " +
        nextEligibleOn +
        "."
    };
  }

  // Exposed for tools.js (and for poking at state from the devtools console).
  window.PharmacyStore = {
    searchMedications: searchMedications,
    checkRefillEligibility: checkRefillEligibility,
    refillPrescription: refillPrescription,
    getAllMedications: function () {
      return medications.map(publicView);
    }
  };

  // ---------------------------------------------------------------------
  // UI
  // ---------------------------------------------------------------------

  var searchInput = document.getElementById("search");
  var listEl = document.getElementById("med-list");
  var emptyEl = document.getElementById("empty-state");

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) {
      node.className = className;
    }
    if (text != null) {
      node.textContent = text;
    }
    return node;
  }

  function buildCard(med) {
    var eligibility = checkRefillEligibility(med.id);

    var card = el("article", "med-card");

    var header = el("div", "med-header");
    var title = el("h2", "med-name", med.name);
    header.appendChild(title);
    if (med.isControlledSubstance) {
      header.appendChild(el("span", "tag tag--controlled", "Controlled"));
    }

    var body = el("div", "med-body");
    body.appendChild(el("p", "med-dosage", med.dosage));
    body.appendChild(el("p", "med-meta", "Patient: " + med.patientName));
    body.appendChild(
      el("p", "med-meta", "Last filled: " + formatDate(med.lastFilledDate))
    );

    var side = el("div", "med-side");
    var badge = el(
      "span",
      "badge " + (eligibility.isEligible ? "badge--eligible" : "badge--pending"),
      eligibility.isEligible
        ? "Eligible"
        : "Not yet eligible — available on " + formatDate(eligibility.eligibleOn)
    );
    var isAwaitingApproval = Boolean(pendingApprovals[med.id]);
    var button = el(
      "button",
      "refill-btn",
      isAwaitingApproval ? "Awaiting approval…" : "Refill"
    );
    button.type = "button";
    button.disabled = isAwaitingApproval;
    button.setAttribute("data-medication-id", med.id);
    side.appendChild(badge);
    side.appendChild(button);

    card.appendChild(header);
    card.appendChild(body);
    card.appendChild(side);

    var message = messages[med.id];
    if (message) {
      card.appendChild(el("p", "med-message med-message--" + message.tone, message.text));
    }

    return card;
  }

  // Realistic portal friction #2: every render tears the list down and rebuilds
  // it. #med-list's innerHTML is cleared and each visible card is constructed
  // as brand-new DOM elements, so any node reference or position an agent
  // noted before a search is stale afterwards — the same churn real
  // single-page portals produce on every keystroke. Visually identical to a
  // user; only DOM stability changes. A WebMCP tool call is unaffected because
  // search_medications reads PharmacyStore directly and never touches the DOM.
  // Permanent behaviour: never gated on webmcpDemoMode or ?webmcp=.
  function render() {
    if (!listEl) {
      return;
    }

    var query = searchInput ? searchInput.value : "";
    var results = searchMedications(query);

    listEl.innerHTML = "";
    results.forEach(function (med) {
      listEl.appendChild(buildCard(med));
    });

    if (emptyEl) {
      emptyEl.hidden = results.length > 0;
      emptyEl.textContent = 'No medications match "' + query + '".';
    }
  }

  var TONE_BY_STATUS = {
    refilled: "success",
    requires_caregiver_approval: "warning",
    not_eligible: "error",
    not_found: "error"
  };

  function setMessage(medicationId, tone, text) {
    messages[medicationId] = { tone: tone, text: text };
    render();
  }

  // Controlled-substance path: open a real approval request and poll until the
  // caregiver decides. There is no timeout here — unlike the WebMCP tool, a
  // human is watching this page, so it keeps showing "Pending…" until a
  // decision arrives or the user navigates away. Only this one card changes
  // state; the rest of the page stays fully interactive.
  async function awaitCaregiverApproval(eligibility) {
    var medicationId = eligibility.medicationId;
    var client = window.ApprovalClient;

    if (!client || typeof client.requestApproval !== "function") {
      setMessage(
        medicationId,
        "error",
        "Cannot request caregiver approval: approval.js did not load."
      );
      return;
    }

    pendingApprovals[medicationId] = { requestId: null };
    setMessage(medicationId, "warning", "Requesting caregiver approval…");

    try {
      var requestId = await client.requestApproval({
        medicationId: medicationId,
        medicationName: eligibility.name,
        patientName: eligibility.patientName
      });

      pendingApprovals[medicationId] = { requestId: requestId };
      setMessage(
        medicationId,
        "warning",
        "Pending caregiver approval… waiting for a decision on the caregiver " +
          "dashboard. (Request " + requestId + ")"
      );

      var outcome = await client.waitForDecision(requestId, {
        intervalMs: client.DEFAULT_POLL_INTERVAL_MS,
        maxPolls: Infinity,
        // A failed poll does not end the wait; say so and keep going.
        onPoll: function (info) {
          if (info.error) {
            setMessage(
              medicationId,
              "warning",
              "Pending caregiver approval… (last status check failed: " +
                info.error.message +
                " — still retrying)"
            );
          }
        },
        isCancelled: function () {
          return !pendingApprovals[medicationId];
        }
      });

      delete pendingApprovals[medicationId];

      if (outcome.status === "denied") {
        setMessage(
          medicationId,
          "error",
          "Caregiver denied this refill. " +
            eligibility.name +
            " was not refilled."
        );
        return;
      }

      if (outcome.status !== "approved") {
        setMessage(
          medicationId,
          "warning",
          "The approval request is no longer being watched. (Request " + requestId + ")"
        );
        return;
      }

      // Approved — complete the refill through the same shared function the
      // non-controlled path and the WebMCP tool both use.
      var result = refillPrescription(medicationId, { caregiverApproved: true });

      if (result.status === "refilled") {
        setMessage(
          medicationId,
          "success",
          "Caregiver approved. " + result.message
        );
      } else {
        setMessage(
          medicationId,
          "error",
          "Caregiver approved, but the refill could not be completed: " + result.message
        );
      }
    } catch (error) {
      delete pendingApprovals[medicationId];
      setMessage(
        medicationId,
        "error",
        "Caregiver approval failed: " + (error && error.message ? error.message : error)
      );
    }
  }

  // ---------------------------------------------------------------------
  // Realistic portal friction #1: a confirmation dialog before any refill
  //
  // Real healthcare portals almost never submit a refill on a single click —
  // they interpose an explicit confirmation step. It is built from real DOM
  // elements rather than window.confirm() precisely so that an agent driving
  // this site through the UI must locate the dialog and click through it like
  // any other element. A WebMCP tool call bypasses this structurally rather
  // than by exemption: refill_prescription calls
  // PharmacyStore.refillPrescription() directly and never touches the button,
  // the dialog, or the DOM at all.
  //
  // Permanent behaviour: never gated on webmcpDemoMode or ?webmcp=, so the ON
  // and OFF comparisons face identical friction.
  // ---------------------------------------------------------------------

  var openDialog = null;

  function handleDialogKeydown(event) {
    if (event.key === "Escape") {
      closeRefillDialog();
    }
  }

  function closeRefillDialog() {
    if (!openDialog) {
      return;
    }

    var medicationId = openDialog.medicationId;
    var overlay = openDialog.overlay;

    document.removeEventListener("keydown", handleDialogKeydown);
    if (overlay.parentNode) {
      overlay.parentNode.removeChild(overlay);
    }
    openDialog = null;

    // Return focus to the Refill button that opened the dialog. It is
    // re-queried rather than held, because a render may have replaced it.
    var trigger = document.querySelector(
      '.refill-btn[data-medication-id="' + medicationId + '"]'
    );
    if (trigger && typeof trigger.focus === "function") {
      trigger.focus();
    }
  }

  function openRefillDialog(eligibility, onConfirm) {
    closeRefillDialog();

    var overlay = el("div", "modal-overlay");

    var dialog = el("div", "modal");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-labelledby", "refill-dialog-title");

    var title = el("h2", "modal__title", "Confirm Refill");
    title.id = "refill-dialog-title";

    var body = el(
      "p",
      "modal__body",
      "Submit a refill request for " +
        eligibility.name +
        ", " +
        eligibility.dosage +
        ", for " +
        eligibility.patientName +
        "?"
    );

    var actions = el("div", "modal__actions");

    var cancelBtn = el("button", "refill-btn btn--secondary", "Cancel");
    cancelBtn.type = "button";
    cancelBtn.addEventListener("click", closeRefillDialog);

    var confirmBtn = el("button", "refill-btn", "Confirm Refill");
    confirmBtn.type = "button";
    confirmBtn.addEventListener("click", function () {
      closeRefillDialog();
      onConfirm();
    });

    actions.appendChild(cancelBtn);
    actions.appendChild(confirmBtn);

    dialog.appendChild(title);
    dialog.appendChild(body);
    dialog.appendChild(actions);
    overlay.appendChild(dialog);

    // Clicking the dimmed backdrop dismisses, same as Cancel.
    overlay.addEventListener("click", function (event) {
      if (event.target === overlay) {
        closeRefillDialog();
      }
    });

    document.body.appendChild(overlay);
    document.addEventListener("keydown", handleDialogKeydown);

    openDialog = { overlay: overlay, medicationId: eligibility.medicationId };

    if (typeof confirmBtn.focus === "function") {
      confirmBtn.focus();
    }
  }

  // The refill itself, unchanged — this is what the dialog's Confirm button
  // runs, and it is the same shared function the WebMCP tool calls.
  function completeRefill(medicationId) {
    var result = refillPrescription(medicationId);
    setMessage(medicationId, TONE_BY_STATUS[result.status] || "error", result.message);
  }

  function handleRefillClick(medicationId) {
    // Ignore clicks while this medication is already waiting on a caregiver.
    if (pendingApprovals[medicationId]) {
      return;
    }

    var eligibility = checkRefillEligibility(medicationId);

    // Eligibility is checked first so a controlled substance that is not yet
    // due never bothers the caregiver with an approval request.
    if (eligibility.found && eligibility.isEligible && eligibility.isControlledSubstance) {
      awaitCaregiverApproval(eligibility);
      return;
    }

    // Eligible and not controlled: confirm before submitting.
    if (eligibility.found && eligibility.isEligible) {
      openRefillDialog(eligibility, function () {
        completeRefill(medicationId);
      });
      return;
    }

    // Not eligible / unknown id: no point confirming a refill that cannot
    // happen, so report it inline exactly as before.
    var result = refillPrescription(medicationId);
    setMessage(medicationId, TONE_BY_STATUS[result.status] || "error", result.message);
  }

  if (listEl) {
    listEl.addEventListener("click", function (event) {
      var button = event.target.closest(".refill-btn");
      if (button) {
        handleRefillClick(button.getAttribute("data-medication-id"));
      }
    });
  }

  if (searchInput) {
    searchInput.addEventListener("input", render);
  }

  // ---------------------------------------------------------------------
  // WebMCP Mode toggle
  //
  // Flips the mode between 'on' and 'off' and navigates, so tools.js re-reads
  // the flag at load time and either registers all four tools or none of them.
  // Nothing else on the page changes: with the mode off, the pharmacy still
  // works exactly as an ordinary website, which is what an agent without tools
  // would have to navigate. This affects only this page's tool registration —
  // caregiver.html and /api are untouched.
  //
  // The mode is written to BOTH localStorage and the ?webmcp= query parameter,
  // and resolved URL-first to match getWebMCPMode() in tools.js. The URL is
  // what makes the mode shareable: localStorage does not carry over to another
  // browser instance, so handing an agent a ?webmcp=off link is the only way
  // to put a different session into a specific mode.
  // ---------------------------------------------------------------------

  var toggleEl = document.getElementById("webmcp-toggle");
  var toggleTextEl = document.getElementById("webmcp-toggle-text");
  var offNoticeEl = document.getElementById("webmcp-off-notice");

  // Mirrors getWebMCPMode() in tools.js: an explicit ?webmcp= decides, and a
  // bare URL always means 'on'. Storage is deliberately NOT consulted, so the
  // pill can never disagree with whether the tools were actually registered.
  function readDemoMode() {
    try {
      var params = new URLSearchParams(window.location.search);
      if (params.has("webmcp")) {
        return params.get("webmcp");
      }
    } catch (error) {
      // A bare URL is the safe assumption.
    }

    return "on";
  }

  function renderDemoMode(mode) {
    var isOn = mode !== "off";

    if (toggleEl) {
      toggleEl.classList.toggle("mode-toggle--on", isOn);
      toggleEl.classList.toggle("mode-toggle--off", !isOn);
      toggleEl.setAttribute("aria-pressed", isOn ? "true" : "false");
      toggleEl.title = isOn
        ? "WebMCP tools are registered. Click to disable them."
        : "WebMCP tools are not registered. Click to enable them.";
    }

    if (toggleTextEl) {
      toggleTextEl.textContent = isOn
        ? "WebMCP tools active on this page"
        : "WebMCP tools disabled";
    }

    if (offNoticeEl) {
      offNoticeEl.hidden = isOn;
    }
  }

  if (toggleEl) {
    toggleEl.addEventListener("click", function () {
      var next = readDemoMode() === "off" ? "on" : "off";

      // Best effort: keeps the choice sticky for this browser. A failure here
      // (private mode, storage disabled) is not fatal, because the query
      // parameter below carries the mode on its own.
      try {
        localStorage.setItem("webmcpDemoMode", next);
      } catch (error) {
        console.warn(
          "[WebMCP Pharmacy] Could not save the WebMCP mode setting:",
          error.message
        );
      }

      // Navigate with ?webmcp=<next> so the reload picks the mode up via the
      // URL check in tools.js, and so the current link is shareable.
      try {
        var url = new URL(window.location.href);
        url.searchParams.set("webmcp", next);
        window.location.href = url.toString();
      } catch (error) {
        // Very old browser without the URL constructor: fall back to a plain
        // reload, which still picks up the localStorage value written above.
        window.location.reload();
      }
    });
  }

  // ---------------------------------------------------------------------
  // Smart prescription upload
  //
  // The image is resized client-side before upload (smaller payload, faster
  // round trip), sent to /api/analyze-prescription for Gemini extraction, and
  // the result is filed for caregiver review. Nothing is added to the
  // medication list here — approval happens on the caregiver dashboard.
  // ---------------------------------------------------------------------

  var MAX_IMAGE_EDGE_PX = 1600;
  var JPEG_QUALITY = 0.8;
  var UPLOAD_COOLDOWN_MS = 3000;
  // A browser that fires neither load nor error on an image (corrupt file,
  // unsupported codec) would otherwise hang the upload forever.
  var IMAGE_DECODE_TIMEOUT_MS = 8000;
  // The extraction model is a thinking model and the server allows it up to
  // 55s, so a slow read is normal rather than a hang. After this long, say so,
  // otherwise the wait looks broken.
  var UPLOAD_PATIENCE_MS = 10000;
  var MAX_UPLOAD_BYTES = 4 * 1024 * 1024;

  var uploadZone = document.getElementById("upload-zone");
  var uploadButton = document.getElementById("upload-button");
  var uploadInput = document.getElementById("prescription-file");
  var uploadResult = document.getElementById("upload-result");

  var uploadBusy = false;
  var uploadCooldownUntil = 0;

  // The upload result card polls for the caregiver's decision. Unlike the
  // refill flow — where a human is waiting to act on the outcome and polls
  // indefinitely — this stops as soon as a decision lands, because there is
  // nothing further to do afterwards. The cap only exists so an abandoned tab
  // does not poll forever.
  var UPLOAD_DECISION_POLL_MS = 2000;
  var UPLOAD_DECISION_MAX_POLLS = 150; // 5 minutes
  var uploadDecisionToken = 0;

  function setUploadEnabled(enabled) {
    if (uploadButton) {
      uploadButton.disabled = !enabled;
      uploadButton.textContent = enabled ? "Upload prescription" : "Analyzing prescription…";
    }
    if (uploadZone) {
      uploadZone.classList.toggle("upload-zone--busy", !enabled);
    }
  }

  function clearUploadResult() {
    if (uploadResult) {
      uploadResult.innerHTML = "";
    }
  }

  function showUploadMessage(tone, text) {
    if (!uploadResult) {
      return;
    }
    uploadResult.innerHTML = "";
    uploadResult.appendChild(el("p", "med-message med-message--" + tone, text));
  }

  // Replaces just the status line inside the existing card, so the extracted
  // details stay put and only the outcome changes.
  function setUploadCardMessage(tone, text) {
    if (!uploadResult) {
      return;
    }

    var card = uploadResult.querySelector(".upload-card");
    if (!card) {
      showUploadMessage(tone, text);
      return;
    }

    var message = card.querySelector(".med-message");
    var replacement = el("p", "med-message med-message--" + tone, text);

    if (message) {
      card.replaceChild(replacement, message);
    } else {
      card.appendChild(replacement);
    }
  }

  function decisionMessage(record) {
    if (record.status === "rejected") {
      return { tone: "error", text: "Caregiver did not approve this upload." };
    }

    if (record.duplicate) {
      return {
        tone: "success",
        text:
          "Approved — matches your existing " +
          (record.matchedExistingMedication || record.medicationName) +
          " prescription, no new entry needed."
      };
    }

    return {
      tone: "success",
      text:
        "Approved by caregiver. In a full implementation, " +
        record.medicationName +
        " would now appear in the medication list below."
    };
  }

  async function pollUploadDecision(requestId) {
    // A newer upload invalidates any poll still running for an older one.
    uploadDecisionToken += 1;
    var token = uploadDecisionToken;

    for (var attempt = 1; attempt <= UPLOAD_DECISION_MAX_POLLS; attempt++) {
      await new Promise(function (resolve) {
        setTimeout(resolve, UPLOAD_DECISION_POLL_MS);
      });

      if (token !== uploadDecisionToken) {
        return;
      }

      try {
        var record = await window.ApprovalClient.getUploadStatus(requestId);

        if (token !== uploadDecisionToken) {
          return;
        }

        if (record && (record.status === "approved" || record.status === "rejected")) {
          var outcome = decisionMessage(record);
          setUploadCardMessage(outcome.tone, outcome.text);
          return; // Final decision — stop polling.
        }
      } catch (error) {
        // An expired or missing record will never resolve, so stop asking.
        if (/No prescription upload found/i.test(error.message)) {
          setUploadCardMessage(
            "warning",
            "This upload request is no longer available — it may have expired. " +
              "Upload the prescription again if it still needs review."
          );
          return;
        }

        // Anything else is treated as transient: keep polling quietly.
        console.warn(
          "[WebMCP Pharmacy] upload decision poll " + attempt + " failed:",
          error.message
        );
      }
    }

    if (token === uploadDecisionToken) {
      setUploadCardMessage(
        "warning",
        "Still pending caregiver review. Reload the page to check again later."
      );
    }
  }

  function showUploadSuccess(payload) {
    if (!uploadResult) {
      return;
    }

    var extracted = payload.extracted || {};
    var confidence = extracted.confidence || "low";

    var card = el("article", "med-card upload-card");

    var header = el("div", "med-header");
    header.appendChild(el("h3", "med-name", extracted.medicationName || "Unnamed medication"));
    header.appendChild(
      el("span", "tag tag--confidence tag--confidence-" + confidence, confidence + " confidence")
    );

    var body = el("div", "med-body");
    body.appendChild(el("p", "med-dosage", extracted.dosage || "Dosage not readable"));
    body.appendChild(
      el("p", "med-meta", "Patient: " + (extracted.patientName || "not readable"))
    );
    body.appendChild(
      el("p", "med-meta", "Prescriber: " + (extracted.prescriberName || "not readable"))
    );
    body.appendChild(el("p", "med-meta med-meta--id", "Request " + payload.requestId));

    card.appendChild(header);
    card.appendChild(body);
    card.appendChild(
      el(
        "p",
        "med-message med-message--warning",
        "Pending caregiver review — this has NOT been added to the medication " +
          "list yet. A caregiver must approve it on the caregiver dashboard."
      )
    );

    uploadResult.innerHTML = "";
    uploadResult.appendChild(card);
  }

  // Canvas resize to keep payloads small. If the browser cannot give us a
  // canvas context, the original bytes are sent instead (still size-checked),
  // so an unusual environment degrades rather than blocking the upload.
  function readFileAsDataURL(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () {
        resolve(String(reader.result));
      };
      reader.onerror = function () {
        reject(new Error("Could not read that file."));
      };
      reader.readAsDataURL(file);
    });
  }

  function loadImage(dataUrl) {
    return new Promise(function (resolve, reject) {
      var image = new Image();
      var settled = false;

      var timer = setTimeout(function () {
        if (!settled) {
          settled = true;
          reject(new Error("Image decoding timed out."));
        }
      }, IMAGE_DECODE_TIMEOUT_MS);

      function finish(callback, value) {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        callback(value);
      }

      image.onload = function () {
        finish(resolve, image);
      };
      image.onerror = function () {
        finish(reject, new Error("That file could not be read as an image."));
      };
      image.src = dataUrl;
    });
  }

  function splitDataUrl(dataUrl) {
    var match = /^data:([^;]+);base64,(.*)$/i.exec(String(dataUrl));
    if (!match) {
      throw new Error("Unexpected image encoding.");
    }
    return { mimeType: match[1].toLowerCase(), imageBase64: match[2] };
  }

  function base64Bytes(base64) {
    var padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
    return Math.floor((base64.length * 3) / 4) - padding;
  }

  async function prepareImage(file) {
    var dataUrl = await readFileAsDataURL(file);
    var original = splitDataUrl(dataUrl);

    try {
      var image = await loadImage(dataUrl);
      var longEdge = Math.max(image.width, image.height);
      var scale = longEdge > MAX_IMAGE_EDGE_PX ? MAX_IMAGE_EDGE_PX / longEdge : 1;

      var canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(image.width * scale));
      canvas.height = Math.max(1, Math.round(image.height * scale));

      var context = canvas.getContext && canvas.getContext("2d");
      if (!context) {
        throw new Error("Canvas is unavailable.");
      }

      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      return splitDataUrl(canvas.toDataURL("image/jpeg", JPEG_QUALITY));
    } catch (error) {
      // Resize unavailable — fall back to the file as-is.
      console.warn("[WebMCP Pharmacy] Image resize unavailable:", error.message);
      return original;
    }
  }

  async function handlePrescriptionFile(file) {
    if (!file) {
      return;
    }

    var now = Date.now();
    if (uploadBusy) {
      return;
    }
    if (now < uploadCooldownUntil) {
      showUploadMessage(
        "warning",
        "Please wait a moment before uploading another prescription."
      );
      return;
    }

    if (file.type && file.type.indexOf("image/") !== 0) {
      showUploadMessage("error", "That file is not an image. Upload a photo of the prescription.");
      return;
    }

    var client = window.ApprovalClient;
    if (!client || typeof client.analyzePrescription !== "function") {
      showUploadMessage("error", "Upload is unavailable: approval.js did not load.");
      return;
    }

    // Abandon any decision poll from a previous upload.
    uploadDecisionToken += 1;

    uploadBusy = true;
    setUploadEnabled(false);
    showUploadMessage("warning", "Analyzing prescription…");

    // Escalates the loading copy rather than replacing it, so the user is not
    // left wondering whether a long read has failed.
    var patienceTimer = setTimeout(function () {
      if (uploadBusy) {
        showUploadMessage(
          "warning",
          "Analyzing prescription… This can take up to a minute for a clear read."
        );
      }
    }, UPLOAD_PATIENCE_MS);

    try {
      var prepared = await prepareImage(file);

      if (base64Bytes(prepared.imageBase64) > MAX_UPLOAD_BYTES) {
        throw new Error(
          "That image is still too large after resizing. Try a smaller photo."
        );
      }

      var payload = await client.analyzePrescription(prepared);
      showUploadSuccess(payload);

      // Watch for the caregiver's decision and update the card in place.
      if (typeof client.getUploadStatus === "function") {
        pollUploadDecision(payload.requestId);
      }
    } catch (error) {
      showUploadMessage(
        "error",
        error && error.message ? error.message : "The prescription could not be analysed."
      );
    } finally {
      // Always leaves the control usable again — never stuck loading.
      clearTimeout(patienceTimer);
      uploadBusy = false;
      uploadCooldownUntil = Date.now() + UPLOAD_COOLDOWN_MS;
      setUploadEnabled(true);
      if (uploadInput) {
        uploadInput.value = "";
      }
    }
  }

  if (uploadButton && uploadInput) {
    uploadButton.addEventListener("click", function () {
      clearUploadResult();
      uploadInput.click();
    });

    uploadInput.addEventListener("change", function () {
      handlePrescriptionFile(uploadInput.files && uploadInput.files[0]);
    });
  }

  if (uploadZone) {
    ["dragenter", "dragover"].forEach(function (name) {
      uploadZone.addEventListener(name, function (event) {
        event.preventDefault();
        uploadZone.classList.add("upload-zone--over");
      });
    });

    ["dragleave", "dragend"].forEach(function (name) {
      uploadZone.addEventListener(name, function () {
        uploadZone.classList.remove("upload-zone--over");
      });
    });

    uploadZone.addEventListener("drop", function (event) {
      event.preventDefault();
      uploadZone.classList.remove("upload-zone--over");
      var files = event.dataTransfer && event.dataTransfer.files;
      handlePrescriptionFile(files && files[0]);
    });
  }

  renderDemoMode(readDemoMode());
  render();
})();
