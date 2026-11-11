# pyRevit bundles

```text
Tools.extension/
  lib/                         optional shared helpers
  Tools.tab/
    Model.panel/
      Check.pushbutton/
        script.py
        bundle.yaml
        icon.png               optional
        icon.dark.png          optional
```

Preserve existing locations, names and icons. Register a search path only within the user's task; it is the directory containing `.extension` folders. Do not overwrite an existing bundle with a scaffold.

```yaml
title: "Проверить\nэлементы"
tooltip: "Проверяет выбранные элементы и показывает результат."
author: "Revit Bridge"
context: doc-project
engine:
  clean: true
```

Use a real title and tooltip; keep the existing author when maintaining a tool. Set `min_revit_version` only to a justified lower bound. Inline `__title__`/`__doc__` metadata remains supported in pyRevit 7; avoid conflicting duplicates.

`clean: true` clears reused engine state; it **does not choose CPython**. To request an available CPython engine, `script.py` begins:

```python
#! python3
# -*- coding: utf-8 -*-
```

For IronPython 2.7, the encoding header is first and all remaining syntax must parse there. Check actual runtime before assuming compatibility. Do not use the presence of `__pycache__` as evidence of a particular button's interpreter.

An agent script's injected `doc`, `inputs`, and `result` are not automatically available to a button: replace them with imports, UI inputs and visible reporting, and move workspace helpers into `lib` as needed. There is no agent-run approval guard around later button clicks.

Reload from the pyRevit UI or a verified supported API/CLI for the installed build. Reload rebuilds the ribbon and may close pyRevit windows; coordinate with ongoing tools. Do not assume a `pyrevit reload` CLI command exists. Check that the command loaded, then test representative behavior within the authorized scope; ribbon visibility alone is not runtime validation.
