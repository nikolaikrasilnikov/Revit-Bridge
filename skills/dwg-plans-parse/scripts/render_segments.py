"""Render an XY segment array without room types or project-specific floor assumptions."""
import argparse
from pathlib import Path

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('segments',type=Path)
    parser.add_argument('output',type=Path)
    args=parser.parse_args()
    import numpy as np
    import matplotlib
    matplotlib.use('Agg')
    from matplotlib import pyplot as plt
    from matplotlib.collections import LineCollection
    data=np.load(args.segments,allow_pickle=False)
    if data.ndim!=2 or data.shape[1]!=4 or not np.isfinite(data).all():
        parser.error('Expected a finite N-by-4 segment array')
    fig,ax=plt.subplots(figsize=(12,8))
    if len(data):
        ax.add_collection(LineCollection(data.reshape((-1,2,2)),linewidths=0.5,colors='#525252'))
        ax.autoscale()
    ax.set_aspect('equal');ax.axis('off')
    fig.savefig(args.output,dpi=160,bbox_inches='tight');plt.close(fig)
    print(args.output)
