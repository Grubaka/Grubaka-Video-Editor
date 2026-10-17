"""Build the optional CPU audio module and its pinned download manifest."""
from pathlib import Path
from zipfile import ZipFile,ZIP_DEFLATED
import argparse,hashlib,json
parser=argparse.ArgumentParser()
parser.add_argument('--source',type=Path,required=True,help='App resources/app folder with CPU Python and weights')
parser.add_argument('--output',type=Path,required=True)
parser.add_argument('--manifest',type=Path,required=True)
parser.add_argument('--version',default='1.0.0')
args=parser.parse_args()
if not all(c.isalnum() or c in '.-' for c in args.version):parser.error('Invalid version')
files=[]
for name in ('runtime','audio-models'):
 files.extend(p for p in (args.source/name).rglob('*') if p.is_file() and '__pycache__' not in p.parts and p.suffix not in ('.pyc','.log'))
provenance=args.source/'PyTorch-CPU-SOURCE.json'
if provenance.exists():files.append(provenance)
assert (args.source/'runtime/python/python.exe').is_file()
assert (args.source/'audio-models/checkpoint-multi.ckpt').is_file()
metadata=list((args.source/'runtime/python/Lib/site-packages').glob('torch-*.dist-info/METADATA'))
assert len(metadata)==1 and '+cpu' in metadata[0].read_text(encoding='utf-8'), 'Use the CPU PyTorch runtime for the optional module'
args.output.mkdir(parents=True,exist_ok=True)
filename=f'Grubaka-Audio-Module-{args.version}-Windows-x64.zip';archive=args.output/filename
assert not archive.exists(),archive
with ZipFile(archive,'w',ZIP_DEFLATED,compresslevel=6,allowZip64=True) as z:
 for index,p in enumerate(sorted(files),1):
  z.write(p,p.relative_to(args.source).as_posix())
  if index%3000==0:print(f'Audio module: {index}/{len(files)} files',flush=True)
assert archive.stat().st_size<2*1024**3
with ZipFile(archive) as z:assert z.testzip() is None
with archive.open('rb') as f:digest=hashlib.file_digest(f,'sha256').hexdigest()
manifest={'version':args.version,'url':f'https://github.com/Grubaka/Grubaka-Video-Editor/releases/download/v{args.version}/{filename}',
 'sha256':digest,'bytes':archive.stat().st_size,'expandedBytes':sum(p.stat().st_size for p in files)}
args.manifest.parent.mkdir(parents=True,exist_ok=True);args.manifest.write_text(json.dumps(manifest,indent=2)+'\n',encoding='utf-8')
(args.output/(filename+'.sha256')).write_text(digest+'  '+filename+'\n',encoding='ascii')
print(json.dumps(manifest),flush=True)
