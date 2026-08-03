package eu.infolead.llmhp.router;

enum SkillAxis {
    CREATIVE,          // creative writing, ideation, brainstorming
    REDACTION_PRO,     // professional writing/editing
    LEGAL_GDPR,        // GDPR / data privacy legal
    LEGAL_COMPLEX,     // complex legal analysis
    REASONING,         // logical/mathematical reasoning
    CALCULATION,       // numerical computation
    PYTHON,            // Python programming
    CODE_GENERAL,      // general coding (non-language-specific)
    DEBUG,             // debugging / bug fixing
    REACT,             // React / frontend development
    SWIFT,             // Swift / iOS development
    REFACTORING,       // code refactoring
    PLAN_DECOMP,       // planning: task decomposition
    PLAN_SPEC,         // planning: specification / requirements
    PLAN_JUDGMENT,     // planning: judgment / trade-offs
    FAST_TOOLS,        // tool-calling / agent execution (speed-critical)
    AGENT_EXEC,        // agent execution / orchestration
    AGENT_SAFETY       // agent safety / guardrails
}
