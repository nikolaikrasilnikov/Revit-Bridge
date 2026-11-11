#!/usr/bin/env python3
"""
Тексты PDF-чертежа с координатами -> CSV/JSON (для поиска подписей помещений, марок, штампа).

python3 pdf_text.py drawing.pdf out_prefix [--page 1] [--scale 100] [--regex "ПАТТЕРН"]

Координаты — как в pdf_to_dxf.py (мм, Y вверх, с учётом масштаба), поэтому тексты
и геометрия ложатся друг на друга. x,y — начало строки (baseline), cx,cy — центр надписи:
для «подпись внутри помещения» брать центр.
"""
import sys
if __name__ == '__main__' and hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')
if '--help' in sys.argv or '-h' in sys.argv:
    print('Тексты PDF-чертежа с координатами -> CSV/JSON (для поиска подписей помещений, марок, штампа).\n\npython3 pdf_text.py drawing.pdf out_prefix [--page 1] [--scale 100] [--regex "ПАТТЕРН"]\n\nКоординаты — как в pdf_to_dxf.py (мм, Y вверх, с учётом масштаба), поэтому тексты\nи геометрия ложатся друг на друга. x,y — начало строки (baseline), cx,cy — центр надписи:\nдля «подпись внутри помещения» брать центр.')
    raise SystemExit(0)

import sys, re, csv, json, math
import pymupdf

PT = 25.4 / 72.0


def extract(pdf, page_no=1, scale=1.0, pattern=None):
    doc = pymupdf.open(pdf)
    page = doc[page_no - 1]
    H = page.rect.height; k = PT * scale
    rx = re.compile(pattern) if pattern else None
    rows = []
    for b in page.get_text("dict")["blocks"]:
        if b.get("type") != 0:
            continue
        for line in b["lines"]:
            ang = round(math.degrees(math.atan2(line["dir"][1], line["dir"][0])), 1)
            for s in line["spans"]:
                t = " ".join(s["text"].split())
                if not t or (rx and not rx.search(t)):
                    continue
                bb = s["bbox"]
                rows.append({"text": t, "x": round(s["origin"][0] * k, 2),
                             "y": round((H - s["origin"][1]) * k, 2),
                             "cx": round((bb[0] + bb[2]) / 2 * k, 2),
                             "cy": round((H - (bb[1] + bb[3]) / 2) * k, 2),
                             "height": round(s["size"] * k, 2), "angle": -ang,
                             "font": s["font"], "page": page_no})
    return rows


if __name__ == "__main__":
    a = sys.argv[1:]
    pdf, pref = a[0], a[1]
    page = int(a[a.index("--page") + 1]) if "--page" in a else 1
    scale = float(a[a.index("--scale") + 1]) if "--scale" in a else 1.0
    pat = a[a.index("--regex") + 1] if "--regex" in a else None
    rows = extract(pdf, page, scale, pat)
    with open(pref + ".csv", "w", newline="", encoding="utf-8-sig") as fh:
        w = csv.DictWriter(fh, fieldnames=["text", "x", "y", "cx", "cy", "height", "angle", "font", "page"])
        w.writeheader(); w.writerows(rows)
    json.dump(rows, open(pref + ".json", "w", encoding="utf-8"), ensure_ascii=False)
    print(f"текстов: {len(rows)} -> {pref}.csv / {pref}.json")
    for r in rows[:10]:
        print(f'  {r["x"]:>10.1f} {r["y"]:>10.1f}  {r["text"][:60]}')
