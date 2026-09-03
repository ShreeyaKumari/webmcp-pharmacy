// Shared navigation behaviour: carry the current WebMCP mode across tabs.
//
// Loaded by index.html, caregiver.html and activity.html, whose nav markup is
// otherwise identical static HTML.
//
// The problem this solves: a bare URL always means ON (deliberately — a stored
// 'off' must never strand a visitor who opened the plain link). But that also
// means clicking a plain nav link out of an OFF-mode page would land on a bare
// URL and silently re-arm the tools, breaking a site-wide OFF demo halfway
// through.
//
// The fix acts on the LINKS, not on how the mode is resolved: while a page is
// in OFF mode, the three nav hrefs get ?webmcp=off appended, so clicking
// between tabs stays off. In ON mode the links are left completely bare, since
// a bare URL already means ON.
//
// This does not weaken the bare-URL safeguard. Resolution is still URL-only
// and unchanged, so a typed, bookmarked or shared link with no query parameter
// is ON no matter what — only in-app navigation from an OFF page carries the
// mode forward.

(function () {
  "use strict";

  var LOG_PREFIX = "[WebMCP Pharmacy]";
  var PARAM = "webmcp";

  // Deliberately URL-only, matching getWebMCPMode() in the tool files: a page
  // with no ?webmcp= parameter is ON, whatever localStorage happens to hold.
  function currentMode() {
    try {
      var params = new URLSearchParams(window.location.search);
      if (params.has(PARAM)) {
        return params.get(PARAM);
      }
    } catch (error) {
      console.warn(LOG_PREFIX, "Could not read the WebMCP mode from the URL:", error.message);
    }
    return "on";
  }

  function applyModeToNavLinks() {
    // Only OFF needs propagating; ON is the bare-URL default.
    if (currentMode() !== "off") {
      return;
    }

    var links = document.querySelectorAll(".site-nav__link");
    var rewritten = 0;

    Array.prototype.forEach.call(links, function (link) {
      var href = link.getAttribute("href");
      if (!href || href.charAt(0) === "#") {
        return;
      }
      // Never append twice, and respect an href that already has a query.
      if (/[?&]webmcp=/.test(href)) {
        return;
      }
      var separator = href.indexOf("?") === -1 ? "?" : "&";
      link.setAttribute("href", href + separator + PARAM + "=off");
      rewritten += 1;
    });

    if (rewritten > 0) {
      console.log(
        LOG_PREFIX,
        "Demo mode is OFF — " +
          rewritten +
          " navigation link(s) now carry ?webmcp=off so the mode survives " +
          "navigation between pages."
      );
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", applyModeToNavLinks);
  } else {
    applyModeToNavLinks();
  }
})();
