"""Build a clean source or binary distribution without machine-local state."""
from pathlib import Path
import argparse
import hashlib
import zipfile

ROOT=Path(__file__).resolve().parents[1]
EXCLUDE={'.git','.local','node_modules','bin','obj','dist','.agents','.claude','.venv','__pycache__','state','logs','tmp'}
PRIVATE={'server/config.json','server/mcp-client.local.json'}

def source_files(directory):
    for item in sorted(directory.iterdir()):
        if item.is_symlink():
            raise ValueError(f'Unexpected link in distribution tree: {item.name}')
        if item.is_dir():
            if item.name not in EXCLUDE:
                yield from source_files(item)
        elif item.is_file():
            name=item.relative_to(ROOT).as_posix()
            if name not in PRIVATE and item.suffix.lower() not in {'.bak','.log','.dmp','.pyc','.rvt','.rfa','.rte','.ifc','.trm','.bcfzip'}:
                yield item

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--binaries',action='store_true')
    parser.add_argument('--output',type=Path)
    args=parser.parse_args()
    version=(ROOT/'VERSION').read_text().strip()
    kind='windows' if args.binaries else 'source'
    out=args.output or ROOT/'dist'/f'revit-bridge-{version}-{kind}.zip'
    out=out.resolve()
    if out.exists():
        raise SystemExit('Output exists; choose a new output path.')
    items=list(source_files(ROOT))
    if args.binaries:
        for year in ['2025','2026']:
            folder=ROOT/'server/bin'/year
            for name in ['RevitWorkspaceBridge.dll','RevitWorkspaceBridge.deps.json','Microsoft.CodeAnalysis.dll','Microsoft.CodeAnalysis.CSharp.dll']:
                binary=folder/name
                if not binary.is_file():
                    raise SystemExit(f'Missing build: {year}/{name}')
                items.append(binary)
    if out in items:
        raise SystemExit('Output must not overwrite a source file.')
    out.parent.mkdir(parents=True,exist_ok=True)
    checksums=[]
    with zipfile.ZipFile(out,'x',zipfile.ZIP_DEFLATED) as archive:
        for item in items:
            name=item.relative_to(ROOT).as_posix()
            data=item.read_bytes()
            archive.writestr(name,data)
            checksums.append(hashlib.sha256(data).hexdigest()+'  '+name)
        archive.writestr('SHA256SUMS','\n'.join(checksums)+'\n')
    print(f'{out.name}: {len(items)} files, {out.stat().st_size} bytes')
    print('SHA256 '+hashlib.sha256(out.read_bytes()).hexdigest())

if __name__=='__main__':
    main()
