// typst-toolkit: Pi plugin definition — registers Typst toolkit as Pi tools.
export default function register(pi: any) {
  pi.registerTool({
    name: "typst-toolkit",
    description: "Typst-specific tools — syntax, format, xref, citation, production, diagram. See typst-toolkit/skills/SKILL.md.",
    parameters: {
      type: "object",
      properties: {
        subskill: { type: "string", description: "Subskill: syntax | format | xref | citation | production | diagram" },
        scope: { type: "string", description: "File path or glob to audit" },
      },
      required: ["subskill"],
    },
    execute: async () => ({ instruction: "See skill definition for protocol." }),
  })
}
