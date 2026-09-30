---
name: security-best-practices
description: Review Python, JavaScript, TypeScript, or Go code supplied in Chat for concrete security weaknesses and safer implementation choices when explicitly requested.
---

# Security review in Chat

Use only for an explicit security review, security best-practices question, or secure implementation request. Work from code, configuration, or architecture the user shares in Chat. If the key behavior is missing, ask for that specific code or state the assumption. Do not imply that the full repository was inspected.

Load only the relevant language and framework file from `references/`, such as the FastAPI, Express, React, or Go guidance. For each finding, cite the supplied code or configuration, describe a realistic abuse path and impact, and propose a concrete fix. Prioritize confirmed issues over generic checklists. Separate verified findings from risks that need more context. For a small snippet, provide the corrected snippet when useful; do not claim to have modified the user's project.
