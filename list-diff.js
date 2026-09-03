// Keyed list diff — shared by every polling list on the site.
//
// Each rendered node carries data-key (its identity) and data-signature (a
// hash of everything it displays). Unchanged nodes are left untouched in the
// DOM; only changed nodes are rebuilt, new ones inserted, departed ones
// removed. A steady list performs zero DOM mutations per poll, so a 2s or 5s
// refresh never flickers.
//
// Plain script, no modules: attaches window.ListDiff.

(function () {
  "use strict";

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

      // Insert or move only when the node is not already in position.
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
})();
