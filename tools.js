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

  try {
    modelContext.registerTool({
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
        var text =
          "Hello, " +
          name +
          "! WebMCP is working — this response came from the say_hello tool " +
          "registered by the WebMCP Pharmacy Demo page.";

        console.log(LOG_PREFIX, "say_hello invoked with:", args);

        return {
          content: [{ type: "text", text: text }]
        };
      }
    });

    console.log(
      LOG_PREFIX,
      'WebMCP tool "say_hello" registered successfully via document.modelContext.registerTool().'
    );
  } catch (error) {
    console.error(LOG_PREFIX, "Failed to register WebMCP tool 'say_hello':", error);
  }
})();
