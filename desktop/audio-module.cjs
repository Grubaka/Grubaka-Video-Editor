'use strict';
const fs=require('node:fs'),fsp=fs.promises,path=require('node:path'),crypto=require('node:crypto'),{spawn}=require('node:child_process');
function createAudioModule({directory,manifest,legacyRoot,onInstalled=()=>{},fetchImpl=fetch}){
  const root=path.resolve(directory),parent=path.dirname(root),token=crypto.randomBytes(24).toString('hex');
  let operation,controller,extractor,state={status:'available',received:0,total:manifest.bytes,error:null};
  function pathsAt(base){const python=path.join(base,'runtime','python','python.exe'),weights=path.join(base,'audio-models');return fs.existsSync(python)&&fs.existsSync(path.join(weights,'checkpoint-multi.ckpt'))?{python,weights}:null}
  function paths(){try{const marker=JSON.parse(fs.readFileSync(path.join(root,'installed.json'),'utf8'));if(marker.sha256===manifest.sha256&&marker.version===manifest.version)return pathsAt(root)}catch{}return legacyRoot?pathsAt(legacyRoot):null}
  function snapshot(){return {...state,status:paths()?'installed':state.status,version:manifest.version,bytes:manifest.bytes}}
  function send(res,code,value){res.writeHead(code,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(value))}
  async function install(){
    if(paths())return;if(operation)return operation;
    if(!/^https:\/\/github\.com\/Grubaka\/Grubaka-Video-Editor\/releases\/download\//.test(manifest.url)||!/^[a-f0-9]{64}$/.test(manifest.sha256)||!(manifest.bytes>0&&manifest.bytes<2*1024**3))throw Error('Invalid audio module manifest');
    controller=new AbortController();state={status:'downloading',received:0,total:manifest.bytes,error:null};
    operation=(async()=>{
      const id=crypto.randomUUID(),archive=path.join(parent,'.audio-'+id+'.zip'),staging=path.join(parent,'.audio-'+id),backup=path.join(parent,'.audio-old-'+id);
      try{
        await fsp.mkdir(parent,{recursive:true});
        const response=await fetchImpl(manifest.url,{signal:controller.signal,redirect:'follow'});if(!response.ok)throw Error('Download failed: HTTP '+response.status);
        const hash=crypto.createHash('sha256'),file=await fsp.open(archive,'wx');
        try{for await(const chunk of response.body){if(controller.signal.aborted)throw Error('Cancelled');state.received+=chunk.length;if(state.received>manifest.bytes)throw Error('Module download exceeds expected size');hash.update(chunk);await file.writeFile(chunk)}}finally{await file.close()}
        if(state.received!==manifest.bytes||hash.digest('hex')!==manifest.sha256)throw Error('Audio module integrity check failed');
        if(controller.signal.aborted)throw Error('Cancelled');state.status='extracting';await fsp.mkdir(staging);
        const psQuote=value=>"'"+String(value).replace(/'/g,"''")+"'";
        const script=`$moduleZip=${psQuote(archive)};$moduleDest=${psQuote(staging)};$moduleLimit=${Number(manifest.expandedBytes)+16*1024**2};$ErrorActionPreference='Stop';Add-Type -AssemblyName System.IO.Compression.FileSystem;$zip=[IO.Compression.ZipFile]::OpenRead($moduleZip);try{$root=[IO.Path]::GetFullPath($moduleDest)+[IO.Path]::DirectorySeparatorChar;[long]$total=0;if($zip.Entries.Count -gt 20000){throw 'Too many module files'};foreach($entry in $zip.Entries){$full=[IO.Path]::GetFullPath([IO.Path]::Combine($root,$entry.FullName));if(-not $full.StartsWith($root,[StringComparison]::OrdinalIgnoreCase)){throw 'Invalid archive path'};if((($entry.ExternalAttributes -shr 16) -band 61440) -eq 40960){throw 'Archive links are not allowed'};$total+=$entry.Length;if($total -gt [long]$moduleLimit){throw 'Module exceeds extraction limit'}}}finally{$zip.Dispose()};[IO.Compression.ZipFile]::ExtractToDirectory($moduleZip,$moduleDest)`;
        await new Promise((resolve,reject)=>{extractor=spawn(path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe'),['-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,stdio:['ignore','ignore','pipe'],env:{...process.env,GRUBAKA_MODULE_ZIP:archive,GRUBAKA_MODULE_DEST:staging,GRUBAKA_MODULE_LIMIT:String(manifest.expandedBytes+16*1024**2)}});let error='';extractor.stderr.on('data',chunk=>error=(error+chunk).slice(-1500));extractor.once('error',reject);extractor.once('close',code=>{extractor=null;code===0?resolve():reject(Error(error||'Module extraction failed'))})});
        if(controller.signal.aborted)throw Error('Cancelled');if(!pathsAt(staging))throw Error('Audio module is incomplete');
        state.status='installing';await fsp.writeFile(path.join(staging,'installed.json'),JSON.stringify({version:manifest.version,sha256:manifest.sha256}));
        let moved=false;try{if(fs.existsSync(root)){await fsp.rename(root,backup);moved=true}await fsp.rename(staging,root)}catch(error){if(moved&&!fs.existsSync(root))await fsp.rename(backup,root);throw error}
        await fsp.rm(backup,{recursive:true,force:true});state.status='installed';onInstalled(paths());
      }catch(error){state.status=controller.signal.aborted?'cancelled':'error';state.error=controller.signal.aborted?null:error.message}
      finally{await fsp.rm(archive,{force:true}).catch(()=>{});await fsp.rm(staging,{recursive:true,force:true}).catch(()=>{});operation=null;controller=null}
    })();return operation;
  }
  async function handle(req,res,url){
    if(!url.pathname.startsWith('/api/audio-module/'))return false;
    const host=req.headers.host||'';if(!/^(localhost|127\.0\.0\.1):\d+$/.test(host)||req.headers.origin&&req.headers.origin!==`http://${host}`){send(res,403,{error:'Invalid request origin'});return true}
    if(url.pathname==='/api/audio-module/info'&&req.method==='GET'){send(res,200,{...snapshot(),token});return true}
    if(req.headers['x-audio-module-token']!==token){send(res,403,{error:'Reload the editor'});return true}
    if(url.pathname==='/api/audio-module/install'&&req.method==='POST'){req.resume();install().catch(error=>{state.status='error';state.error=error.message});send(res,202,snapshot());return true}
    if(url.pathname==='/api/audio-module/cancel'&&req.method==='POST'){req.resume();controller?.abort();extractor?.kill();send(res,200,snapshot());return true}
    send(res,404,{error:'Unknown module operation'});return true;
  }
  return {paths,snapshot,handle,install,stop(){controller?.abort();extractor?.kill();return operation?.catch(()=>{})||Promise.resolve()},get busy(){return !!operation}};
}
module.exports={createAudioModule};
