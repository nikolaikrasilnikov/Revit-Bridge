"""Extract XY line segments from DXF with explicit curve tolerance and skipped-entity report."""
import argparse
import json
from pathlib import Path

def build(source,tolerance):
    import numpy as np
    from ezdxf import recover
    from ezdxf.disassemble import recursive_decompose
    from ezdxf.path import make_path
    doc,audit=recover.readfile(source)
    segments=[];skipped={};errors=[]
    for entity in recursive_decompose(doc.modelspace()):
        kind=entity.dxftype()
        if kind not in {'LINE','LWPOLYLINE','POLYLINE','ARC','CIRCLE','ELLIPSE','SPLINE'}:
            skipped[kind]=skipped.get(kind,0)+1
            continue
        try:
            points=list(make_path(entity).flattening(tolerance))
            segments.extend((a.x,a.y,b.x,b.y) for a,b in zip(points,points[1:]))
        except Exception as error:
            errors.append({'type':kind,'handle':entity.dxf.get('handle'), 'error':str(error)})
    return np.asarray(segments,dtype=np.float64).reshape((-1,4)),{'units':doc.units,'projection':'XY','tolerance':tolerance,'skipped':skipped,'errors':errors,'auditErrors':len(audit.errors)}

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source')
    parser.add_argument('output',type=Path)
    parser.add_argument('--tolerance',type=float,default=1.0,help='Curve tolerance in DXF drawing units')
    args=parser.parse_args()
    if not 0<args.tolerance<float('inf'):parser.error('Tolerance must be positive and finite')
    import numpy as np
    segments,report=build(args.source,args.tolerance)
    with args.output.open('wb') as out:np.save(out,segments)
    report['segments']=len(segments)
    args.output.with_suffix(args.output.suffix+'.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps(report,ensure_ascii=False))
