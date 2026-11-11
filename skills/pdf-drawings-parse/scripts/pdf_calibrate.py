#!/usr/bin/env python3
"""
Калибровка масштаба PDF-чертежа: по двум точкам с известным расстоянием.

python3 pdf_calibrate.py x1 y1 x2 y2 истинное_расстояние_мм

x,y — координаты точек на листе в миллиметрах (как их выдают pdf_text.py / pdf_to_dxf.py
при --scale 1). Истинное расстояние берут с размерной линии чертежа или из модели.
Выводит знаменатель масштаба для --scale и ближайший стандартный масштаб.
"""
import sys
if __name__ == '__main__' and hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')
if '--help' in sys.argv or '-h' in sys.argv:
    print('Калибровка масштаба PDF-чертежа: по двум точкам с известным расстоянием.\n\npython3 pdf_calibrate.py x1 y1 x2 y2 истинное_расстояние_мм\n\nx,y — координаты точек на листе в миллиметрах (как их выдают pdf_text.py / pdf_to_dxf.py\nпри --scale 1). Истинное расстояние берут с размерной линии чертежа или из модели.\nВыводит знаменатель масштаба для --scale и ближайший стандартный масштаб.')
    raise SystemExit(0)

import sys, math

STD = [1, 2, 5, 10, 20, 25, 50, 75, 100, 200, 250, 500, 1000]

if __name__ == "__main__":
    x1, y1, x2, y2, real = map(float, sys.argv[1:6])
    d = math.hypot(x2 - x1, y2 - y1)
    if d == 0:
        sys.exit("точки совпадают")
    k = real / d
    near = min(STD, key=lambda s: abs(s - k))
    print(f"на листе {d:.2f} мм, в натуре {real:g} мм")
    print(f"масштаб: 1:{k:.3f}  ->  --scale {k:.4f}")
    print(f"ближайший стандартный: 1:{near}  (отклонение {abs(k-near)/near*100:.2f} %)")
    if abs(k - near) / near < 0.005:
        print("совпадает со стандартным — брать 1:%d" % near)
    else:
        print("не стандартный: проверить, не обрезан ли лист и та ли пара точек")
