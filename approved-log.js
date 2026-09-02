// Approved prescriptions log — shared by index.html and caregiver.html.
//
// Both pages show the same read-only list of approved uploads, so it is
// implemented once here and mounted with different containers rather than
// duplicated in two scripts.
//
// Also exports the keyed list diff both pages use, so no list on the site
// rebuilds its container on a poll (which reads as a flicker).
//
// Plain script, no modules: attaches window.ListDiff and window.ApprovedLog.

(function () {
  "use strict";

  var DEFAULT_POLL_INTERVAL_MS = 5000; // historical data, not urgent

  // -------------------------------------------------------------------
  // Keyed list diff
  //
  // Each rendered node carries data-key (its identity) and data-signature (a
  // hash of everything it displays). Unchanged nodes are left untouched in the
  // DOM; only changed nodes are rebuilt, new ones inserted, departed ones
  // removed. A steady list performs zero DOM mutations per poll.
  // -------------------------------------------------------------------

  function reconcile(container, items, options) {
    var byKey = {};
    var child = container.firstElementChild;

    while (child) {
      var existingKey = child.getAttribute("data-key");
      if (existingKey) {
        byKey[existingKey] = child;
      }
      child = child.nextElementSibling;
    }

    var seen = {};
    var previous = null;

    items.forEach(function (item) {
      var key = options.keyOf(item);
      var signature = options.signatureOf(item);
      var existing = byKey[key];
      var node;

      if (existing && existing.getAttribute("data-signature") === signature) {
        node = existing;
      } else {
        node = options.buildCard(item);
        node.setAttribute("data-key", key);
        node.setAttribute("data-signature", signature);
        if (existing) {
          container.replaceChild(node, existing);
        }
      }

      seen[key] = true;

      var expected = previous ? previous.nextElementSibling : container.firstElementChild;
      if (node !== expected) {
        container.insertBefore(node, expected);
      }
      previous = node;
    });

    Object.keys(byKey).forEach(function (key) {
      if (!seen[key]) {
        container.removeChild(byKey[key]);
      }
    });
  }

  window.ListDiff = { reconcile: reconcile };

  // -------------------------------------------------------------------
  // The log widget
  // -------------------------------------------------------------------

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

  function buildRow(entry) {
    var row = el("li", "log-row");

    var title = el("p", "log-row__title");
    title.appendChild(el("span", null, entry.medicationName || "Unnamed medication"));
    if (entry.duplicate) {
      title.appendChild(el("span", "tag tag--duplicate", "Duplicate"));
    }

    var details = [entry.dosage, entry.patientName]
      .filter(Boolean)
      .join(" · ");

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

  // options: { listId, emptyId, errorId?, intervalMs? }
  function mount(options) {
    var listEl = document.getElementById(options.listId);
    var emptyEl = document.getElementById(options.emptyId);
    var errorEl = options.errorId ? document.getElementById(options.errorId) : null;

    if (!listEl) {
      return; // Page does not include the log.
    }

    var intervalMs = options.intervalMs || DEFAULT_POLL_INTERVAL_MS;

    async function refresh() {
      var client = window.ApprovalClient;
      if (!client || typeof client.listApprovedPrescriptions !== "function") {
        return;
      }

      try {
        var approved = await client.listApprovedPrescriptions();

        reconcile(listEl, approved, {
          // Records are immutable once written, so the id alone is enough —
          // but the signature still guards against a changed payload.
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
          buildCard: buildRow
        });

        if (emptyEl) {
          emptyEl.hidden = approved.length > 0;
        }
        if (errorEl) {
          errorEl.hidden = true;
        }
      } catch (error) {
        // Keep whatever is on screen; the log is historical, so a failed
        // refresh is not worth blanking it for.
        if (errorEl) {
          errorEl.textContent = "Could not load the approved prescriptions log: " + error.message;
          errorEl.hidden = false;
        } else {
          console.warn(
            "[WebMCP Pharmacy] Could not load the approved prescriptions log:",
            error.message
          );
        }
      }
    }

    refresh();
    setInterval(refresh, intervalMs);
  }

  window.ApprovedLog = { mount: mount, formatDateTime: formatDateTime };
})();
