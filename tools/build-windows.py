from pathlib import Path
import shutil,json,sys,sysconfig,argparse,hashlib
parser=argparse.ArgumentParser();parser.add_argument('--ffmpeg-dir',required=True,type=Path);parser.add_argument('--weights',required=True,type=Path);parser.add_argument('--python-base',type=Path,default=Path(sys.base_prefix));parser.add_argument('--site-packages',type=Path,default=Path(sysconfig.get_path('purelib')));parser.add_argument('--output',type=Path,default=Path('dist/РњРѕРЅС‚Р°Р¶РЅР°СЏ'));args=parser.parse_args()
assert hashlib.file_digest(args.weights.open('rb'),'sha256').hexdigest()=='abcfccf65446752a057f4a302c941479a54b7560ebf8d7bca039d2ea98e64cfc', 'Wrong model checksum'
from PIL import Image,ImageDraw
if not (args.python_base/'python311.dll').exists():raise RuntimeError('Use Python 3.11 x64 as documented')
base=args.output.resolve()
base.mkdir(parents=True,exist_ok=True)
shutil.copytree('node_modules/electron/dist',base,dirs_exist_ok=True)
if (base/'electron.exe').exists():(base/'electron.exe').rename(base/'РњРѕРЅС‚Р°Р¶РЅР°СЏ.exe')
app=base/'resources/app';app.mkdir(parents=True,exist_ok=True)
shutil.copytree('desktop',app,dirs_exist_ok=True)
editor=app/'editor'
def ignored(folder,names):return [n for n in names if n in ['__pycache__','audio-engine.local.json','Р—Р°РїСѓСЃС‚РёС‚СЊ СЂРµРґР°РєС‚РѕСЂ.bat']]
shutil.copytree('editor',editor,dirs_exist_ok=True,ignore=ignored)
# Only the new application copy receives desktop integration; BAT editor stays unchanged.
p=editor/'audio-separator-server.js';text=p.read_text(encoding='utf-8-sig').replace("const config=()=>{try{", "const config=()=>{if(process.env.MONTAZHNAYA_PYTHON&&process.env.MONTAZHNAYA_AUDIO_WEIGHTS)return {python:process.env.MONTAZHNAYA_PYTHON,weights:process.env.MONTAZHNAYA_AUDIO_WEIGHTS};try{");p.write_text(text,encoding='utf-8')
p=editor/'app.js';text=p.read_text(encoding='utf-8-sig');hook="""
  window.montazhnayaFlush=async()=>{clearTimeout(saveTimer);await persist();const db=await openDb();try{const saved=await new Promise((resolve,reject)=>{const r=db.transaction('project').objectStore('project').get('current');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)});return JSON.stringify(saved)===JSON.stringify(project)&&currentMediaAssets().every(asset=>asset.stored)}finally{db.close()}};
""";pos=text.rfind('\n})();');assert pos>=0;text=text[:pos]+hook+text[pos:];p.write_text(text,encoding='utf-8')
pythonBase=args.python_base
runtime=app/'runtime/python';runtime.mkdir(parents=True,exist_ok=True)
for source in pythonBase.iterdir():
 if source.is_file():shutil.copy2(source,runtime/source.name)
for name in ['DLLs','Lib']:
 shutil.copytree(pythonBase/name,runtime/name,dirs_exist_ok=True,ignore=lambda folder,names:[n for n in names if n in ['site-packages','__pycache__','test','tests','idlelib','tkinter','ensurepip','turtledemo']])
site=runtime/'Lib/site-packages';site.mkdir(exist_ok=True)
source=args.site_packages
packages=['torch','functorch','torchgen','numpy','numpy.libs','soundfile.py','_soundfile.py','_soundfile_data','cffi','_cffi_backend.cp311-win_amd64.pyd','pycparser','sympy','mpmath','networkx','jinja2','markupsafe','filelock','fsspec','typing_extensions.py']
for name in packages:
 item=source/name
 if not item.exists():raise RuntimeError('Missing dependency: '+name)
 print('Bundling '+name,flush=True)
 if item.is_dir():shutil.copytree(item,site/name,dirs_exist_ok=True,ignore=lambda folder,names:[n for n in names if n in ['__pycache__','test','tests']])
 else:shutil.copy2(item,site/name)
# Metadata includes dependency licences and allows runtime version checks.
for item in source.glob('*.dist-info'):
 normalized=item.name.lower().replace('-','_')
 if any(normalized.startswith(name+'_') for name in ['torch','numpy','soundfile','cffi','pycparser','sympy','mpmath','networkx','jinja2','markupsafe','filelock','fsspec','typing_extensions']):shutil.copytree(item,site/item.name,dirs_exist_ok=True)
models=app/'audio-models';models.mkdir(exist_ok=True)
shutil.copy2(args.weights,models/'checkpoint-multi.ckpt')
for name in ['ffmpeg.exe','ffprobe.exe']:shutil.copy2(args.ffmpeg_dir/name,editor/'bin'/name)
(models/'SOURCE.txt').write_text('Bandit v2 Multi, Karn Watcharasupat et al. CC BY-SA 4.0. https://zenodo.org/records/12701995',encoding='utf-8')
im=Image.new('RGBA',(256,256),(20,23,24,255));draw=ImageDraw.Draw(im);draw.rounded_rectangle((16,16,240,240),radius=48,fill='#252a2b',outline='#dcff00',width=8);draw.polygon([(101,72),(101,184),(184,128)],fill='#dcff00');
for y in [62,100,138,176]:draw.rounded_rectangle((42,y,65,y+19),radius=3,fill='#93a9b7')
im.save(app/'icon.ico',sizes=[(16,16),(32,32),(48,48),(64,64),(128,128),(256,256)])
(base/'README.txt').write_text('Р—Р°РїСѓСЃРєР°Р№С‚Рµ РњРѕРЅС‚Р°Р¶РЅР°СЏ.exe. РљРѕРїРёСЂРѕРІР°С‚СЊ РЅСѓР¶РЅРѕ РІСЃСЋ РїР°РїРєСѓ РїСЂРёР»РѕР¶РµРЅРёСЏ. Р”Р°РЅРЅС‹Рµ: %APPDATA%/Montazhnaya Desktop. РЎРµСЂРІРµСЂ Рё РѕР±СЂР°Р±РѕС‚РєР° РѕСЃС‚Р°РЅР°РІР»РёРІР°СЋС‚СЃСЏ РІРјРµСЃС‚Рµ СЃ РїСЂРёР»РѕР¶РµРЅРёРµРј.',encoding='utf-8')
print('Desktop package assembled: '+str(base),flush=True)
