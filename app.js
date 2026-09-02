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
    var button = el("button", "refill-btn", "Refill");
    button.type = "button";
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

  function handleRefillClick(medicationId) {
    var result = refillPrescription(medicationId);

    if (result.status === "requires_caregiver_approval") {
      messages[medicationId] = {
        tone: "warning",
        text: "This medication requires caregiver approval (coming in a later stage)"
      };
    } else {
      messages[medicationId] = {
        tone: TONE_BY_STATUS[result.status] || "error",
        text: result.message
      };
    }

    render();
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

  render();
})();
