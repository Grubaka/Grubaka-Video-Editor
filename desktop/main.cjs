'use strict';
const {app,BrowserWindow,Menu,dialog,session,shell,screen}=require('electron');
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
const appRoot=__dirname,editorRoot=path.join(appRoot,'editor'),diagnosticArg=process.argv.find(s=>s.startsWith('--diagnostics=')),diagnosticDir=diagnosticArg?path.resolve(diagnosticArg.slice(14)):null;
app.setName('Монтажная');app.setAppUserModelId('Montazhnaya.Desktop');
const profile=diagnosticDir?path.join(diagnosticDir,'profile'):path.join(app.getPath('appData'),'Montazhnaya Desktop');fs.mkdirSync(profile,{recursive:true});app.setPath('userData',profile);
let uiLanguage='ru';const nativeText=(ru,en)=>uiLanguage==='en'?en:ru;
let mainWindow,server,audioModule,origin,quitting=false,closing=false;const children=new Set();const spawn=cp.spawn;
cp.spawn=function(...args){const child=spawn.apply(this,args);children.add(child);child.once('close',()=>children.delete(child));return child};
const logFile=path.join(profile,'application.log');function log(message){try{fs.appendFileSync(logFile,new Date().toISOString()+' '+message+'\n')}catch{}}
process.on('uncaughtException',e=>{log(e.stack||e.message);if(!diagnosticDir)dialog.showErrorBox(nativeText('Монтажная — ошибка','Grubaka Video Editor — error'),e.message)});process.on('unhandledRejection',e=>log(e?.stack||String(e)));
function allowed(url){try{const parsed=new URL(url);return parsed.origin===origin}catch{return false}}
const prefs={nodeIntegration:false,contextIsolation:true,sandbox:true,spellcheck:false,backgroundThrottling:false};
function configureWindow(win){win.webContents.on('will-navigate',(event,url)=>{if(!allowed(url))event.preventDefault()});win.webContents.setWindowOpenHandler(({url})=>{if(!allowed(url))return {action:'deny'};return {action:'allow',overrideBrowserWindowOptions:{width:1200,height:850,minWidth:960,minHeight:650,autoHideMenuBar:true,icon:path.join(appRoot,'icon.ico'),webPreferences:prefs}}});win.webContents.on('render-process-gone',(_e,details)=>log('Renderer: '+JSON.stringify(details)));}
function saveWindow(){if(!mainWindow||mainWindow.isDestroyed())return;try{fs.writeFileSync(path.join(profile,'window.json'),JSON.stringify({bounds:mainWindow.getNormalBounds(),maximized:mainWindow.isMaximized()}))}catch{}}
function stop(){audioModule?.stop();for(const child of children)try{child.kill()}catch{}server?.closeAllConnections();server?.close();}
async function quit(){if(quitting)return;quitting=true;saveWindow();await audioModule?.stop();stop();app.quit()}
app.on('before-quit',()=>{quitting=true;stop()});app.on('window-all-closed',quit);
if(!diagnosticDir&&!app.requestSingleInstanceLock()){app.quit()}else{
app.on('second-instance',()=>{if(mainWindow&&!mainWindow.isDestroyed()){if(mainWindow.isMinimized())mainWindow.restore();mainWindow.show();mainWindow.focus()}});
app.on('browser-window-created',(_e,win)=>configureWindow(win));
app.whenReady().then(async()=>{
 try{
 const connectModule=paths=>{process.env.MONTAZHNAYA_PYTHON=paths?.python||'';process.env.MONTAZHNAYA_AUDIO_WEIGHTS=paths?.weights||''};
 audioModule=require('./audio-module.cjs').createAudioModule({directory:path.join(profile,'modules','audio-v1'),manifest:require('./audio-module.json'),legacyRoot:appRoot,onInstalled:connectModule});connectModule(audioModule.paths());
 const port=diagnosticDir?0:18765;server=require('./desktop-server.cjs').createDesktopServer(editorRoot,{audioModule});await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve)});origin='http://localhost:'+server.address().port;
 session.defaultSession.setPermissionRequestHandler((_web,permission,callback)=>callback(permission==='fullscreen'));session.defaultSession.setPermissionCheckHandler((_web,permission)=>permission==='fullscreen');
 session.defaultSession.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(details,callback)=>callback({cancel:!allowed(details.url)}));
 session.defaultSession.on('will-download',(_event,item,webContents)=>{const file=path.basename(item.getFilename()).replace(/[<>:"/\\|?*\x00-\x1f]/g,'_');if(diagnosticDir)item.setSavePath(path.join(diagnosticDir,file));else item.setSaveDialogOptions({title:nativeText('Сохранить файл','Save file'),defaultPath:path.join(app.getPath('downloads'),file)});item.once('done',(_e,state)=>{log('Download '+state+' '+file);if(state==='interrupted'&&!diagnosticDir)dialog.showErrorBox(nativeText('Не удалось сохранить файл','Could not save file'),nativeText('Выберите другую папку и повторите экспорт.','Choose another folder and try exporting again.'))})});
 let saved={};try{saved=JSON.parse(fs.readFileSync(path.join(profile,'window.json'),'utf8'))}catch{}const work=screen.getPrimaryDisplay().workAreaSize,bounds=saved.bounds||{};
 mainWindow=new BrowserWindow({title:'Монтажная',width:Math.min(bounds.width||1600,work.width),height:Math.min(bounds.height||1000,work.height),minWidth:1050,minHeight:650,show:false,autoHideMenuBar:true,backgroundColor:'#151515',icon:path.join(appRoot,'icon.ico'),webPreferences:prefs});
 mainWindow.webContents.on('page-title-updated',()=>{mainWindow.webContents.executeJavaScript('document.documentElement.lang').then(lang=>{uiLanguage=lang==="en"?"en":"ru";updateMenu()}).catch(()=>{})});
 const action=id=>()=>mainWindow?.webContents.executeJavaScript(`document.getElementById(${JSON.stringify(id)})?.click()`,true);
 const updateMenu=()=>Menu.setApplicationMenu(Menu.buildFromTemplate([{label:nativeText('Проект','Project'),submenu:[{label:nativeText('Открыть проект…','Open project…'),click:action('openProjectInput')},{label:nativeText('Сохранить проект…','Save project…'),click:action('saveBtn')},{type:'separator'},{label:nativeText('Выход','Exit'),click:()=>mainWindow.close()}]},{label:nativeText('Вид','View'),submenu:[{role:'togglefullscreen',label:nativeText('Во весь экран','Fullscreen')},{role:'resetZoom',label:nativeText('Исходный масштаб интерфейса','Reset interface zoom')},{role:'zoomIn',label:nativeText('Увеличить интерфейс','Zoom in')},{role:'zoomOut',label:nativeText('Уменьшить интерфейс','Zoom out')}]},{label:nativeText('Справка','Help'),submenu:[{label:nativeText('Инструкция','Guide'),click:()=>{const win=new BrowserWindow({width:1200,height:900,autoHideMenuBar:true,webPreferences:prefs});win.loadURL(origin+'/guide.html')}},{label:nativeText('Папка приложения','Application folder'),click:()=>shell.openPath(path.dirname(process.execPath))}]}]));updateMenu();
 mainWindow.on('close',async event=>{if(quitting||diagnosticDir)return;event.preventDefault();if(closing)return;closing=true;
 if(children.size||audioModule?.busy){const result=await dialog.showMessageBox(mainWindow,{type:'question',title:nativeText('Завершить обработку?','Stop processing?'),message:nativeText('Выполняется обработка файла. Закрыть приложение и остановить её?','A file is being processed. Close the app and stop processing?'),buttons:[nativeText('Продолжить работу','Keep working'),nativeText('Закрыть','Close')],defaultId:0,cancelId:0});if(result.response!==1){closing=false;return}}
 mainWindow.setEnabled(false);let saved=false;try{saved=await mainWindow.webContents.executeJavaScript('window.montazhnayaFlush?.()')}catch(e){log('Save on close: '+e.message)}mainWindow.setEnabled(true);
 if(!saved){const result=await dialog.showMessageBox(mainWindow,{type:'warning',title:nativeText('Не удалось сохранить проект','Could not save project'),message:nativeText('Автосохранение не подтверждено. Можно вернуться и сохранить проект в JSON.','Autosave was not confirmed. You can go back and save the project as JSON.'),buttons:[nativeText('Вернуться','Go back'),nativeText('Закрыть без сохранения','Close without saving')],defaultId:0,cancelId:0});if(result.response!==1){closing=false;return}}await quit()});
 await mainWindow.loadURL(origin+'/');if(diagnosticDir){await diagnostics();return}if(saved.maximized)mainWindow.maximize();mainWindow.show();log('Ready '+origin);
 }catch(e){log(e.stack||e.message);if(diagnosticDir){fs.mkdirSync(diagnosticDir,{recursive:true});fs.writeFileSync(path.join(diagnosticDir,'error.txt'),e.stack||e.message);app.exit(1)}else{dialog.showErrorBox('Монтажная не запустилась',e.code==='EADDRINUSE'?'Порт приложения 18765 занят другой программой. Закройте её и запустите Монтажную снова.':e.message);app.exit(1)}}
});}
async function diagnostics(){
 fs.mkdirSync(diagnosticDir,{recursive:true});const report={electron:process.versions.electron,node:process.versions.node,origin,profile,rendererErrors:[]};mainWindow.webContents.on('console-message',details=>{if(details.level==='error')report.rendererErrors.push(details.message)});
 const pages=['/','/guide.html','/converter.html','/slow-motion.html'];for(const route of pages){const r=await fetch(origin+route);if(!r.ok)throw Error('Page unavailable '+route)}
 report.converter=await(await fetch(origin+'/api/converter/info')).json();delete report.converter.token;report.audio=await(await fetch(origin+'/api/audio-separator/info')).json();delete report.audio.token;
 const fixtureArg=process.argv.find(value=>value.startsWith('--fixture='));if(fixtureArg){report.processing=await processingDiagnostics(path.resolve(fixtureArg.slice(10)))}
 report.languages=await mainWindow.webContents.executeJavaScript(`(async()=>{try{
 const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
 const choose=code=>document.querySelector('[data-ui-language="'+code+'"]').click();
 const before={name:document.getElementById('projectName').value,duration:document.getElementById('durationTime').textContent};
 choose('en');await tick();const english=document.getElementById('exportBtn').textContent.includes('Export')&&document.documentElement.lang==='en';
 choose('ru');await tick();const russian=document.getElementById('exportBtn').textContent.includes('Экспорт')&&document.documentElement.lang==='ru';
 choose('en');await tick();const preserved=before.name===document.getElementById('projectName').value&&before.duration===document.getElementById('durationTime').textContent;
 return {english,russian,preserved,saved:localStorage.getItem('grubaka.editor.language')==='en'};
 }catch(error){return {error:error.stack,loaded:!!window.editorI18n,buttons:document.querySelectorAll('[data-ui-language]').length}}})()`);
 fs.writeFileSync(path.join(diagnosticDir,'language-check.json'),JSON.stringify(report.languages,null,2));
 if(report.languages.error||Object.values(report.languages).some(value=>!value))throw Error('Language switch check failed');
 report.flush=await mainWindow.webContents.executeJavaScript('window.montazhnayaFlush()');
 report.window=await mainWindow.webContents.executeJavaScript(`({title:document.title,canvas:!!document.getElementById('preview'),mediaInput:!!document.getElementById('mediaInput'),videoTools:document.querySelectorAll('.video-tool').length,nodeIntegration:typeof require!=='undefined',indexedDB:typeof indexedDB!=='undefined',webm:MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus'),mp4:MediaRecorder.isTypeSupported('video/mp4'),webgl:!!document.createElement('canvas').getContext('webgl')})`);
 const image=await mainWindow.webContents.capturePage();fs.writeFileSync(path.join(diagnosticDir,'application.png'),image.toPNG());fs.writeFileSync(path.join(diagnosticDir,'report.json'),JSON.stringify(report,null,2));if(!report.converter.ready||!(report.audio.ready||report.audio.installable)||!report.window.canvas||report.window.nodeIntegration)throw Error('Diagnostic check failed');await quit();
}

async function processingDiagnostics(fixture){
 const converter=await(await fetch(origin+'/api/converter/info')).json(),audio=await(await fetch(origin+'/api/audio-separator/info')).json();
 async function request(route,token,options={}){const r=await fetch(origin+route,{...options,headers:{...options.headers,...token}});if(!r.ok)throw Error(await r.text());return r}
 async function wait(route,headers){const deadline=Date.now()+600000;while(Date.now()<deadline){const state=await(await request(route,headers)).json();fs.writeFileSync(path.join(diagnosticDir,'processing-status.json'),JSON.stringify({route,...state}));if(state.status==='done')return state;if(state.status==='error')throw Error(state.error);await new Promise(resolve=>setTimeout(resolve,500))}throw Error('Processing timeout')}
 const ch={'X-Converter-Token':converter.token};const job=await(await request('/api/converter/upload?name=desktop-test.mp4',ch,{method:'POST',body:fs.readFileSync(fixture)})).json();
 await request('/api/converter/'+job.id+'/start',ch,{method:'POST',body:JSON.stringify({format:'h264',quality:'low',resolution:'original'})});await wait('/api/converter/'+job.id,ch);let result=await request('/api/converter/'+job.id+'/download?token='+converter.token,ch);fs.writeFileSync(path.join(diagnosticDir,'converted.mp4'),Buffer.from(await result.arrayBuffer()));
 await request('/api/converter/'+job.id+'/start',ch,{method:'POST',body:JSON.stringify({mode:'slowmotion',factor:2,scope:'whole',ease:false,interpolation:'flow',sound:'natural',fps:24,resolution:'original',format:'h264'})});await wait('/api/converter/'+job.id,ch);result=await request('/api/converter/'+job.id+'/download?token='+converter.token,ch);fs.writeFileSync(path.join(diagnosticDir,'slowmotion.mp4'),Buffer.from(await result.arrayBuffer()));await request('/api/converter/'+job.id,ch,{method:'DELETE'});
 if(!audio.ready)return {conversion:true,slowMotion:true,audioModuleOptional:!!audio.installable};
 const ah={'X-Audio-Token':audio.token},a=await(await request('/api/audio-separator/jobs?start=0&length=1',ah,{method:'POST',body:fs.readFileSync(fixture)})).json();await wait('/api/audio-separator/jobs/'+a.id,ah);for(const stem of ['speech','effects','music']){const response=await request('/api/audio-separator/jobs/'+a.id+'/'+stem,ah);fs.writeFileSync(path.join(diagnosticDir,stem+'.wav'),Buffer.from(await response.arrayBuffer()))}await request('/api/audio-separator/jobs/'+a.id,ah,{method:'DELETE'});
 return {conversion:true,slowMotion:true,separatedStems:['speech','effects','music']};
}
