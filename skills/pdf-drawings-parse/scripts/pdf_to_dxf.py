#!/usr/bin/env python3
"""
Векторный PDF-чертёж -> DXF (геометрия + тексты), масштаб 1:1 в миллиметрах листа.

python3 pdf_to_dxf.py drawing.pdf out.dxf [--page 1] [--scale 100] [--no-text]

--scale — знаменатель масштаба чертежа (1:100 -> 100): координаты умножаются,
          чтобы в DXF получились натурные миллиметры. По умолчанию 1 (размеры листа).
Слои DXF формируются по цвету и толщине линии PDF: p_<цвет>_<толщина>, тексты — в слое TEXT.
Система координат PDF (Y вниз) переводится в обычную (Y вверх).
"""
import sys
if __name__ == '__main__' and hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')
if '--help' in sys.argv or '-h' in sys.argv:
    print('Векторный PDF-чертёж -> DXF (геометрия + тексты), масштаб 1:1 в миллиметрах листа.\n\npython3 pdf_to_dxf.py drawing.pdf out.dxf [--page 1] [--scale 100] [--no-text]\n\n--scale — знаменатель масштаба чертежа (1:100 -> 100): координаты умножаются,\n          чтобы в DXF получились натурные миллиметры. По умолчанию 1 (размеры листа).\nСлои DXF формируются по цвету и толщине линии PDF: p_<цвет>_<толщина>, тексты — в слое TEXT.\nСистема координат PDF (Y вниз) переводится в обычную (Y вверх).')
    raise SystemExit(0)

import sys, math, collections
import pymupdf, ezdxf

PT = 25.4 / 72.0


def rgb(c):
    if c is None:
        return "none"
    if isinstance(c, (int, float)):
        c = (c, c, c)
    return "%02X%02X%02X" % tuple(max(0, min(255, int(round(v * 255)))) for v in c[:3])


def bezier(p0, p1, p2, p3, n=12):
    out = []
    for i in range(1, n + 1):
        t = i / n; u = 1 - t
        out.append((u**3 * p0[0] + 3*u*u*t*p1[0] + 3*u*t*t*p2[0] + t**3 * p3[0],
                    u**3 * p0[1] + 3*u*u*t*p1[1] + 3*u*t*t*p2[1] + t**3 * p3[1]))
    return out


def convert(pdf, out, page_no=1, scale=1.0, with_text=True):
    doc = pymupdf.open(pdf)
    page = doc[page_no - 1]
    H = page.rect.height
    k = PT * scale
    def P(p):   # PDF -> чертёж
        return (p[0] * k, (H - p[1]) * k)

    dxf = ezdxf.new("R2013", setup=True)
    dxf.units = 4  # миллиметры
    msp = dxf.modelspace()
    stat = collections.Counter()

    for d in page.get_drawings():
        stroke = rgb(d.get("color")); fill = rgb(d.get("fill"))
        w = d.get("width") or 0
        layer = f"p_{stroke if stroke != 'none' else 'fill_' + fill}_{round(w, 2)}"
        if layer not in dxf.layers:
            dxf.layers.add(layer)
        for it in d["items"]:
            op = it[0]
            try:
                if op == "l":
                    msp.add_line(P(it[1]), P(it[2]), dxfattribs={"layer": layer}); stat["линии"] += 1
                elif op == "re":
                    r = it[1]
                    pts = [P((r.x0, r.y0)), P((r.x1, r.y0)), P((r.x1, r.y1)), P((r.x0, r.y1))]
                    msp.add_lwpolyline(pts, close=True, dxfattribs={"layer": layer}); stat["прямоугольники"] += 1
                elif op == "qu":
                    q = it[1]
                    pts = [P((q.ul.x, q.ul.y)), P((q.ur.x, q.ur.y)), P((q.lr.x, q.lr.y)), P((q.ll.x, q.ll.y))]
                    msp.add_lwpolyline(pts, close=True, dxfattribs={"layer": layer}); stat["четырёхугольники"] += 1
                elif op == "c":
                    pts = [P(it[1])] + [P(p) for p in bezier(it[1], it[2], it[3], it[4])]
                    msp.add_lwpolyline(pts, dxfattribs={"layer": layer}); stat["кривые"] += 1
            except Exception:
                stat["пропущено"] += 1

    if with_text:
        if "TEXT" not in dxf.layers:
            dxf.layers.add("TEXT")
        for b in page.get_text("dict")["blocks"]:
            if b.get("type") != 0:
                continue
            for line in b["lines"]:
                ang = math.degrees(math.atan2(line["dir"][1], line["dir"][0]))
                for s in line["spans"]:
                    t = s["text"].strip()
                    if not t:
                        continue
                    x, y = P((s["origin"][0], s["origin"][1]))
                    msp.add_text(t, height=max(s["size"] * k, 0.1),
                                 rotation=-ang,
                                 dxfattribs={"layer": "TEXT"}).set_placement((x, y))
                    stat["тексты"] += 1
    dxf.saveas(out)
    return stat


if __name__ == "__main__":
    a = sys.argv[1:]
    pdf, out = a[0], a[1]
    page = int(a[a.index("--page") + 1]) if "--page" in a else 1
    scale = float(a[a.index("--scale") + 1]) if "--scale" in a else 1.0
    st = convert(pdf, out, page, scale, "--no-text" not in a)
    print(f"страница {page}, масштаб 1:{scale:g} -> {out}")
    print("  " + ", ".join(f"{k}: {v}" for k, v in st.most_common()))
