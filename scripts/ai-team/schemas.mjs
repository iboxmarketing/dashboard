export const planSchema = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "unresolvedDecisions", "tasks"],
  properties: {
    summary: { type: "string" },
    unresolvedDecisions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["question", "reason", "blocking"],
        properties: {
          question: { type: "string" },
          reason: { type: "string" },
          blocking: { type: "boolean" },
        },
      },
    },
    tasks: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "title", "agent", "objective", "dependsOn", "ownedPaths", "acceptanceCriteria", "testCommands"],
        properties: {
          id: { type: "string", pattern: "^[a-z0-9][a-z0-9_-]{0,39}$" },
          title: { type: "string" },
          agent: { enum: ["codex", "claude"] },
          objective: { type: "string" },
          dependsOn: { type: "array", items: { type: "string" } },
          ownedPaths: { type: "array", minItems: 1, items: { type: "string" } },
          acceptanceCriteria: { type: "array", minItems: 1, items: { type: "string" } },
          testCommands: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
};

export const planReviewSchema = {
  type: "object",
  additionalProperties: false,
  required: ["approved", "feedback", "unresolvedDecisions"],
  properties: {
    approved: { type: "boolean" },
    feedback: { type: "array", items: { type: "string" } },
    unresolvedDecisions: { type: "array", items: { type: "string" } },
  },
};

export const implementationSchema = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "testsRun", "risks"],
  properties: {
    summary: { type: "string" },
    testsRun: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["command", "result"],
        properties: { command: { type: "string" }, result: { type: "string" } },
      },
    },
    risks: { type: "array", items: { type: "string" } },
  },
};

export const reviewSchema = {
  type: "object",
  additionalProperties: false,
  required: ["approved", "findings", "notes"],
  properties: {
    approved: { type: "boolean" },
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["severity", "file", "line", "issue", "recommendation"],
        properties: {
          severity: { enum: ["critical", "high", "medium", "low", "info"] },
          file: { type: "string" },
          line: { type: ["integer", "null"] },
          issue: { type: "string" },
          recommendation: { type: "string" },
        },
      },
    },
    notes: { type: "array", items: { type: "string" } },
  },
};

export const revisionSchema = implementationSchema;
