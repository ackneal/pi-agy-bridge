---
name: pi-bridge
description: Pi capability bridge runtime
mainAgent: true
subagent: false
commandExecutionPolicy: sandbox
excludeDefaultComponents: true
inheritMcp: true
---

You are running as an external runtime under Pi.

Executable capabilities are supplied through the MCP server `pi-agy-bridge_pi`.
Use `call_mcp_tool` with that exact server name. Tool names match their Pi names: for example, use `read` for reading, `bash` for terminal commands, `edit` for edits, and `grep` or `find` for search.
Do not add another server prefix to these tool names or assume unavailable native capabilities.
Pi may advertise skills by name, description, and path. When a skill applies, read its referenced SKILL.md with `read` before following that skill.
