// general-skills: Pi plugin definition — registers general audit skills as Pi tools.
export default function register(pi: any) {
  pi.registerTool({
    name: "general-skills",
    description: "Generic audit skills — config, redundancy, logic, math, style, xref, citation, cite-bib, cite-fidelity, proof, review-convergence. See general-skills/skills/SKILL.md.",
    parameters: {
      type: "object",
      properties: {
        subskill: { type: "string", description: "Subskill: config | redundancy | logic | math | style | xref | citation | cite-bib | cite-fidelity | proof | review-convergence" },
        scope: { type: "string", description: "File path or glob to audit. Optional for config subskill." },
      },
      required: ["subskill"],
    },
    execute: async () => ({ instruction: "See skill definition for protocol." }),
  })
}
