# Installation

[Русский](INSTALL.ru.md)

| Component | Required for | Official source |
| --- | --- | --- |
| Windows and Revit 2025/2026 | Live API access | https://www.autodesk.com/products/revit/overview |
| Node.js 22+ | MCP server | https://nodejs.org/en/download |
| .NET 8 SDK | Building missing bridge binaries | https://dotnet.microsoft.com/download/dotnet/8.0 |
| pyRevit | Optional Python ribbon tools | https://github.com/pyrevitlabs/pyRevit/releases |
| Python 3 | Optional external reference helpers | https://www.python.org/downloads/ |

The bridge targets Revit's runtime. Do not retarget it to a newer .NET just because an SDK is installed. Autodesk API DLLs, pyRevit and DWG converters are not bundled.

## Agent procedure

1. Read AGENTS.md and inspect prerequisites with `install.ps1 -CheckOnly`.
2. Install for the intended years and explicit model directory. Missing dependencies come from official sources. A source build uses API references from the installed Revit.
3. For a binary distribution, verify the supplied hashes. Keep model files outside source control.
4. Register `server/mcp-client.local.json` in the agent's actual configuration format, preserving other entries. Example JSON and Codex TOML snippets live in `examples/`.
5. Use `-SkillsPath` only for the intended client's skills directory. Confirm discovery; presence in a source directory is not proof of installation.
6. Restart Revit normally, discover the new session and perform a read-only query. Never close unsaved user windows automatically.

`server/config.example.json` is portable. The installer writes absolute machine-local paths into ignored `server/config.json`. The DLL reads this file two directories above its location, so keep `server/bin/<year>/` intact. Server and bridge must use the same config and state directory.

Registration uses `RevitBridge.addin`, separate from the development bridge. The installer backs up an existing owned manifest and refuses an unrelated one. Use one intended writer per document even if multiple integrations are installed.

`-Remove` unregisters the owned manifest only. Dependencies, skills and model data remain. Existing skills are not overwritten during installation. The pyRevit agent host is never enabled by this installer.
