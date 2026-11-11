# Validation — packaging preview 0.1.0

[Русский](VALIDATION.ru.md)

| Check | Fresh result |
| --- | --- |
| Bridge build for Revit 2025 | PASS; zero warnings/errors |
| Bridge build for Revit 2026 | PASS; zero warnings/errors |
| Actual stdio MCP handshake and tools/list | PASS; 28 tools, specialized adapters absent |
| Configuration/identity/warning focused tests | PASS; 9 tests |
| Full Node suite in this executor | 21 passed; 34 failed on denied hardlink/junction filesystem operations |
| Python helpers | All 12 parse; 7 FBX/OBJ/coordinate-fit tests pass; optional DXF execution not tested because ezdxf is absent |
| Installer/config/skills/removal | PASS with APPDATA and LOCALAPPDATA redirected to a disposable test directory, using existing binaries/dependencies |
| Dependency installation from npm | Not exercised; local existing dependency cache used for protocol verification |
| Native loading/editing in Revit after extraction | Not performed |

The full suite is not reported as passing. This executor denies `fs.link`/junction creation; the ownership protocol intentionally relies on those operations and was not weakened to satisfy the environment. GitHub Actions is configured for normal Windows/Linux runners; no CI run has been observed yet.

No user model was opened, modified or saved. The installer test did not register an add-in in the user's actual Revit profile. The original running integration was left unchanged.

Code Mode source was not found and no working Code Mode is claimed. This is a packaging preview rather than a claim of end-to-end installation/runtime validation on a clean machine.
