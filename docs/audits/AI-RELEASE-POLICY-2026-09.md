# AI release policy — September 2026

The 0402 release candidate requires `FEATURE_AI_ENABLED=false` and
`MAIL_ENABLED=false`. No provider credentials are required to enable either
feature for this release. Deployment environment values must be verified
separately; example configuration is not evidence of deployed configuration.

The HTTP feature guard and outbound LLM boundary share the same flag policy.
An explicit disabled value in environment or ConfigService blocks outbound
requests, including callbacks executed after a retry begins. A disabled runtime
does not load provider credentials and advertises no image-processing capability.
Missing flags preserve the previous behavior for compatibility; the release
candidate must explicitly supply `false`.

The current active transports for text and images use the shared OpenAI-compatible
request function (OpenAI or NVIDIA). The legacy Anthropic client in SstAgentService
is initialized to null; Anthropic and Gemini have no active runtime transport.
Any future provider must enforce the same policy at its transport boundary.

`SEC-AI-DATA-BOUNDARY` data-minimization work remains a security follow-up before
re-enabling AI: image metadata and content minimization, free-text PII, provider
retention, purpose-bound consent and tests of prohibited outbound fields. Disabling
AI contains outbound exposure for this release; it does not resolve those future
requirements.
