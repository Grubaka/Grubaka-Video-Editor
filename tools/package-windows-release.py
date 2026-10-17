"""Build the compact Windows editor. Audio runtime is downloaded separately."""
from pathlib import Path
from zipfile import ZipFile,ZIP_DEFLATED
from windows_shortcut import create_portable_shortcut
import argparse,hashlib,json,shutil
parser=argparse.ArgumentParser();parser.add_argument('--app-dir',type=Path);parser.add_argument('--output',type=Path,default=Path('dist/releases'));parser.add_argument('--version',default='1.0.0')
mode=parser.add_mutually_exclusive_group(required=True);mode.add_argument('--stage',action='store_true');mode.add_argument('--archive',action='store_true');mode.add_argument('--refresh',action='store_true')
args=parser.parse_args()
if not all(c.isalnum() or c in '.-' for c in args.version):parser.error('Invalid version')
name=f'Grubaka-Video-Editor-{args.version}-Windows-x64';package=args.output.resolve()/name;payload=package/'app';args.output.mkdir(parents=True,exist_ok=True)
if args.stage:
 if args.app_dir is None or not args.app_dir.is_dir():parser.error('--app-dir must be an assembled application')
 if package.exists():raise SystemExit('Refusing to overwrite existing package')
 excluded={'runtime','audio-models','__pycache__','audio-engine.local.json','Прочитать перед запуском.txt','Start Offline Editor.bat','Запустить редактор.bat'}
 shutil.copytree(args.app_dir,payload,ignore=lambda folder,names:[n for n in names if n in excluded or n.startswith('Release validation') or n.endswith(('.pyc','.log'))])
 if (payload/'Монтажная.exe').exists():(payload/'Монтажная.exe').rename(payload/'Grubaka Video Editor.exe')
if args.stage or args.refresh:
 for relative in ['Grubaka Video Editor.exe','resources/app/main.cjs','resources/app/audio-module.cjs','resources/app/audio-module.json','resources/app/editor/bin/ffmpeg.exe','resources/app/editor/bin/ffprobe.exe']:
  assert (payload/relative).is_file(),relative
 assert not (payload/'resources/app/runtime').exists(),'Audio runtime must be separate from the compact editor'
 assert not (payload/'resources/app/audio-models').exists(),'Audio weights must be separate from the compact editor'
 create_portable_shortcut(package/'Start Grubaka Video Editor.lnk')
 text=f"""GRUBAKA VIDEO EDITOR {args.version} — WINDOWS x64

ENGLISH
1. Extract the entire ZIP to a folder.
2. Double-click Start Grubaka Video Editor.lnk.
You can also run app\\Grubaka Video Editor.exe. Keep the shortcut and app folder together.
No Node.js, Python, installation or console commands are required.
Editing, cropping, chroma key, timers, slow motion, conversion and export work immediately.

OPTIONAL AUDIO MODULE
The first time you choose to separate speech, music or effects, click Download audio
separation module. The app downloads, verifies and connects it automatically.
Python and the model are included in that module; install nothing manually.
An internet connection is needed only for this one-time download. Afterwards it works offline.
Audio separation uses the CPU. The module is stored in your user profile, separately from the app.
Projects and modules: %APPDATA%\\Montazhnaya Desktop
Use Eng / Rus and the book icon for the illustrated guide.

РУССКИЙ
1. Полностью распакуйте ZIP в папку.
2. Дважды щёлкните Start Grubaka Video Editor.lnk.
Можно запустить app\\Grubaka Video Editor.exe напрямую. Храните ярлык рядом с папкой app.
Установка Node.js, Python и команды в консоли не нужны.
Монтаж, обрезка, хромокей, счётчики, слоумоушен, конвертация и экспорт работают сразу.

ДОПОЛНИТЕЛЬНЫЙ АУДИОМОДУЛЬ
При первом выделении речи, музыки или звуков нажмите «Скачать модуль разделения звука».
Приложение само скачает, проверит и подключит модуль со встроенными Python и моделью.
Вручную устанавливать ничего не нужно. Интернет нужен только для первой загрузки.
После неё разделение работает офлайн, на процессоре. Модуль хранится отдельно от приложения.
Проекты и модули: %APPDATA%\\Montazhnaya Desktop
Eng / Rus переключает язык; кнопка книги открывает инструкцию с картинками.

LICENSES / ЛИЦЕНЗИИ
Electron/Chromium: app/LICENSE, app/LICENSES.chromium.html
FFmpeg: app/resources/app/editor/bin/
lamejs: app/resources/app/editor/LICENSE-lamejs.txt
Optional Python/PyTorch dependencies: licenses inside the downloaded module.
Bandit code: Apache-2.0, app/resources/app/editor/vendor/
Bandit v2 Multi weights: CC BY-SA 4.0, Karn Watcharasupat and coauthors;
https://zenodo.org/records/12701995
Project: https://github.com/Grubaka/Grubaka-Video-Editor
"""
 (package/'README FIRST - Прочитать.txt').write_text(text,encoding='utf-8-sig')
 (package/'BUILD.json').write_text(json.dumps({'product':'Grubaka Video Editor','version':args.version,'platform':'Windows x64','audio_module':'optional download','launch':'Start Grubaka Video Editor.lnk'},indent=2)+'\n',encoding='utf-8')
 print('Compact package ready: '+str(package),flush=True)
else:
 assert package.is_dir()
 archive=args.output/(name+'.zip');assert not archive.exists(),archive
 files=sorted(p for p in package.rglob('*') if p.is_file())
 with ZipFile(archive,'w',ZIP_DEFLATED,compresslevel=6,allowZip64=True) as z:
  for p in files:z.write(p,p.relative_to(package.parent).as_posix())
 assert archive.stat().st_size<2*1024**3
 with ZipFile(archive) as z:assert z.testzip() is None
 with archive.open('rb') as f:digest=hashlib.file_digest(f,'sha256').hexdigest()
 (args.output/(name+'.zip.sha256')).write_text(digest+'  '+archive.name+'\n',encoding='ascii')
 print(json.dumps({'archive':str(archive),'bytes':archive.stat().st_size,'files':len(files),'sha256':digest}),flush=True)
