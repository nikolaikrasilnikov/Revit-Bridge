# Runtime and button contracts

| Surface | Transaction owner |
| --- | --- |
| pyRevit ribbon button | Script opens and closes its own Transaction |
| Revit Bridge MCP | Host owns the outer managed transaction; use SubTransaction |
| Optional pyRevit agent host | Follow its actual discovered schema and run policy |
| Python shell | Explicit transactions; ordinary shell statements do not inherit MCP guards |

Inspect the loaded interpreter rather than infer it from a Revit year. IronPython 2.7 rejects f-strings. CPython requires an installed compatible engine; `engine.clean` does not select it. Resolve current document objects at invocation rather than module import.

Python buttons, pyRevit's optional agent runtime and the C# bridge are separate execution surfaces. Do not replace an existing connection or change host policy just to author a button. Discover current runtime tools instead of inventing API calls from an archived release.

For bundles preserve `.extension/.tab/.panel/.pushbutton` suffixes, UTF-8 source and meaningful localized title/tooltip metadata. Register the extension parent only within the requested installation task. Verify ribbon discovery separately from script behavior.

References: https://docs.pyrevitlabs.io/agent-runtime/ and https://docs.pyrevitlabs.io/python-shell/ . Compare documentation with the installed release and actual schemas.
