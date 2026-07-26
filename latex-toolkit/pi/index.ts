// latex-toolkit: Pi plugin definition — registers LaTeX toolkit as Pi tools.
export default function register(pi: any) {
  pi.registerTool({
    name: "latex-toolkit",
    description: "LaTeX-specific tools — syntax, format, xref, citation, production, figure-caption, index, notation. See latex-toolkit/skills/SKILL.md.",
    parameters: {
      type: "object",
      properties: {
        subskill: { type: "string", description: "Subskill: syntax | format | xref | citation | production | figure-caption | index | notation" },
        scope: { type: "string", description: "File path or glob to audit" },
      },
      required: ["subskill"],
    },
    execute: async () => ({ instruction: "See skill definition for protocol." }),
  })
}
