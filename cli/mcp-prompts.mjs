// Prompt registry for the jot MCP server.
//
// Each entry has: name, description, arguments (MCP standard), and resolve(args)
// which returns { description, messages }.
//
// Validation errors throw a regular Error with .code = "INVALID_PARAMS" so the
// wiring layer (cli/jot-mcp.mjs) can convert to McpError(InvalidParams, ...)
// without this module needing to import the SDK.

const NOTE_ID_PATTERN = /^[a-z0-9]+$/;

function invalidParams(message) {
  const err = new Error(message);
  err.code = "INVALID_PARAMS";
  return err;
}

function validateNoteId(value) {
  if (typeof value !== "string") {
    throw invalidParams("Argument 'id' must be a string.");
  }
  if (value.trim().length === 0) {
    throw invalidParams("Argument 'id' must not be empty.");
  }
  if (!NOTE_ID_PATTERN.test(value)) {
    throw invalidParams(
      `Argument 'id' must match /^[a-z0-9]+$/ (got: ${JSON.stringify(value)}).`
    );
  }
}

function validateBoolString(name, value) {
  if (value === undefined || value === null) return;
  if (value !== "true" && value !== "false") {
    throw invalidParams(
      `Argument '${name}' must be the string "true" or "false" if provided ` +
        `(got: ${JSON.stringify(value)}). MCP arguments are stringly-typed; ` +
        `case-sensitive booleans only.`
    );
  }
}

const PROMPTS = [
  {
    name: "summarize-note",
    description: "Read a jot note and produce a 2-3 paragraph TL;DR.",
    arguments: [
      { name: "id", description: "Note id to summarize", required: true },
    ],
    validate: ({ id }) => {
      validateNoteId(id);
    },
    resolve: ({ id }) => ({
      description: `Summarize jot note ${id}`,
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              `Read the note at jot://notes/${id} and produce a 2-3 paragraph TL;DR. ` +
              `Lead with the single most important takeaway in the first sentence. ` +
              `Do not use bullet points — write flowing prose.`,
          },
        },
      ],
    }),
  },

  {
    name: "review-note",
    description:
      "Have Claude review a jot note and leave inline comments on weak points via comment_on_note.",
    arguments: [
      { name: "id", description: "Note id to review", required: true },
      {
        name: "focus",
        description:
          "Optional focus area (e.g. 'clarity', 'technical accuracy', 'tone')",
        required: false,
      },
    ],
    validate: ({ id }) => {
      validateNoteId(id);
    },
    resolve: ({ id, focus }) => ({
      description: `Review jot note ${id}${focus ? ` (focus: ${focus})` : ""}`,
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              `Read the note at jot://notes/${id}. Identify the 3 most important weak ` +
              `points` +
              `${focus ? ` (focusing on ${focus})` : ""}. ` +
              `For each one, use the comment_on_note tool to leave an inline comment ` +
              `anchored to the relevant passage. ` +
              `\n\n` +
              `IMPORTANT — anchoring rules:\n` +
              `• The 'quote' argument to comment_on_note must be a LITERAL substring ` +
              `of the note's source markdown — including any backticks, asterisks, or ` +
              `other formatting characters as they appear in the source.\n` +
              `• Anchor only against the SOURCE BODY (the note content above the ` +
              `"## Comments" divider). The Comments section is server-rendered from ` +
              `existing threads and is NOT part of the note's source markdown — quotes ` +
              `taken from there will not anchor.\n` +
              `\n` +
              `If the comment_on_note tool is unavailable in this environment, fall ` +
              `back to returning the same findings inline as a markdown list, with ` +
              `each weak point pairing an exact quote anchor (a verbatim substring of ` +
              `the source body, formatting characters included) and your critique.\n` +
              `\n` +
              `After leaving the comments (or after producing the fallback list), give ` +
              `a brief summary of what you flagged and why.`,
          },
        },
      ],
    }),
  },

  {
    name: "extract-action-items",
    description: "Extract action items from a jot note as a markdown checklist.",
    arguments: [
      { name: "id", description: "Note id", required: true },
      {
        name: "post_as_note",
        description:
          "If \"true\", also create a new note containing the checklist via create_note. " +
          "Stringly-typed; only \"true\" or \"false\" accepted.",
        required: false,
      },
    ],
    validate: ({ id, post_as_note }) => {
      validateNoteId(id);
      validateBoolString("post_as_note", post_as_note);
    },
    resolve: ({ id, post_as_note }) => {
      const postClause =
        post_as_note === "true"
          ? ` After extracting, use create_note to create a new note titled ` +
            `"Action items: <original title>" containing just the checklist.`
          : "";
      return {
        description: `Extract action items from jot note ${id}`,
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text:
                `Read the note at jot://notes/${id}. Extract all action items / next ` +
                `steps as a markdown checklist using the - [ ] format. Include implicit ` +
                `action items (things that are clearly TODOs but not explicitly marked).` +
                postClause +
                ` Return the checklist in your response either way.`,
            },
          },
        ],
      };
    },
  },
];

export function listPrompts() {
  return {
    prompts: PROMPTS.map(({ name, description, arguments: args }) => ({
      name,
      description,
      arguments: args,
    })),
  };
}

export function getPrompt({ name, arguments: args }) {
  const prompt = PROMPTS.find((p) => p.name === name);
  if (!prompt) {
    throw invalidParams(`Unknown prompt: ${name}`);
  }
  const safeArgs = args ?? {};
  for (const arg of prompt.arguments) {
    if (arg.required && (safeArgs[arg.name] == null)) {
      throw invalidParams(`Missing required argument: ${arg.name}`);
    }
  }
  if (typeof prompt.validate === "function") {
    prompt.validate(safeArgs);
  }
  return prompt.resolve(safeArgs);
}
