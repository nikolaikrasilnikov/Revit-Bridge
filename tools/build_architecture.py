"""Generate the neutral RU/EN GitHub architecture figures (standard library)."""
from pathlib import Path
from html import escape

OUT = Path(__file__).resolve().parents[1] / 'docs' / 'architecture'
TEXT = {
    'en': dict(title='Architecture', client='AI client', server='Local MCP server', agent='AI agent', js='JavaScript orchestration', operations='28 Revit operations', handlers='Validation · jobs · transactions', skills='Agent instructions', bridge='Revit Bridge', model='Model', optional='optional', solid='Core connection', dashed='Optional component', desc='The agent uses skills and Code Mode inside the local MCP server to orchestrate validated operations; the native bridge executes Revit API work, while optional pyRevit buttons also work with the model.'),
    'ru': dict(title='Архитектура', client='AI-клиент', server='Локальный MCP-сервер', agent='AI-агент', js='Управление через JavaScript', operations='28 операций Revit', handlers='Проверки · задания · транзакции', skills='Инструкции агенту', bridge='Мост Revit', model='Модель', optional='необязательно', solid='Основной путь', dashed='Необязательный компонент', desc='Агент использует навыки и Code Mode внутри локального MCP-сервера для вызова проверяемых операций; нативный мост выполняет Revit API, а необязательные кнопки pyRevit также работают с моделью.')
}

def text(x, y, value, size=16, anchor='middle', fill='#171717', weight=600):
    return f'<text x="{x}" y="{y}" text-anchor="{anchor}" font-family="Arial, sans-serif" font-size="{size}" font-weight="{weight}" fill="{fill}">{escape(value)}</text>'

def dash(x1, y1, x2, y2):
    length = abs(x2-x1)+abs(y2-y1)
    dx, dy = (x2-x1)/length, (y2-y1)/length
    return ' '.join(f'M {x1+dx*s:g},{y1+dy*s:g} L {x1+dx*min(s+5,length):g},{y1+dy*min(s+5,length):g}' for s in range(0, int(length), 9))

def node(x, y, w, h, name, sub, focal=False, optional=False):
    box = f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="6" fill="{"#f4f4f5" if focal else "#ffffff"}" stroke="{"none" if optional else "#171717" if focal else "#737373"}" stroke-width="{2 if focal else 1}"/>'
    if optional:
        # Physical dash segments remain portable to static SVG renderers.
        d = ' '.join([dash(x,y,x+w,y),dash(x+w,y,x+w,y+h),dash(x+w,y+h,x,y+h),dash(x,y+h,x,y)])
        box += f'<path d="{d}" fill="none" stroke="#737373" stroke-width="1"/>'
    return f'<g data-node="{escape(name)}">{box}{text(x+w/2,y+h/2-3,name,18 if focal else 16)}{text(x+w/2,y+h/2+19,sub,11,fill="#5b616a",weight=400)}</g>'

def build():
    OUT.mkdir(parents=True, exist_ok=True)
    for lang,t in TEXT.items():
        slug = 'revit-bridge-'+lang
        svg = [f'<svg viewBox="0 0 960 680" xmlns="http://www.w3.org/2000/svg" role="img" aria-labelledby="{slug}-title {slug}-desc" id="{slug}-root">', f'<title id="{slug}-title">Revit Bridge — {t["title"]}</title>', f'<desc id="{slug}-desc">{escape(t["desc"])}</desc>', '<rect width="960" height="680" fill="#ffffff"/>', text(32,60,'Revit Bridge',28,'start'),text(32,88,t['title'],12,'start','#5b616a',400)]
        for x,w,label in [(32,224,t['client']),(288,352,t['server']),(672,256,'Autodesk Revit')]:
            svg += [f'<rect x="{x}" y="176" width="{w}" height="432" rx="8" fill="#fafafa" stroke="#d1d5db"/>', text(x+24,208,label,12,'start','#5b616a',400)]
        edges = [
            ('M 232,280 H 308','304,276 312,280 304,284'),
            ('M 464,320 V 384','460,380 464,388 468,380'),
            ('M 616,428 H 648 Q 656,428 656,420 V 288 Q 656,280 664,280 H 692','688,276 696,280 688,284'),
            ('M 800,320 V 384','796,380 800,388 804,380'),
            ('M 144,388 V 324','140,328 144,320 148,328'),
            (dash(800,520,800,472),'796,476 800,468 804,476')
        ]
        for d,arrow in edges:
            svg += [f'<path d="{d}" fill="none" stroke="#737373" stroke-width="1.4"/>',f'<polygon points="{arrow}" fill="#737373"/>']
        svg += [node(56,240,176,80,t['agent'],'ChatGPT · Codex'), node(312,240,304,80,'Code Mode',t['js'],True), node(312,388,304,80,t['operations'],t['handlers']), node(696,240,208,80,t['bridge'],'C# · Revit API'), node(696,388,208,80,t['model'],'RVT'), node(56,388,176,80,'Skills','Revit · pyRevit Assistant'),node(696,520,208,64,'pyRevit',t['optional'],optional=True), '<line x1="32" y1="636" x2="928" y2="636" stroke="#e5e7eb"/>','<path d="M 32,660 H 64" stroke="#737373" stroke-width="1.4"/>',text(76,664,t['solid'],11,'start','#5b616a',400),f'<path d="{dash(312,660,344,660)}" fill="none" stroke="#737373" stroke-width="1.4"/>',text(356,664,t['dashed'],11,'start','#5b616a',400),'</svg>']
        image = '\n'.join(svg)
        html = f'<!DOCTYPE html>\n<html lang="{lang}"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Revit Bridge — {t["title"]}</title><style>html,body {{ margin:0; background:#ffffff; }} .diagram-container {{ width:100%; overflow-x:auto; }} svg {{ display:block; width:100%; min-width:960px; }} @media print {{ .diagram-container {{ overflow-x:visible; }} svg {{ min-width:0; }} }}</style></head><body><main class="diagram-container">\n{image}\n</main></body></html>\n'
        (OUT/(slug+'.html')).write_text(html,encoding='utf-8')
        (OUT/(slug+'.svg')).write_text('<?xml version="1.0" encoding="UTF-8"?>\n'+image+'\n',encoding='utf-8')
        print(slug)

if __name__ == '__main__':
    build()
