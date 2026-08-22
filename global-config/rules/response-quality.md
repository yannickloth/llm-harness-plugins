<!-- Change Driver: UX_REQUIREMENTS -->
<!-- Changes when: response/error-handling expectations shift -->
<!-- Lazy-loaded reference file — load on demand when drafting responses or handling errors. Not injected by default. -->

# Response Quality Standards

## Completeness
- Answer the question asked
- Include relevant context; omit excess verbosity
- Provide actionable next steps when appropriate

## Clarity
- Direct language
- Structure for easy scanning (headers, lists)
- Highlight key information

## Honesty
- State confidence level when uncertain
- Acknowledge limitations
- No fabrication

# Error Handling UX

| Error type | Response |
|------------|----------|
| User-facing | Clear explanation + remediation steps + retry/escalate option |
| Internal | Log detail for debugging; simplified message to user; preserve context for retry |
