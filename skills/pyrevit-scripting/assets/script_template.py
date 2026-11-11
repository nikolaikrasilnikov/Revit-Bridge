# -*- coding: utf-8 -*-
"""Шаблон атомарной pyRevit-кнопки для IronPython 2.7 / совместимого CPython.

Заполнить collect_work, apply_change и verify_changes для конкретной задачи.
"""
from __future__ import unicode_literals

from pyrevit import revit, DB, forms, script


def get_id_value(element_id):
    try:
        return element_id.Value
    except AttributeError:
        return element_id.IntegerValue


def collect_work(doc):
    return []


def apply_change(doc, item):
    raise NotImplementedError("Задайте изменение элемента")


def verify_changes(doc, work):
    raise NotImplementedError("Задайте независимое чтение результата")


def main():
    doc = revit.doc
    if doc is None:
        forms.alert("Откройте документ Revit.")
        return
    output = script.get_output()
    work = list(collect_work(doc))
    if not work:
        forms.alert("Нет элементов для обработки.")
        return
    output.print_table([[output.linkify(item.Id)] for item in work], columns=["Элемент"])
    if not forms.alert("Применить к {} элементам?".format(len(work)), yes=True, no=True):
        return
    transaction = DB.Transaction(doc, "Изменение модели")
    try:
        if transaction.Start() != DB.TransactionStatus.Started:
            raise RuntimeError("Не удалось начать транзакцию")
        for item in work:
            apply_change(doc, item)
        status = transaction.Commit()
        if status != DB.TransactionStatus.Committed:
            raise RuntimeError("Транзакция не подтверждена: {}".format(status))
    except Exception:
        if transaction.GetStatus() == DB.TransactionStatus.Started:
            transaction.RollBack()
        raise
    finally:
        transaction.Dispose()
    verify_changes(doc, work)
    output.print_md("Подтверждено и проверено: **{}** элементов.".format(len(work)))


if __name__ == "__main__":
    main()
