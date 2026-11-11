"""Inventory DXF contents without interpreting project-specific room/floor labels."""
import argparse
import json
from collections import Counter

def survey(source):
    from ezdxf import recover
    doc,audit=recover.readfile(source)
    msp=doc.modelspace()
    return {'dxfVersion':doc.dxfversion,'units':doc.units,
            'audit':{'errors':len(audit.errors),'fixes':len(audit.fixes)},
            'layers':[layer.dxf.name for layer in doc.layers],
            'layouts':list(doc.layout_names()),
            'entityTypes':dict(Counter(e.dxftype() for e in msp)),
            'blocks':{block.name:dict(Counter(e.dxftype() for e in block)) for block in doc.blocks},
            'inserts':[{'block':e.dxf.name,'insertion':list(e.dxf.insert),
                        'scale':[e.dxf.xscale,e.dxf.yscale,e.dxf.zscale],
                        'rotation':e.dxf.rotation} for e in msp.query('INSERT')]}

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source')
    parser.add_argument('output')
    args=parser.parse_args()
    with open(args.output,'w',encoding='utf-8') as out:
        json.dump(survey(args.source),out,ensure_ascii=False,indent=2)
    print(args.output)
