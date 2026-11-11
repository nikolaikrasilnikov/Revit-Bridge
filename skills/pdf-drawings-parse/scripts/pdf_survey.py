#!/usr/bin/env python3
"""
Разведка PDF-чертежа: что на страницах и можно ли вообще брать оттуда геометрию.

python3 pdf_survey.py drawing.pdf [survey.json]

По каждой странице: размер в мм, поворот, сколько векторных объектов, текстов, растров,
есть ли слои PDF (OCG), шрифты, и вердикт: вектор / скан / гибрид.
"""
import sys
if __name__ == '__main__' and hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')
if '--help' in sys.argv or '-h' in sys.argv:
    print('Разведка PDF-чертежа: что на страницах и можно ли вообще брать оттуда геометрию.\n\npython3 pdf_survey.py drawing.pdf [survey.json]\n\nПо каждой странице: размер в мм, поворот, сколько векторных объектов, текстов, растров,\nесть ли слои PDF (OCG), шрифты, и вердикт: вектор / скан / гибрид.')
    raise SystemExit(0)

import sys, json
import pymupdf

PT = 25.4 / 72.0  # пункт PDF -> мм


def survey(path):
    doc = pymupdf.open(path)
    res = {"file": path, "pages": doc.page_count, "ocg_layers": list(doc.get_ocgs().values()) if doc.get_ocgs() else [],
           "metadata": {k: v for k, v in (doc.metadata or {}).items() if v}, "sheets": []}
    for i, page in enumerate(doc):
        r = page.rect
        drawings = page.get_drawings()
        items = sum(len(d["items"]) for d in drawings)
        text = page.get_text("dict")
        spans = [s for b in text["blocks"] if b.get("type") == 0 for l in b["lines"] for s in l["spans"]]
        images = page.get_images(full=True)
        img_area = 0.0
        for im in images:
            try:
                for rct in page.get_image_rects(im[0]):
                    img_area += rct.get_area()
            except Exception:
                pass
        cover = img_area / r.get_area() if r.get_area() else 0
        kind = ("вектор" if items > 200 and cover < 0.5 else
                "скан" if cover > 0.5 and items < 200 else
                "гибрид" if items > 200 and cover > 0.5 else "почти пусто")
        fonts = sorted({s["font"] for s in spans})
        r_ = {"page": i + 1, "width_mm": round(r.width * PT, 1), "height_mm": round(r.height * PT, 1),
              "rotation": page.rotation, "paths": len(drawings), "segments": items,
              "texts": len(spans), "images": len(images), "image_cover": round(cover, 2),
              "fonts": fonts[:10], "kind": kind,
              "text_sample": [" ".join(s["text"].split()) for s in spans[:15] if s["text"].strip()]}
        res["sheets"].append(r_)
    return res


if __name__ == "__main__":
    res = survey(sys.argv[1])
    out = sys.argv[2] if len(sys.argv) > 2 else "survey.json"
    json.dump(res, open(out, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print(f'{res["file"]}: страниц {res["pages"]}, слои PDF: {res["ocg_layers"] or "нет"}')
    for s in res["sheets"]:
        print(f'  стр.{s["page"]:>3} {s["width_mm"]}x{s["height_mm"]} мм · {s["kind"]} · '
              f'векторов {s["segments"]}, текстов {s["texts"]}, растров {s["images"]} (покрытие {s["image_cover"]})')
    print("->", out)
