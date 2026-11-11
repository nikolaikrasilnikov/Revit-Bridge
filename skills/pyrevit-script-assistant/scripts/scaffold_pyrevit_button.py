#!/usr/bin/env python3
"""Create a UTF-8 pyRevit selection-report scaffold, using standalone Python 3."""

import argparse
import io
import json
import re
import sys
from pathlib import Path


def bundle_name(value):
    if (not value or value != value.strip() or value.endswith('.')
            or any(ord(c) < 32 or c in '<>:"/\\|?*' for c in value)
            or value in ('.', '..')
            or re.match(r'^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)', value, re.I)):
        raise argparse.ArgumentTypeError('Use one valid Windows folder name: {!r}'.format(value))
    return value


def main():
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, 'reconfigure'):
            stream.reconfigure(encoding='utf-8')
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('root', type=Path, help='Parent directory of the .extension')
    parser.add_argument('--extension', type=bundle_name, default='CodexTools')
    parser.add_argument('--tab', type=bundle_name, default='Codex')
    parser.add_argument('--panel', type=bundle_name, default='Tools')
    parser.add_argument('--button', type=bundle_name, default='Selection Report')
    parser.add_argument('--title', help='Displayed title; defaults to button name')
    parser.add_argument('--engine', choices=('ironpython', 'cpython'), default='ironpython')
    parser.add_argument('--context', choices=('doc-project', 'doc-family', 'selection', 'zero-doc'),
                        default='doc-project')
    args = parser.parse_args()
    title = args.title or args.button
    button_dir = (args.root.resolve() / (args.extension + '.extension') / (args.tab + '.tab')
                  / (args.panel + '.panel') / (args.button + '.pushbutton'))
    if button_dir.exists():
        parser.error('Bundle already exists; no files changed: {}'.format(button_dir))
    quoted_title = json.dumps(title, ensure_ascii=False)
    code = '''# -*- coding: utf-8 -*-
from __future__ import unicode_literals

from pyrevit import revit, forms, script


def main():
    doc = revit.doc
    uidoc = revit.uidoc
    if doc is None or uidoc is None:
        forms.alert("Откройте документ Revit.", title=TITLE)
        return
    selected = [doc.GetElement(eid) for eid in uidoc.Selection.GetElementIds()]
    selected = [element for element in selected if element is not None]
    if not selected:
        forms.alert("Выберите элементы для отчёта.", title=TITLE)
        return
    output = script.get_output()
    output.print_table(
        [[output.linkify(element.Id), element.GetType().Name] for element in selected],
        columns=["Элемент", "Класс"], title=TITLE)


TITLE = {title}

if __name__ == "__main__":
    main()
'''.format(title=quoted_title)
    if args.engine == 'cpython':
        code = '#! python3\n' + code
    metadata = ('title: {title}\ntooltip: {tooltip}\nauthor: "Codex"\ncontext: {context}\n').format(
        title=quoted_title,
        tooltip=json.dumps('Показывает выбранные элементы без изменения модели.', ensure_ascii=False),
        context=args.context)
    button_dir.mkdir(parents=True, exist_ok=False)
    for filename, content in (('script.py', code), ('bundle.yaml', metadata)):
        with io.open(str(button_dir / filename), 'x', encoding='utf-8', newline='\n') as handle:
            handle.write(content)
    print('Created read-only scaffold: {}'.format(button_dir))


if __name__ == '__main__':
    main()
