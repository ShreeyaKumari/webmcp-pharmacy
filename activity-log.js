// Activity log rendering — used by activity.html.
//
// Two histories, one shape: approved prescription uploads
// (/api/approved-prescriptions) and caregiver decisions on controlled-substance
// refills (/api/refill-decisions). Both poll on the same interval and render
// through window.ListDiff, so neither flickers.
//
// Plain script, no modules: attaches window.ActivityLog.
// Requires approval.js (window.ApprovalClient) and list-diff.js.

(function () {
  "use strict";

  var DEFAULT_POLL_INTERVAL_MS = 5000; // historical data, not urgent

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

  // "3 Sep 2026, 14:32" in the viewer's locale, or a clear fallback.
  function formatDateTime(isoTimestamp) {
    var date = new Date(isoTimestamp);
    if (isNaN(date.getTime())) {
      return "unknown time";
    }
    try {
      return date.toLocaleString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit"
      });
    } catch (error) {
      return date.toISOString().replace("T", " ").slice(0, 16);
    }
  }

  // ---- Row builders -------------------------------------------------

  function buildApprovedRow(entry) {
    var row = el("li", "log-row");

    var title = el("p", "log-row__title");
    title.appendChild(el("span", null, entry.medicationName || "Unnamed medication"));
    if (entry.duplicate) {
      title.appendChild(el("span", "tag tag--duplicate", "Duplicate"));
    }

    var details = [entry.dosage, entry.patientName].filter(Boolean).join(" · ");

    row.appendChild(title);
    if (details) {
      row.appendChild(el("p", "log-row__meta", details));
    }
    row.appendChild(
      el(
        "p",
        "log-row__meta",
        (entry.prescriberName ? entry.prescriberName + " · " : "") +
          "Approved " +
          formatDateTime(entry.decidedAt)
      )
    );

    if (entry.duplicate && entry.matchedExistingMedication) {
      row.appendChild(
        el(
          "p",
          "log-row__meta log-row__meta--quiet",
          "Matched existing " + entry.matchedExistingMedication + " — no new entry created."
        )
      );
    }

    return row;
  }

  function buildDecisionRow(entry) {
    var denied = entry.status === "denied";
    var row = el("li", "log-row " + (denied ? "log-row--denied" : "log-row--approved"));

    var title = el("p", "log-row__title");
    title.appendChild(el("span", null, entry.medicationName || "Unnamed medication"));
    title.appendChild(
      el(
        "span",
        "tag " + (denied ? "tag--denied" : "tag--approved"),
        denied ? "Denied" : "Approved"
      )
    );

    row.appendChild(title);
    if (entry.patientName) {
      row.appendChild(el("p", "log-row__meta", entry.patientName));
    }
    row.appendChild(
      el(
        "p",
        "log-row__meta",
        (denied ? "Denied " : "Approved ") +
          formatDateTime(entry.decidedAt) +
          (entry.requestedAt ? " · requested " + formatDateTime(entry.requestedAt) : "")
      )
    );
    row.appendChild(
      el(
        "p",
        "log-row__meta log-row__meta--quiet",
        denied
          ? "The refill was not completed."
          : "Caregiver approval granted; the requester completed the refill."
      )
    );

    return row;
  }

  // ---- Generic polling mount ----------------------------------------

  function mountList(options) {
    var listEl = document.getElementById(options.listId);
    var emptyEl = document.getElementById(options.emptyId);
    var errorEl = options.errorId ? document.getElementById(options.errorId) : null;

    if (!listEl) {
      return; // Page does not include this list.
    }

    var intervalMs = options.intervalMs || DEFAULT_POLL_INTERVAL_MS;

    async function refresh() {
      var client = window.ApprovalClient;
      if (!client || !window.ListDiff) {
        return;
      }

      try {
        var entries = await options.load(client);

        window.ListDiff.reconcile(listEl, entries, {
          keyOf: options.keyOf,
          signatureOf: options.signatureOf,
          buildCard: options.buildRow
        });

        if (emptyEl) {
          emptyEl.hidden = entries.length > 0;
        }
        if (errorEl) {
          errorEl.hidden = true;
        }
      } catch (error) {
        // Keep whatever is on screen; this is history, not live state.
        if (errorEl) {
          errorEl.textContent = options.errorPrefix + ": " + error.message;
          errorEl.hidden = false;
        } else {
          console.warn("[WebMCP Pharmacy] " + options.errorPrefix + ":", error.message);
        }
      }
    }

    refresh();
    setInterval(refresh, intervalMs);
  }

  function mountApprovedPrescriptions(options) {
    mountList({
      listId: options.listId,
      emptyId: options.emptyId,
      errorId: options.errorId,
      intervalMs: options.intervalMs,
      errorPrefix: "Could not load the approved prescriptions log",
      load: function (client) {
        return client.listApprovedPrescriptions();
      },
      keyOf: function (entry) {
        return entry.requestId || entry.medicationName + "|" + entry.decidedAt;
      },
      signatureOf: function (entry) {
        return JSON.stringify([
          entry.medicationName,
          entry.dosage,
          entry.patientName,
          entry.prescriberName,
          entry.decidedAt,
          entry.duplicate,
          entry.matchedExistingMedication
        ]);
      },
      buildRow: buildApprovedRow
    });
  }

  function mountRefillDecisions(options) {
    mountList({
      listId: options.listId,
      emptyId: options.emptyId,
      errorId: options.errorId,
      intervalMs: options.intervalMs,
      errorPrefix: "Could not load the refill decision history",
      load: function (client) {
        return client.listRefillDecisions();
      },
      keyOf: function (entry) {
        return entry.requestId || entry.medicationName + "|" + entry.decidedAt;
      },
      signatureOf: function (entry) {
        return JSON.stringify([
          entry.medicationName,
          entry.patientName,
          entry.status,
          entry.requestedAt,
          entry.decidedAt
        ]);
      },
      buildRow: buildDecisionRow
    });
  }

  window.ActivityLog = {
    mountApprovedPrescriptions: mountApprovedPrescriptions,
    mountRefillDecisions: mountRefillDecisions,
    formatDateTime: formatDateTime
  };
})();
