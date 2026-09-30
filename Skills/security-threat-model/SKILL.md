---
name: security-threat-model
description: Draft a focused threat model from a system description, architecture diagram, or code excerpts supplied in Chat when the user explicitly asks for threat modeling.
---

# Threat modeling in Chat

Use when the user explicitly requests a threat model or abuse-path analysis. Start with the system description, diagram, or files the user provides. Identify assets, actors, entry points, data flows, and trust boundaries. If a decisive boundary is unclear, ask a focused question; otherwise mark the assumption and continue.

For each major threat, show the attacker capability, path through a boundary, affected asset, likely impact, and a mitigation tied to that path. Rank threats using the provided exposure and controls, not a generic severity label. Use `references/security-controls-and-assets.md` for examples of assets and controls when relevant. If a repository is supplied and readable, `references/prompt-template.md` can help structure evidence; without one, do not claim repository verification. Return a concise threat-model table and open questions in Chat, or a file if the user requests one and file creation is available.
