# Validation — Code Mode 0.2.0

[Русский](VALIDATION.ru.md)

| Check | Fresh result |
| --- | --- |
| Bridge build for Revit 2025 | PASS; zero warnings/errors |
| Bridge build for Revit 2026 | PASS; zero warnings/errors |
| Actual stdio MCP handshake and tools/list | PASS; two default tools; 28 operations discovered; full mode exposes 30 tools |
| Code Mode worker and protocol tests | PASS; 9 tests: orchestration, schema checks, receipts, errors, deadlines, limits and compatibility |
| Configuration/identity/warning focused tests | PASS; 9 tests |
| Full Node suite in this executor | 30 passed; 34 failed on denied hardlink/junction filesystem operations |
| Previous full Node suite in GitHub Actions, Node 22 | PASS; 55 tests on Ubuntu and 55 on Windows before Code Mode; current run pending |
| Python helpers | All 12 parse; 7 FBX/OBJ/coordinate-fit tests pass; optional DXF execution not tested because ezdxf is absent |
| Installer/config/skills/removal | PASS with APPDATA and LOCALAPPDATA redirected to a disposable test directory, using existing binaries/dependencies |
| Dependency installation from npm | PASS; npm ci on both GitHub Actions runners |
| Native loading/editing in Revit after extraction | Not performed |

This executor denies `fs.link`/junction creation; the ownership protocol intentionally relies on those operations and was not weakened to satisfy the environment. The full suite passed on normal Windows/Linux runners in [GitHub Actions run 43077535136](https://github.com/nikolaikrasilnikov/Revit-Bridge/actions/runs/43077535136), commit `c903c9a`. Windows lifecycle fixtures now canonicalize the temporary root to handle 8.3 path aliases consistently.

No user model was opened, modified or saved. The installer test did not register an add-in in the user's actual Revit profile. The original running integration was left unchanged.

Code Mode is now implemented and protocol-tested. No live Revit model has been used to validate it; this is not a claim of end-to-end native runtime validation on a clean machine. The native C# bridge was not changed for 0.2.0.
