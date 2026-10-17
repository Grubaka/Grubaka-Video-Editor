(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const canvas = $('preview');
  const ctx = canvas.getContext('2d', {alpha:false});
  const assets = new Map();
  const elements = new Map();
  const undoStack = [], redoStack = [];
  const uid = () => globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, Number.isFinite(v) ? v : a));
  const escapeHtml = s => String(s ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
  const defaultTrack = (type, n) => ({id:uid(),type,label:`${type==='video'?'V':type==='text'?'T':'S'}${n}`,locked:false,hidden:false,muted:false,solo:false,items:[]});
  const overlayKind = item => ['title','subtitle','shape','countdown'].includes(item.kind);
  const clipTrackType = item => item.kind==='compound'?item.trackType:item.kind==='audio'?'audio':overlayKind(item)?'text':'video';
  function groupTracks(){
    if(project.trackLayoutVersion===1)return;
    const number=track=>Number(track.label.match(/\d+$/)?.[0])||0;
    project.tracks.sort((a,b)=>a.type==='text'?(b.type==='text'?0:-1):b.type==='text'?1:number(b)-number(a)||(a.type==='audio'?-1:1));
    project.trackLayoutVersion=1;
  }
  function insertTrackAtTop(track){const index=tracks().findIndex(t=>t.type!=='text');tracks().splice(index<0?tracks().length:index,0,track)}
  function placeSoundAboveVideo(sound,video){const previous=tracks().indexOf(sound);if(previous>=0)tracks().splice(previous,1);tracks().splice(Math.max(0,tracks().indexOf(video)),0,sound)}
  function moveTrack(id,direction){if(exporting)return;const index=tracks().findIndex(t=>t.id===id),next=index+direction;if(index<0||next<0||next>=tracks().length)return;mutate(()=>{const [track]=tracks().splice(index,1);tracks().splice(next,0,track);project.trackLayoutVersion=1})}

  function nextTrackNumber(type){return Math.max(0,...tracks().filter(t=>t.type===type).map(t=>Number(t.label.match(/\d+$/)?.[0])||0))+1}
  const freshProject = () => ({version:2,name:'Новый проект',ratio:'16:9',resolution:720,frameWidth:1280,frameHeight:720,frameInitialized:false,fps:30,bg:'#000000',bgMode:'color',trackLayoutVersion:1,tracks:[defaultTrack('audio',1),defaultTrack('video',1)],markers:[],inPoint:null,outPoint:null,assetManifest:[],hiddenMediaIds:[],mediaLibraryVersion:1});
  let project = freshProject();
  let projectEpoch=0,persistQueue=Promise.resolve();
  let showHiddenMedia = false;
  let mediaFilter = 'all';
  let markerAnchorId=null,markerRangeEndId=null;
  let selected = null, tab = 'media', playhead = 0, playing = false, exporting = false;
  let zoom = 80, snap = true, ripple = false, previewMuted = false, lastTick = 0, raf = 0, toastTimer, saveTimer;
  let audioContext, audioDestination, audioClock, recorder, exportMime, exportChunks = [], discardExport = false;

  const tracks = () => project.tracks;
  const allItems = () => tracks().flatMap(track => track.items.map(item => ({track,item})));
  const findItem = id => {for(const track of tracks()){const item=track.items.find(x=>x.id===id);if(item)return {track,item}}return null};
  const findTrack = id => tracks().find(t=>t.id===id);
  const duration = () => Math.max(0,...allItems().map(({item})=>item.start+item.duration));
  const activeAt = (item,t) => t>=Math.max(item.start,item._activeStart??-Infinity) && t<Math.min(item.start+item.duration,item._activeEnd??Infinity);
  function transitionTail(track,item,t){if(track.type==='audio')return null;const end=item.start+item.duration,next=playbackItems().filter(entry=>entry.track.id===track.id).map(entry=>entry.item).find(x=>x.id!==item.id&&Math.abs(x.start-end)<.03&&x.transitionIn&&x.transitionIn!=='none'&&transitionSeconds(x)>0);if(!next||t<next.start||t>=next.start+transitionSeconds(next))return null;return {next,offset:t-next.start,fade:Math.min(transitionSeconds(next),item.duration)}}
  const number = v => Number(v)||0;
  const ratioParts = () => project.ratio==='custom'?[project.frameWidth||1280,project.frameHeight||720]:(project.ratio||'16:9').split(':').map(Number);
  function timecode(t){return formatClipTime(t)}
  function toast(message){const el=$('toast');el.textContent=message;el.classList.add('show');clearTimeout(toastTimer);toastTimer=setTimeout(()=>el.classList.remove('show'),4000)}
  function status(message){$('statusText').textContent=message}
  function queueSave(){clearTimeout(saveTimer);saveTimer=setTimeout(persist,600)}
  const HISTORY_LIMIT=100;
  function updateHistoryButtons(){for(const [id,count,label,key] of [['undoBtn',undoStack.length,'Отменить','Ctrl+Z'],['redoBtn',redoStack.length,'Повторить','Ctrl+Y / Ctrl+Shift+Z']]){const button=$(id);if(!button)continue;button.disabled=count===0||exporting;button.title=`${label} (${key}) · доступно шагов: ${count} / ${HISTORY_LIMIT}`;button.setAttribute('aria-label',button.title)}}
  function recordChange(before){undoStack.push(before);if(undoStack.length>HISTORY_LIMIT)undoStack.shift();redoStack.length=0;updateHistoryButtons()}
  function mutate(fn){const before=JSON.stringify(project);fn();if(JSON.stringify(project)!==before){recordChange(before);refresh();queueSave()}}
  function undo(){if(exporting||!undoStack.length)return;pause();redoStack.push(JSON.stringify(project));project=JSON.parse(undoStack.pop());selected=null;rebuildElements();refresh();queueSave()}
  function redo(){if(exporting||!redoStack.length)return;pause();undoStack.push(JSON.stringify(project));project=JSON.parse(redoStack.pop());selected=null;rebuildElements();refresh();queueSave()}
  function selectedItemIds(){return selected?.kind==='items'?selected.ids:selected?.kind==='item'?[selected.id]:[]}
  function selectedEntries(){return selectedItemIds().map(findItem).filter(Boolean)}
  function mergeReason(){const entries=selectedEntries();if(entries.length<2)return 'Выделите минимум две ячейки с Shift';if(entries.some(e=>e.track.locked))return 'Разблокируйте дорожку';if(entries.some(e=>e.track.id!==entries[0].track.id))return 'Выберите ячейки одной дорожки';return ''}
  function updateMergeButton(){updateUnmergeButton();const button=$('mergeBtn');if(!button)return;const reason=mergeReason();button.disabled=!!reason||exporting;button.title=reason||'Объединить выбранные ячейки в одну';button.setAttribute('aria-label',button.title)}
  function leafItems(){const result=[];function visit(track,item){if(item.kind==='compound')for(const child of item.parts||[])visit(track,child);else result.push({track,item})}for(const track of tracks())for(const item of track.items)visit(track,item);return result}
  function playbackItems(){
    const result=[];
    function visit(track,item,offset=0,prefix='',maskStart=-Infinity,maskEnd=Infinity,rootId=null,groups=[]){
      const start=offset+item.start;
      if(item.kind==='compound'){
        const nextStart=Math.max(maskStart,start),nextEnd=Math.min(maskEnd,start+item.duration);
        for(const child of item.parts||[])visit(track,child,start-(item.sourceIn||0),`${prefix}${item.id}/`,nextStart,nextEnd,rootId||item.id,[...groups,{item,start}]);
      }else{
        const copy=prefix?{...item,id:`${prefix}${item.id}`,start,_activeStart:maskStart,_activeEnd:maskEnd,_compoundRoot:rootId}:item;
        if(groups.length){copy._groupFades=[...(item._groupFades||[]),...groups.filter(g=>g.item.fadeIn>0||g.item.fadeOut>0).map(g=>({offset:g.start-start,duration:g.item.duration,fadeIn:g.item.fadeIn||0,fadeOut:g.item.fadeOut||0}))];
          for(const g of [...groups].reverse())if(g.item.keyframes){copy.keyframes={...copy.keyframes};for(const [key,frames] of Object.entries(g.item.keyframes))if(frames.length)copy.keyframes[key]=frames.map(f=>({...f,time:(item.sourceIn||0)+(g.start+f.time-(g.item.sourceIn||0)-start)*(item.speed||1)}))}
        }
        result.push({track,item:copy});
      }
    }
    for(const track of tracks())for(const item of track.items)visit(track,item);return result;
  }
  function groupFadeGain(item,time=playhead){let gain=1;for(const group of item._groupFades||[]){const local=time-item.start-group.offset;if(group.fadeIn>0)gain*=clamp(local/group.fadeIn,0,1);if(group.fadeOut>0)gain*=clamp((group.duration-local)/group.fadeOut,0,1)}return gain}
  function compoundInspectorItem(item,track){
    const shared=new Set(['id','start','duration','sourceIn','contentDuration','name','linkId','parts','trackType','fadeIn','fadeOut','keyframes']);
    const leaves=[];const visit=part=>part.kind==='compound'?(part.parts||[]).forEach(visit):leaves.push(part);item.parts.forEach(visit);
    return new Proxy(item,{get(target,key){if(key==='_compound')return target;if(key==='kind')return track.type==='audio'?'audio':track.type==='text'?'title':'video';if(key==='speed')return target.controlSpeed||1;if(key==='assetId')return undefined;return target[key]??(!shared.has(key)?leaves[0]?.[key]:undefined)},set(target,key,value){target[key]=value;if(!shared.has(key)&&key!=='controlSpeed')for(const leaf of leaves)leaf[key]=typeof value==='object'&&value!==null?JSON.parse(JSON.stringify(value)):value;return true}});
  }
  function setCompoundSpeed(item,value){
    const next=clamp(value,.25,4),ratio=next/(item.controlSpeed||1);
    function scale(part,root=false){if(!root)part.start/=ratio;part.duration/=ratio;part.fadeIn=(part.fadeIn||0)/ratio;part.fadeOut=(part.fadeOut||0)/ratio;if(part.kind==='compound'){part.contentDuration/=ratio;part.sourceIn=(part.sourceIn||0)/ratio;for(const frames of Object.values(part.keyframes||{}))for(const frame of frames)frame.time/=ratio;part.parts.forEach(child=>scale(child))}else{part.speed=(part.speed||1)*ratio;if(part.transitionDuration!=null)part.transitionDuration/=ratio;for(const group of part._groupFades||[]){group.offset/=ratio;group.duration/=ratio;group.fadeIn/=ratio;group.fadeOut/=ratio}}}
    scale(item,true);item.controlSpeed=next;
  }
  function visiblePlaybackItems(){return playbackItems().map(({track,item})=>{const start=Math.max(item.start,item._activeStart??item.start),end=Math.min(item.start+item.duration,item._activeEnd??Infinity);return {track,item:{...item,start,duration:end-start}}}).filter(({item})=>item.duration>0)}
  function mergeSelected(){
    const reason=mergeReason();if(reason)return toast(reason);pause();closeClipMenu();const entries=selectedEntries().sort((a,b)=>a.item.start-b.item.start),track=entries[0].track,start=Math.min(...entries.map(e=>e.item.start)),end=Math.max(...entries.map(e=>e.item.start+e.item.duration));let compound;
    mutate(()=>{const ids=new Set(entries.map(e=>e.item.id));compound={id:uid(),kind:'compound',trackType:track.type,name:`Объединено: ${entries.length} клипа`,start,duration:end-start,contentDuration:end-start,sourceIn:0,parts:entries.map(({item})=>({...JSON.parse(JSON.stringify(item)),start:item.start-start}))};track.items=track.items.filter(i=>!ids.has(i.id));track.items.push(compound);preserveMergedLinks(entries,compound);selected={kind:'item',id:compound.id}});
    selectItem(compound.id);toast(`Объединено ячеек: ${entries.length}. Ctrl+Z — отменить.`);
  }
  function unmergeClip(id){
    const found=findItem(id);if(!found||found.item.kind!=='compound'||found.track.locked)return;pause();
    const entries=playbackItems().filter(e=>e.item._compoundRoot===id);const restored=[];
    for(const {item} of entries){const start=Math.max(item.start,item._activeStart),end=Math.min(item.start+item.duration,item._activeEnd);if(end<=start)continue;const copy={...item,id:uid(),start,duration:end-start,sourceIn:(item.sourceIn||0)+(start-item.start)*(item.speed||1)};copy.fadeIn=Math.max(0,(item.fadeIn||0)-(start-item.start));copy.fadeOut=Math.max(0,(item.fadeOut||0)-(item.start+item.duration-end));if(copy._groupFades)copy._groupFades=copy._groupFades.map(g=>({...g,offset:g.offset-(start-item.start)}));delete copy._activeStart;delete copy._activeEnd;delete copy._compoundRoot;if(linkedEntries(found.item).length>1)copy.linkId=found.item.linkId;restored.push(copy)}
    mutate(()=>{found.track.items=found.track.items.filter(i=>i.id!==id);found.track.items.push(...restored);selected=null});toast('Объединённая ячейка разделена на исходные клипы');
  }
  function appendUnlinkPropertyButton(root){
    const groups=unlinkGroups();if(!groups.size)return false;
    const button=document.createElement('button');button.type='button';button.className='sidebar-action property-unlink';button.append(trackIcon('unlink'),document.createTextNode('Разъединить'));
    button.title='Снять связь видео и звука, чтобы перемещать их отдельно';button.setAttribute('aria-label','Разъединить видео и звук');button.disabled=exporting||allItems().some(entry=>groups.has(entry.item.linkId)&&entry.track.locked);button.onclick=unlinkSelected;const controls=root.querySelector('.clip-controls');if(controls)root.insertBefore(button,controls);else root.append(button);return true;
  }
  function renderMultipleInspector(root){
    const entries=selectedEntries();const primary=entries.find(e=>e.item.id===selected?.primaryId)||entries[0];if(primary&&primary.item.linkId&&entries.every(e=>e.item.linkId===primary.item.linkId)&&entries.some(e=>e.item.kind==='countdown')){if(primary.item.kind==='countdown'){renderCountdownInspector(root,primary);renderTextTransitionControls(root,primary.item,primary.track)}else renderMediaInspector(root,primary);renderKeyframes(root,primary.item);return}if(primary&&entries.some(e=>e.item.kind==='compound')&&primary.item.linkId&&entries.every(e=>e.item.linkId===primary.item.linkId)){if(primary.item.kind==='compound')renderCompoundInspector(root,primary);else if(['audio','video','image'].includes(primary.item.kind))renderMediaInspector(root,primary);else renderItemInspector(root,primary);renderKeyframes(root,primary.item);return}if(primary&&['audio','video','image'].includes(primary.item.kind)&&primary.item.linkId&&entries.every(e=>e.item.linkId===primary.item.linkId)){renderMediaInspector(root,primary);renderKeyframes(root,primary.item);return}inspectorHeading(root,`Выделено ячеек: ${entries.length}`);const hasLinks=appendUnlinkPropertyButton(root);
    const note=document.createElement('p');note.className='note';note.textContent=hasLinks?'Видео и звук связаны и двигаются вместе. «Разъединить» снимает связь и позволяет перемещать их отдельно.':'Shift + клик добавляет ячейку к выделению или убирает её. Перетащите любую выбранную ячейку — остальные будут двигаться вместе, включая V и S. Для объединения выберите клипы одной дорожки.';root.append(note);
    const list=document.createElement('div');list.className='selected-clip-list';for(const {track,item} of entries){const row=document.createElement('div');row.textContent=`${track.label} · ${item.name||assets.get(item.assetId)?.name||item.text||'Клип'}`;list.append(row)}root.append(list);
    if(hasLinks&&mergeReason())return;
    const merge=document.createElement('button');merge.className='accent-btn merge-selection';merge.textContent='Объединить в одну ячейку';merge.disabled=!!mergeReason();merge.onclick=mergeSelected;root.append(merge);
    if(mergeReason()){const hint=document.createElement('p');hint.className='note';hint.textContent=mergeReason();root.append(hint)}
  }
  function renderCompoundInspector(root,found){
    const {track,item}=found;
    if(track.type==='audio'||track.type==='video'){
      renderMediaInspector(root,{track,item:compoundInspectorItem(item,track)});
      const note=root.querySelector('.clip-track-note');note.textContent+=` · Объединено: ${item.parts.length} клипа. Настройки применяются ко всему содержимому.`;
      return;
    }
    renderTextInspector(root,{track,item:compoundInspectorItem(item,track)});
  }
  function updateUnmergeButton(){const button=$('unmergeBtn');if(!button)return;const entries=selectedEntries().filter(e=>e.item.kind==='compound');button.disabled=exporting||entries.length!==1||entries.some(e=>e.track.locked);button.classList.toggle('active',!button.disabled);button.title=entries.length?'Разъединить объединённую ячейку на исходные клипы':'Разъединить: выберите объединённую ячейку';}
  function bindUnmergeButton(){const button=document.createElement('button');button.id='unmergeBtn';button.type='button';button.setAttribute('aria-label','Разъединить объединённую ячейку');button.append(trackIcon('unmerge'));button.onclick=()=>{const entries=selectedEntries().filter(e=>e.item.kind==='compound');if(entries.length!==1)return toast('Выберите одну объединённую ячейку');unmergeClip(entries[0].item.id)};const tools=document.querySelector('.editing-tools');tools.insertBefore(button,$('splitBtn').nextSibling);updateUnmergeButton()}
  function bindMergeButton(){const button=document.createElement('button');button.id='mergeBtn';button.type='button';button.append(trackIcon('layers'));const label=document.createElement('span');label.textContent='Объединить';button.append(label);button.onclick=mergeSelected;document.querySelector('.editing-tools').insertBefore(button,$('splitBtn'));updateMergeButton()}

  function selectItem(id,extend=false){
    if(extend){const ids=new Set(selectedItemIds());ids.has(id)?ids.delete(id):ids.add(id);const values=[...ids];selected=values.length>1?{kind:'items',ids:values}:values.length?{kind:'item',id:values[0]}:null}
    else selected=id?{kind:'item',id}:null;
    renderTimeline();renderInspector();draw();
  }
  function selectTrack(id){selected={kind:'track',id};renderTimeline();renderInspector();draw()}
  function removeTrack(id){
    const track=findTrack(id);if(!track)return;
    closeClipMenu();
    mutate(()=>{project.tracks=tracks().filter(t=>t.id!==id);selected=null;playhead=Math.min(playhead,duration())});
    toast(`Дорожка ${track.label} удалена. Ctrl+Z — отменить.`);
  }
  function trackIcon(name){
    const paths={
      slowmotion:'<circle cx="12" cy="13" r="8"/><path d="M12 8v5l3 2M9 2h6m-3 0v3M4 5l2 2"/>',
      crop:'<path d="M6 2v15a1 1 0 0 0 1 1h15M2 6h15a1 1 0 0 1 1 1v15M9 6h5m4 3v5"/>',
      chroma:'<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m6 17 4-4 3 3m-2-7 3-3 4 4-3 3-4-4Zm3 0-3 3"/>',
      unmerge:'<rect x="2" y="5" width="7" height="14" rx="1"/><rect x="15" y="5" width="7" height="14" rx="1"/><path d="M12 3v3m0 3v3m0 3v3m0 3v1"/>',
      previousMarker:'<path d="m6 8-4 4 4 4M10 4h10v16l-5-4-5 4V4Z"/>',
      nextMarker:'<path d="m18 8 4 4-4 4M4 4h10v16l-5-4-5 4V4Z"/>',
      link:'<path d="m10 13 4-4M8 16l-2 2a4 4 0 0 1-6-6l5-5a4 4 0 0 1 6 0m2 1 2-2a4 4 0 0 1 6 6l-5 5a4 4 0 0 1-6 0"/>',
      unlink:'<path d="m3 3 18 18M8 16l-2 2a4 4 0 0 1-6-6l3-3m10-1 2-2a4 4 0 0 1 6 6l-3 3M9 1v3M1 9h3m11 8v4m2-6h4"/>',
      play:'<path d="m8 4 12 8-12 8V4Z"/>',
      pause:'<path d="M8 5v14M16 5v14"/>',
      start:'<path d="M5 5v14m14-14L8 12l11 7V5Z"/>',
      end:'<path d="M19 5v14M5 5l11 7-11 7V5Z"/>',
      previous:'<path d="M7 5v14m12-14-7 7 7 7"/>',
      next:'<path d="M17 5v14M5 5l7 7-7 7"/>',
      camera:'<path d="M3 7h4l2-3h6l2 3h4v13H3V7Z"/><circle cx="12" cy="13" r="4"/>',
      fullscreen:'<path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/>',
      fit:'<path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5M8 12h8m-8 0 3-3m-3 3 3 3m5-3-3-3m3 3-3 3"/>',
      scissors:'<circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="m8.1 8.1 12 12M8.1 15.9 20 4M14 12l-3-3"/>',
      trash:'<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7"/>',
      rippleDelete:'<path d="M4 6h16M4 10h12M4 14h7m6-1-4 4 4 4m-4-4h8"/>',
      paintbrush:'<path d="m14 3 7 7-8 8-7-7 8-8ZM6 11l-3 3v7h7l3-3M3 18h5v3"/>',
      clipboard:'<rect x="5" y="5" width="14" height="16" rx="2"/><rect x="9" y="2" width="6" height="6" rx="1"/>',
      insertTrack:'<path d="M3 13h18v7H3v-7ZM12 3v7m-3-3 3 3 3-3M7 13v7M17 13v7"/>',
      layers:'<path d="m12 3 10 5-10 5L2 8l10-5Zm-10 9 10 5 10-5M2 16l10 5 10-5"/>',
      magnet:'<path d="m4 13 4 4a5.7 5.7 0 0 0 8-8l-4-4-3 3 4 4a1.5 1.5 0 0 1-2 2l-4-4-3 3Zm2-2 3 3m5-7 3 3"/>',
      bookmark:'<path d="M6 3h12v18l-6-4-6 4V3Z"/>',
      in:'<path d="M5 4v16m14-15-7 7 7 7"/>',
      out:'<path d="M19 4v16M5 5l7 7-7 7"/>',
      undo:'<path d="m9 4-6 6 6 6M3 10h11a6 6 0 0 1 0 12"/>',
      redo:'<path d="m15 4 6 6-6 6m6-6H10a6 6 0 0 0 0 12"/>',
      new:'<path d="M14 2H5v20h14V7l-5-5Zm0 0v5h5M8 14h8m-4-4v8"/>',
      folder:'<path d="M3 8V4h6l3 3h9v4M2 20l3-9h17l-3 9H2Z"/>',
      save:'<path d="M3 3h15l3 3v15H3V3Zm4 0v6h10V3M7 21v-8h10v8"/>',
      keyboard:'<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M6 9h.01M10 9h.01M14 9h.01M18 9h.01M6 12h.01M10 12h.01M14 12h.01M18 12h.01M7 16h10"/>',
      download:'<path d="M12 3v12m-5-5 5 5 5-5M4 17v4h16v-4"/>',
      minus:'<path d="M5 12h14"/>',
      clapper:'<path d="M3 9h18v12H3V9Zm0 0L2 4l18-3 1 5-18 3Zm3-6 3 5m3-6 3 5"/>',
      image:'<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8" cy="8" r="2"/><path d="m3 18 6-6 4 4 3-4 5 6"/>',
      subtitle:'<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M5 11h5m4 0h5M5 15h8m3 0h3"/>',
      text:'<path d="M4 5h16M12 5v15M8 20h8"/>',
      video:'<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M7 3v18M17 3v18M3 8h4M3 16h4M17 8h4M17 16h4"/>',
      audio:'<path d="M3 10v4M7 6v12M11 3v18M15 7v10M19 5v14M23 10v4"/>',
      plus:'<path d="M12 5v14M5 12h14"/>',
      close:'<path d="m6 6 12 12M18 6 6 18"/>',
      lock:'<rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
      unlock:'<rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 7.5-2"/>',
      eye:'<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
      eyeOff:'<path d="m3 3 18 18M9.9 5.2A11 11 0 0 1 12 5c6.5 0 10 7 10 7a18 18 0 0 1-3 3.8M6 6.6A20 20 0 0 0 2 12s3.5 7 10 7a12 12 0 0 0 5.4-1.3M10 10a3 3 0 0 0 4 4"/>',
      volume:'<path d="m11 5-6 4H2v6h3l6 4V5ZM15 8a6 6 0 0 1 0 8M18 5a10 10 0 0 1 0 14"/>',
      muted:'<path d="m11 5-6 4H2v6h3l6 4V5ZM16 9l6 6M22 9l-6 6"/>',
      headphones:'<path d="M4 14v-3a8 8 0 0 1 16 0v3"/><rect x="3" y="12" width="5" height="9" rx="2"/><rect x="16" y="12" width="5" height="9" rx="2"/>'
    };
    const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('viewBox','0 0 24 24');svg.setAttribute('fill','none');svg.setAttribute('stroke','currentColor');svg.setAttribute('stroke-width','1.7');svg.setAttribute('stroke-linecap','round');svg.setAttribute('stroke-linejoin','round');svg.setAttribute('aria-hidden','true');svg.innerHTML=paths[name]||paths.video;return svg;
  }
  function renderTrackHeader(track){
    const header=document.createElement('div');header.className='track-head'+(selected?.kind==='track'&&selected.id===track.id?' active':'');header.dataset.trackId=track.id;header.dataset.type=track.type;header.onclick=()=>selectTrack(track.id);
    const row=document.createElement('div');row.className='track-title-row';
    const name=document.createElement('div');name.className='track-name';const label=document.createElement('span');label.textContent=track.label;name.append(trackIcon(track.type),label);
    const remove=document.createElement('button');remove.type='button';remove.className='track-remove';remove.dataset.action='remove';remove.title=`Удалить дорожку ${track.label}`;remove.setAttribute('aria-label',remove.title);remove.append(trackIcon('close'));remove.onclick=e=>{e.stopPropagation();removeTrack(track.id)};
    const order=document.createElement('div');order.className='track-order-controls';
    for(const [direction,label,path] of [[-1,'Поднять','m6 14 6-6 6 6'],[1,'Опустить','m6 10 6 6 6-6']]){const button=document.createElement('button');button.type='button';button.title=`${label} дорожку ${track.label}`;button.setAttribute('aria-label',button.title);button.disabled=exporting||(direction===-1?tracks().indexOf(track)===0:tracks().indexOf(track)===tracks().length-1);button.innerHTML=`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="${path}"/></svg>`;button.onclick=e=>{e.stopPropagation();moveTrack(track.id,direction)};order.append(button)}
    row.append(name,order,remove);header.append(row);
    const actions=document.createElement('div');actions.className='track-actions';
    const controls=[
      ['locked',track.locked?'lock':'unlock',track.locked?'Разблокировать дорожку':'Заблокировать дорожку'],
      ['hidden',track.hidden?'eyeOff':'eye',track.hidden?'Показать дорожку':'Скрыть дорожку'],
      ['muted',track.muted?'muted':'volume',track.muted?'Включить звук дорожки':'Выключить звук дорожки'],
      ['solo','headphones',track.solo?'Выключить соло':'Соло: слушать только эту дорожку']
    ];
    for(const [key,icon,title] of controls){if(track.type!=='audio'&&['muted','solo'].includes(key))continue;const button=document.createElement('button');button.type='button';button.dataset.action=key;button.title=title;button.setAttribute('aria-label',title);button.setAttribute('aria-pressed',String(!!track[key]));button.className=track[key]?'active':'';button.append(trackIcon(icon));button.onclick=e=>{e.stopPropagation();mutate(()=>track[key]=!track[key]);syncElements();draw()};actions.append(button)}
    header.append(actions);return header;
  }
  function setButtonIcon(id,name,label){
    const button=$(id);if(!button)return;
    button.replaceChildren(trackIcon(name));
    if(label){const span=document.createElement('span');span.textContent=label;button.append(span)}
    if(!button.hasAttribute('aria-label'))button.setAttribute('aria-label',button.title||label||name);
  }
  function updatePlaybackIcon(){setButtonIcon('playBtn',playing?'pause':'play');$('playBtn').setAttribute('aria-label',playing?'Пауза':'Воспроизвести');$('playBtn').title=playing?'Пауза (Пробел)':'Воспроизвести (Пробел)'}
  function updatePreviewSoundIcon(){setButtonIcon('mutePreviewBtn',previewMuted?'muted':'volume');const label=previewMuted?'Включить звук просмотра':'Отключить звук просмотра';$('mutePreviewBtn').title=label;$('mutePreviewBtn').setAttribute('aria-label',label);$('mutePreviewBtn').setAttribute('aria-pressed',String(previewMuted));$('mutePreviewBtn').classList.toggle('active',previewMuted)}
  function bindToolbarIcons(){
    for(const [id,icon] of [['undoBtn','undo'],['redoBtn','redo'],['newBtn','new'],['saveBtn','save'],['shortcutsBtn','keyboard'],['jumpStartBtn','start'],['prevFrameBtn','previous'],['nextFrameBtn','next'],['jumpEndBtn','end'],['snapshotBtn','camera'],['fullscreenBtn','fullscreen'],['zoomOutBtn','minus'],['zoomInBtn','plus'],['fitBtn','fit'],['closeExportBtn','close'],['closeShortcutsBtn','close']])setButtonIcon(id,icon);
    for(const [id,icon,label] of [['splitBtn','scissors','Разрезать'],['deleteBtn','trash','Удалить'],['rippleDeleteBtn','rippleDelete','Удалить со сдвигом'],['rippleBtn','insertTrack','Вставлять на V1'],['snapBtn','magnet','Привязка'],['markerBtn','bookmark','Маркер'],['inBtn','in','Вход'],['outBtn','out','Выход'],['exportBtn','download','Экспорт']])setButtonIcon(id,icon,label);
    const open=document.querySelector('.file-label');for(const node of [...open.childNodes])if(node.nodeType===3)node.remove();open.prepend(trackIcon('folder'));
    document.querySelector('.brand-icon').replaceChildren(trackIcon('clapper'));
    updatePlaybackIcon();updatePreviewSoundIcon();
  }
  function bindToolbarLayout(){
    const tools=document.querySelector('.editing-tools'),bar=tools.parentElement,key='montazhnaya-toolbar-layout-v2';
    let editing=false,dragged=null;
    let separatorNumber=0;for(const divider of tools.querySelectorAll('.divider'))divider.dataset.layoutId=`separator-default-${++separatorNumber}`;
    const defaults=['copyAppearanceBtn','pasteAppearanceBtn','separator-appearance','snapBtn','rippleBtn','separator-insertion','inBtn','outBtn','separator-range','linkBtn','unlinkBtn','separator-links','rippleDeleteBtn','deleteBtn','separator-delete','mergeBtn','splitBtn','unmergeBtn','separator-cut','slowMotionBtn','cropVideoBtn','chromaKeyBtn','separator-video-tools','previousMarkerBtn','markerBtn','nextMarkerBtn','separator-end'];
    const settings=document.createElement('button');settings.type='button';settings.className='toolbar-customize';settings.innerHTML='<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="m9 3-1 3-3 1-2 3 2 2-1 3 3 2 3-1 2 2 3-2 1-3 3-1 1-3-2-2-3-1-1-3Z"/><circle cx="12" cy="12" r="3"/></svg>';settings.title='Настроить панель: переставить кнопки и добавить разделители';settings.setAttribute('aria-label','Настроить панель инструментов');settings.setAttribute('aria-pressed','false');bar.insertBefore(settings,tools);
    const add=document.createElement('button');add.type='button';add.className='toolbar-add-divider';add.textContent='+ |';add.title='Добавить разделитель, затем перетащить в нужное место';add.setAttribute('aria-label','Добавить разделитель');add.hidden=true;bar.insertBefore(add,settings.nextSibling);
    const id=el=>el.id||el.dataset.layoutId;
    const save=()=>{try{localStorage.setItem(key,JSON.stringify([...tools.children].map(id)))}catch{toast('Браузер не разрешил сохранить расположение панели')}};
    const makeDivider=value=>{const el=document.createElement('span');el.className='divider';el.dataset.layoutId=value;return el};
    const configure=()=>{tools.classList.toggle('layout-editing',editing);settings.classList.toggle('active',editing);settings.setAttribute('aria-pressed',String(editing));settings.title=editing?'Готово: закончить настройку панели':'Настроить панель: переставить кнопки и добавить разделители';settings.setAttribute('aria-label',editing?'Завершить настройку панели':'Настроить панель инструментов');add.hidden=!editing;for(const el of tools.children){el.draggable=false;if(el.matches('button')){if(editing){if(el.dataset.layoutDisabled==null)el.dataset.layoutDisabled=String(el.disabled);el.disabled=false}else if(el.dataset.layoutDisabled!=null){el.disabled=el.dataset.layoutDisabled==='true';delete el.dataset.layoutDisabled}}else{el.tabIndex=editing?0:-1;el.setAttribute('role','separator');el.setAttribute('aria-label','Разделитель панели');el.title='Разделитель: перетащите; правая кнопка — удалить'}el.classList.toggle('layout-unavailable',editing&&el.dataset.layoutDisabled==='true')}};
    const apply=order=>{const nodes=new Map([...tools.children].map(el=>[id(el),el]));const seen=new Set();for(const value of order){if(typeof value!=='string'||seen.has(value))continue;seen.add(value);let el=nodes.get(value);if(!el&&/^separator-[\w-]+$/.test(value))el=makeDivider(value);if(el)tools.append(el)}for(const [value,el] of nodes)if(!seen.has(value)){if(el.classList.contains('divider'))el.remove();else tools.append(el)}configure()};
    apply(defaults);try{const saved=JSON.parse(localStorage.getItem(key));if(Array.isArray(saved)){if(!saved.includes('unmergeBtn'))saved.splice(saved.indexOf('splitBtn')<0?saved.length:saved.indexOf('splitBtn')+1,0,'unmergeBtn');const anchor=saved.indexOf('markerBtn');if(!saved.includes('previousMarkerBtn'))saved.splice(anchor<0?saved.length:anchor,0,'previousMarkerBtn');if(!saved.includes('nextMarkerBtn'))saved.splice(saved.indexOf('markerBtn')<0?saved.length:saved.indexOf('markerBtn')+1,0,'nextMarkerBtn');const videoTools=['slowMotionBtn','cropVideoBtn','chromaKeyBtn','separator-video-tools'];let videoAnchor=saved.indexOf('unmergeBtn')+1;if(videoAnchor===0)videoAnchor=saved.length;for(const value of videoTools)if(!saved.includes(value))saved.splice(videoAnchor++,0,value);apply(saved)}}catch{}
    settings.onclick=()=>{editing=!editing;configure();if(editing)toast('Перетащите кнопки и разделители. + | добавляет разделитель. Правый клик — меню. Нажмите шестерёнку, когда закончите.');else{save();updateMergeButton();updateLinkButtons();updateMarkerNavigation();updateVideoToolButtons()}};
    const insertDivider=before=>{const el=makeDivider(`separator-${uid()}`);tools.insertBefore(el,before||null);configure();save()};add.onclick=()=>insertDivider(null);
    tools.addEventListener('click',e=>{if(editing){e.preventDefault();e.stopImmediatePropagation()}},true);
    const clearDropHints=()=>{for(const el of tools.children)el.classList.remove('layout-drop-before','layout-drop-after','layout-dragging')};
    const dropBefore=x=>[...tools.children].find(el=>el!==dragged&&x<el.getBoundingClientRect().left+el.getBoundingClientRect().width/2)||null;
    tools.addEventListener('pointerdown',e=>{
      if(!editing||e.button!==0)return;const target=e.target.closest('.editing-tools > *');if(!target)return;
      e.preventDefault();dragged=target;const startX=e.clientX;let moved=false;tools.setPointerCapture(e.pointerId);
      const clear=()=>{clearDropHints();dragged=null;tools.onpointermove=null;tools.onpointerup=null;tools.onpointercancel=null;if(tools.hasPointerCapture(e.pointerId))tools.releasePointerCapture(e.pointerId)};
      tools.onpointermove=ev=>{if(Math.abs(ev.clientX-startX)>5)moved=true;if(!moved)return;clearDropHints();dragged.classList.add('layout-dragging');const before=dropBefore(ev.clientX);if(before)before.classList.add('layout-drop-before');else tools.lastElementChild?.classList.add('layout-drop-after')};
      tools.onpointerup=ev=>{if(moved){tools.insertBefore(dragged,dropBefore(ev.clientX));save()}clear()};tools.onpointercancel=clear;
    });
    const availabilityObserver=new MutationObserver(()=>{if(editing)for(const button of tools.querySelectorAll('button:disabled')){button.dataset.layoutDisabled='true';button.disabled=false;button.classList.add('layout-unavailable')}});availabilityObserver.observe(tools,{subtree:true,attributes:true,attributeFilter:['disabled']});
    tools.addEventListener('contextmenu',e=>{const target=e.target.closest('.editing-tools > *');popupActions(e,[[editing?'Закончить настройку':'Переставить кнопки',()=>settings.click()],['Добавить разделитель здесь',()=>insertDivider(target)],['Удалить разделитель',()=>{target.remove();save()},!target?.classList.contains('divider')],['Вернуть исходный порядок',()=>{apply(defaults);save()}]])});
    tools.addEventListener('keydown',e=>{if(!editing)return;const target=e.target.closest('.editing-tools > *');if(!target)return;if(e.key==='Delete'&&target.classList.contains('divider')){e.preventDefault();target.remove();save()}else if(e.altKey&&['ArrowLeft','ArrowRight'].includes(e.key)){e.preventDefault();const sibling=e.key==='ArrowLeft'?target.previousElementSibling:target.nextElementSibling;if(sibling){tools.insertBefore(target,e.key==='ArrowLeft'?sibling:sibling.nextSibling);target.focus();save()}}});
  }
  function bindTrackAddIcons(){for(const [id,type,label] of [['addVideoTrackBtn','video','Добавить видеодорожку'],['addAudioTrackBtn','audio','Добавить аудиодорожку'],['addTextTrackBtn','text','Добавить текстовую дорожку']]){const button=$(id);button.replaceChildren(trackIcon(type),trackIcon('plus'));button.setAttribute('aria-label',label)}}
  function currentVisualTrack(){if(selected?.kind==='track'){const t=findTrack(selected.id);if(t?.type==='video')return t}if(selected?.kind==='item'){const f=findItem(selected.id);if(f?.track.type==='video')return f.track}return tracks().find(t=>t.type==='video')}
  function currentAudioTrack(){if(selected?.kind==='track'){const t=findTrack(selected.id);if(t?.type==='audio')return t}return tracks().find(t=>t.type==='audio')}
  function addTrack(type){let track;mutate(()=>{const n=nextTrackNumber(type);track=defaultTrack(type,n);if(type==='text')tracks().unshift(track);else insertTrackAtTop(track)});selectTrack(track.id)}
  function mediaKind(file){if(/\.(srt|vtt)$/i.test(file.name))return 'subtitle';if(file.type.startsWith('video/'))return 'video';if(file.type.startsWith('audio/'))return 'audio';if(file.type.startsWith('image/'))return 'image';const ext=file.name.split('.').pop()?.toLowerCase();return ['mp4','mov','webm','mkv'].includes(ext)?'video':['mp3','wav','m4a','ogg','flac'].includes(ext)?'audio':['png','jpg','jpeg','webp','gif'].includes(ext)?'image':null}
  function mediaMetadata(file,url,type){if(type==='subtitle')return file.text().then(text=>{const cues=parseSubtitleCues(text);if(!cues.length)throw Error('В файле не найдены субтитры');return {cues,duration:Math.max(...cues.map(c=>c.end)),width:0,height:0,thumbnail:null}});return new Promise((resolve,reject)=>{if(type==='image'){const image=new Image();image.onload=()=>resolve({duration:5,width:image.naturalWidth,height:image.naturalHeight,thumbnail:url,image});image.onerror=()=>reject(Error('Не удалось прочесть фото'));image.src=url;return}const element=document.createElement(type==='video'?'video':'audio');element.preload='metadata';element.playsInline=true;element.src=url;element.onloadedmetadata=async()=>{let mediaDuration=element.duration;if(!Number.isFinite(mediaDuration)||mediaDuration<=0){try{const seeked=new Promise(ok=>element.addEventListener('seeked',ok,{once:true}));element.currentTime=1e9;await Promise.race([seeked,new Promise(ok=>setTimeout(ok,2000))]);mediaDuration=element.currentTime;element.currentTime=0}catch{}}resolve({duration:Number.isFinite(mediaDuration)?mediaDuration:0,width:element.videoWidth||0,height:element.videoHeight||0,thumbnail:null});if(type==='video'){const thumbnail=()=>{try{const c=document.createElement('canvas');c.width=160;c.height=90;const fit=Math.max(c.width/element.videoWidth,c.height/element.videoHeight);c.getContext('2d').drawImage(element,(c.width-element.videoWidth*fit)/2,(c.height-element.videoHeight*fit)/2,element.videoWidth*fit,element.videoHeight*fit);const asset=[...assets.values()].find(a=>a.url===url);if(asset){asset.thumbnail=c.toDataURL('image/jpeg',.68);asset.libraryThumbnail=asset.thumbnail;renderSidebar();renderTimeline()}}catch{}};if(element.readyState>=2)setTimeout(thumbnail,30);else element.addEventListener('loadeddata',thumbnail,{once:true})}};element.onerror=()=>reject(Error('Не удалось прочесть медиа'))})}
  async function importFiles(files){files=Array.from(files);const epoch=projectEpoch;let added=0;for(const file of files){if(epoch!==projectEpoch)break;const type=mediaKind(file);if(!type)continue;const url=URL.createObjectURL(file);try{const meta=await mediaMetadata(file,url,type);if(epoch!==projectEpoch){URL.revokeObjectURL(url);break}const relink=project.assetManifest?.find(a=>a.name===file.name&&a.type===type&&!assets.has(a.id));const id=relink?.id||uid();const asset={id,name:file.name,type,file,url,...meta,stored:false};assets.set(id,asset);project.assetManifest??=[];if(!project.assetManifest.some(a=>a.id===id))project.assetManifest.push({id,name:file.name,type});autoFrameFromFirstVideo();queueAssetAnalysis(asset);added++}catch(e){URL.revokeObjectURL(url);toast(`${file.name}: ${e.message}`)}}rebuildElements();renderSidebar();renderTimeline();if(added){toast(`Добавлено файлов: ${added}`);queueSave()}}
  function createItem(assetId,trackId,start=playhead,options={}){
    const asset=assets.get(assetId);if(!asset||exporting)return;
    if(asset.type==='subtitle')return insertSubtitleAsset(asset,start,trackId);
    const initialEmpty=!allItems().some(e=>['video','audio'].includes(e.track.type));
    let track=findTrack(trackId),newTrack=false;
    if(asset.type==='video'&&options.newVideoTrack){track=initialEmpty?tracks().find(t=>t.type==='video'&&!t.locked&&!t.items.length):null;if(!track){track=defaultTrack('video',nextTrackNumber('video'));newTrack=true}}
    else if(asset.type==='video'&&options.forceV1&&!track){track=defaultTrack('video',1);newTrack=true}
    if(!track)return;if(track.locked)return toast('Разблокируйте дорожку '+track.label);
    if(track.type!==(asset.type==='audio'?'audio':'video'))return toast('Выберите подходящую дорожку');
    const at=clamp(start,0,86400),dur=asset.type==='image'?5:Math.max(.1,asset.duration||5);
    if(options.forceV1&&expandLinkedEntries(track.items.filter(i=>i.start+i.duration>at+1e-7).map(item=>({track,item}))).some(e=>e.track.locked))return toast('Разблокируйте V1 и связанные звуковые дорожки перед вставкой');
    let item;pause();
    mutate(()=>{
      if(newTrack)insertTrackAtTop(track)
      if(options.forceV1)makeRoomForVideo(track,at,dur);
      item={id:uid(),kind:asset.type,assetId,start:at,duration:dur,sourceIn:0,speed:1,volume:1,opacity:1,scale:1,x:0,y:0,rotation:0,flipH:false,flipV:false,brightness:1,contrast:1,saturation:1,fadeIn:0,fadeOut:0,transitionIn:'none',transitionOut:'none'};track.items.push(item);
      if(item.kind==='video'){
        let audioTrack=null;
        if(options.newSoundTrack){audioTrack=initialEmpty?tracks().find(t=>t.type==='audio'&&!t.locked&&!t.items.length):null;if(!audioTrack){audioTrack=defaultTrack('audio',nextTrackNumber('audio'));placeSoundAboveVideo(audioTrack,track)}}
        detachAudio(item,audioTrack);
      }
    });
    ensureElement(item);selectItem(item.id);seek(item.start);return item;
  }
  function detachAudio(item,audioTrackOverride=null){
    if(item.kind!=='video'||item.audioDetached)return;
    let audioTrack=audioTrackOverride||tracks().find(t=>t.type==='audio'&&!t.locked&&!t.items.some(i=>i.start<item.start+item.duration&&i.start+i.duration>item.start));
    if(!audioTrack){audioTrack=defaultTrack('audio',nextTrackNumber('audio'));const videoTrack=findItem(item.id)?.track;if(videoTrack)placeSoundAboveVideo(audioTrack,videoTrack);else insertTrackAtTop(audioTrack)}
    const linkId=uid();item.linkId=linkId;audioTrack.items.push({id:uid(),linkId,kind:'audio',assetId:item.assetId,start:item.start,duration:item.duration,sourceIn:item.sourceIn||0,speed:item.speed||1,volume:item.volume??1,fadeIn:item.fadeIn||0,fadeOut:item.fadeOut||0,sourceVideoId:item.id});item.audioDetached=true;
  }
  function separateLegacyAudio(){
    for(const {track,item} of [...allItems()])if(track.type==='video'&&item.kind==='video'&&!item.audioDetached){
      const originalVolume=item.volume??1;if(track.muted)item.volume=0;detachAudio(item);item.volume=originalVolume;
    }
  }
  function insertAsset(id){
    const asset=assets.get(id);if(!asset)return;
    if(asset.type==='subtitle')return insertSubtitleAsset(asset);
    if(asset.type==='video'){
      const primary=ripple?tracks().find(t=>t.type==='video'&&t.label==='V1'):null;
      const item=createItem(id,primary?.id,playhead,{newVideoTrack:!ripple,forceV1:ripple,newSoundTrack:true});
      if(item){const video=findItem(item.id)?.track,audio=linkedEntries(item).find(e=>e.track.type==='audio')?.track;toast(`Добавлено: ${video.label} + ${audio?.label||'звук'}. ${ripple?'Следующие клипы сдвинуты вправо.':'Отдельная связанная пара дорожек.'}`)}return;
    }
    const track=asset.type==='audio'?currentAudioTrack():currentVisualTrack();if(!track)return toast('Добавьте дорожку');createItem(id,track.id);
  }
  function openSlowMotion(item=null){
    if(exporting)return;if(location.protocol==='file:')return toast('Запустите редактор через «Запустить редактор.bat», чтобы использовать слоу-моушен.');
    const asset=item?assets.get(item.assetId):null;if(item&&!asset?.file)return toast('Исходное видео недоступно. Добавьте его в Медиа.');
    pause();const popup=window.open('slow-motion.html','_blank');if(!popup)return toast('Разрешите открытие окна слоу-моушен в браузере.');
    const onMessage=async event=>{if(event.origin!==location.origin||event.source!==popup)return;
      if(event.data?.type==='montazhnaya-slow-ready'&&asset?.file){popup.postMessage({type:'montazhnaya-slow-input',file:asset.file,options:{inputStart:item.sourceIn||0,inputEnd:Math.min(asset.duration,(item.sourceIn||0)+item.duration*(item.speed||1)),baseSpeed:item.speed||1,playhead:clamp(playhead-item.start,0,Math.max(0,item.duration-.04))}},location.origin)}
      if(event.data?.type==='montazhnaya-slow-result'&&event.data.file instanceof File){try{await importFiles([event.data.file]);tab='media';renderSidebar();popup.postMessage({type:'montazhnaya-slow-imported'},location.origin);toast('Слоу-моушен добавлен в Медиа. Нажмите «На линию», чтобы использовать результат.')}catch(e){popup.postMessage({type:'montazhnaya-slow-imported',error:e.message},location.origin)}}
    };window.addEventListener('message',onMessage);const cleanup=setInterval(()=>{if(popup.closed){window.removeEventListener('message',onMessage);clearInterval(cleanup)}},2000);
  }
  function updateInsertModeButton(){
    const button=$('rippleBtn');button.classList.toggle('active',ripple);button.setAttribute('aria-pressed',String(ripple));
    button.title=ripple?'Вставка на V1 включена. По кнопке «На линию» видео вставляется на красный курсор в V1, звук — на новую S-дорожку. Следующие клипы V1 и связанный звук сдвигаются вправо. Нажмите, чтобы добавлять отдельные пары V/S.':'Вставка на V1 выключена. По кнопке «На линию» каждое новое видео добавляется на отдельные дорожки V и S. Нажмите, чтобы вставлять на V1 со сдвигом следующих клипов.';
    button.setAttribute('aria-label',button.title);
  }

  function addText(style='title',caption=''){let item;mutate(()=>{let track=tracks().find(t=>t.type==='text'&&!t.locked&&!t.items.some(i=>i.start<playhead+3&&i.start+i.duration>playhead));if(!track){track=defaultTrack('text',nextTrackNumber('text'));tracks().unshift(track)}item={id:uid(),kind:style==='subtitle'?'subtitle':style==='shape-rectangle'||style==='shape-ellipse'?'shape':'title',style,timelineHue:(allItems().filter(({item})=>['title','subtitle','shape','countdown'].includes(item.kind)).length*137.508+275)%360,text:caption||({title:'Заголовок',subtitle:'Субтитр',caption:'Подпись',typewriter:'Печатный текст',lower:'Имя Фамилия',accent:'Важная мысль',label:'Надпись'}[style]||''),start:playhead,duration:3,opacity:1,scale:1,x:0,y:style==='title'||style.startsWith('shape')?0:25,rotation:0,size:style==='subtitle'?42:68,color:style.startsWith('shape')?'#dcff00':'#ffffff',outline:'#000000',outlineWidth:3,bg:'transparent',font:'Arial',bold:true,italic:false,align:'center',fadeIn:0,fadeOut:0};track.items.push(item)});selectItem(item.id)}
  function ensureElement(item){if(!item?.assetId||elements.has(item.id))return;const asset=assets.get(item.assetId);if(!asset||asset.type==='image')return;const el=document.createElement(item.kind==='audio'?'audio':'video');el.preload='auto';el.playsInline=true;el.src=asset.url;el.muted=item.kind!=='audio';el.onseeked=draw;el.onloadeddata=draw;elements.set(item.id,{el,source:null,exportGain:null,monitorGain:null})}
  function rebuildElements(){const ids=new Set(playbackItems().map(({item})=>item.id));for(const [id,state] of elements)if(!ids.has(id)){state.el.pause();state.source?.disconnect();state.exportGain?.disconnect();state.monitorGain?.disconnect();state.el.src='';elements.delete(id)}for(const {item} of playbackItems())ensureElement(item)}
  function removeItem(id,rippleDelete=false){const found=findItem(id);if(!found||found.track.locked)return;if(found.item.kind==='countdown'){const entries=expandLinkedEntries([found]);if(entries.some(e=>e.track.locked))return toast('Разблокируйте связанные дорожки');const ids=new Set(entries.map(e=>e.item.id)),end=found.item.start+found.item.duration,length=found.item.duration;mutate(()=>{for(const t of tracks()){t.items=t.items.filter(i=>!ids.has(i.id));if(rippleDelete)for(const other of t.items)if(other.start>=end-.001)other.start=Math.max(0,other.start-length)}selected=null});return;}const {track,item}=found;mutate(()=>{track.items=track.items.filter(x=>x.id!==id);if(rippleDelete)for(const t of tracks())for(const other of t.items)if(other.start>=item.start+item.duration-.001)other.start=Math.max(0,other.start-item.duration)});selected=null;rebuildElements();refresh()}
  function deleteSelected(rippleDelete=false){
    const entries=selectedEntries().filter(({track})=>!track.locked);if(!entries.length)return;
    if(entries.length===1)return removeItem(entries[0].item.id,rippleDelete);
    const ids=new Set(entries.map(({item})=>item.id)),ranges=[];
    for(const {item} of [...entries].sort((a,b)=>a.item.start-b.item.start)){const end=item.start+item.duration,last=ranges[ranges.length-1];if(last&&item.start<=last.end)last.end=Math.max(last.end,end);else ranges.push({start:item.start,end})}
    mutate(()=>{for(const track of tracks())track.items=track.items.filter(item=>!ids.has(item.id));if(rippleDelete)for(const range of ranges.reverse())for(const {item} of allItems())if(item.start>=range.end-.001)item.start=Math.max(0,item.start-(range.end-range.start));selected=null});
  }

  function splitEntriesAt(targets,cuts,time){
    const affectedGroups=new Set(cuts.map(({item})=>item.linkId).filter(Boolean));
      const rightIds=new Map(),rightGroups=new Map([...affectedGroups].map(id=>[id,uid()]));
      const rightItems=[];
      for(const {track,item} of cuts){
        const delta=time-item.start;
        const second={...item,id:uid(),start:time,duration:item.duration-delta,sourceIn:(item.sourceIn||0)+delta*(item.speed||1)};
        item.duration=delta;track.items.push(second);rightIds.set(item.id,second.id);rightItems.push(second);
        if(item.linkId)second.linkId=rightGroups.get(item.linkId);
      }
      for(const {item} of targets){
        if(affectedGroups.has(item.linkId)&&!rightIds.has(item.id)&&item.start+item.duration/2>=time){item.linkId=rightGroups.get(item.linkId);rightItems.push(item)}
      }
      for(const item of rightItems)if(rightIds.has(item.sourceVideoId))item.sourceVideoId=rightIds.get(item.sourceVideoId);
      return rightItems;
  }
  function makeRoomForVideo(track,time,length){
    const targets=expandLinkedEntries(track.items.filter(item=>item.start+item.duration>time+1e-7).map(item=>({track,item})));
    const cuts=targets.filter(({item})=>time-item.start>1e-7&&item.start+item.duration-time>1e-7);
    if(cuts.length)splitEntriesAt(targets,cuts,time);
    const moving=expandLinkedEntries(track.items.filter(item=>item.start>=time-1e-7).map(item=>({track,item})));
    for(const {item} of moving)item.start+=length;
  }
  function splitAtPlayhead(useMarkerRange=true){
    if(exporting)return;
    if(useMarkerRange!==false&&selectedMarkerRange())return splitMarkerRange();
    const initial=selectedItemIds().length?selectedEntries():allItems().filter(({item})=>activeAt(item,playhead));
    const targets=expandLinkedEntries(initial);
    const canSplit=item=>playhead-item.start>=.03&&item.start+item.duration-playhead>=.03;
    const cuts=targets.filter(({item})=>canSplit(item));
    if(!cuts.length)return toast('Нет клипа для разреза в этой точке');
    const affectedGroups=new Set(cuts.map(({item})=>item.linkId).filter(Boolean));
    if(targets.some(({track,item})=>track.locked&&(canSplit(item)||affectedGroups.has(item.linkId))))return toast('Разблокируйте связанные дорожки перед разрезанием');
    pause();
    mutate(()=>splitEntriesAt(targets,cuts,playhead));
    rebuildElements();toast(`Разрезано клипов: ${cuts.length}`);
  }

  function togglePlayback(){if(playing)pause();else play()}
  function seek(t,allowBeyondEnd=false){playhead=clamp(t,0,Math.max(duration(),allowBeyondEnd?t:0));lastTick=0;syncElements(true);draw();updatePlayhead()}
  function play(){if(duration()<=0)return toast('Добавьте клипы на монтажную линию');if(playhead>=duration())playhead=0;playing=true;lastTick=0;updatePlaybackIcon();syncElements(true);raf=requestAnimationFrame(tick)}
  function pause(){subtitlePlayUntil=null;playing=false;cancelAnimationFrame(raf);lastTick=0;updatePlaybackIcon();syncElements();draw()}
  function tick(now){if(!playing&&!exporting)return;if(lastTick)playhead+=Math.min((now-lastTick)/1000,.15);lastTick=now;const end=exporting?exportEnd:Math.min(duration(),subtitlePlayUntil??Infinity);if(playhead>=end){playhead=end;if(exporting){finishExport();return}pause();updatePlayhead();return}syncElements();draw();updatePlayhead();raf=requestAnimationFrame(tick)}
  function audible(track){if(track.type!=='audio')return false;const solos=tracks().filter(t=>t.type==='audio'&&t.solo);return !track.muted && (!solos.length||track.solo)}
  function syncElements(force=false){for(const {track,item} of playbackItems()){const state=elements.get(item.id);if(!state)continue;const el=state.el;el.muted=!(item.kind==='audio'&&track.type==='audio');const tail=transitionTail(track,item,playhead);const should=(activeAt(item,playhead)||!!tail)&&(!exporting||exportAllows(item));if(!should){if(!el.paused)el.pause();continue}const local=tail?item.duration-tail.fade+tail.offset:playhead-item.start;const wanted=(item.sourceIn||0)+local*(item.speed||1);if(force||Math.abs(el.currentTime-wanted)>.22)try{el.currentTime=clamp(wanted,0,Math.max(.01,assets.get(item.assetId)?.duration||wanted))}catch{}el.playbackRate=item.speed||1;el.preservesPitch=true;const fadeIn=item.fadeIn>0?clamp(local/item.fadeIn,0,1):1;const fadeOut=tail?1:item.fadeOut>0?clamp((item.duration-local)/item.fadeOut,0,1):1;const vol=(item.kind==='audio'&&track.type==='audio'&&!item.muted?keyframeValue(item,'volume',playhead):0)*(audible(track)?1:0)*fadeIn*fadeOut*groupFadeGain(item)*(tail?1-clamp(tail.offset/tail.fade,0,1):1);if(state.exportGain){state.exportGain.gain.value=vol;state.monitorGain.gain.value=previewMuted?0:vol;el.volume=1}else el.volume=previewMuted?0:vol;if(playing||exporting){if(el.paused)el.play().catch(()=>{})}else if(!el.paused)el.pause()}}
  function fitPreview(){
    const shell=$('canvasShell'),style=getComputedStyle(shell);
    const width=Math.max(1,shell.clientWidth-parseFloat(style.paddingLeft)-parseFloat(style.paddingRight));
    const height=Math.max(1,shell.clientHeight-parseFloat(style.paddingTop)-parseFloat(style.paddingBottom));
    const scale=Math.min(width/canvas.width,height/canvas.height);
    canvas.style.width=`${canvas.width*scale}px`;
    canvas.style.height=`${canvas.height*scale}px`;updatePreviewSelection();
  }
  function bindPreviewFit(){
    if(window.ResizeObserver){const observer=new ResizeObserver(fitPreview);observer.observe($('canvasShell'))}
    else window.addEventListener('resize',fitPreview);
    document.addEventListener('fullscreenchange',fitPreview);
    fitPreview();
  }
  function projectFrameSize(height=project.resolution){
    const h=Math.round(clamp(Number(height)||720,1,8192));
    const [rw,rh]=ratioParts();const compatible=project.ratio==='custom'||Math.abs(project.frameWidth/project.frameHeight-rw/rh)/(rw/rh)<.002;
    if(h===project.frameHeight&&project.frameWidth>0&&compatible)return {width:Math.round(project.frameWidth),height:h};return {width:Math.max(1,Math.round(h*(rw>0&&rh>0?rw/rh:16/9))),height:h};
  }
  function setCanvasSize(height=project.resolution){const size=projectFrameSize(height);canvas.height=size.height;canvas.width=size.width;fitPreview();draw()}
  const framePresets=['16:9','9:16','1:1','4:5','21:9'];
  function setProjectFrame(width,height,ratio='custom'){
    project.frameWidth=Math.round(clamp(Number(width),1,8192));project.frameHeight=Math.round(clamp(Number(height),1,8192));project.resolution=project.frameHeight;project.ratio=ratio;project.frameInitialized=true;
  }
  function frameAutoPending(){return project.frameInitialized===false||(project.frameInitialized==null&&project.ratio==='16:9'&&project.resolution===720&&!allItems().some(e=>e.track.type==='video'&&e.item.kind!=='title'))}
  function autoFrameFromFirstVideo(force=false){
    if(!force&&!frameAutoPending())return false;
    const asset=currentMediaAssets().find(a=>a.type==='video'&&a.width>0&&a.height>0);if(!asset)return false;
    const ratio=framePresets.find(value=>{const [w,h]=value.split(':').map(Number);return Math.abs(asset.width/asset.height-w/h)/(w/h)<.002})||'custom';
    mutate(()=>setProjectFrame(asset.width,asset.height,ratio));return true;
  }
  function selectFramePreset(ratio){
    const size=projectFrameSize();if(ratio==='custom')return setProjectFrame(size.width,size.height,'custom');
    const [w,h]=ratio.split(':').map(Number);setProjectFrame(Math.round(size.height*w/h),size.height,ratio);
  }
  function refreshExportFrameOption(){const select=$('exportResolution');let option=select.querySelector('option[value="source"]');if(!option){option=document.createElement('option');option.value='source';select.prepend(option)}const size=projectFrameSize();option.textContent=`Размер проекта · ${size.width} × ${size.height}`}

  function draw(){const w=canvas.width,h=canvas.height;ctx.save();ctx.fillStyle=project.bg||'#000';ctx.fillRect(0,0,w,h);if(project.bgMode==='blur'){const background=playbackItems().find(({track,item})=>track.type==='video'&&!track.hidden&&['video','image'].includes(item.kind)&&activeAt(item,playhead)&&(!exporting||exportAllows(item)));if(background){const {item}=background,asset=assets.get(item.assetId),source=item.kind==='image'?asset?.image:elements.get(item.id)?.el;if(source&&(item.kind==='image'||source.readyState>=2)){const sw=asset?.width||source.videoWidth,sh=asset?.height||source.videoHeight;if(sw&&sh){const cover=Math.max(w/sw,h/sh);ctx.save();ctx.filter=`blur(${Math.max(12,w/60)}px) brightness(.55)`;ctx.drawImage(source,(w-sw*cover)/2,(h-sh*cover)/2,sw*cover,sh*cover);ctx.restore()}}}}for(const track of [...tracks()].reverse()){if(track.hidden||track.type==='audio')continue;for(const item of playbackItems().filter(entry=>entry.track.id===track.id).map(entry=>entry.item).sort((a,b)=>a.start-b.start)){if(!activeAt(item,playhead)||(exporting&&!exportAllows(item)))continue;if(item.transitionIn&&item.transitionIn!=='none'&&transitionSeconds(item)>0){const previous=playbackItems().filter(entry=>entry.track.id===track.id).map(entry=>entry.item).find(x=>x.id!==item.id&&Math.abs(x.start+x.duration-item.start)<.03);if(previous&&playhead<item.start+transitionSeconds(item)&&item.transitionIn!=='fade'){const progress=clamp((playhead-item.start)/Math.max(.001,transitionSeconds(item)),0,1);drawItem(previous,w,h,item.transitionIn==='dissolve'?1-progress:1)}}drawItem(item,w,h)}}ctx.restore();$('currentTime').textContent=timecode(playhead);$('durationTime').textContent=timecode(duration());$('projectStats').textContent=`${canvas.width}×${canvas.height} · ${project.fps} fps · ${tracks().length} дорожки`;updatePreviewSelection()}
  function itemAlpha(item){const local=playhead-item.start;let alpha=keyframeValue(item,'opacity');const fi=number(item.fadeIn),fo=number(item.fadeOut);if(fi>0)alpha*=clamp(local/fi,0,1);if(fo>0)alpha*=clamp((item.duration-local)/fo,0,1);return clamp(alpha*groupFadeGain(item),0,1)}
  function cropFitRect(rect,sw,sh,ratio=0){
    let w=clamp(rect.w,Math.min(1,sw),sw),h=clamp(rect.h,Math.min(1,sh),sh);
    if(ratio){w=Math.min(w,h*ratio,sw,sh*ratio);h=w/ratio}
    return {x:clamp(rect.x,0,sw-w),y:clamp(rect.y,0,sh-h),w,h};
  }
  function cropDragRect(initial,handle,dx,dy,sw,sh,ratio=0){
    if(handle==='move')return cropFitRect({...initial,x:initial.x+dx,y:initial.y+dy},sw,sh,ratio);
    const west=handle.includes('w'),east=handle.includes('e'),north=handle.includes('n'),south=handle.includes('s');
    let w=Math.max(1,initial.w+(west?-dx:east?dx:0)),h=Math.max(1,initial.h+(north?-dy:south?dy:0));
    if(ratio){if(west||east)h=w/ratio;else w=h*ratio}
    const anchorX=west?initial.x+initial.w:east?initial.x:initial.x+initial.w/2;
    const anchorY=north?initial.y+initial.h:south?initial.y:initial.y+initial.h/2;
    const maxW=west?anchorX:east?sw-anchorX:2*Math.min(anchorX,sw-anchorX);
    const maxH=north?anchorY:south?sh-anchorY:2*Math.min(anchorY,sh-anchorY);
    if(ratio){w=Math.min(w,maxW,maxH*ratio);h=w/ratio}else{w=Math.min(w,maxW);h=Math.min(h,maxH)}
    return {x:west?anchorX-w:east?anchorX:anchorX-w/2,y:north?anchorY-h:south?anchorY:anchorY-h/2,w,h};
  }
  function openCropEditor(item){
    if(exporting)return;const candidates=item._compound?playbackItems().map(e=>e.item).filter(clip=>clip._compoundRoot===item.id&&['video','image'].includes(clip.kind)):[];const sample=candidates.find(clip=>activeAt(clip,playhead))||candidates[0]||item;const asset=assets.get(sample.assetId);if(!asset?.width||!asset?.height)return toast('Исходный файл недоступен. Добавьте его в Медиа.');
    pause();const dialog=$('cropDialog'),box=$('cropBox'),image=$('cropImage'),surface=$('cropCanvas'),sw=asset.width,sh=asset.height;
    const perc=item.crop||{};let rect=cropFitRect({x:sw*(perc.left||0)/100,y:sh*(perc.top||0)/100,w:sw*(1-((perc.left||0)+(perc.right||0))/100),h:sh*(1-((perc.top||0)+(perc.bottom||0))/100)},sw,sh),ratio=0,source=null,disposed=false;
    const context=surface.getContext('2d');surface.width=Math.min(sw,1600);surface.height=Math.round(sh*surface.width/sw);image.style.aspectRatio=`${sw} / ${sh}`;
    const paint=()=>{if(disposed)return;try{context.drawImage(source,0,0,surface.width,surface.height)}catch{}};
    if(sample.kind==='image'){source=asset.image;paint()}else{source=document.createElement('video');source.muted=true;source.playsInline=true;source.preload='auto';source.onloadeddata=()=>{if(disposed)return;const t=clamp((sample.sourceIn||0)+clamp(playhead-sample.start,0,Math.max(0,sample.duration-.001))*(sample.speed||1),0,Math.max(0,source.duration-.001));source.currentTime=t;paint()};source.onseeked=paint;source.onerror=()=>{if(!disposed)toast('Не удалось показать исходный кадр')};source.src=asset.url}
    const inputs={};$('cropFields').replaceChildren();for(const [key,label] of [['x','Слева, px'],['y','Сверху, px'],['w','Ширина, px'],['h','Высота, px']]){const field=document.createElement('label');field.textContent=label;const input=document.createElement('input');input.type='number';input.step='1';input.min=key==='x'||key==='y'?'0':'1';input.max=String(key==='x'||key==='w'?sw:sh);field.append(input);$('cropFields').append(field);inputs[key]=input;input.onchange=()=>{const next={...rect,[key]:number(input.value)};if(ratio&&key==='w')next.h=next.w/ratio;if(ratio&&key==='h')next.w=next.h*ratio;rect=cropFitRect(next,sw,sh,ratio);update()}}
    function update(){box.style.left=`${rect.x/sw*100}%`;box.style.top=`${rect.y/sh*100}%`;box.style.width=`${rect.w/sw*100}%`;box.style.height=`${rect.h/sh*100}%`;$('cropOutput').textContent=`Область кадра: ${Math.round(rect.w)} × ${Math.round(rect.h)} px`;for(const key of Object.keys(inputs))inputs[key].value=String(Math.round(rect[key]));for(const button of $('cropRatios').children){const active=Number(button.dataset.ratio)===ratio;button.classList.toggle('active',active);button.setAttribute('aria-pressed',String(active))}}
    $('cropRatios').replaceChildren();for(const [label,value] of [['Свободно',0],['9:16',9/16],['1:1',1],['4:5',4/5],['16:9',16/9]]){const button=document.createElement('button');button.type='button';button.textContent=label;button.dataset.ratio=value;button.onclick=()=>{ratio=value;const cx=rect.x+rect.w/2,cy=rect.y+rect.h/2;rect=cropFitRect(rect,sw,sh,ratio);rect=cropFitRect({...rect,x:cx-rect.w/2,y:cy-rect.h/2},sw,sh,ratio);update()};$('cropRatios').append(button)}
    box.querySelectorAll('.crop-handle').forEach(el=>el.remove());for(const handle of ['nw','n','ne','e','se','s','sw','w']){const node=document.createElement('span');node.className=`crop-handle crop-${handle}`;node.dataset.handle=handle;box.append(node)}
    box.onpointerdown=e=>{if(e.button!==0)return;e.preventDefault();box.focus();const start={...rect},bounds=image.getBoundingClientRect(),x=e.clientX,y=e.clientY,handle=e.target.dataset.handle||'move';box.setPointerCapture(e.pointerId);box.onpointermove=ev=>{rect=cropDragRect(start,handle,(ev.clientX-x)*sw/bounds.width,(ev.clientY-y)*sh/bounds.height,sw,sh,ratio);update()};const stop=()=>{box.onpointermove=null;box.onpointerup=null;box.onpointercancel=null};box.onpointerup=stop;box.onpointercancel=stop};
    box.onkeydown=e=>{const direction={ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,-1],ArrowDown:[0,1]}[e.code];if(!direction)return;e.preventDefault();e.stopPropagation();rect=cropDragRect(rect,'move',direction[0]*(e.shiftKey?10:1),direction[1]*(e.shiftKey?10:1),sw,sh,ratio);update()};
    $('cropMatchProject').checked=false;$('cropReset').onclick=()=>{ratio=0;rect={x:0,y:0,w:sw,h:sh};update()};
    $('cropApply').onclick=()=>{if(exporting)return;mutate(()=>{item.crop={left:rect.x/sw*100,top:rect.y/sh*100,right:(sw-rect.x-rect.w)/sw*100,bottom:(sh-rect.y-rect.h)/sh*100};if($('cropMatchProject').checked)setProjectFrame(Math.max(2,Math.round(rect.w/2)*2),Math.max(2,Math.round(rect.h/2)*2),'custom')});dialog.close();toast('Обрезка применена. Ctrl+Z — отменить.')};
    for(const id of ['cropClose','cropCancel'])$(id).onclick=()=>dialog.close();dialog.onclose=()=>{disposed=true;if(source?.tagName==='VIDEO'){source.pause();source.removeAttribute('src');source.load()}box.onpointermove=null};
    update();dialog.showModal();const fitStage=()=>{const stage=$('cropStage'),bounds=stage.getBoundingClientRect(),scale=Math.min((bounds.width-48)/sw,(bounds.height-48)/sh);image.style.width=`${sw*scale}px`;image.style.height=`${sh*scale}px`};fitStage();const observer=new ResizeObserver(fitStage);observer.observe($('cropStage'));const cleanup=dialog.onclose;dialog.onclose=()=>{observer.disconnect();cleanup()};
  }

  let chromaShadeSurface=null;
  function shadeChroma(source,sw,sh,sx,sy,cw,ch,amount){
    chromaShadeSurface??=document.createElement('canvas');const c=chromaShadeSurface;if(c.width!==sw||c.height!==sh){c.width=sw;c.height=sh}const cx=c.getContext('2d');cx.clearRect(0,0,sw,sh);cx.drawImage(source,0,0);cx.globalCompositeOperation='source-atop';const radius=Math.max(cw,ch)*.7,gradient=cx.createRadialGradient(sx+cw/2,sy+ch/2,radius*.25,sx+cw/2,sy+ch/2,radius);gradient.addColorStop(0,'rgba(0,0,0,0)');gradient.addColorStop(1,`rgba(0,0,0,${clamp(amount,0,1)})`);cx.fillStyle=gradient;cx.fillRect(sx,sy,cw,ch);cx.globalCompositeOperation='source-over';return c;
  }
  function drawMediaSource(item,source,sw,sh,w,h){
    const crop=item.crop||{},left=clamp(number(crop.left),0,99.999999)/100,right=clamp(number(crop.right),0,99.999999)/100,top=clamp(number(crop.top),0,99.999999)/100,bottom=clamp(number(crop.bottom),0,99.999999)/100;
    const sx=sw*left,sy=sh*top,cw=sw*Math.max(1/sw,1-left-right),ch=sh*Math.max(1/sh,1-top-bottom),fit=item.fit==='cover'?Math.max(w/cw,h/ch):Math.min(w/cw,h/ch),dw=item.fit==='stretch'?w:cw*fit,dh=item.fit==='stretch'?h:ch*fit;
    const temperature=item.temperature||0,sepia=Math.max(item.sepia||0,Math.abs(temperature)/100*.45),hue=temperature===0?0:temperature>0?-15:170;
    ctx.globalCompositeOperation=item.blend||'source-over';
    ctx.filter=`brightness(${item.brightness??1}) contrast(${item.contrast??1}) saturate(${item.saturation??1}) sepia(${sepia}) hue-rotate(${hue}deg)`;
    let keyed=item.chromaKey?.enabled?MontazhnayaChroma.render(source,sw,sh,item.chromaKey):source;
    if(item.chromaKey?.enabled&&item.vignette>0)keyed=shadeChroma(keyed,sw,sh,sx,sy,cw,ch,item.vignette);
    ctx.drawImage(keyed,sx,sy,cw,ch,-dw/2,-dh/2,dw,dh);
    ctx.filter='none';ctx.globalCompositeOperation='source-over';
    if(item.vignette>0&&!item.chromaKey?.enabled){const radius=Math.max(dw,dh)*.7;const gradient=ctx.createRadialGradient(0,0,radius*.25,0,0,radius);gradient.addColorStop(0,'rgba(0,0,0,0)');gradient.addColorStop(1,`rgba(0,0,0,${clamp(item.vignette,0,1)})`);ctx.fillStyle=gradient;ctx.fillRect(-dw/2,-dh/2,dw,dh)}
  }
  function drawItem(item,w,h,alphaOverride=null){
    const asset=assets.get(item.assetId),source=item.kind==='image'?asset?.image:item.kind==='video'?elements.get(item.id)?.el:null;
    ctx.save();const local=playhead-item.start,fade=Math.max(.001,transitionSeconds(item)),progress=clamp(local/fade,0,1);
    if(item.transitionIn==='fade'&&['video','image'].includes(item.kind)&&progress<1&&alphaOverride==null){ctx.globalAlpha=1-progress;ctx.fillStyle='#000';ctx.fillRect(0,0,w,h)}
    ctx.globalAlpha=alphaOverride==null?itemAlpha(item):alphaOverride*(item.opacity??1);if(alphaOverride==null&&['dissolve','fade'].includes(item.transitionIn))ctx.globalAlpha*=progress;
    if(item.transitionIn==='wipe'&&progress<1&&alphaOverride==null){ctx.beginPath();ctx.rect(0,0,w*progress,h);ctx.clip()}
    const transform=mediaTransform(item,playhead);ctx.translate(w/2+transform.x*w/100,h/2+transform.y*h/100);
    if(item.transitionIn==='slide-left'&&progress<1&&alphaOverride==null)ctx.translate((1-progress)*w,0);
    if(item.transitionIn==='slide-right'&&progress<1&&alphaOverride==null)ctx.translate(-(1-progress)*w,0);
    ctx.rotate(keyframeValue(item,'rotation')*Math.PI/180);
    const transitionScale=item.transitionIn==='zoom'&&progress<1&&alphaOverride==null?1.25-.25*progress:1;
    ctx.scale((item.flipH?-1:1)*transform.scale*transitionScale,(item.flipV?-1:1)*transform.scale*transitionScale);
    if(item.kind==='video'||item.kind==='image'){
      if(source&&(item.kind==='image'||source.readyState>=2)){const sw=asset?.width||source.videoWidth,sh=asset?.height||source.videoHeight;if(sw&&sh)drawMediaSource(item,source,sw,sh,w,h)}
    }else if(item.kind==='shape'){
      ctx.fillStyle=item.color||'#dcff00';const rw=w*.28,rh=h*.16;
      if(item.style==='shape-ellipse'){ctx.beginPath();ctx.ellipse(0,0,rw/2,rh/2,0,0,Math.PI*2);ctx.fill()}else ctx.fillRect(-rw/2,-rh/2,rw,rh)
    }else if(item.kind==='countdown')drawCountdown(item,w,h);else drawText(item,w,h);
    ctx.restore();
  }
  const textFonts=['Arial','Segoe UI','Calibri','Georgia','Times New Roman','Tahoma','Verdana','Trebuchet MS','Courier New','Impact'];
  function textLayout(item,w,h){
    const size=(item.size||56)*h/720,font=textFonts.includes(item.font)?item.font:'Arial';
    const fontSpec=`${item.italic?'italic ':''}${item.bold===false?400:700} ${size}px "${font}"`;
    const lines=String(item.text||'').split('\n'),lineHeight=size*1.2;
    ctx.save();ctx.font=fontSpec;const width=Math.min(w*.9,Math.max(size*.5,...lines.map(line=>ctx.measureText(line).width)));ctx.restore();
    const pad=['lower','accent','label'].includes(item.style)?size*.3:Math.max(4,(item.outlineWidth||0)*h/720);
    return {size,fontSpec,lines,lineHeight,width,height:lines.length*lineHeight,pad};
  }
  function drawText(item,w,h){
    const layout=textLayout(item,w,h);let lines=layout.lines;
    if(item.style==='typewriter'){const full=lines.join('\n'),fraction=clamp((playhead-item.start)/Math.max(.1,item.duration*.6),0,1);lines=full.slice(0,Math.round(full.length*fraction)).split('\n')}
    const {size,fontSpec,lineHeight,width,height,pad}=layout,offset=(layout.lines.length-1)*lineHeight/2;
    ctx.font=fontSpec;ctx.textAlign=item.align||'center';ctx.textBaseline='middle';
    if(['lower','accent','label'].includes(item.style)){
      ctx.fillStyle=item.style==='label'?'#fff':!item.bg||item.bg==='transparent'?'#101010':item.bg;
      ctx.fillRect(-width/2-pad,-height/2-pad,width+pad*2,height+pad*2);
      if(item.style==='accent'){ctx.fillStyle='#dcff00';ctx.fillRect(-width/2-pad,-height/2-pad,size*.12,height+pad*2)}
    }
    const x=item.align==='left'?-width/2:item.align==='right'?width/2:0;
    lines.forEach((line,i)=>{const y=i*lineHeight-offset;ctx.lineWidth=(item.outlineWidth??3)*h/720;ctx.strokeStyle=item.outline||'#000';if(ctx.lineWidth>0)ctx.strokeText(line,x,y,w*.9);ctx.fillStyle=item.style==='label'?'#171717':item.color||'#fff';ctx.fillText(line,x,y,w*.9)});
  }
  function renderTextControls(root,item){
    const input=inspectorField(root,'Текст',item.text,()=>{},{multiline:true});input.dataset.textEditor='true';
    let before=JSON.stringify(project);
    input.onfocus=()=>{before=JSON.stringify(project)};
    input.oninput=()=>{item.text=input.value;draw();renderTimeline();queueSave();updateSubtitleWorkshopUI()};
    input.onchange=()=>{if(JSON.stringify(project)!==before){recordChange(before);before=JSON.stringify(project);queueSave()}};input.onblur=input.onchange;
    inspectorField(root,'Шрифт',item.font||'Arial',value=>mutate(()=>item.font=value),{values:textFonts.map(font=>[font,font])});
    const row=document.createElement('div');row.className='text-style-controls';
    for(const [key,label] of [['bold','Жирный'],['italic','Курсив']]){const button=document.createElement('button');button.type='button';button.textContent=key==='bold'?'B':'I';button.style.fontWeight=key==='bold'?'bold':'normal';button.style.fontStyle=key==='italic'?'italic':'normal';button.title=label;button.setAttribute('aria-label',label);button.dataset.textStyle=key;const active=key==='bold'?item.bold!==false:!!item.italic;button.className=active?'active':'';button.setAttribute('aria-pressed',String(active));button.onclick=()=>mutate(()=>item[key]=!active);row.append(button)}
    root.append(row);
    inspectorField(root,'Выравнивание',item.align||'center',value=>mutate(()=>item.align=value),{values:[['left','По левому краю'],['center','По центру'],['right','По правому краю']]});
    const hint=document.createElement('p');hint.className='note';hint.textContent='Перетащите текст прямо на видео. Круглая ручка в углу рамки меняет размер. Двойной клик по тексту открывает редактирование.';root.append(hint);
  }
  function overlayBounds(item){
    if(item.kind==='countdown')return countdownBounds(item);
    if(['video','image'].includes(item.kind)){const asset=assets.get(item.assetId),crop=item.crop||{},cw=(asset?.width||canvas.width)*(1-((crop.left||0)+(crop.right||0))/100),ch=(asset?.height||canvas.height)*(1-((crop.top||0)+(crop.bottom||0))/100),fit=item.fit==='cover'?Math.max(canvas.width/cw,canvas.height/ch):Math.min(canvas.width/cw,canvas.height/ch);return item.fit==='stretch'?{width:canvas.width,height:canvas.height}:{width:cw*fit,height:ch*fit}}if(item.kind==='shape')return {width:canvas.width*.28,height:canvas.height*.16};
    const layout=textLayout(item,canvas.width,canvas.height);return {width:layout.width+layout.pad*2,height:layout.height+layout.pad*2};
  }
  function updatePreviewSelection(){
    const box=$('previewSelection');if(!box)return;
    const found=selected?.kind==='item'?findItem(selected.id):selected?.primaryId&&findItem(selected.primaryId)?.item.kind==='countdown'?findItem(selected.primaryId):null;
    if(!found||!['title','subtitle','shape','countdown','video','image'].includes(found.item.kind)||found.track.hidden||!activeAt(found.item,playhead)||playing||exporting){box.hidden=true;return}
    const {track}=found,item={...found.item,...mediaTransform(found.item,playhead),rotation:keyframeValue(found.item,'rotation')},bounds=overlayBounds(item),rect=canvas.getBoundingClientRect(),shell=$('canvasShell').getBoundingClientRect(),scale=Math.abs(item.scale||1);
    box.hidden=false;box.classList.toggle('locked',!!track.locked);
    box.style.left=`${rect.left-shell.left+rect.width*(.5+(item.x||0)/100)}px`;box.style.top=`${rect.top-shell.top+rect.height*(.5+(item.y||0)/100)}px`;
    box.style.width=`${bounds.width*scale*rect.width/canvas.width}px`;box.style.height=`${bounds.height*scale*rect.height/canvas.height}px`;
    box.style.transform=`translate(-50%,-50%) rotate(${item.rotation||0}deg)`;
    $('previewResizeHandle').disabled=!!track.locked;
  }
  function previewPoint(event){const rect=canvas.getBoundingClientRect();return {x:(event.clientX-rect.left)*canvas.width/rect.width,y:(event.clientY-rect.top)*canvas.height/rect.height}}
  function hitOverlay(point){
    for(const track of tracks()){if(track.hidden||track.type==='audio')continue;for(const item of [...track.items].sort((a,b)=>b.start-a.start)){
      if(!['title','subtitle','shape','countdown','video','image'].includes(item.kind)||!activeAt(item,playhead)||item.kind==='compound')continue;
      const dx=point.x-canvas.width*(.5+(item.x||0)/100),dy=point.y-canvas.height*(.5+(item.y||0)/100),angle=-(item.rotation||0)*Math.PI/180,scale=Math.abs(item.scale||1);
      const x=(dx*Math.cos(angle)-dy*Math.sin(angle))/scale,y=(dx*Math.sin(angle)+dy*Math.cos(angle))/scale,bounds=overlayBounds(item);
      if(Math.abs(x)<=bounds.width/2&&Math.abs(y)<=bounds.height/2)return item;
    }}return null;
  }
  function bindPreviewEditing(){
    const box=$('previewSelection'),handle=$('previewResizeHandle');
    function begin(e,item,resize=false){
      if(e.button!==0||exporting)return;e.preventDefault();e.stopPropagation();pause();selectItem(item.id);
      const found=findItem(item.id);if(!found||found.track.locked)return;
      const target=resize?handle:box,before=JSON.stringify(project),origin=previewPoint(e),initial={x:item.x||0,y:item.y||0,size:item.size||56,scale:item.scale||1},bounds=overlayBounds(item),angle=-(item.rotation||0)*Math.PI/180;
      const center={x:canvas.width*(.5+initial.x/100),y:canvas.height*(.5+initial.y/100)};
      const local=p=>({x:(p.x-center.x)*Math.cos(angle)-(p.y-center.y)*Math.sin(angle),y:(p.x-center.x)*Math.sin(angle)+(p.y-center.y)*Math.cos(angle)});
      const start=local(origin),denominator=start.x*start.x+start.y*start.y;
      target.setPointerCapture(e.pointerId);let moved=false;
      target.onpointermove=ev=>{if(!target.hasPointerCapture(ev.pointerId))return;const point=previewPoint(ev);if(Math.hypot(point.x-origin.x,point.y-origin.y)<2&&!moved)return;moved=true;
        if(resize){const current=local(point),factor=denominator>0?(current.x*start.x+current.y*start.y)/denominator:1;if(['shape','countdown','video','image'].includes(item.kind))item.scale=clamp(initial.scale*factor,.1,5);else item.size=clamp(initial.size*factor,12,400)}
        else{item.x=clamp(initial.x+(point.x-origin.x)/canvas.width*100,-100,100);item.y=clamp(initial.y+(point.y-origin.y)/canvas.height*100,-100,100);if(Math.abs(item.x)<1)item.x=0;if(Math.abs(item.y)<1)item.y=0}updateCenterGuides(item);draw();
      };
      const clear=()=>{document.querySelectorAll('.preview-center-guide').forEach(el=>el.remove());target.onpointermove=null;target.onpointerup=null;target.onpointercancel=null};
      target.onpointerup=ev=>{if(target.hasPointerCapture(ev.pointerId))target.releasePointerCapture(ev.pointerId);clear();if(moved&&JSON.stringify(project)!==before){recordChange(before);queueSave();renderInspector();draw()}};
      target.onpointercancel=()=>{clear();project=JSON.parse(before);refresh()};
    }
    canvas.onpointerdown=e=>{if(e.button!==0||exporting)return;const item=hitOverlay(previewPoint(e));if(item)begin(e,item);else{selected=null;renderTimeline();renderInspector();draw()}};
    box.onpointerdown=e=>{if(e.target===handle)return;const found=selected?.kind==='item'?findItem(selected.id):selected?.primaryId&&findItem(selected.primaryId)?.item.kind==='countdown'?findItem(selected.primaryId):null;if(found)begin(e,found.item)};
    handle.onpointerdown=e=>{const found=selected?.kind==='item'?findItem(selected.id):selected?.primaryId&&findItem(selected.primaryId)?.item.kind==='countdown'?findItem(selected.primaryId):null;if(found)begin(e,found.item,true)};
    function editText(){const found=selected?.kind==='item'?findItem(selected.id):selected?.primaryId&&findItem(selected.primaryId)?.item.kind==='countdown'?findItem(selected.primaryId):null;if(!found||!['title','subtitle'].includes(found.item.kind))return;if($('togglePropertiesPanelBtn').getAttribute('aria-expanded')==='false')$('togglePropertiesPanelBtn').click();renderInspector();const input=document.querySelector('[data-text-editor]');input?.focus();input?.select()}
    box.ondblclick=editText;canvas.ondblclick=editText;
  }
  function updatePlayhead(){updateMarkerNavigation();const el=$('playhead');el.style.left=`${playhead*zoom}px`;const bottom=$('bottomPlayhead');if(bottom){bottom.style.left=`${playhead*zoom}px`;$('bottomTime').textContent=timecode(playhead);$('bottomRuler').setAttribute('aria-valuenow',String(playhead));$('bottomRuler').setAttribute('aria-valuetext',timecode(playhead))}$('currentTime').textContent=timecode(playhead);if(playing||exporting){const scroll=$('timelineScroll');const x=playhead*zoom;if(x>scroll.scrollLeft+scroll.clientWidth-70)scroll.scrollLeft=x-scroll.clientWidth*.3}}

  function renderSidebar(){const root=$('sidebarContent');root.replaceChildren();document.querySelectorAll('.tab').forEach(b=>b.classList.toggle('active',b.dataset.tab===tab));if(tab==='media')renderMediaSidebar(root);if(tab==='text'){renderCountdownLibrary(root);renderTextSidebar(root);renderSavedTextTemplates(root)}if(tab==='transitions')renderTransitionSidebar(root);if(tab==='subtitles')renderSubtitleSidebar(root)}
  function toggleMediaHidden(id){
    mutate(()=>{const hidden=new Set(project.hiddenMediaIds||[]);if(hidden.has(id))hidden.delete(id);else hidden.add(id);project.hiddenMediaIds=[...hidden]});
  }
  function mediaDurationLabel(seconds){const value=Math.max(0,Math.ceil(seconds||0)),h=Math.floor(value/3600),m=Math.floor(value/60)%60,s=value%60;return (h?`${h}:${String(m).padStart(2,'0')}`:String(m))+`:${String(s).padStart(2,'0')}`}
  function renderMediaSidebar(root){
    const drop=document.createElement('button');drop.type='button';drop.className='media-drop';drop.innerHTML='<strong>Добавить медиа</strong><small>Видео, фото, звук, SRT / VTT</small>';drop.firstElementChild.prepend(trackIcon('plus'));drop.title='Выбрать файлы или перетащить их сюда';drop.onclick=()=>$('mediaInput').click();
    drop.ondragover=e=>{e.preventDefault();drop.classList.add('drag-over')};drop.ondragleave=()=>drop.classList.remove('drag-over');drop.ondrop=e=>{e.preventDefault();e.stopPropagation();drop.classList.remove('drag-over');importFiles(e.dataTransfer.files)};root.append(drop);
    const filters=document.createElement('div');filters.className='media-filters';filters.setAttribute('role','group');filters.setAttribute('aria-label','Фильтр медиа');
    const labels={all:'Все',image:'Фото',video:'Видео',audio:'Звук',subtitle:'Титры'};
    for(const type of ['all','image','video','audio','subtitle']){const button=document.createElement('button');button.type='button';button.title=labels[type];button.setAttribute('aria-label',labels[type]);button.setAttribute('aria-pressed',String(mediaFilter===type));button.className=mediaFilter===type?'active':'';button.append(trackIcon(type==='all'?'layers':type));button.onclick=()=>{mediaFilter=type;renderSidebar();root.querySelector(`.media-filters button[aria-label="${labels[type]}"]`)?.focus()};filters.append(button)}root.append(filters);
    const hidden=new Set(project.hiddenMediaIds||[]),library=currentMediaAssets(),hiddenCount=library.filter(a=>hidden.has(a.id)).length;
    if(hiddenCount){const label=document.createElement('label');label.className='media-hidden-toggle';const checkbox=document.createElement('input');checkbox.type='checkbox';checkbox.checked=showHiddenMedia;checkbox.onchange=()=>{showHiddenMedia=checkbox.checked;renderSidebar()};label.append(checkbox,document.createTextNode(`Показать скрытые (${hiddenCount})`));root.append(label)}
    const list=document.createElement('div');list.className='media-list media-grid';
    for(const asset of library){const isHidden=hidden.has(asset.id);if(isHidden&&!showHiddenMedia||mediaFilter!=='all'&&asset.type!==mediaFilter)continue;
      const row=document.createElement('div');row.className=`media-card media-item${isHidden?' media-item-hidden':''}`;row.dataset.assetId=asset.id;row.dataset.mediaType=asset.type;row.title=asset.name;row.draggable=true;row.ondragstart=e=>e.dataTransfer.setData('application/x-montazhnaya-asset',asset.id);
      const preview=document.createElement('button');preview.type='button';preview.className=`media-preview media-preview-${asset.type}`;preview.title=asset.name+' — добавить на линию';preview.setAttribute('aria-label',`Добавить на линию: ${asset.name}`);preview.onclick=()=>insertAsset(asset.id);
      if(asset.libraryThumbnail||asset.thumbnail){const img=document.createElement('img');img.src=asset.libraryThumbnail||asset.thumbnail;img.alt='';img.draggable=false;preview.append(img)}else{const placeholder=document.createElement('span');placeholder.className='media-placeholder';placeholder.append(trackIcon(asset.type));if(asset.type==='subtitle'){const blocks=document.createElement('span');blocks.className='media-caption-blocks';blocks.innerHTML='<i></i><i></i><i></i>';placeholder.append(blocks)}preview.append(placeholder)}row.append(preview);
      const badge=document.createElement('span');badge.className='media-type-badge';badge.title=labels[asset.type];badge.append(trackIcon(asset.type));row.append(badge);
      if(asset.type!=='image'){const duration=document.createElement('span');duration.className='media-duration';duration.textContent=mediaDurationLabel(asset.duration);duration.title=asset.type==='subtitle'?`Реплик: ${asset.cues.length}`:'Длительность';row.append(duration)}
      const name=document.createElement('span');name.className='media-hover-name';name.textContent=asset.name;row.append(name);
      const eye=document.createElement('button');eye.type='button';eye.className='media-card-eye';const action=isHidden?'Показать в списке медиа':'Скрыть из списка медиа';eye.title=`${action}: ${asset.name}. На дорожки это не влияет.`;eye.setAttribute('aria-label',`${action}: ${asset.name}`);eye.append(trackIcon(isHidden?'eyeOff':'eye'));eye.onclick=e=>{e.stopPropagation();toggleMediaHidden(asset.id)};row.append(eye);list.append(row);
    }
    if(!list.childElementCount){const empty=document.createElement('p');empty.className='media-empty';empty.textContent=!library.length?'Добавьте файлы. Нажмите на превью или перетащите его на дорожку.':'Нет файлов в этом фильтре. Проверьте скрытые медиа или выберите «Все».';list.append(empty)}root.append(list);
  }
  const countdownStyles=[['digits','Крупные цифры'],['ring','Круговой таймер'],['film','Киноплёнка'],['flip','Табло'],['bar','Полоса прогресса']];
  function countdownState(item,time=playhead){const total=clamp(Math.round(number(item.countSeconds)||10),1,3600),elapsed=clamp((time-item.start)*(item.speed||1)+(item.sourceIn||0),0,total),remaining=Math.max(0,total-elapsed),value=item.countDirection==='up'?Math.floor(elapsed+1e-7):Math.ceil(remaining-1e-7);let text=String(value);if(item.countFormat==='clock'||item.countFormat!=='seconds'&&total>=60){const h=Math.floor(value/3600),m=Math.floor(value/60)%60,s=value%60;text=(h?`${String(h).padStart(2,'0')}:`:'')+`${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`}if(elapsed>=total&&item.countFinishText)text=item.countFinishText;return {total,elapsed,remaining,value,text,progress:item.countDirection==='up'?elapsed/total:remaining/total}}
  function countdownBounds(item,w=canvas.width,h=canvas.height){const size=(item.size||140)*h/720;return item.countStyle==='ring'||item.countStyle==='film'?{width:Math.min(size*2.8,w*.92),height:Math.min(size*2.8,w*.92)}:{width:Math.min(w*.9,Math.max(size*3.5,Math.min(w*.85,size*7))),height:size*(item.countStyle==='bar'?1.8:1.5)}}
  function drawCountdown(item,w,h){
    const state=countdownState(item),size=(item.size||140)*h/720,style=item.countStyle||'digits',bounds=countdownBounds(item,w,h),pulse=item.countPulse===false||state.elapsed>=state.total?1:1+.07*(1-(state.elapsed%1));ctx.save();ctx.scale(pulse,pulse);
    if(item.countBg&&item.countBg!=='transparent'){ctx.fillStyle=item.countBg;ctx.fillRect(-bounds.width/2,-bounds.height/2,bounds.width,bounds.height)}
    ctx.strokeStyle=item.countAccent||'#dcff00';ctx.lineWidth=Math.max(2,size*.06);ctx.lineCap='round';
    if(style==='ring'||style==='film'){const r=Math.min(size*1.15,bounds.width*.43);ctx.save();ctx.globalAlpha*=.3;ctx.beginPath();ctx.arc(0,0,r,0,Math.PI*2);ctx.stroke();ctx.restore();ctx.beginPath();ctx.arc(0,0,r,-Math.PI/2,-Math.PI/2+Math.PI*2*Math.max(.00001,state.progress));ctx.stroke();if(style==='film'){ctx.save();ctx.globalAlpha*=.3;ctx.beginPath();ctx.moveTo(-r*1.15,0);ctx.lineTo(r*1.15,0);ctx.moveTo(0,-r*1.15);ctx.lineTo(0,r*1.15);ctx.stroke();ctx.beginPath();ctx.arc(0,0,r*.86,0,Math.PI*2);ctx.stroke();ctx.restore()}}
    if(style==='flip'){ctx.fillStyle=item.countBg&&item.countBg!=='transparent'?item.countBg:'#191b20';ctx.fillRect(-bounds.width*.46,-size*.62,bounds.width*.92,size*1.24);ctx.save();ctx.globalAlpha*=.7;ctx.fillStyle='#000';ctx.fillRect(-bounds.width*.46,-1,bounds.width*.92,3);ctx.restore()}
    if(style==='bar'){ctx.save();ctx.globalAlpha*=.25;ctx.fillStyle=item.countAccent||'#dcff00';ctx.fillRect(-bounds.width/2,size*.57,bounds.width,size*.1);ctx.restore();ctx.fillStyle=item.countAccent||'#dcff00';ctx.fillRect(-bounds.width/2,size*.57,bounds.width*state.progress,size*.1)}
    ctx.font=`700 ${size}px "${textFonts.includes(item.font)?item.font:'Arial'}"`;ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillStyle=item.color||'#fff';ctx.lineJoin='round';ctx.strokeStyle=item.outline||'#000';ctx.lineWidth=(item.outlineWidth??2)*h/720;if(ctx.lineWidth)ctx.strokeText(state.text,0,0,bounds.width*.92);ctx.fillText(state.text,0,0,bounds.width*.92);ctx.restore();
  }
  function countdownWav(seconds,sound='beep',window='last10',finish=true,hold=1){
    const rate=8000,length=Math.ceil((seconds+hold)*rate),buffer=new ArrayBuffer(44+length*2),view=new DataView(buffer),samples=new Int16Array(buffer,44);const put=(offset,text)=>{for(let i=0;i<text.length;i++)view.setUint8(offset+i,text.charCodeAt(i))};put(0,'RIFF');view.setUint32(4,36+length*2,true);put(8,'WAVE');put(12,'fmt ');view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,1,true);view.setUint32(24,rate,true);view.setUint32(28,rate*2,true);view.setUint16(32,2,true);view.setUint16(34,16,true);put(36,'data');view.setUint32(40,length*2,true);
    const tone=(at,duration,freq,gain)=>{const begin=Math.round(at*rate),n=Math.min(Math.round(duration*rate),length-begin);for(let i=0;i<n;i++){const t=i/rate,attack=Math.min(1,i/32),env=attack*Math.exp(-t*(sound==='tick'?65:9)),wave=Math.sin(2*Math.PI*freq*t)+(sound==='tick'?.3*Math.sin(2*Math.PI*freq*2.7*t):0);samples[begin+i]=Math.max(-32768,Math.min(32767,samples[begin+i]+Math.round(wave*env*gain*22000)))}};
    if(sound!=='none')for(let t=window==='last10'?Math.max(0,seconds-10):0;t<seconds;t++)tone(t,sound==='tick'?.07:.13,sound==='tick'?1500:880,.7);
    if(finish&&hold>0){tone(seconds,Math.min(.7,hold),1046,.65);tone(seconds+.08,Math.min(.6,Math.max(0,hold-.08)),1318,.5)}return buffer;
  }
  function rebuildCountdownSound(item){
    if(item.countAudioLinked===false)return;
    const existing=item.linkId?linkedEntries(item).find(e=>e.item.kind==='audio'&&e.item.timerOwnerId):null;
    if(existing?.track.locked)throw Error('Разблокируйте связанную звуковую дорожку');
    const oldAsset=existing?.item.assetId;let audioTrack=existing?.track;if(existing)audioTrack.items=audioTrack.items.filter(i=>i!==existing.item);
    delete item.countAudioId;
    if(item.countSound==='none'&&!item.countFinishSound){if(existing)delete item.linkId;if(oldAsset&&!allItems().some(e=>e.item.assetId===oldAsset))project.assetManifest=project.assetManifest.filter(a=>a.id!==oldAsset);return}
    const buffer=countdownWav(item.countSeconds,item.countSound,item.countSoundWindow,item.countFinishSound,item.countHold??1),id=uid(),name=`Счётчик ${item.countSeconds} с — звук.wav`,file=new File([buffer],name,{type:'audio/wav'}),asset={id,name,type:'audio',file,url:URL.createObjectURL(file),duration:item.countSeconds+(item.countHold??1),stored:false,generatedCountdown:true};assets.set(id,asset);project.assetManifest??=[];project.assetManifest.push({id,name,type:'audio'});
    if(!audioTrack){audioTrack=defaultTrack('audio',nextTrackNumber('audio'));const index=tracks().findIndex(t=>t.id===findItem(item.id)?.track.id);tracks().splice(Math.max(0,index+1),0,audioTrack)}
    const linkId=item.linkId||uid();item.linkId=linkId;const audio={id:uid(),kind:'audio',assetId:id,name:`Счётчик · ${item.countSeconds} с`,timerOwnerId:item.id,linkId,start:item.start,duration:item.duration,sourceIn:item.sourceIn||0,speed:item.speed||1,volume:existing?.item.volume??.7,muted:existing?.item.muted??false,fadeIn:Math.min(existing?.item.fadeIn||0,item.duration),fadeOut:Math.min(existing?.item.fadeOut||0,item.duration)};audioTrack.items.push(audio);item.countAudioId=audio.id;
    if(oldAsset&&!allItems().some(e=>e.item.assetId===oldAsset))project.assetManifest=project.assetManifest.filter(a=>a.id!==oldAsset);queueAssetAnalysis(asset);
  }
  function changeCountdown(item,fn,sound=false){
    if(exporting)return;const pair=item.linkId?linkedEntries(item):[];if(pair.some(e=>e.track.locked))return toast('Разблокируйте связанные дорожки');
    const before=JSON.stringify(project);try{fn();if(sound)rebuildCountdownSound(item);if(JSON.stringify(project)!==before){recordChange(before);refresh();queueSave()}}catch(e){project=JSON.parse(before);refresh();toast(e.message)}
  }
  function addCountdown(style='digits'){
    if(exporting)return;pause();let item;mutate(()=>{const track=defaultTrack('text',nextTrackNumber('text'));tracks().unshift(track);item={id:uid(),kind:'countdown',name:'Счётчик · 10 с',start:playhead,duration:11,sourceIn:0,countSeconds:10,countHold:1,countStyle:style,countAudioLinked:true,countDirection:'down',countFormat:'auto',countFinishText:'',countPulse:true,countSound:'beep',countSoundWindow:'last10',countFinishSound:true,countAccent:'#dcff00',countBg:'transparent',size:140,font:'Arial',color:'#ffffff',outline:'#000000',outlineWidth:2,x:0,y:0,scale:1,rotation:0,opacity:1,fadeIn:0,fadeOut:0};track.items.push(item);rebuildCountdownSound(item);selected={kind:'item',id:item.id}});selectItem(item.id);toast('Счётчик добавлен на T, связанный звук — на S.');
  }
  function renderCountdownLibrary(root){const title=document.createElement('div');title.className='section-heading';title.textContent='СЧЁТЧИКИ И ТАЙМЕРЫ';root.append(title);const grid=document.createElement('div');grid.className='template-grid countdown-library';for(const [style,label]of countdownStyles){const button=document.createElement('button');button.type='button';button.className=`template countdown-card countdown-${style}`;button.title=`Добавить: ${label}. По умолчанию 10 секунд со звуком.`;const preview=document.createElement('strong');preview.textContent=style==='flip'?'00:10':'10';const name=document.createElement('small');name.textContent=label;button.append(preview,name);button.onclick=()=>addCountdown(style);grid.append(button)}root.append(grid)}
  function renderCountdownInspector(root,{track,item}){
    root.classList.add('media-inspector');inspectorHeading(root,'Счётчик',`${track.label} · ${item.countSeconds} с`);const controls=document.createElement('fieldset');controls.className='clip-controls';controls.disabled=track.locked;root.append(controls);
    inspectorTimeField(controls,'Начало на линии',item.start,v=>mutate(()=>moveLinkedStart(item,clamp(v,0,86400))),{min:0});
    inspectorField(controls,'Время счёта, с',item.countSeconds,v=>changeCountdown(item,()=>{item.countSeconds=clamp(Math.round(v),1,3600);item.sourceIn=0;item.speed=1;item.duration=item.countSeconds+(item.countHold??1);item.name=`Счётчик · ${item.countSeconds} с`},true),{min:1,max:3600,step:1});
    inspectorField(controls,'Задержка последнего кадра, с',item.countHold??1,v=>changeCountdown(item,()=>{item.countHold=clamp(v,.1,5);item.sourceIn=0;item.speed=1;item.duration=item.countSeconds+item.countHold},true),{min:.1,max:5,step:.1});
    const timing=document.createElement('p');timing.className='note';timing.textContent=`Длительность вставки: ${formatClipTime(item.duration)}. После завершения результат остаётся на экране ${item.countHold??1} с.`;controls.append(timing);
    const appearance=clipSection(controls,'count-style','Оформление');inspectorField(appearance,'Стиль',item.countStyle,v=>mutate(()=>item.countStyle=v),{values:countdownStyles});inspectorField(appearance,'Направление',item.countDirection,v=>mutate(()=>item.countDirection=v),{values:[['down','Обратный отсчёт'],['up','Секундомер']]});inspectorField(appearance,'Формат чисел',item.countFormat||'auto',v=>mutate(()=>item.countFormat=v),{values:[['auto','Автоматически'],['seconds','Секунды'],['clock','Минуты:секунды']]});inspectorField(appearance,'Текст в конце (необязательно)',item.countFinishText||'',v=>mutate(()=>item.countFinishText=v.slice(0,40)),{type:'text'});inspectorField(appearance,'Шрифт',item.font,v=>mutate(()=>item.font=v),{values:textFonts.map(f=>[f,f])});inspectorField(appearance,'Цвет цифр',item.color,v=>mutate(()=>item.color=v),{type:'color'});inspectorField(appearance,'Цвет оформления',item.countAccent,v=>mutate(()=>item.countAccent=v),{type:'color'});clipToggle(appearance,'Подложка под счётчиком',item.countBg!=='transparent',v=>mutate(()=>item.countBg=v?'#171717':'transparent'));if(item.countBg!=='transparent')inspectorField(appearance,'Цвет подложки',item.countBg,v=>mutate(()=>item.countBg=v),{type:'color'});clipToggle(appearance,'Пульсация цифр',item.countPulse!==false,v=>mutate(()=>item.countPulse=v));
    const position=clipSection(controls,'count-position','Размер и положение');clipSlider(position,item,'size','Размер',item.size||140,40,300,1,v=>item.size=v,v=>`${Math.round(v)} px`);for(const [key,label]of [['x','По горизонтали'],['y','По вертикали']])clipSlider(position,item,key,label,item[key]||0,-100,100,.1,v=>item[key]=v,v=>`${v.toFixed(1)}%`);clipSlider(position,item,'scale','Масштаб',(item.scale||1)*100,10,300,1,v=>item.scale=v/100,v=>`${Math.round(v)}%`);clipSlider(position,item,'opacity','Непрозрачность',(item.opacity??1)*100,0,100,1,v=>item.opacity=v/100,v=>`${Math.round(v)}%`);
    const sound=clipSection(controls,'count-sound','Звук');inspectorField(sound,'Каждую секунду',item.countSound||'none',v=>changeCountdown(item,()=>item.countSound=v,true),{values:[['none','Без тиканья'],['tick','Щелчок'],['beep','Сигнал']]});inspectorField(sound,'Когда звучать',item.countSoundWindow||'last10',v=>changeCountdown(item,()=>item.countSoundWindow=v,true),{values:[['last10','Только последние 10 секунд'],['all','На всём счёте']]});clipToggle(sound,'Сигнал завершения',!!item.countFinishSound,v=>changeCountdown(item,()=>item.countFinishSound=v,true));const note=document.createElement('p');note.className='note';const audio=linkedEntries(item).find(e=>e.item.kind==='audio'&&e.item.timerOwnerId);note.textContent=audio?'Счётчик и звук связаны: перемещаются и обрезаются вместе. Чтобы удалить только звук, сначала отвяжите его.':item.countAudioLinked===false?'Звук отвязан. Можно перемещать или удалить его отдельно; изменение счётчика не вернёт звук автоматически.':'Звук выключен в настройках счётчика.';sound.append(note);
    if(audio){const unlink=document.createElement('button');unlink.type='button';unlink.className='sidebar-action';unlink.textContent='Отвязать звук';unlink.disabled=audio.track.locked;unlink.onclick=()=>{selected={kind:'item',id:item.id};unlinkSelected()};sound.append(unlink)}
    else if(item.countAudioLinked===false){const restore=document.createElement('button');restore.type='button';restore.className='sidebar-action';restore.textContent='Добавить новый связанный звук';restore.onclick=()=>changeCountdown(item,()=>{item.countAudioLinked=true;if(item.countSound==='none'&&!item.countFinishSound)item.countSound='beep'},true);sound.append(restore)}
    const del=document.createElement('button');del.type='button';del.className='danger';del.textContent=audio?'Удалить счётчик и связанный звук':'Удалить счётчик';del.onclick=()=>{if(linkedEntries(item).some(e=>e.track.locked))return toast('Разблокируйте связанные дорожки');mutate(()=>{const ids=new Set([item.id,...linkedEntries(item).map(e=>e.item.id)]);for(const t of tracks())t.items=t.items.filter(i=>!ids.has(i.id));selected=null})};controls.append(del);
  }

  function renderTextSidebar(root){const groups=[['ЗАГОЛОВКИ И ТЕКСТ',[['title','Заголовок'],['subtitle','Субтитр'],['caption','Подпись'],['typewriter','Печатный']]],['НИЖНИЕ ПОДПИСИ',[['lower','Имя'],['accent','Акцент'],['label','Ярлык']]],['ФИГУРЫ',[['shape-rectangle','Прямоугольник'],['shape-ellipse','Эллипс']]]];for(const [heading,templates] of groups){const h=document.createElement('div');h.className='section-heading';h.textContent=heading;root.append(h);const grid=document.createElement('div');grid.className='template-grid';for(const [style,name] of templates){const b=document.createElement('button');b.className=`template ${style}`;b.innerHTML=style.startsWith('shape')?`<span><i class="shape-sample ${style==='shape-ellipse'?'ellipse':''}"></i>${name}</span>`:`<span>${name}</span>`;b.onclick=()=>addText(style);grid.append(b)}root.append(grid)}}
  function renderTransitionSidebar(root){const h=document.createElement('div');h.className='section-heading';h.textContent='ПЕРЕХОД НА ВЫБРАННЫЙ КЛИП';root.append(h);const p=document.createElement('p');p.className='sidebar-caption';p.textContent='Перетащите переход на видео или текст. Переход действует в начале ячейки. Крестик на ячейке удаляет переход; правая ручка меняет его длительность.';root.append(p);const grid=document.createElement('div');grid.className='transition-row';const options=[['none','Без перехода','–'],['dissolve','Плавный','◒'],['fade','Через чёрный','◐'],['slide-left','Сдвиг влево','⇠'],['slide-right','Сдвиг вправо','⇢'],['wipe','Шторка','▨'],['zoom','Приближение','⊕']];for(const [value,label,icon] of options){const b=document.createElement('button');b.className='transition-card';b.draggable=false;if(value!=='none')b.onpointerdown=e=>startTransitionDrag(e,value,b);b.innerHTML=`<span class="transition-icon">${icon}</span>${label}`;b.onclick=()=>{if(b.dataset.dragged==='1'){b.dataset.dragged='0';return}const entries=selectedEntries().filter(({track,item})=>canHaveTransition(track,item));if(!entries.length)return toast('Выберите видео, фото или текст. Звуку переходы не добавляются.');if(entries.some(e=>e.track.locked))return toast('Разблокируйте дорожки');mutate(()=>{for(const {item} of entries){item.transitionIn=value;item.transitionDuration=value==='none'?0:Math.min(.65,item.duration)}});toast(`Переход: ${label}`)};grid.append(b)}root.append(grid)}
  let subtitleDrawMode=false,subtitleTrackId=null,subtitlePlayUntil=null,subtitleSearch='';
  function subtitleWorkshopTrack(create=false){
    let track=findTrack(subtitleTrackId);if(track?.type==='text')return track;
    track=tracks().find(t=>t.type==='text'&&!t.locked&&(t.subtitleWorkshop||t.items.length&&t.items.every(i=>i.kind==='subtitle')));
    if(!track&&create)mutate(()=>{track=defaultTrack('text',nextTrackNumber('text'));track.subtitleWorkshop=true;tracks().unshift(track)});
    subtitleTrackId=track?.id||null;return track;
  }
  function focusSubtitleEditor(){
    if($('togglePropertiesPanelBtn').getAttribute('aria-expanded')==='false')$('togglePropertiesPanelBtn').click();
    const input=document.querySelector('[data-text-editor]');if(!input)return;const details=input.closest('details');if(details)details.open=true;input.focus();input.select();
  }
  function subtitleZoneRange(anchor,target,items){
    if(!Number.isFinite(anchor)||!Number.isFinite(target)||anchor<0||anchor>86400)return null;
    if(items.some(i=>anchor>i.start-1e-7&&anchor<i.start+i.duration-1e-7))return null;
    let min=0,max=86400;for(const item of items){if(item.start+item.duration<=anchor+1e-7)min=Math.max(min,item.start+item.duration);if(item.start>=anchor-1e-7)max=Math.min(max,item.start)}
    const end=clamp(target,min,max),start=Math.min(anchor,end),finish=Math.max(anchor,end);return finish-start>=.04?{start,end:finish}:null;
  }
  function createSubtitleZone(track,start,end){
    if(!track||findTrack(track.id)!==track||track.type!=='text'||track.locked||exporting||!Number.isFinite(start)||!Number.isFinite(end)||start<0||end>86400||end-start<.04)return null;
    if(track.items.some(i=>i.start<end-1e-7&&i.start+i.duration>start+1e-7)){toast('Зона пересекает другую ячейку. Выберите свободное место.');return null}
    const template=[...track.items].reverse().find(i=>i.kind==='subtitle');let item;
    mutate(()=>{track.subtitleWorkshop=true;item={id:uid(),kind:'subtitle',style:'subtitle',text:'',start,duration:end-start,size:42,color:'#ffffff',outline:'#000000',outlineWidth:3,x:0,y:25,scale:1,rotation:0,opacity:1,fadeIn:0,fadeOut:0,font:'Arial',bold:true,align:'center'};if(template)for(const key of ['size','color','outline','outlineWidth','x','y','scale','font','bold','italic','align','bg'])if(template[key]!=null)item[key]=template[key];track.items.push(item);selected={kind:'item',id:item.id}});
    pause();seek(start);focusSubtitleEditor();return item;
  }
  function addSubtitleOnCursor(){const track=subtitleWorkshopTrack(true);if(track.locked)return toast('Разблокируйте дорожку субтитров');const range=subtitleZoneRange(playhead,playhead+2,track.items);if(!range)return toast('На курсоре уже есть ячейка. Выберите свободное место.');return createSubtitleZone(track,range.start,range.end)}
  function toggleSubtitleDrawing(){
    if(exporting)return;subtitleDrawMode=!subtitleDrawMode;if(subtitleDrawMode){const track=subtitleWorkshopTrack(true);if(track.locked){subtitleDrawMode=false;return toast('Разблокируйте дорожку субтитров')}
      if($('app').classList.contains('timeline-collapsed'))$('toggleTimelineBtn')?.click();
      if($('toggleMediaPanelBtn').getAttribute('aria-expanded')==='false')$('toggleMediaPanelBtn').click();
      status(`Мастерская субтитров: протяните свободный участок на ${track.label}, затем напишите текст.`);
    }else status('Рисование зон выключено');renderSidebar();renderTimeline();
    const lane=[...document.querySelectorAll('.lane')].find(el=>el.dataset.trackId===subtitleTrackId);if(subtitleDrawMode)lane?.scrollIntoView({block:'nearest',inline:'nearest'});
  }
  function bindSubtitleZoneDrawing(lane,track){
    if(!subtitleDrawMode||tab!=='subtitles'||track.id!==subtitleWorkshopTrack()?.id)return;
    lane.classList.add('subtitle-draw-lane');lane.title=`${track.label}: протяните мышкой свободный участок, чтобы создать субтитр. Края существующей ячейки меняют время.`;
    lane.onclick=e=>{if(e.target===lane)seek((e.clientX-lane.getBoundingClientRect().left)/zoom,true)};
    lane.onpointerdown=e=>{
      if(e.button!==0||e.target!==lane||track.locked||exporting)return;document.activeElement?.blur();e.preventDefault();e.stopPropagation();pause();
      const anchor=clamp((e.clientX-lane.getBoundingClientRect().left)/zoom,0,86400),origin=e.clientX;let range=null,moved=false;
      const draft=document.createElement('div');draft.className='subtitle-zone-draft';lane.append(draft);lane.setPointerCapture(e.pointerId);
      lane.onpointermove=ev=>{if(Math.abs(ev.clientX-origin)>4)moved=true;if(!moved)return;const viewport=$('timelineScroll'),bounds=viewport.getBoundingClientRect();if(ev.clientX>bounds.right-24)viewport.scrollLeft+=12;else if(ev.clientX<bounds.left+24)viewport.scrollLeft=Math.max(0,viewport.scrollLeft-12);range=subtitleZoneRange(anchor,(ev.clientX-lane.getBoundingClientRect().left)/zoom,track.items);draft.hidden=!range;if(range){draft.style.left=`${range.start*zoom}px`;draft.style.width=`${(range.end-range.start)*zoom}px`;draft.textContent=`${timecode(range.start)} — ${timecode(range.end)} · ${(range.end-range.start).toFixed(3)} с`}};
      const clear=()=>{draft.remove();lane.onpointermove=null;lane.onpointerup=null;lane.onpointercancel=null};
      lane.onpointerup=ev=>{if(lane.hasPointerCapture(ev.pointerId))lane.releasePointerCapture(ev.pointerId);clear();if(moved&&range&&subtitleDrawMode&&tab==='subtitles')createSubtitleZone(track,range.start,range.end);else seek(anchor,true)};
      lane.onpointercancel=()=>clear();
    };
  }
  function subtitleReadingInfo(item){const text=String(item.text||''),chars=Array.from(text.replace(/\n/g,'')).length,longest=Math.max(0,...text.split('\n').map(line=>Array.from(line).length)),cps=chars/Math.max(.04,item.duration),issues=[];if(!text.trim())issues.push('Нет текста');if(cps>17)issues.push('Быстро читается: сократите текст или удлините зону');if(longest>42)issues.push('Длинная строка: добавьте перенос');if(text.split('\n').length>2)issues.push('Больше двух строк');return {chars,longest,cps,issues}}
  function updateSubtitleWorkshopUI(){
    for(const row of document.querySelectorAll('.subtitle-row[data-subtitle-id]')){const found=findItem(row.dataset.subtitleId);if(!found)continue;const {item}=found;row.classList.toggle('selected',selectedItemIds().includes(item.id));row.querySelector('small').textContent=`${timecode(item.start)} — ${timecode(item.start+item.duration)}`;row.querySelector('.subtitle-row-text').textContent=item.text||'Новая реплика — введите текст';row.title=subtitleReadingInfo(item).issues.join('\n')}
    const output=$('subtitleReadability'),item=selected?.kind==='item'&&findItem(selected.id)?.item;if(output&&item?.kind==='subtitle'){const info=subtitleReadingInfo(item);output.textContent=`${info.cps.toFixed(1)} зн/с · строка ${info.longest} · всего ${info.chars}${info.issues.length?'\n'+info.issues.join(' · '):''}`;output.classList.toggle('needs-attention',!!info.issues.length)}
  }
  function setSubtitleBoundary(item,key){const end=item.start+item.duration;if(key==='start'){if(playhead>=end-.04)return toast('Начало должно быть раньше конца реплики');mutate(()=>{item.start=Math.max(0,playhead);item.duration=end-item.start})}else{if(playhead<=item.start+.04)return toast('Конец должен быть позже начала реплики');mutate(()=>item.duration=playhead-item.start)}}
  function playSubtitleCue(item){pause();seek(item.start);subtitlePlayUntil=item.start+item.duration;play()}
  function renderSubtitleCueTools(controls,item){
    const actions=document.createElement('div');actions.className='subtitle-cue-actions';
    for(const [label,action] of [['Начало на курсоре',()=>setSubtitleBoundary(item,'start')],['Конец на курсоре',()=>setSubtitleBoundary(item,'end')],['Просмотреть реплику',()=>playSubtitleCue(item)]]){const button=document.createElement('button');button.type='button';button.textContent=label;button.title=label==='Начало на курсоре'?'Начало на курсоре ([ / Х)':label==='Конец на курсоре'?'Конец на курсоре (] / Ъ)':'Воспроизвести только выбранную реплику';button.onclick=action;actions.append(button)}controls.append(actions);
    const output=document.createElement('p');output.id='subtitleReadability';output.className='subtitle-readability';output.title='Ориентиры для ручной проверки: до 17 знаков в секунду, до 42 знаков в строке и до двух строк.';controls.append(output);
    queueMicrotask(updateSubtitleWorkshopUI);
  }
  function renderSubtitleSidebar(root){
    if(subtitleDrawMode&&!subtitleWorkshopTrack())subtitleDrawMode=false;
    const title=document.createElement('h3');title.className='subtitle-workshop-title';title.textContent='Мастерская субтитров';root.append(title);
    const draw=document.createElement('button');draw.type='button';draw.id='subtitleDrawBtn';draw.className='sidebar-action'+(subtitleDrawMode?' active':'');draw.textContent=subtitleDrawMode?'Рисование зон включено':'Рисовать зоны мышкой';draw.setAttribute('aria-pressed',String(subtitleDrawMode));draw.onclick=toggleSubtitleDrawing;root.append(draw);
    const note=document.createElement('p');note.className='sidebar-caption';const track=subtitleWorkshopTrack();note.textContent=subtitleDrawMode&&track?`Протяните участок на ${track.label} → введите текст справа. Края меняют время, середина — положение. Esc выключает рисование.`:'Включите рисование и выделяйте мышкой время каждой реплики на дорожке T. Текст и оформление редактируются справа.';root.append(note);
    const buttons=document.createElement('div');buttons.className='subtitle-file-actions';for(const [label,action]of [['Импорт SRT / VTT',()=>$('srtInput').click()],['Добавить на курсоре',addSubtitleOnCursor]]){const button=document.createElement('button');button.type='button';button.className='sidebar-action';button.textContent=label;button.title=label==='Добавить на курсоре'?'Новая реплика на курсоре (Alt+N / Alt+Т)':label;button.onclick=action;buttons.append(button)}root.append(buttons);
    const search=document.createElement('input');search.type='search';search.id='subtitleSearch';search.placeholder='Найти текст реплики';search.setAttribute('aria-label','Поиск по субтитрам');search.value=subtitleSearch;search.oninput=()=>{subtitleSearch=search.value;renderSubtitleList(list,count)};root.append(search);
    const count=document.createElement('p');count.className='sidebar-caption';const list=document.createElement('div');list.className='subtitle-workshop-list';root.append(count,list);renderSubtitleList(list,count);
    if(visiblePlaybackItems().some(({item})=>item.kind==='subtitle')){const save=document.createElement('button');save.type='button';save.className='sidebar-action';save.textContent='Скачать SRT';save.onclick=downloadSrt;root.append(save)}
  }
  function renderSubtitleList(list,count){
    list.replaceChildren();const all=visiblePlaybackItems().filter(({item})=>item.kind==='subtitle').sort((a,b)=>a.item.start-b.item.start),subtitles=all.filter(({item})=>String(item.text||'').toLocaleLowerCase('ru-RU').includes(subtitleSearch.toLocaleLowerCase('ru-RU')));count.textContent=`Реплики: ${subtitles.length} из ${all.length}`;
    for(const {item,track} of subtitles){const row=document.createElement('button');row.type='button';row.className='subtitle-row'+(selectedItemIds().includes(item._compoundRoot||item.id)?' selected':'');row.dataset.subtitleId=item.id;const meta=document.createElement('small');meta.textContent=`${timecode(item.start)} — ${timecode(item.start+item.duration)}`;const text=document.createElement('span');text.className='subtitle-row-text';text.textContent=item.text||'Новая реплика — введите текст';row.append(meta,text);row.title=subtitleReadingInfo(item).issues.join('\n');row.onclick=e=>{if(!item._compoundRoot)subtitleTrackId=track.id;pause();selectItem(item._compoundRoot||item.id,e.shiftKey);seek(item.start);if(!e.shiftKey)focusSubtitleEditor()};list.append(row)}
    if(!subtitles.length){const p=document.createElement('p');p.className='sidebar-caption';p.textContent=all.length?'Реплики не найдены.':'Нарисуйте первую зону или импортируйте SRT / VTT.';list.append(p)}
  }
  function formatClipTime(seconds){
    const total=Math.max(0,Math.round((Number(seconds)||0)*1000)),whole=Math.floor(total/1000);
    return [Math.floor(whole/3600),Math.floor(whole/60)%60,whole%60].map(n=>String(n).padStart(2,'0')).join(':')+':'+String(total%1000).padStart(3,'0');
  }
  function parseClipTime(text){
    const value=String(text).trim();if(/^\d+(?:[.,]\d+)?$/.test(value))return Number(value.replace(',','.'));
    const match=/^(\d{2}):(\d{2}):(\d{2}):(\d{3})$/.exec(value);if(!match)return null;
    const [hours,minutes,seconds,milliseconds]=match.slice(1).map(Number);if(minutes>=60||seconds>=60)return null;
    return hours*3600+minutes*60+seconds+milliseconds/1000;
  }
  function inspectorTimeField(parent,label,value,onChange,options={}){
    const wrap=document.createElement('label');wrap.className='clip-time-field';wrap.textContent=label;
    const input=document.createElement('input');input.type='text';input.value=formatClipTime(value);input.placeholder='00:00:00:000';input.spellcheck=false;input.autocomplete='off';input.setAttribute('aria-label',label);input.title=`Часы:минуты:секунды:миллисекунды. Например, 00:00:16:250 — 16 секунд 250 мс. Также можно ввести число секунд.`;
    let cancelled=false;input.oninput=()=>{cancelled=false;input.setCustomValidity('');input.removeAttribute('aria-invalid')};
    input.onchange=()=>{if(cancelled)return;const parsed=parseClipTime(input.value);if(parsed===null||!Number.isFinite(parsed)){input.setCustomValidity('Введите ЧЧ:ММ:СС:ммм. Часы — 2 цифры, минуты и секунды — от 00 до 59, миллисекунды — 3 цифры от 000 до 999.');input.setAttribute('aria-invalid','true');input.reportValidity();return}input.setCustomValidity('');input.removeAttribute('aria-invalid');const next=clamp(parsed,options.min??0,options.max??86400);input.value=formatClipTime(next);if(Math.abs(next-value)>1e-9)onChange(next)};
    input.onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();e.stopPropagation();input.blur()}else if(e.key==='Escape'){e.preventDefault();e.stopPropagation();cancelled=true;input.value=formatClipTime(value);input.setCustomValidity('');input.removeAttribute('aria-invalid');input.blur()}};
    wrap.append(input);parent.append(wrap);return input;
  }
  function inspectorField(parent,label,value,onChange,options={}){const wrap=document.createElement('label');wrap.textContent=label;let input;if(options.values){input=document.createElement('select');for(const [val,name] of options.values){const o=document.createElement('option');o.value=val;o.textContent=name;input.append(o)}}else if(options.multiline)input=document.createElement('textarea');else{input=document.createElement('input');input.type=options.type||'number';if(options.min!=null)input.min=options.min;if(options.max!=null)input.max=options.max;if(options.step!=null)input.step=options.step}input.value=value;input.onchange=()=>onChange(options.type==='text'||options.type==='color'||options.multiline||options.values?input.value:number(input.value));wrap.append(input);parent.append(wrap);return input}
  function inspectorHeading(parent,title,meta=''){const h=document.createElement('h2');h.textContent=title;if(meta){const m=document.createElement('span');m.className='meta';m.textContent=meta;h.append(m)}parent.append(h);parent.append(document.createElement('hr'))}
  function sectionLabel(parent,text){const h=document.createElement('div');h.className='section-label';h.textContent=text;parent.append(h)}
  function renderInspector(){updateVideoToolButtons();const root=$('inspectorContent');root.replaceChildren();root.classList.remove('media-inspector');if(selected?.kind==='items'){renderMultipleInspector(root);return}if(selected?.kind==='item'){const found=findItem(selected.id);if(found){if(found.item.kind==='compound')renderCompoundInspector(root,found);else if(['video','image','audio'].includes(found.item.kind)){renderMediaInspector(root,found);appendUnlinkPropertyButton(root);}else if(found.item.kind==='countdown')renderCountdownInspector(root,found);else if(['title','subtitle'].includes(found.item.kind))renderTextInspector(root,found);else renderItemInspector(root,found);if(found.track.type==='text')renderTextTransitionControls(root,found.item,found.track);renderKeyframes(root,found.item);if(['title','subtitle'].includes(found.item.kind)){const save=document.createElement('button');save.type='button';save.className='sidebar-action';save.textContent='Сохранить оформление как шаблон';save.onclick=()=>saveTextTemplate(found.item);root.append(save)}return}}if(selected?.kind==='track'){const track=findTrack(selected.id);if(track){renderTrackInspector(root,track);return}}renderProjectInspector(root)}
  function renderProjectInspector(root){
    const size=projectFrameSize();inspectorHeading(root,'Проект',`${size.width}×${size.height} · ${project.fps}`);
    const label=document.createElement('label');label.textContent='Формат кадра';root.append(label);
    const segment=document.createElement('div');segment.className='segmented frame-presets';
    for(const ratio of [...framePresets,'custom']){const b=document.createElement('button');b.type='button';b.textContent=ratio==='custom'?'Свой размер':ratio;b.className=project.ratio===ratio?'active':'';b.onclick=()=>mutate(()=>selectFramePreset(ratio));segment.append(b)}root.append(segment);
    if(project.ratio==='custom'){
      const row=document.createElement('div');row.className='field-row';root.append(row);
      inspectorField(row,'Ширина, px',size.width,value=>mutate(()=>setProjectFrame(value,projectFrameSize().height)),{min:1,max:8192,step:1});
      inspectorField(row,'Высота, px',size.height,value=>mutate(()=>setProjectFrame(projectFrameSize().width,value)),{min:1,max:8192,step:1});
    }else{
      const options=[480,720,1080,1440,2160];if(!options.includes(project.resolution))options.push(project.resolution);options.sort((a,b)=>a-b);
      inspectorField(root,'Разрешение',project.resolution,value=>mutate(()=>{const [w,h]=ratioParts();setProjectFrame(Math.round(number(value)*w/h),number(value),project.ratio)}),{values:options.map(value=>[String(value),`${value}p`])});
    }
    const auto=document.createElement('button');auto.type='button';auto.className='sidebar-action';auto.textContent='По первому видео';auto.disabled=!currentMediaAssets().some(a=>a.type==='video'&&a.width>0&&a.height>0);auto.title='Установить размеры кадра по первому видео в Медиа';auto.onclick=()=>autoFrameFromFirstVideo(true);root.append(auto);
    const hint=document.createElement('p');hint.className='note';hint.textContent=frameAutoPending()?'Первое загруженное видео автоматически задаст ширину, высоту и пропорции проекта.':'Следующие видео не меняют формат проекта. Для произвольных размеров выберите «Свой размер».';root.append(hint);
    inspectorField(root,'Частота кадров',project.fps,value=>mutate(()=>{project.fps=number(value);draw()}),{values:[['24','24 fps'],['25','25 fps'],['30','30 fps'],['60','60 fps']]});
    sectionLabel(root,'ПУСТОЕ ПРОСТРАНСТВО');const mode=document.createElement('div');mode.className='segmented';for(const [value,name] of [['color','Цвет'],['blur','Размытое видео']]){const b=document.createElement('button');b.textContent=name;b.className=(project.bgMode||'color')===value?'active':'';b.onclick=()=>mutate(()=>{project.bgMode=value;draw()});mode.append(b)}root.append(mode);inspectorField(root,'Цвет фона',project.bg,v=>mutate(()=>{project.bg=v;draw()}),{type:'color'});const note=document.createElement('p');note.className='note';note.textContent='Файлы остаются на этом компьютере. Проект сохраняется в браузере автоматически, а копию JSON можно скачать кнопкой сверху.';root.append(note)}
  function renderTrackInspector(root,track){inspectorHeading(root,`Дорожка ${track.label}`);inspectorField(root,'Название',track.label,v=>mutate(()=>track.label=v),{type:'text'});for(const [key,label] of [['locked','Заблокировать'],['hidden','Скрыть из просмотра'],['muted','Выключить звук'],['solo','Слушать только эту дорожку']]){if(track.type!=='audio'&&['muted','solo'].includes(key))continue;const row=document.createElement('label');row.className='checkbox-row';const box=document.createElement('input');box.type='checkbox';box.checked=!!track[key];box.onchange=()=>mutate(()=>track[key]=box.checked);row.append(box,document.createTextNode(label));root.append(row)}const remove=document.createElement('button');remove.className='danger';remove.textContent='Удалить дорожку';remove.onclick=()=>removeTrack(track.id);root.append(remove)}
  function renderItemInspector(root,{track,item}){const asset=assets.get(item.assetId);inspectorHeading(root,item.kind==='subtitle'?'Субтитр':item.kind==='title'?'Текст':item.kind==='shape'?'Фигура':asset?.name||'Клип',`${item.duration.toFixed(2)} с`);if(['title','subtitle','shape','countdown'].includes(item.kind)){if(item.kind!=='shape')renderTextControls(root,item);else inspectorField(root,'Форма',item.style,v=>mutate(()=>item.style=v),{values:[['shape-rectangle','Прямоугольник'],['shape-ellipse','Эллипс']]});inspectorField(root,'Цвет',item.color,v=>mutate(()=>item.color=v),{type:'color'});if(item.kind!=='shape'){inspectorField(root,'Размер текста',item.size,v=>mutate(()=>item.size=clamp(v,12,400)),{min:12,max:400,step:1});inspectorField(root,'Толщина обводки',item.outlineWidth??3,v=>mutate(()=>item.outlineWidth=clamp(v,0,15)),{min:0,max:15,step:1})}}sectionLabel(root,'ВРЕМЯ');const timeRow=document.createElement('div');timeRow.className='field-row';root.append(timeRow);inspectorTimeField(timeRow,'Начало',item.start,v=>mutate(()=>moveLinkedStart(item,clamp(v,0,86400))),{min:0,step:.01});inspectorTimeField(timeRow,'Длительность',item.duration,v=>mutate(()=>item.duration=clamp(v,.04,itemMaxDuration(item))),{min:.04,step:.01});if(item.assetId){inspectorField(root,'Пропустить в начале файла, с',item.sourceIn||0,v=>mutate(()=>setSourceIn(item,v)),{min:0,step:.01});inspectorField(root,'Скорость',item.speed||1,v=>mutate(()=>{item.speed=clamp(v,.25,4);item.duration=Math.min(item.duration,itemMaxDuration(item))}),{min:.25,max:4,step:.05})}sectionLabel(root,'ИЗОБРАЖЕНИЕ');if(item.kind!=='audio'){const row=document.createElement('div');row.className='field-row';root.append(row);inspectorField(row,'X, %',item.x||0,v=>mutate(()=>item.x=clamp(v,-200,200)),{min:-200,max:200,step:1});inspectorField(row,'Y, %',item.y||0,v=>mutate(()=>item.y=clamp(v,-200,200)),{min:-200,max:200,step:1});inspectorField(root,'Масштаб',item.scale??1,v=>mutate(()=>item.scale=clamp(v,.1,5)),{min:.1,max:5,step:.05});inspectorField(root,'Поворот, °',item.rotation||0,v=>mutate(()=>item.rotation=clamp(v,-360,360)),{min:-360,max:360,step:1});inspectorField(root,'Прозрачность',item.opacity??1,v=>mutate(()=>item.opacity=clamp(v,0,1)),{min:0,max:1,step:.05})}if(item.kind==='video'||item.kind==='image'){sectionLabel(root,'ЦВЕТ');for(const [key,label] of [['brightness','Яркость'],['contrast','Контраст'],['saturation','Насыщенность']])inspectorField(root,label,item[key]??1,v=>mutate(()=>item[key]=clamp(v,0,3)),{min:0,max:3,step:.05});const row=document.createElement('div');row.className='field-row';root.append(row);for(const [key,label] of [['flipH','Отразить ↔'],['flipV','Отразить ↕']]){const b=document.createElement('button');b.className='sidebar-action';b.textContent=label;b.onclick=()=>mutate(()=>item[key]=!item[key]);row.append(b)}}if(item.kind==='video'){const note=document.createElement('p');note.className='note';note.textContent='V — только изображение. Звук редактируется отдельно на дорожках S.';root.append(note)}if(item.kind==='audio'&&track.type==='audio')inspectorField(root,'Громкость',item.volume??1,v=>mutate(()=>item.volume=clamp(v,0,1)),{min:0,max:1,step:.05});sectionLabel(root,'ПЛАВНОСТЬ');const row2=document.createElement('div');row2.className='field-row';root.append(row2);inspectorField(row2,'Появление, с',item.fadeIn||0,v=>mutate(()=>item.fadeIn=clamp(v,0,item.duration)),{min:0,step:.1});inspectorField(row2,'Исчезновение, с',item.fadeOut||0,v=>mutate(()=>item.fadeOut=clamp(v,0,item.duration)),{min:0,step:.1});const del=document.createElement('button');del.className='danger';del.textContent='Удалить клип';del.onclick=()=>removeItem(item.id);root.append(del)}
  function itemMaxDuration(item){item=item._compound||item;if(item.kind==='compound')return Math.max(.04,item.contentDuration-(item.sourceIn||0));const asset=assets.get(item.assetId);return asset?.type==='video'||asset?.type==='audio'?Math.max(.04,(asset.duration-(item.sourceIn||0))/(item.speed||1)):3600}
  const clipLooks={
    original:{brightness:1,contrast:1,saturation:1,temperature:0,vignette:0,sepia:0},
    bw:{brightness:1,contrast:1.08,saturation:0,temperature:0,vignette:0,sepia:0},
    sepia:{brightness:1.02,contrast:1.02,saturation:.65,temperature:0,vignette:.08,sepia:.85},
    vivid:{brightness:1.02,contrast:1.16,saturation:1.4,temperature:0,vignette:0,sepia:0},
    faded:{brightness:1.08,contrast:.78,saturation:.72,temperature:8,vignette:0,sepia:0},
    noir:{brightness:1,contrast:1.35,saturation:0,temperature:0,vignette:.28,sepia:0},
    warm:{brightness:1.02,contrast:1.06,saturation:1.12,temperature:45,vignette:.08,sepia:0},
    cool:{brightness:1,contrast:1.08,saturation:1.03,temperature:-45,vignette:.08,sepia:0}
  };
  const clipSectionState=new Map();
  function setSourceIn(item,value){
    if(item._compound){const group=item._compound,end=Math.min(group.contentDuration,(group.sourceIn||0)+group.duration);group.sourceIn=clamp(value,0,Math.max(0,end-.04));group.duration=end-group.sourceIn;return}
    const speed=item.speed||1,previousIn=item.sourceIn||0,asset=assets.get(item.assetId);
    const end=Math.min(asset?.duration??Infinity,previousIn+item.duration*speed);
    item.sourceIn=clamp(value,0,Math.max(0,end-.04*speed));
    item.duration=Math.max(.04,(end-item.sourceIn)/speed);
    item.fadeIn=Math.min(item.fadeIn||0,item.duration);item.fadeOut=Math.min(item.fadeOut||0,item.duration);
  }
  function setClipSpeed(item,value){if(item._compound)return setCompoundSpeed(item._compound,value);const span=item.duration*(item.speed||1);item.speed=clamp(value,.25,4);item.duration=Math.max(.04,Math.min(span/item.speed,itemMaxDuration(item)));item.fadeIn=Math.min(item.fadeIn||0,item.duration);item.fadeOut=Math.min(item.fadeOut||0,item.duration)}
  function mediaTransform(item,t){const progress=item.kenBurns?clamp((t-item.start)/Math.max(.04,item.duration),0,1):0;const x=keyframeValue(item,'x',t),y=keyframeValue(item,'y',t),scale=keyframeValue(item,'scale',t);return {x:item.keyframes?.x?.length?x:x+((item.motionEndX??x)-x)*progress,y:item.keyframes?.y?.length?y:y+((item.motionEndY??y)-y)*progress,scale:item.keyframes?.scale?.length?scale:scale+((item.motionEndScale??scale*1.15)-scale)*progress}}
  function transitionSeconds(item){return Math.max(0,item.transitionDuration??item.fadeIn??.65)}
  function duplicateClip(item){item=item._compound||item;const found=findItem(item.id);if(!found||found.track.locked)return;let copy;mutate(()=>{copy={...JSON.parse(JSON.stringify(item)),id:uid(),start:item.start+item.duration};clearClipLinks(copy);found.track.items.push(copy);if(copy.kind==='countdown')rebuildCountdownSound(copy)});selectItem(copy.id);seek(copy.start)}
  function clipSection(parent,key,title,reset){
    const details=document.createElement('details');details.className='clip-section';details.open=clipSectionState.get(key)??true;details.ontoggle=()=>clipSectionState.set(key,details.open);
    const summary=document.createElement('summary');const text=document.createElement('span');text.textContent=title;summary.append(text);
    if(reset){const button=document.createElement('button');button.type='button';button.className='section-reset';button.textContent='Сбросить';button.onclick=e=>{e.preventDefault();e.stopPropagation();reset()};summary.append(button)}
    const body=document.createElement('div');body.className='clip-section-body';details.append(summary,body);parent.append(details);return body;
  }
  function clipSlider(parent,item,key,label,value,min,max,step,apply,format=v=>String(v)){
    const wrap=document.createElement('div');wrap.className='clip-slider';const head=document.createElement('div');head.className='clip-slider-head';
    const name=document.createElement('label');const id=`clip-${item.id}-${key}`;name.htmlFor=id;name.textContent=label;
    const numberInput=document.createElement('input');numberInput.type='number';numberInput.id=`${id}-number`;numberInput.min=min;numberInput.max=max;numberInput.step=step;numberInput.value=Number(value.toFixed(3));numberInput.setAttribute('aria-label',`${label}: точное значение`);numberInput.title='Можно ввести точное значение';
    const output=document.createElement('output');output.textContent=format(value);head.append(name,output,numberInput);
    const range=document.createElement('input');range.type='range';range.id=id;range.min=min;range.max=max;range.step=step;range.value=value;range.setAttribute('aria-label',label);range.setAttribute('aria-valuetext',format(value));
    let before=null;
    const begin=()=>{if(before===null)before=JSON.stringify(project)};
    const live=raw=>{begin();const v=clamp(number(raw),min,max);apply(v);range.value=v;range.setAttribute('aria-valuetext',format(v));numberInput.value=Number(v.toFixed(3));output.textContent=format(v);syncElements(true);draw();queueSave()};
    const commit=()=>{if(before!==null&&JSON.stringify(project)!==before){recordChange(before);queueSave();renderTimeline();if(key==='speed'){const focusId=document.activeElement?.id;before=null;renderInspector();if(focusId)document.getElementById(focusId)?.focus({preventScroll:true})}}before=null};
    range.onpointerdown=begin;range.oninput=()=>live(range.value);range.onchange=commit;range.onblur=commit;
    range.onpointercancel=()=>{if(before!==null){project=JSON.parse(before);before=null;refresh()}};
    numberInput.onfocus=begin;numberInput.oninput=()=>{if(numberInput.value!==''&&Number.isFinite(Number(numberInput.value)))live(numberInput.value)};numberInput.onchange=commit;numberInput.onblur=commit;
    wrap.append(head,range);parent.append(wrap);return range;
  }
  function clipToggle(parent,label,checked,change){const row=document.createElement('label');row.className='clip-checkbox';const input=document.createElement('input');input.type='checkbox';input.checked=checked;input.onchange=()=>mutate(()=>change(input.checked));row.append(input,document.createTextNode(label));parent.append(row)}
  function clipChips(parent,values,current,choose){const row=document.createElement('div');row.className='clip-chips';for(const [value,label] of values){const button=document.createElement('button');button.type='button';button.textContent=label;button.className=value===current?'active':'';button.setAttribute('aria-pressed',String(value===current));button.onclick=()=>choose(value);row.append(button)}parent.append(row)}
  function renderTextInspector(root,{track,item}){
    root.classList.add('media-inspector');
    const head=document.createElement('div');head.className='clip-heading';const name=document.createElement('h2');name.textContent=item.kind==='subtitle'?'Субтитр':'Текст';head.append(name);
    const actions=document.createElement('div');actions.className='clip-heading-actions';for(const [icon,label,action] of [['scissors','Разрезать на курсоре',splitAtPlayhead],['layers','Дублировать клип',()=>duplicateClip(item)],['trash','Удалить клип',()=>removeItem(item.id)]]){const button=document.createElement('button');button.type='button';button.title=label;button.setAttribute('aria-label',label);button.disabled=track.locked;button.append(trackIcon(icon));button.onclick=action;actions.append(button)}head.append(actions);root.append(head);
    const note=document.createElement('p');note.className='clip-track-note';note.textContent=`${track.label} · ${item.kind==='subtitle'?'Субтитр':'Текст'}${track.locked?' · Дорожка заблокирована':''}`;root.append(note);
    const controls=document.createElement('fieldset');controls.className='clip-controls';controls.disabled=track.locked;root.append(controls);
    const timeRow=document.createElement('div');timeRow.className='field-row';controls.append(timeRow);
    inspectorTimeField(timeRow,'Начало',item.start,v=>mutate(()=>moveLinkedStart(item,clamp(v,0,86400))),{min:0});
    inspectorTimeField(timeRow,'Длительность',item.duration,v=>mutate(()=>{item.duration=clamp(v,.04,itemMaxDuration(item));item.fadeIn=Math.min(item.fadeIn||0,item.duration);item.fadeOut=Math.min(item.fadeOut||0,item.duration)}),{min:.04});
    if(item.kind==='subtitle'){inspectorTimeField(timeRow,'Конец',item.start+item.duration,v=>mutate(()=>item.duration=clamp(v-item.start,.04,3600)),{min:item.start+.04});renderSubtitleCueTools(controls,item)}
    const text=clipSection(controls,'text-style','Текст и оформление');renderTextControls(text,item);
    inspectorField(text,'Цвет текста',item.color||'#ffffff',v=>mutate(()=>item.color=v),{type:'color'});
    clipSlider(text,item,'size','Размер текста',item.size||56,12,400,1,v=>item.size=v,v=>`${Math.round(v)} px`);
    inspectorField(text,'Цвет обводки',item.outline||'#000000',v=>mutate(()=>item.outline=v),{type:'color'});
    clipSlider(text,item,'outlineWidth','Толщина обводки',item.outlineWidth??3,0,15,.1,v=>item.outlineWidth=v,v=>`${v.toFixed(1)} px`);
    const position=clipSection(controls,'position','Положение и размер',()=>mutate(()=>Object.assign(item,{x:0,y:item.kind==='subtitle'?25:0,scale:1,rotation:0})));
    clipSlider(position,item,'x','По горизонтали',item.x||0,-200,200,.1,v=>item.x=v,v=>`${v.toFixed(1)}%`);
    clipSlider(position,item,'y','По вертикали',item.y||0,-200,200,.1,v=>item.y=v,v=>`${v.toFixed(1)}%`);
    clipSlider(position,item,'scale','Масштаб',(item.scale??1)*100,10,500,1,v=>item.scale=v/100,v=>`${Math.round(v)}%`);
    clipSlider(position,item,'rotation','Поворот',item.rotation||0,-360,360,1,v=>item.rotation=v,v=>`${Math.round(v)}°`);
    const fade=clipSection(controls,'fade','Плавность и видимость',()=>mutate(()=>Object.assign(item,{opacity:1,fadeIn:0,fadeOut:0})));
    clipSlider(fade,item,'opacity','Непрозрачность',(item.opacity??1)*100,0,100,1,v=>item.opacity=v/100,v=>`${Math.round(v)}%`);
    for(const [key,label] of [['fadeIn','Появление'],['fadeOut','Исчезновение']])clipSlider(fade,item,key,label,item[key]||0,0,item.duration,.001,v=>item[key]=v,v=>`${v.toFixed(3)} с`);
  }
  let separationActive=false;
  function renderSeparationControls(parent,item){
    const body=clipSection(parent,'separation','Речь, звуки и музыка');
    const note=document.createElement('p');note.className='note';note.textContent='Любая кнопка разделит выбранный фрагмент на Voice, SFX и Music. Исходная ячейка сохранится без звука. Все три результата будут связаны и начнутся в то же время.';body.append(note);
    for(const [stem,label] of [['speech','Выделить речь'],['effects','Выделить звуки'],['music','Выделить музыку']]){const button=document.createElement('button');button.type='button';button.className='sidebar-action';button.textContent=label;button.disabled=separationActive||!!item._compound;button.onclick=()=>{void separateAudioClip(item.id,stem)};body.append(button)}
    if(item._compound){const help=document.createElement('p');help.className='note';help.textContent='Для разделения выберите исходную звуковую ячейку после разъединения объединённого клипа.';body.append(help)}
  }
  function applySeparatedAudio(sourceId,prepared,focusStem){
    const found=findItem(sourceId);if(!found||found.track.locked)throw Error('Исходная ячейка удалена или дорожка заблокирована');const source=found.item;let focus;
    mutate(()=>{const linkId=source.linkId||uid();source.linkId=linkId;source.muted=true;source.separationResultIds=[];
      let position=tracks().indexOf(found.track);
      for(const {stem,asset} of prepared){const role={speech:'Voice',effects:'SFX',music:'Music'}[stem],n=1+Math.max(0,...tracks().filter(t=>t.audioRole===role||new RegExp('^'+role+'[0-9]+$').test(t.label)).map(t=>Number(t.label.match(/\d+$/)?.[0])||0));
        const track=defaultTrack('audio',n);track.label=role+n;track.audioRole=role;
        const item={id:uid(),kind:'audio',assetId:asset.id,name:role+n+' · '+(source.name||assets.get(source.assetId)?.name||'Звук'),start:source.start,duration:Math.min(source.duration,asset.duration/(source.speed||1)),sourceIn:0,speed:source.speed||1,volume:source.volume??1,muted:false,fadeIn:source.fadeIn||0,fadeOut:source.fadeOut||0,linkId,separationSourceId:sourceId,stem};
        assets.set(asset.id,asset);project.assetManifest??=[];project.assetManifest.push({id:asset.id,name:asset.name,type:'audio'});track.items.push(item);tracks().splice(position++,0,track);source.separationResultIds.push(item.id);if(stem===focusStem)focus=item;
      }project.trackLayoutVersion=1;
    });for(const {asset} of prepared)queueAssetAnalysis(asset);if(focus)selectItem(focus.id);seek(source.start);return focus;
  }
  async function separateAudioClip(id,focusStem){
    if(exporting||separationActive)return;
    const selectedSource=findItem(id)?.item;
    if(selectedSource?.separationSourceId){const original=findItem(selectedSource.separationSourceId)?.item,ready=(original?.separationResultIds||[]).map(findItem).filter(Boolean);if(ready.length===3){const target=ready.find(e=>e.item.stem===focusStem);if(target)selectItem(target.item.id);return toast('Выбран готовый компонент без повторного разделения.')}}
    const found=findItem(id),source=found?.item,asset=assets.get(source?.assetId);
    if(!source||source.kind!=='audio'||found.track.locked)return toast('Выберите звук на разблокированной дорожке');
    if(location.protocol==='file:')return toast('Запустите редактор через «Запустить редактор.bat»');if(!asset?.file)return toast('Загрузите исходное медиа заново');
    const previous=(source.separationResultIds||[]).map(findItem).filter(Boolean);if(previous.length===3){const target=previous.find(e=>e.item.stem===focusStem);if(target)selectItem(target.item.id);return toast('Компоненты этой ячейки уже разделены. Они на Voice, SFX и Music.')}
    const signature=JSON.stringify([source.assetId,source.sourceIn||0,source.duration,source.speed||1]),epoch=projectEpoch,abort=new AbortController(),prepared=[];let jobId,token,cancelled=false,committed=false;
    const dialog=document.createElement('dialog');dialog.className='modal separation-dialog';dialog.setAttribute('aria-label','Разделение звука');const heading=document.createElement('h2');heading.textContent='Речь, звуки и музыка';const status=document.createElement('p');status.className='note';status.setAttribute('role','status');status.textContent='Проверяю локальный аудиодвижок…';const progress=document.createElement('progress');progress.setAttribute('aria-label','Выполняется разделение звука');const cancel=document.createElement('button');cancel.type='button';cancel.className='sidebar-action';cancel.textContent='Отмена';dialog.append(heading,status,progress,cancel);document.body.append(dialog);
    const request=async(url,options={})=>{const response=await fetch('/api/audio-separator'+url,{...options,signal:abort.signal,headers:{'X-Audio-Token':token||'',...options.headers}});if(!response.ok){let message;try{message=(await response.json()).error}catch{}throw Error(message||'Ошибка локального аудиодвижка')}return response};
    const stop=()=>{cancelled=true;abort.abort();dialog.close()};cancel.onclick=stop;dialog.oncancel=e=>{e.preventDefault();stop()};separationActive=true;pause();dialog.showModal();
    try{
      const info=await(await request('/info')).json();if(!info.ready)throw Error(info.error||'Аудиодвижок не установлен');token=info.token;
      status.textContent='Подготавливаю выбранный фрагмент. Файлы остаются на компьютере.';
      const job=await(await request('/jobs?start='+encodeURIComponent(source.sourceIn||0)+'&length='+encodeURIComponent(source.duration*(source.speed||1)),{method:'POST',body:asset.file})).json();jobId=job.id;
      const phases={extracting:'Извлекаю звук выбранного фрагмента…',loading:'Загружаю модель разделения…',separating:'Разделяю речь, музыку и звуки…',saving:'Сохраняю три звуковые дорожки…'};
      while(true){if(epoch!==projectEpoch)throw Error('Проект изменён — результат не добавлен');const state=await(await request('/jobs/'+jobId)).json();if(state.status==='error')throw Error(state.error||'Не удалось разделить звук');if(state.status==='done')break;status.textContent=(phases[state.status]||'Подготавливаю звук…')+(state.gpu?' · видеокарта':'')+(state.total?` · ${state.completed} / ${state.total}`:'');if(state.total){progress.max=state.total;progress.value=state.completed}await new Promise((resolve,reject)=>{const cancelWait=()=>{clearTimeout(timer);reject(Error('Отменено'))},timer=setTimeout(()=>{abort.signal.removeEventListener('abort',cancelWait);resolve()},1000);abort.signal.addEventListener('abort',cancelWait,{once:true})})}
      status.textContent='Добавляю Voice, SFX и Music…';
      for(const stem of ['speech','effects','music']){const blob=await(await request('/jobs/'+jobId+'/'+stem)).blob(),file=new File([blob],asset.name.replace(/\.[^.]+$/,'')+'-'+stem+'.wav',{type:'audio/wav'}),url=URL.createObjectURL(file);try{const meta=await mediaMetadata(file,url,'audio');prepared.push({stem,asset:{id:uid(),name:file.name,type:'audio',file,url,...meta,stored:false}})}catch(e){URL.revokeObjectURL(url);throw e}}
      const current=findItem(id)?.item;if(cancelled||epoch!==projectEpoch||!current||JSON.stringify([current.assetId,current.sourceIn||0,current.duration,current.speed||1])!==signature)throw Error('Исходный фрагмент изменён — результат не добавлен');
      applySeparatedAudio(id,prepared,focusStem);committed=true;toast('Созданы Voice, SFX и Music. Исходный звук приглушён. Ctrl+Z — отменить.');
    }catch(e){if(!cancelled)toast(e.message)}finally{
      if(!committed)for(const {asset} of prepared)URL.revokeObjectURL(asset.url);if(jobId&&token)fetch('/api/audio-separator/jobs/'+jobId,{method:'DELETE',headers:{'X-Audio-Token':token}}).catch(()=>{});separationActive=false;dialog.close();dialog.remove();renderInspector();
    }
  }
  function selectedVideoToolEntry(){
    const entries=selectedEntries().filter(e=>e.track.type==='video'&&(['video','image'].includes(e.item.kind)||e.item.kind==='compound'));
    if(entries.length!==1)return null;const entry=entries[0];return entry.item.kind==='compound'?{track:entry.track,item:compoundInspectorItem(entry.item,entry.track)}:entry;
  }
  function updateVideoToolButtons(){
    const entry=selectedVideoToolEntry(),available=!!entry&&!entry.track.locked&&!exporting;
    for(const [id,label] of [['slowMotionBtn','Слоу-моушен'],['cropVideoBtn','Обрезка кадра'],['chromaKeyBtn','Хромакей']]){const button=$(id);if(!button)continue;const supported=id!=='slowMotionBtn'||entry?.item.kind==='video'&&!entry.item._compound;button.disabled=!available||!supported;button.classList.toggle('active',!button.disabled);button.title=!entry?`${label}: выберите одну видеоячейку`:entry.track.locked?`${label}: разблокируйте дорожку`:!supported?'Слоу-моушен: выберите отдельный видеоклип':label+(id==='chromaKeyBtn'&&entry.item.chromaKey?.enabled?' — эффект включён':'');button.setAttribute('aria-label',label)}
  }
  function bindVideoTools(){
    const tools=document.querySelector('.editing-tools');
    for(const [id,icon,action] of [['slowMotionBtn','slowmotion',openSlowMotion],['cropVideoBtn','crop',openCropEditor],['chromaKeyBtn','chroma',openChromaEditor]]){const button=$(id)||document.createElement('button');button.id=id;button.type='button';button.className='video-tool';button.replaceChildren(trackIcon(icon));button.onclick=()=>{const entry=selectedVideoToolEntry();if(entry&&!entry.track.locked&&!exporting)action(entry.item)};tools.append(button)}updateVideoToolButtons();
  }
  function openChromaEditor(item){
    if(exporting)return;pause();const dialog=document.createElement('dialog');dialog.className='modal chroma-editor';dialog.setAttribute('aria-label','Настройка хромакея');
    const head=document.createElement('div');head.className='modal-head';const title=document.createElement('h2');title.textContent='Хромакей';const close=document.createElement('button');close.type='button';close.textContent='×';close.setAttribute('aria-label','Закрыть хромакей');close.onclick=()=>dialog.close();head.append(title,close);
    const layout=document.createElement('div');layout.className='chroma-editor-layout';const preview=document.createElement('div');preview.className='chroma-editor-preview';const surface=document.createElement('canvas');surface.width=Math.min(720,canvas.width);surface.height=Math.round(canvas.height*surface.width/canvas.width);const cx=surface.getContext('2d');surface.setAttribute('aria-label','Предпросмотр хромакея с нижними слоями');preview.append(surface);
    const playback=document.createElement('button');playback.type='button';playback.className='sidebar-action';playback.textContent='Воспроизвести / пауза';playback.onclick=togglePlayback;preview.append(playback);const hint=document.createElement('p');hint.className='note';hint.textContent='Изменения видны сразу и сохраняются в проекте. Ctrl+Z после закрытия окна — отменить.';preview.append(hint);
    const controls=document.createElement('fieldset');controls.className='clip-controls';controls.disabled=!!findItem(item.id)?.track.locked;const render=()=>{controls.replaceChildren();renderChromaControls(controls,item,render)};render();layout.append(preview,controls);dialog.append(head,layout);document.body.append(dialog);let frame,disposed=false;const paint=()=>{if(disposed)return;cx.drawImage(canvas,0,0,surface.width,surface.height);frame=requestAnimationFrame(paint)};
    dialog.onclose=()=>{disposed=true;cancelAnimationFrame(frame);pause();dialog.remove();renderInspector();updateVideoToolButtons()};dialog.showModal();paint();close.focus();
  }
  function renderChromaControls(parent,item,onChange=()=>{}){
    const body=clipSection(parent,'chromakey','Хромакей — удалить фон',()=>{mutate(()=>item.chromaKey={enabled:false,color:'#33b340',strength:35,softness:20,spill:65});onChange()});
    const defaults={color:'#33b340',strength:35,softness:20,spill:65};
    clipToggle(body,'Удалить одноцветный фон',!!item.chromaKey?.enabled,v=>{item.chromaKey={...defaults,...item.chromaKey,enabled:v};queueMicrotask(onChange)});
    const note=document.createElement('p');note.className='note';note.textContent='Разместите этот клип выше фонового видео (например, V2 над V1). Удалённый цвет станет прозрачным. Звук остаётся на S.';body.append(note);
    if(!item.chromaKey?.enabled)return;const value=item.chromaKey;
    inspectorField(body,'Цвет удаляемого фона',value.color||defaults.color,v=>mutate(()=>item.chromaKey={...item.chromaKey,color:v}),{type:'color'});
    const pick=document.createElement('button');pick.type='button';pick.className='sidebar-action';pick.textContent='Пипетка: выбрать цвет из кадра';pick.onclick=()=>pickChromaColor(item,onChange);body.append(pick);
    for(const [key,label] of [['strength','Сила удаления'],['softness','Мягкость края'],['spill','Подавление цветного ореола']])clipSlider(body,item,'chroma-'+key,label,value[key]??defaults[key],0,100,1,v=>item.chromaKey={...item.chromaKey,[key]:v},v=>`${Math.round(v)}%`);
  }
  function pickChromaColor(item,onChange=()=>{}){
    if(exporting)return;const found=findItem(item.id)||item._compound&&findItem(item._compound.id);if(found?.track.locked)return;pause();
    const raw=item._compound?playbackItems().find(e=>e.item._compoundRoot===item.id&&activeAt(e.item,playhead))?.item:item;
    const asset=assets.get(raw?.assetId),source=raw?.kind==='image'?asset?.image:elements.get(raw?.id)?.el;
    if(!source||item.kind==='video'&&source.readyState<2)return toast('Поставьте курсор внутрь клипа и дождитесь кадра');
    const dialog=document.createElement('dialog');dialog.className='modal chroma-picker';dialog.setAttribute('aria-label','Выбор цвета фона');
    const heading=document.createElement('h2');heading.textContent='Нажмите на цвет фона в исходном кадре';const hint=document.createElement('p');hint.className='note';hint.textContent='Для точного выбора поставьте курсор на нужный кадр перед открытием пипетки. Esc — отмена.';
    const frame=document.createElement('canvas');frame.width=asset.width;frame.height=asset.height;frame.setAttribute('aria-label','Исходный кадр: нажмите на цвет фона');const cx=frame.getContext('2d',{willReadFrequently:true});cx.drawImage(source,0,0,frame.width,frame.height);
    const cancel=document.createElement('button');cancel.type='button';cancel.className='sidebar-action';cancel.textContent='Отмена';cancel.onclick=()=>dialog.close();dialog.append(heading,hint,frame,cancel);document.body.append(dialog);dialog.onclose=()=>dialog.remove();
    frame.onclick=e=>{const rect=frame.getBoundingClientRect(),x=clamp(Math.floor((e.clientX-rect.left)*frame.width/rect.width),0,frame.width-1),y=clamp(Math.floor((e.clientY-rect.top)*frame.height/rect.height),0,frame.height-1),pixel=cx.getImageData(x,y,1,1).data,color='#'+[...pixel.slice(0,3)].map(v=>v.toString(16).padStart(2,'0')).join('');dialog.close();mutate(()=>item.chromaKey={...item.chromaKey,color});toast('Цвет фона: '+color);onChange()};dialog.showModal();cancel.focus();
  }
  function renderMediaInspector(root,{track,item}){
    const audio=item.kind==='audio',locked=!!track.locked;root.classList.add('media-inspector');
    const head=document.createElement('div');head.className='clip-heading';const name=document.createElement('h2');name.textContent=item.name||assets.get(item.assetId)?.name||(audio?'Звуковой клип':'Видеоклип');name.title=name.textContent;head.append(name);
    const actions=document.createElement('div');actions.className='clip-heading-actions';for(const [icon,label,action] of [['scissors','Разрезать на курсоре',splitAtPlayhead],['layers','Дублировать клип',()=>duplicateClip(item)],['trash','Удалить клип',()=>removeItem(item.id)]]){const button=document.createElement('button');button.type='button';button.title=label;button.setAttribute('aria-label',label);button.disabled=locked;button.append(trackIcon(icon));button.onclick=action;actions.append(button)}head.append(actions);root.append(head);
    const trackNote=document.createElement('p');trackNote.className='clip-track-note';trackNote.textContent=`${track.label} · ${audio?'Звук':'Изображение'}${locked?' · Дорожка заблокирована':''}`;root.append(trackNote);
    const controls=document.createElement('fieldset');controls.className='clip-controls';controls.disabled=locked;root.append(controls);
    const timeRow=document.createElement('div');timeRow.className='field-row';controls.append(timeRow);
    inspectorTimeField(timeRow,'Начало',item.start,v=>mutate(()=>moveLinkedStart(item,clamp(v,0,86400))),{min:0,step:.01});
    inspectorTimeField(timeRow,'Длительность',item.duration,v=>mutate(()=>setLinkedDuration(item,v)),{min:.04,step:.01});
    if(!['image'].includes(item.kind)){const sourceInput=inspectorField(controls,item._compound?'Пропустить в начале объединения, с':'Пропустить в начале файла, с',item.sourceIn||0,v=>mutate(()=>setSourceIn(item,v)),{min:0,step:.01});sourceInput.title='С какой секунды исходного файла начинается фрагмент. Меняет обрезку слева, сохраняя выбранный конец. Возврат к 0 восстанавливает начало файла.';const hint=document.createElement('p');hint.className='source-in-hint';hint.textContent='Например, 0,58 — пропустить первые 0,58 с записи. Возврат к 0 вернёт их в клип. Конец фрагмента остаётся прежним.';controls.append(hint)}
    if(!audio){
      const resetPosition=()=>mutate(()=>Object.assign(item,{fit:'contain',x:0,y:0,scale:1,rotation:0,flipH:false,flipV:false,kenBurns:false,motionEndX:0,motionEndY:0,motionEndScale:1.15}));
      const position=clipSection(controls,'position','Положение и размер',resetPosition);
      clipChips(position,[['contain','Вписать'],['cover','Заполнить'],['stretch','Растянуть']],item.fit||'contain',v=>mutate(()=>item.fit=v));
      clipToggle(position,'Плавное движение и приближение (Ken Burns)',!!item.kenBurns,v=>{item.kenBurns=v;item.motionEndScale??=(item.scale||1)*1.15;item.motionEndX??=item.x||0;item.motionEndY??=item.y||0});
      clipSlider(position,item,'scale','Масштаб',(item.scale||1)*100,10,500,1,v=>item.scale=v/100,v=>`${Math.round(v)}%`);
      clipSlider(position,item,'x','По горизонтали',item.x||0,-100,100,.1,v=>item.x=v,v=>`${v.toFixed(1)}%`);
      clipSlider(position,item,'y','По вертикали',item.y||0,-100,100,.1,v=>item.y=v,v=>`${v.toFixed(1)}%`);
      clipSlider(position,item,'rotation','Поворот',item.rotation||0,-180,180,1,v=>item.rotation=v,v=>`${Math.round(v)}°`);
      const flip=document.createElement('div');flip.className='clip-chips';for(const [key,label] of [['flipH','Отразить ↔'],['flipV','Отразить ↕']]){const button=document.createElement('button');button.type='button';button.textContent=label;button.className=item[key]?'active':'';button.setAttribute('aria-pressed',String(!!item[key]));button.onclick=()=>mutate(()=>item[key]=!item[key]);flip.append(button)}position.append(flip);
      if(item.kenBurns){const note=document.createElement('p');note.className='note';note.textContent='Основные ползунки задают начало движения. Ниже — положение в конце клипа.';position.append(note);clipSlider(position,item,'motionEndScale','Масштаб в конце',(item.motionEndScale??1.15)*100,10,500,1,v=>item.motionEndScale=v/100,v=>`${Math.round(v)}%`);for(const [key,label] of [['motionEndX','Горизонталь в конце'],['motionEndY','Вертикаль в конце']])clipSlider(position,item,key,label,item[key]||0,-100,100,.1,v=>item[key]=v,v=>`${v.toFixed(1)}%`)}
      const color=clipSection(controls,'color','Цвет',()=>mutate(()=>{Object.assign(item,clipLooks.original);item.look='original'}));
      clipChips(color,[['original','Оригинал'],['bw','Чёрно-белый'],['sepia','Сепия'],['vivid','Яркий'],['faded','Выцветший'],['noir','Нуар'],['warm','Тёплый'],['cool','Холодный']],item.look||'original',v=>mutate(()=>{item.look=v;Object.assign(item,clipLooks[v])}));
      for(const [key,label] of [['brightness','Яркость'],['contrast','Контраст'],['saturation','Насыщенность']])clipSlider(color,item,key,label,((item[key]??1)-1)*100,-100,200,1,v=>{item[key]=1+v/100;item.look='custom'},v=>`${Math.round(v)>0?'+':''}${Math.round(v)}`);
      clipSlider(color,item,'temperature','Температура',item.temperature||0,-100,100,1,v=>{item.temperature=v;item.look='custom'});
      clipSlider(color,item,'vignette','Виньетка',(item.vignette||0)*100,0,100,1,v=>item.vignette=v/100,v=>`${Math.round(v)}%`);
    }
    if(item.kind!=='image'){
      const speed=clipSection(controls,'speed','Скорость',()=>mutate(()=>setClipSpeed(item,1)));
      clipChips(speed,[.25,.5,.75,1,1.25,1.5,2,3,4].map(v=>[v,`${v}×`]),item.speed||1,v=>mutate(()=>setClipSpeed(item,v)));
      clipSlider(speed,item,'speed','Скорость',item.speed||1,.25,4,.01,v=>setClipSpeed(item,v),v=>`${v.toFixed(2)}×`);
      const note=document.createElement('p');note.className='note';note.textContent=audio?'Высота тона сохраняется браузером при изменении скорости.':'Меняется длительность выбранного V-клипа. Скорость отделённого звука на S настраивается отдельно.';speed.append(note);
    }
    if(audio){
      renderSeparationControls(controls,item);
      const sound=clipSection(controls,'audio','Звук',()=>mutate(()=>Object.assign(item,{muted:false,volume:1,fadeIn:0,fadeOut:0})));
      clipToggle(sound,'Отключить звук этого клипа',!!item.muted,v=>item.muted=v);
      clipSlider(sound,item,'volume','Громкость',(item.volume??1)*100,0,100,1,v=>item.volume=v/100,v=>`${Math.round(v)}%`);
      for(const [key,label] of [['fadeIn','Нарастание звука'],['fadeOut','Затухание звука']])clipSlider(sound,item,key,label,item[key]||0,0,item.duration,.01,v=>item[key]=v,v=>`${v.toFixed(2)} с`);
    }else{
      const fade=clipSection(controls,'fade','Плавность изображения',()=>mutate(()=>Object.assign(item,{fadeIn:0,fadeOut:0,opacity:1})));
      for(const [key,label] of [['fadeIn','Появление'],['fadeOut','Исчезновение']])clipSlider(fade,item,key,label,item[key]||0,0,item.duration,.01,v=>item[key]=v,v=>`${v.toFixed(2)} с`);
      clipSlider(fade,item,'opacity','Непрозрачность',(item.opacity??1)*100,0,100,1,v=>item.opacity=v/100,v=>`${Math.round(v)}%`);
      const transition=clipSection(controls,'transition','Переход в начале',()=>mutate(()=>{item.transitionIn='none';item.transitionDuration=0}));
      inspectorField(transition,'Тип перехода',item.transitionIn||'none',v=>mutate(()=>{item.transitionIn=v;if(v!=='none'&&!transitionSeconds(item))item.transitionDuration=.65}),{values:[['none','Без перехода'],['dissolve','Плавное смешивание'],['fade','Через чёрный'],['slide-left','Сдвиг влево'],['slide-right','Сдвиг вправо'],['wipe','Шторка'],['zoom','Приближение']]});
      if(item.transitionIn&&item.transitionIn!=='none')clipSlider(transition,item,'transitionDuration','Длительность перехода',Math.min(item.duration,transitionSeconds(item)),.01,item.duration,.01,v=>item.transitionDuration=v,v=>`${v.toFixed(2)} с`);
      const blend=clipSection(controls,'blend','Смешивание слоёв',()=>mutate(()=>item.blend='source-over'));
      const blendIntro=document.createElement('p');blendIntro.className='note';blendIntro.textContent='Смешивает этот клип с изображением под ним. Например: V2 поверх V1, оба клипа идут одновременно. Если снизу только фон, результат зависит от его цвета: на чёрном фоне некоторые режимы почти ничего не меняют.';blend.append(blendIntro);
      const blendModes=[['source-over','Обычный','Показывает верхний клип поверх нижнего. Чтобы видеть оба, уменьшите «Непрозрачность» в разделе «Плавность изображения».'],['multiply','Умножение','Затемняет изображение. Белый цвет верхнего слоя пропускает нижний, чёрный затемняет его до чёрного.'],['screen','Экран','Осветляет изображение. Чёрный цвет верхнего слоя пропускает нижний — удобно для бликов и огня на чёрном фоне.'],['overlay','Перекрытие','Усиливает контраст нижнего изображения: светлые участки осветляет, тёмные затемняет.'],['lighten','Осветление','В каждом месте оставляет более светлый цвет из двух слоёв.'],['darken','Затемнение','В каждом месте оставляет более тёмный цвет из двух слоёв.']];
      inspectorField(blend,'Режим смешивания',item.blend||'source-over',v=>mutate(()=>item.blend=v),{values:blendModes.map(([value,label])=>[value,label])});
      const blendHelp=document.createElement('p');blendHelp.className='note blend-help';blendHelp.textContent=(blendModes.find(([value])=>value===(item.blend||'source-over'))||blendModes[0])[2];blend.append(blendHelp);
      const blendSelect=blend.querySelector('select');if(blendSelect){blendSelect.title='Как смешивать изображение этого клипа с нижними слоями и фоном';for(const option of blendSelect.options)option.title=blendModes.find(([value])=>value===option.value)?.[2]||''}
    }
  }
  function bindFloatingInspector(){
    const panel=$('propertiesPanel'),workspace=document.querySelector('.workspace'),header=panel.querySelector('.side-panel-header');
    const button=document.createElement('button');button.type='button';button.id='floatInspectorBtn';button.append(trackIcon('layers'));button.title='Открепить настройки: панель можно перетаскивать';button.setAttribute('aria-label',button.title);button.setAttribute('aria-pressed','false');header.insertBefore(button,$('togglePropertiesPanelBtn'));
    let floating=false,left=0,top=0;
    const clampPosition=()=>{left=clamp(left,0,Math.max(0,window.innerWidth-panel.offsetWidth));top=clamp(top,0,Math.max(0,window.innerHeight-panel.offsetHeight-8));panel.style.left=`${left}px`;panel.style.top=`${top}px`};
    button.onclick=()=>{if($('togglePropertiesPanelBtn').getAttribute('aria-expanded')==='false')$('togglePropertiesPanelBtn').click();floating=!floating;panel.classList.toggle('floating-inspector',floating);workspace.classList.toggle('properties-floating',floating);button.title=floating?'Закрепить настройки справа':'Открепить настройки: панель можно перетаскивать';button.setAttribute('aria-label',button.title);button.setAttribute('aria-pressed',String(floating));if(floating){left=window.innerWidth-390;top=80;panel.scrollTop=0;clampPosition()}else{panel.style.left='';panel.style.top=''}fitPreview()};
    header.onpointerdown=e=>{if(!floating||e.button!==0||e.target.closest('button'))return;e.preventDefault();const x=e.clientX-left,y=e.clientY-top;header.setPointerCapture(e.pointerId);header.onpointermove=ev=>{left=ev.clientX-x;top=ev.clientY-y;clampPosition()};const finish=ev=>{if(header.hasPointerCapture(ev.pointerId))header.releasePointerCapture(ev.pointerId);header.onpointermove=null;header.onpointerup=null;header.onpointercancel=null};header.onpointerup=finish;header.onpointercancel=finish};
    window.addEventListener('resize',()=>{if(floating)clampPosition()});
  }

  function renderFadeHandles(clip,item,track){
    if(!['video','image','audio','compound'].includes(item.kind))return;
    for(const [key,label,side] of [['fadeIn',(item.kind==='audio'||item.trackType==='audio')?'Нарастание звука':'Появление изображения','left'],['fadeOut',(item.kind==='audio'||item.trackType==='audio')?'Затухание звука':'Исчезновение изображения','right']]){
      const band=document.createElement('div');band.className=`clip-fade-band ${side}`;band.style.width=`${Math.min(item.duration,item[key]||0)*zoom}px`;clip.append(band);
      const handle=document.createElement('button');handle.type='button';handle.className=`clip-fade-handle ${side}`;handle.title=`${label}: ${(item[key]||0).toFixed(2)} с. ${key==='fadeIn'?'Потяните квадрат вправо, чтобы начало стало плавным.':'Потяните квадрат влево, чтобы конец стал плавным.'} Чем дальше от края, тем дольше эффект`;handle.setAttribute('aria-label',handle.title);handle.disabled=track.locked;
      const position=()=>handle.style[side]=`${clamp((item[key]||0)*zoom,12,Math.max(12,item.duration*zoom-20))}px`;position();clip.append(handle);
      handle.onpointerdown=e=>{
        e.stopPropagation();if(e.button!==0||exporting)return;if(e.shiftKey){selectItem(item.id,true);return}if(track.locked)return;e.preventDefault();pause();selected={kind:'item',id:item.id};renderInspector();const before=JSON.stringify(project),origin=e.clientX,initial=item[key]||0;handle.setPointerCapture(e.pointerId);
        const readout=document.createElement('div');readout.className='fade-drag-readout';readout.setAttribute('role','status');document.body.append(readout);
        const updateReadout=()=>{readout.textContent=`${label}: ${(item[key]||0).toFixed(2).replace('.',',')} с`;const rect=handle.getBoundingClientRect();readout.style.left=`clamp(8px, ${rect.left+rect.width/2-readout.offsetWidth/2}px, calc(100vw - ${readout.offsetWidth+8}px))`;readout.style.top=`${Math.max(8,rect.top-readout.offsetHeight-10)}px`};updateReadout();
        handle.onpointermove=ev=>{item[key]=clamp(initial+(ev.clientX-origin)/zoom*(side==='left'?1:-1),0,item.duration);band.style.width=`${item[key]*zoom}px`;position();updateReadout();handle.title=`${label}: ${item[key].toFixed(2)} с. Потяните квадрат к середине клипа: чем дальше от края, тем дольше плавный эффект`;handle.setAttribute('aria-label',handle.title);syncElements();draw()};
        const clear=()=>{readout.remove();handle.onpointermove=null;handle.onpointerup=null;handle.onpointercancel=null};
        handle.onpointerup=ev=>{if(handle.hasPointerCapture(ev.pointerId))handle.releasePointerCapture(ev.pointerId);clear();if(JSON.stringify(project)!==before){recordChange(before);queueSave()}refresh()};
        handle.onpointercancel=()=>{clear();project=JSON.parse(before);refresh()};
      };
    }
  }

  function renderAdvancedItemInspector(root,item){if(!['video','image'].includes(item.kind))return;const panel=document.createElement('div');root.insertBefore(panel,root.querySelector('.danger'));sectionLabel(panel,'ЦВЕТ И КАДР');const looks={original:{brightness:1,contrast:1,saturation:1,temperature:0,vignette:0},warm:{brightness:1.02,contrast:1.06,saturation:1.12,temperature:45,vignette:.08},cool:{brightness:1,contrast:1.08,saturation:1.03,temperature:-45,vignette:.08},noir:{brightness:1,contrast:1.18,saturation:0,temperature:0,vignette:.2},vintage:{brightness:1.03,contrast:.9,saturation:.8,temperature:35,vignette:.18}};inspectorField(panel,'Цветовой пресет',item.look||'original',value=>mutate(()=>{item.look=value;Object.assign(item,looks[value])}),{values:[['original','Без пресета'],['warm','Тёплый'],['cool','Холодный'],['noir','Чёрно-белый'],['vintage','Винтаж']]});inspectorField(panel,'Температура (-100…100)',item.temperature||0,v=>mutate(()=>item.temperature=clamp(v,-100,100)),{min:-100,max:100,step:5});inspectorField(panel,'Виньетка (0–1)',item.vignette||0,v=>mutate(()=>item.vignette=clamp(v,0,1)),{min:0,max:1,step:.05});inspectorField(panel,'Режим наложения',item.blend||'source-over',v=>mutate(()=>item.blend=v),{values:[['source-over','Обычный'],['multiply','Умножение'],['screen','Экран'],['overlay','Перекрытие'],['lighten','Осветление'],['darken','Затемнение']]});sectionLabel(panel,'КАДРИРОВАНИЕ, %');const row1=document.createElement('div');row1.className='field-row';panel.append(row1);const row2=document.createElement('div');row2.className='field-row';panel.append(row2);for(const [key,label,parent] of [['left','Слева',row1],['right','Справа',row1],['top','Сверху',row2],['bottom','Снизу',row2]])inspectorField(parent,label,item.crop?.[key]||0,v=>mutate(()=>{item.crop=item.crop||{};item.crop[key]=clamp(v,0,45)}),{min:0,max:45,step:1})}

  function renderTimeline(){updateVideoToolButtons();updateMergeButton();updateLinkButtons();const viewport=$('timelineScroll'),inner=$('timelineInner'),headers=$('trackHeaders'),lanes=$('trackLanes'),ruler=$('ruler'),markers=$('markerLayer');const width=Math.max(viewport.clientWidth,Math.ceil(Math.max(duration()+10,...(project.markers||[]).filter(m=>Number.isFinite(m.time)).map(m=>m.time+2))*zoom));inner.style.width=`${width}px`;headers.replaceChildren();lanes.replaceChildren();ruler.replaceChildren();markers.replaceChildren();const seconds=width/zoom;const step=zoom>=120?1:zoom>=55?2:zoom>=28?5:10;for(let t=0;t<=seconds;t+=step){const tick=document.createElement('div');tick.className='ruler-tick';tick.style.left=`${t*zoom}px`;tick.textContent=t<60?`0:${String(t).padStart(2,'0')}`:`${Math.floor(t/60)}:${String(t%60).padStart(2,'0')}`;ruler.append(tick);if(step*zoom>80){const mid=document.createElement('div');mid.className='ruler-tick minor';mid.style.left=`${(t+step/2)*zoom}px`;ruler.append(mid)}}for(const marker of project.markers||[]){markers.append(renderMarker(marker))}for(const track of tracks()){headers.append(renderTrackHeader(track));const lane=document.createElement('div');lane.className='lane';lane.dataset.trackId=track.id;lane.dataset.type=track.type;lane.style.width=`${width}px`;lane.onclick=e=>{if(e.target!==lane)return;selectTrack(track.id);seek((e.clientX-lane.getBoundingClientRect().left)/zoom)};lane.ondragover=e=>{if(!e.dataTransfer.types.includes('application/x-montazhnaya-asset'))return;e.preventDefault();lane.classList.add('drop-target')};lane.ondragleave=()=>lane.classList.remove('drop-target');lane.ondrop=e=>{e.preventDefault();lane.classList.remove('drop-target');const id=e.dataTransfer.getData('application/x-montazhnaya-asset');createItem(id,track.id,(e.clientX-lane.getBoundingClientRect().left)/zoom)};for(const item of [...track.items].sort((a,b)=>a.start-b.start))lane.append(renderClip(item,track));bindLaneExtras(lane,track);bindSubtitleZoneDrawing(lane,track);lanes.append(lane)}renderBottomRuler();renderMarkerRange();renderExportRange();updatePlayhead();updateSubtitleWorkshopUI()}
  function renderClip(item,track){const asset=assets.get(item.assetId);const clip=document.createElement('div');if(['title','subtitle','shape','countdown'].includes(item.kind)){let hash=0;for(const c of item.id)hash=(hash*31+c.charCodeAt(0))>>>0;const hue=item.timelineHue??hash%360;clip.style.backgroundColor=`hsl(${hue} 32% 32%)`;clip.style.borderColor=`hsl(${hue} 48% 65%)`;}clip.dataset.itemId=item.id;clip.className=`timeline-clip ${item.kind}${item.kind==='compound'?` ${track.type==='audio'?'audio':track.type==='text'?'title':'video'}`:''}${selectedItemIds().includes(item.id)?' selected':''}${item.assetId&&!asset?' missing':''}`;clip.style.left=`${item.start*zoom}px`;clip.style.width=`${Math.max(8,item.duration*zoom)}px`;clip.title=`${item.name||asset?.name||item.text||item.kind}\n${timecode(item.start)} — ${timecode(item.start+item.duration)}`;if(asset?.thumbnail&&(item.kind==='video'||item.kind==='image')){const bg=document.createElement('div');bg.className='clip-thumb';bg.style.backgroundImage=`url("${asset.thumbnail}")`;clip.append(bg)}const body=document.createElement('div');body.className='clip-body';const title=document.createElement('div');title.textContent=item.name||asset?.name||item.text||(item.kind==='subtitle'?'Новая реплика':item.kind==='shape'?(item.style==='shape-ellipse'?'Эллипс':'Прямоугольник'):'Файл отсутствует');const detail=document.createElement('div');detail.className='clip-detail';detail.textContent=`${item.kind==='compound'?`${item.parts.length} клипа · `:''}${item.duration.toFixed(2)} c${item.speed&&item.speed!==1?` · ${item.speed}×`:''}`;body.append(title,detail);clip.append(body);if(canHaveTransition(track,item)&&item.transitionIn&&item.transitionIn!=='none'&&transitionSeconds(item)>0){const band=document.createElement('div');band.className='transition-band';band.style.width=`${Math.min(item.duration,transitionSeconds(item))*zoom}px`;band.textContent='↔';band.title=`Переход: ${item.transitionIn}`;clip.append(band)}for(const edge of ['left','right']){const handle=document.createElement('div');handle.className=`trim-handle ${edge}`;handle.dataset.edge=edge;clip.append(handle)}clip.oncontextmenu=e=>showClipMenu(e,item.id);clip.onpointerdown=e=>startClipPointer(e,item,track,clip);if(linkedEntries(item).length>1){const badge=document.createElement('span');badge.className='clip-link-badge';badge.title=item.kind==='countdown'||item.timerOwnerId?'Счётчик и звук связаны':'Видео и звук связаны';badge.append(trackIcon('link'));clip.append(badge)}renderClipMedia(clip,item);bindTransitionHandle(clip,item,track);renderFadeHandles(clip,item,track);clip.ondblclick=e=>{e.stopPropagation();seek(item.start);if(item.kind==='subtitle'){selectItem(item.id);focusSubtitleEditor()}};return clip}
  function snapTime(value,itemId){if(!snap)return value;const candidates=[0,playhead,...(project.markers||[]).map(x=>x.time)];for(const {item} of allItems())if(item.id!==itemId)candidates.push(item.start,item.start+item.duration);let closest=value,dist=8/zoom;for(const c of candidates)if(Math.abs(c-value)<dist){closest=c;dist=Math.abs(c-value)}return closest}
  function linkedEntries(item){return item?.linkId?allItems().filter(entry=>entry.item.linkId===item.linkId):[]}
  function expandLinkedEntries(entries){const result=new Map(entries.map(entry=>[entry.item.id,entry]));for(const entry of entries)for(const partner of linkedEntries(entry.item))result.set(partner.item.id,partner);return [...result.values()]}
  function linkTargets(){
    const entries=selectedEntries();if(entries.length!==1)return entries;
    const entry=entries[0],partners=linkedEntries(entry.item);if(partners.length>1)return partners;
    const pair=allItems().filter(other=>other.item.id!==entry.item.id&&((entry.track.type==='video'&&other.track.type==='audio'&&other.item.sourceVideoId===entry.item.id)||(entry.track.type==='audio'&&other.track.type==='video'&&entry.item.sourceVideoId===other.item.id)));
    return pair.length===1?[entry,pair[0]]:entries;
  }
  function linkReason(){const targets=linkTargets();if(targets.length<2)return 'Выберите видео V и звук S через Shift';if(!targets.some(entry=>entry.item.kind==='countdown')&&(targets.some(entry=>!['video','audio'].includes(entry.track.type))||!targets.some(entry=>entry.track.type==='video')||!targets.some(entry=>entry.track.type==='audio'))||targets.some(entry=>!['audio','video'].includes(entry.track.type)&&entry.item.kind!=='countdown')||!targets.some(entry=>entry.track.type==='audio'))return 'Связывать можно видео V и звук S';if(expandLinkedEntries(targets).some(entry=>entry.track.locked))return 'Разблокируйте связанные дорожки';if(targets[0].item.linkId&&targets.every(entry=>entry.item.linkId===targets[0].item.linkId))return 'Ячейки уже связаны';return ''}
  function unlinkGroups(){return new Set(selectedEntries().filter(entry=>linkedEntries(entry.item).length>1).map(entry=>entry.item.linkId))}
  function linkSelected(){const reason=linkReason();if(reason)return toast(reason);const entries=expandLinkedEntries(linkTargets()),linkId=uid();mutate(()=>{for(const {item} of entries){item.linkId=linkId;if(item.kind==='countdown')item.countAudioLinked=true}});toast('Видео и звук связаны. Перетаскивайте любую ячейку — остальные двигаются вместе.')}
  function unlinkSelected(){const groups=unlinkGroups();if(!groups.size)return;const entries=allItems().filter(entry=>groups.has(entry.item.linkId));if(entries.some(entry=>entry.track.locked))return toast('Разблокируйте связанные дорожки');const anchorId=selectedItemIds()[0];mutate(()=>{for(const {item} of entries){if(item.kind==='countdown')item.countAudioLinked=false;delete item.linkId;}selected=anchorId?{kind:'item',id:anchorId}:null});toast('Связь убрана. Ячейки можно перемещать отдельно.')}
  function clearClipLinks(item){delete item.linkId;if(item.kind==='compound')for(const child of item.parts||[])clearClipLinks(child)}
  function preserveMergedLinks(entries,compound){const groups=new Set(entries.map(entry=>entry.item.linkId).filter(Boolean)),partners=allItems().filter(entry=>groups.has(entry.item.linkId));clearClipLinks(compound);if(partners.length){const linkId=uid();compound.linkId=linkId;for(const {item} of partners)item.linkId=linkId}}
  function moveLinkedStart(item,value){const entries=expandLinkedEntries([findItem(item.id)]).filter(Boolean);if(entries.some(entry=>entry.track.locked)){toast('Разблокируйте связанные дорожки');return}const delta=clamp(value-item.start,-Math.min(...entries.map(entry=>entry.item.start)),86400-Math.max(...entries.map(entry=>entry.item.start)));for(const entry of entries)entry.item.start+=delta}
  function updateLinkButtons(){const link=$('linkBtn'),unlink=$('unlinkBtn');if(!link||!unlink)return;const reason=linkReason(),groups=unlinkGroups(),locked=allItems().some(entry=>groups.has(entry.item.linkId)&&entry.track.locked);link.disabled=!!reason||exporting;link.title=reason||'Связать ячейки и звук: перемещать вместе';link.setAttribute('aria-label',link.title);unlink.disabled=!groups.size||locked||exporting;unlink.title=groups.size?'Развязать ячейки: перемещать отдельно':'У выбранной ячейки нет связи';unlink.setAttribute('aria-label',unlink.title)}
  function bindLinkButtons(){for(const [id,icon,label,action] of [['linkBtn','link','Связать',linkSelected],['unlinkBtn','unlink','Развязать',unlinkSelected]]){const button=document.createElement('button');button.id=id;button.type='button';button.className='link-tool';button.append(trackIcon(icon));const text=document.createElement('span');text.textContent=label;button.append(text);button.onclick=action;document.querySelector('.editing-tools').insertBefore(button,$('mergeBtn'))}updateLinkButtons()}

  function selectedMoveDelta(entries,rawDelta){
    const minStart=Math.min(...entries.map(entry=>entry.start)),maxStart=Math.max(...entries.map(entry=>entry.start)),lower=-minStart,upper=86400-maxStart;
    let delta=clamp(rawDelta,lower,upper);
    if(!snap)return delta;
    const ids=new Set(entries.map(entry=>entry.item.id)),candidates=[0,playhead,...(project.markers||[]).map(marker=>marker.time)];
    for(const {item} of allItems())if(!ids.has(item.id))candidates.push(item.start,item.start+item.duration);
    let distance=8/zoom;
    for(const entry of entries)for(const edge of [entry.start,entry.start+entry.item.duration])for(const target of candidates){const proposed=target-edge,diff=Math.abs(proposed-rawDelta);if(proposed>=lower&&proposed<=upper&&diff<distance){delta=proposed;distance=diff}}
    return delta;
  }
  function selectedMoveTracks(entries,anchorTrack,candidate){
    if(!candidate||candidate.type!==anchorTrack.type)return null;
    const siblings=tracks().filter(track=>track.type===anchorTrack.type),offset=siblings.indexOf(candidate)-siblings.indexOf(anchorTrack),destinations=new Map();
    for(const entry of entries){const peers=tracks().filter(track=>track.type===entry.track.type),destination=peers[peers.indexOf(entry.track)+offset];if(!destination||destination.locked)return null;destinations.set(entry.item.id,destination)}
    return destinations;
  }
  function startSelectedClipsPointer(e,anchor,anchorTrack,clip,movingEntries=null){
    const entries=(movingEntries||expandLinkedEntries(selectedEntries())).map(entry=>({...entry,start:entry.item.start}));
    if(entries.some(entry=>entry.track.locked)){toast('Разблокируйте все выбранные дорожки, чтобы переместить ячейки вместе.');return}
    pause();renderInspector();e.preventDefault();clip.setPointerCapture(e.pointerId);
    const before=JSON.stringify(project),originX=e.clientX,originY=e.clientY,ids=new Set(entries.map(entry=>entry.item.id)),visuals=new Map([...document.querySelectorAll('.timeline-clip')].filter(element=>ids.has(element.dataset.itemId)).map(element=>[element.dataset.itemId,element]));
    let moved=false,destinations=new Map(entries.map(entry=>[entry.item.id,entry.track]));
    const clearTargets=()=>document.querySelectorAll('.lane.drop-target').forEach(element=>element.classList.remove('drop-target'));
    clip.onpointermove=ev=>{
      if(!clip.hasPointerCapture(ev.pointerId))return;if(Math.hypot(ev.clientX-originX,ev.clientY-originY)>3)moved=true;if(!moved)return;
      const delta=selectedMoveDelta(entries,(ev.clientX-originX)/zoom);clearTargets();
      const lane=[...document.querySelectorAll('.lane')].find(element=>{const rect=element.getBoundingClientRect();return ev.clientX>=rect.left&&ev.clientX<=rect.right&&ev.clientY>=rect.top&&ev.clientY<=rect.bottom});
      destinations=selectedMoveTracks(entries,anchorTrack,lane&&findTrack(lane.dataset.trackId))||new Map(entries.map(entry=>[entry.item.id,entry.track]));
      for(const entry of entries){entry.item.start=entry.start+delta;const element=visuals.get(entry.item.id),destination=destinations.get(entry.item.id),targetLane=[...document.querySelectorAll('.lane')].find(lane=>lane.dataset.trackId===destination.id);if(element){element.style.left=`${entry.item.start*zoom}px`;element.style.zIndex='20';element.style.transform=targetLane?`translateY(${targetLane.getBoundingClientRect().top-element.parentElement.getBoundingClientRect().top}px)`:''}targetLane?.classList.add('drop-target')}
      draw();
    };
    const clear=()=>{clip.onpointermove=null;clip.onpointerup=null;clip.onpointercancel=null;for(const element of visuals.values()){element.style.transform='';element.style.zIndex=''}clearTargets()};
    clip.onpointerup=ev=>{if(clip.hasPointerCapture(ev.pointerId))clip.releasePointerCapture(ev.pointerId);clear();if(moved){for(const entry of entries){const destination=destinations.get(entry.item.id);if(destination!==entry.track){entry.track.items=entry.track.items.filter(item=>item.id!==entry.item.id);destination.items.push(entry.item)}}if(JSON.stringify(project)!==before){recordChange(before);queueSave()}}refresh()};
    clip.onpointercancel=()=>{clear();project=JSON.parse(before);refresh()};
  }

  function startClipPointer(e,item,track,clip){
    if(e.button!==0||exporting)return;e.stopPropagation();if(e.shiftKey){selectItem(item.id,true);return}if(e.target.dataset.edge&&linkedEntries(item).length>1){startLinkedTrim(e,item,track,clip);return}if(!e.target.dataset.edge){const moving=expandLinkedEntries(selectedItemIds().includes(item.id)?selectedEntries():[{track,item}]);if(moving.length>1){selected={kind:'items',ids:moving.map(entry=>entry.item.id),primaryId:item.id};for(const element of document.querySelectorAll('.timeline-clip'))element.classList.toggle('selected',selected.ids.includes(element.dataset.itemId));updateMergeButton();updateLinkButtons();startSelectedClipsPointer(e,item,track,clip,moving);return}}pause();selected={kind:'item',id:item.id};updateMergeButton();updateLinkButtons();document.querySelectorAll('.timeline-clip.selected').forEach(el=>el.classList.remove('selected'));clip.classList.add('selected');renderInspector();draw();if(track.locked)return;
    clip.setPointerCapture(e.pointerId);
    const mode=e.target.dataset.edge||'move',originX=e.clientX,originY=e.clientY,before=JSON.stringify(project),original={start:item.start,duration:item.duration,sourceIn:item.sourceIn||0};let moved=false,destination=track;
    const clearTargets=()=>document.querySelectorAll('.lane.drop-target').forEach(el=>el.classList.remove('drop-target'));
    clip.onpointermove=ev=>{
      if(!clip.hasPointerCapture(ev.pointerId))return;
      const delta=(ev.clientX-originX)/zoom;if(Math.hypot(ev.clientX-originX,ev.clientY-originY)>3)moved=true;if(!moved)return;
      if(mode==='move'){
        item.start=clamp(snapTime(original.start+delta,item.id),0,86400);clearTargets();destination=track;
        const lane=[...document.querySelectorAll('.lane')].find(el=>{const r=el.getBoundingClientRect();return ev.clientX>=r.left&&ev.clientX<=r.right&&ev.clientY>=r.top&&ev.clientY<=r.bottom});
        const candidate=lane&&findTrack(lane.dataset.trackId);
        if(candidate&&!candidate.locked&&candidate.type===clipTrackType(item)){destination=candidate;lane.classList.add('drop-target');clip.style.transform=`translateY(${lane.getBoundingClientRect().top-clip.parentElement.getBoundingClientRect().top}px)`;clip.style.zIndex=20}else clip.style.transform='';
      }else if(mode==='left'){
        const end=original.start+original.duration;let proposed=clamp(snapTime(original.start+delta,item.id),0,end-.04);if(item.assetId||item.kind==='compound')proposed=Math.max(original.start-original.sourceIn/(item.speed||1),proposed);item.start=proposed;item.duration=end-proposed;item.sourceIn=original.sourceIn+(proposed-original.start)*(item.speed||1);
      }else{const max=item.assetId||item.kind==='compound'?itemMaxDuration({...item,sourceIn:original.sourceIn}):3600;item.duration=clamp(snapTime(original.start+original.duration+delta,item.id)-original.start,.04,max)}
      clip.style.left=`${item.start*zoom}px`;clip.style.width=`${Math.max(8,item.duration*zoom)}px`;draw();
    };
    const clear=()=>{clip.onpointermove=null;clip.onpointerup=null;clip.onpointercancel=null;clip.style.transform='';clip.style.zIndex='';clearTargets()};
    clip.onpointerup=ev=>{if(clip.hasPointerCapture(ev.pointerId))clip.releasePointerCapture(ev.pointerId);clear();if(moved&&mode==='move'&&destination!==track){track.items=track.items.filter(i=>i.id!==item.id);destination.items.push(item)}if(moved&&JSON.stringify(project)!==before){recordChange(before);queueSave();refresh()}else renderInspector()};
    clip.onpointercancel=()=>{clear();project=JSON.parse(before);refresh()};
  }

  function refresh(){groupTracks();updateHistoryButtons();$('projectName').value=project.name;rebuildElements();renderSidebar();renderTimeline();renderInspector();setCanvasSize();syncElements(true);draw()}
  function setExportBoundary(key){
    if(exporting)return;if(!duration())return toast('Сначала добавьте клип на линию');
    const removing=project[key]!=null;
    mutate(()=>{if(removing){project[key]=null;return}project[key]=clamp(playhead,0,duration());if(key==='inPoint'&&project.outPoint!=null&&project.outPoint<=project.inPoint)project.outPoint=null;if(key==='outPoint'&&project.inPoint!=null&&project.inPoint>=project.outPoint)project.inPoint=null});
    toast(removing?`${key==='inPoint'?'Вход':'Выход'} выключен`:`${key==='inPoint'?'Вход':'Выход'}: ${timecode(project[key])}. Повторный клик выключает границу.`);
  }

  function renderExportRange(){
    let layer=$('exportRangeLayer');if(!layer){layer=document.createElement('div');layer.id='exportRangeLayer';layer.className='export-range-layer';$('timelineInner').append(layer)}layer.replaceChildren();
    for(const [id,key,label,shortcut] of [['inBtn','inPoint','Вход','I'],['outBtn','outPoint','Выход','O']]){const button=$(id);button.classList.toggle('export-point-set',project[key]!=null);button.setAttribute('aria-pressed',String(project[key]!=null));button.title=`${label} (${shortcut}): ${project[key]!=null?`выключить границу ${timecode(project[key])}`:'поставить границу экспорта на красную линию'}`;button.setAttribute('aria-label',button.title)}
    if(project.inPoint==null&&project.outPoint==null)return;
    const start=clamp(project.inPoint??0,0,duration()),end=clamp(project.outPoint??duration(),0,duration());
    if(end>start){const fill=document.createElement('div');fill.className='export-range-fill';fill.style.left=`${start*zoom}px`;fill.style.width=`${(end-start)*zoom}px`;layer.append(fill)}
    for(const [key,label] of [['inPoint','Вход'],['outPoint','Выход']]){
      if(project[key]==null)continue;
      const line=document.createElement('div');line.className='export-range-line';line.style.left=`${project[key]*zoom}px`;layer.append(line);
      const handle=document.createElement('button');handle.type='button';handle.className=`export-range-marker ${key==='outPoint'?'export-range-end':''}`;handle.textContent=label;handle.style.left=`${project[key]*zoom}px`;handle.title=`${label} экспорта: ${timecode(project[key])}. Потяните для перемещения. Правая кнопка — убрать границу.`;handle.setAttribute('aria-label',handle.title);handle.dataset.boundary=key;layer.append(handle);
      handle.oncontextmenu=e=>{e.preventDefault();e.stopPropagation();mutate(()=>project[key]=null)};
      handle.onpointerdown=e=>{
        e.stopPropagation();if(e.button!==0||exporting)return;e.preventDefault();const before=JSON.stringify(project),initial=project[key],origin=e.clientX;let moved=false;handle.setPointerCapture(e.pointerId);
        handle.onpointermove=ev=>{if(Math.abs(ev.clientX-origin)>=3)moved=true;if(!moved)return;const other=key==='inPoint'?project.outPoint:project.inPoint,min=key==='outPoint'&&other!=null?Math.min(duration(),other+.01):0,max=key==='inPoint'&&other!=null?Math.max(0,other-.01):duration();project[key]=clamp(initial+(ev.clientX-origin)/zoom,min,max);handle.style.left=line.style.left=`${project[key]*zoom}px`;if(fillElement()){const a=project.inPoint??0,b=project.outPoint??duration();fillElement().style.left=`${a*zoom}px`;fillElement().style.width=`${Math.max(0,b-a)*zoom}px`}};
        const fillElement=()=>layer.querySelector('.export-range-fill');
        const clear=()=>{handle.onpointermove=null;handle.onpointerup=null;handle.onpointercancel=null};
        handle.onpointerup=ev=>{if(handle.hasPointerCapture(ev.pointerId))handle.releasePointerCapture(ev.pointerId);clear();if(moved&&JSON.stringify(project)!==before){recordChange(before);queueSave();renderTimeline()}else seek(project[key])};
        handle.onpointercancel=()=>{clear();project=JSON.parse(before);renderTimeline()};
      };
    }
  }

  function selectedMarkerRange(){const first=project.markers?.find(m=>m.id===markerAnchorId),last=project.markers?.find(m=>m.id===markerRangeEndId);if(!first||!last||Math.abs(first.time-last.time)<1e-7)return null;return {start:Math.min(first.time,last.time),end:Math.max(first.time,last.time)}}
  function chooseMarker(marker,extend){
    if(extend&&project.markers?.some(m=>m.id===markerAnchorId))markerRangeEndId=marker.id;
    else{markerAnchorId=marker.id;markerRangeEndId=null}
    seek(marker.time,true);renderMarkerRange();const range=selectedMarkerRange();if(range)toast(`Выделен участок ${formatClipTime(range.start)} — ${formatClipTime(range.end)}. Ножницы отрежут его от выбранной ячейки. Esc — снять выделение.`);
  }
  function renderMarkerRange(){
    const range=selectedMarkerRange();for(const [id,parent] of [['markerSelectionRange',$('timelineInner')],['bottomMarkerSelectionRange',$('bottomRuler')]]){let band=$(id);if(!range){band?.remove();continue}if(!parent)continue;if(!band){band=document.createElement('div');band.id=id;band.className='marker-selection-range';parent.append(band)}band.style.left=`${range.start*zoom}px`;band.style.width=`${(range.end-range.start)*zoom}px`}
    for(const el of document.querySelectorAll('[data-marker-id]'))el.classList.toggle('range-selected',!!range&&[markerAnchorId,markerRangeEndId].includes(el.dataset.markerId));
    const split=$('splitBtn');if(split)split.title=range?`Отрезать выделенный участок ${formatClipTime(range.start)} — ${formatClipTime(range.end)} (S). Esc — снять выделение.`:'Разрезать (S)';
  }
  function splitMarkerRange(){
    const range=selectedMarkerRange();if(!range)return;
    let targets=expandLinkedEntries(selectedEntries());if(!targets.length)return toast('Выберите ячейку, от которой нужно отрезать выделенный участок');
    const crosses=(item,time)=>time-item.start>1e-7&&item.start+item.duration-time>1e-7;
    const affectedGroups=new Set(targets.filter(({item})=>crosses(item,range.start)||crosses(item,range.end)).map(({item})=>item.linkId).filter(Boolean));
    if(targets.some(({track,item})=>track.locked&&(crosses(item,range.start)||crosses(item,range.end)||affectedGroups.has(item.linkId))))return toast('Разблокируйте связанные дорожки перед разрезанием');
    if(!targets.some(({item})=>item.start<range.end-1e-7&&item.start+item.duration>range.start+1e-7))return toast('Выбранная ячейка не пересекает выделенный участок');
    pause();mutate(()=>{
      for(const time of [range.start,range.end]){const cuts=targets.filter(({item})=>crosses(item,time));if(!cuts.length)continue;const right=splitEntriesAt(targets,cuts,time);const entries=new Map(targets.map(entry=>[entry.item.id,entry]));for(const item of right){const found=findItem(item.id);if(found)entries.set(item.id,found)}targets=[...entries.values()]}
      const ids=targets.filter(({item})=>item.start>=range.start-1e-7&&item.start+item.duration<=range.end+1e-7).map(({item})=>item.id);
      selected=ids.length>1?{kind:'items',ids}:ids.length?{kind:'item',id:ids[0]}:selected;markerAnchorId=null;markerRangeEndId=null;
    });refresh();toast('Фрагмент выделен. Остальные части сохранены на дорожке. Ctrl+Z отменяет разрезы.');
  }
  function markerDestination(direction){
    const candidates=(project.markers||[]).filter(m=>Number.isFinite(m.time)&&m.time>=0&&(direction<0?m.time<playhead-1e-7:m.time>playhead+1e-7));
    return candidates.sort((a,b)=>direction<0?b.time-a.time:a.time-b.time)[0]||null;
  }
  function updateMarkerNavigation(){for(const [id,direction,label] of [['previousMarkerBtn',-1,'Предыдущая метка (Ctrl+←)'],['nextMarkerBtn',1,'Следующая метка (Ctrl+→)']]){const button=$(id);if(!button)continue;const marker=markerDestination(direction);button.disabled=exporting||!marker;button.title=marker?`${label}: ${markerNumber(marker)?`№${markerNumber(marker)} · `:''}${marker.label||'Метка'} · ${timecode(marker.time)}`:label+(project.markers?.length?' — в этой стороне меток нет':' — добавьте метки на шкалу')}}
  function jumpToMarker(direction){const marker=markerDestination(direction);if(exporting||!marker)return;pause();seek(marker.time,true);const viewport=$('timelineScroll'),x=marker.time*zoom;if(x<viewport.scrollLeft+20||x>viewport.scrollLeft+viewport.clientWidth-20)viewport.scrollLeft=Math.max(0,x-viewport.clientWidth/2);syncBottomRulerScroll()}
  function bindMarkerNavigation(){const tools=document.querySelector('.editing-tools');for(const [id,icon,label,direction] of [['previousMarkerBtn','previousMarker','Предыдущая метка',-1],['nextMarkerBtn','nextMarker','Следующая метка',1]]){const button=document.createElement('button');button.id=id;button.type='button';button.title=label;button.setAttribute('aria-label',label);button.setAttribute('aria-keyshortcuts',direction<0?'Control+ArrowLeft':'Control+ArrowRight');button.append(trackIcon(icon));button.onclick=()=>jumpToMarker(direction);tools.insertBefore(button,direction<0?$('markerBtn'):$('markerBtn').nextSibling)}updateMarkerNavigation()}
  const markerColors=[['#ffce48','Жёлтый'],['#72b6ff','Голубой'],['#83dd8d','Зелёный'],['#f19bc9','Розовый'],['#ffa361','Оранжевый'],['#c3a0ff','Фиолетовый']];
  const markerShapes=[['flag','Флажок'],['diamond','Ромб'],['circle','Круг'],['tag','Табличка']];
  function markerNumber(marker){if(marker.number===null)return '';if(Number.isInteger(marker.number)&&marker.number>0)return String(marker.number);return /^Маркер (\d+)$/.exec(marker.label||'')?.[1]||''}
  function markerTitle(marker){return `${markerNumber(marker)?`№${markerNumber(marker)} · `:''}${marker.label||'Метка'} · ${timecode(marker.time)}. Правая кнопка — оформление и удаление.\nДержите Shift и выберите соседнюю метку, для выделения поля.`}
  function markerStyle(el,marker){el.dataset.shape=markerShapes.some(([value])=>value===marker.shape)?marker.shape:'flag';el.style.backgroundColor=markerColors.some(([value])=>value===marker.color)?marker.color:markerColors[0][0];el.textContent=markerNumber(marker)}
  function renderMarker(marker){const el=document.createElement('div');el.className='marker';el.style.left=`${marker.time*zoom}px`;el.title=markerTitle(marker);markerStyle(el,marker);bindMarker(el,marker);return el}
  function addMarker(){mutate(()=>{project.markers=project.markers||[];const number=Math.max(project.markerSerial||0,...project.markers.map(m=>Number(markerNumber(m))||0))+1;project.markerSerial=number;project.markers.push({id:uid(),time:playhead,number,label:`Маркер ${number}`,color:markerColors[0][0],shape:'flag'})})}
  function showMarkerMenu(e,marker){
    e.preventDefault();e.stopPropagation();closeClipMenu();
    const menu=document.createElement('form');menu.id='clipContextMenu';menu.className='clip-context-menu marker-style-menu';menu.setAttribute('role','dialog');menu.setAttribute('aria-label','Настройка метки');
    const head=document.createElement('div');head.className='marker-menu-heading';const title=document.createElement('strong');title.textContent=`Метка · ${timecode(marker.time)}`;const preview=document.createElement('span');preview.className='marker marker-style-preview';head.append(title,preview);menu.append(head);
    const draft={...marker,number:markerNumber(marker)?Number(markerNumber(marker)):null};const updatePreview=()=>markerStyle(preview,draft);updatePreview();
    const nameLabel=document.createElement('label');nameLabel.textContent='Подпись';const name=document.createElement('input');name.type='text';name.value=marker.label||'';name.maxLength=120;name.placeholder='Например: удачный дубль';nameLabel.append(name);menu.append(nameLabel);name.oninput=()=>draft.label=name.value;
    const numberLabel=document.createElement('label');numberLabel.textContent='Номер · пусто — без номера';const number=document.createElement('input');number.type='number';number.min=1;number.max=9999;number.step=1;number.value=markerNumber(marker);numberLabel.append(number);menu.append(numberLabel);number.oninput=()=>{draft.number=number.value===''?null:Number(number.value);updatePreview()};
    for(const [key,label,values] of [['color','Цвет',markerColors],['shape','Форма',markerShapes]]){const group=document.createElement('fieldset');const legend=document.createElement('legend');legend.textContent=label;group.append(legend);const choices=document.createElement('div');choices.className='marker-style-choices';group.append(choices);for(const [value,text] of values){const button=document.createElement('button');button.type='button';button.title=text;button.setAttribute('aria-label',text);button.setAttribute('aria-pressed',String((draft[key]||(key==='color'?markerColors[0][0]:'flag'))===value));if(key==='color'){button.className='marker-color-choice';button.style.setProperty('--marker-color',value)}else{button.className='marker-shape-choice';const sample=document.createElement('span');sample.className='marker marker-style-preview';markerStyle(sample,{number:1,shape:value,color:draft.color});button.append(sample)}button.onclick=()=>{draft[key]=value;for(const other of choices.children)other.setAttribute('aria-pressed',String(other===button));updatePreview()};choices.append(button)}menu.append(group)}
    const actions=document.createElement('div');actions.className='marker-menu-actions';const remove=document.createElement('button');remove.type='button';remove.textContent='Удалить';remove.className='danger';remove.onclick=()=>{closeClipMenu();mutate(()=>{project.markerSerial=Math.max(project.markerSerial||0,...project.markers.map(m=>Number(markerNumber(m))||0));project.markers=project.markers.filter(m=>m.id!==marker.id)})};const cancel=document.createElement('button');cancel.type='button';cancel.textContent='Отмена';cancel.onclick=closeClipMenu;const save=document.createElement('button');save.type='submit';save.textContent='Сохранить';save.className='marker-save';actions.append(remove,cancel,save);menu.append(actions);
    menu.onsubmit=event=>{event.preventDefault();if(!menu.reportValidity())return;const current=project.markers.find(m=>m.id===marker.id);if(!current){closeClipMenu();return}closeClipMenu();mutate(()=>{Object.assign(current,{label:name.value.trim(),number:number.value===''?null:Number(number.value),color:draft.color||markerColors[0][0],shape:draft.shape||'flag'});project.markerSerial=Math.max(project.markerSerial||0,current.number||0)})};
    document.body.append(menu);const rect=menu.getBoundingClientRect();menu.style.left=`${clamp(e.clientX,8,window.innerWidth-rect.width-8)}px`;menu.style.top=`${clamp(e.clientY,8,window.innerHeight-rect.height-8)}px`;name.focus({preventScroll:true});
  }
  function bindMarker(el,marker){
    el.style.touchAction='none';el.dataset.markerId=marker.id;
    el.oncontextmenu=e=>showMarkerMenu(e,marker);
    el.onpointerdown=e=>{
      e.stopPropagation();
      if(e.button!==0)return;
      e.preventDefault();
      const originX=e.clientX,initialTime=marker.time;
      let moved=false;
      el.setPointerCapture(e.pointerId);
      el.onpointermove=ev=>{
        if(!el.hasPointerCapture(ev.pointerId))return;
        if(Math.abs(ev.clientX-originX)>=4)moved=true;
        if(!moved)return;
        marker.time=clamp(initialTime+(ev.clientX-originX)/zoom,0,86400);
        for(const copy of document.querySelectorAll('[data-marker-id]'))if(copy.dataset.markerId===marker.id){copy.style.left=`${marker.time*zoom}px`;copy.title=markerTitle(marker)}renderMarkerRange(); 
      };
      const clear=()=>{el.onpointermove=null;el.onpointerup=null;el.onpointercancel=null};
      el.onpointerup=ev=>{
        if(el.hasPointerCapture(ev.pointerId))el.releasePointerCapture(ev.pointerId);
        clear();
        if(moved){const time=marker.time;marker.time=initialTime;mutate(()=>marker.time=time)}
        else chooseMarker(marker,e.shiftKey);
      };
      el.onpointercancel=()=>{marker.time=initialTime;clear();renderTimeline()};
    };
  }
  function fitTimeline(){const room=$('timelineScroll').clientWidth-50;zoom=clamp(room/Math.max(duration(),5),20,240);$('zoomSlider').value=zoom;renderTimeline()}
  function bindSidePanels(){
    const workspace=document.querySelector('.workspace'),storageKey='montazhnaya-side-panels-v1';
    let state={mediaCollapsed:false,propertiesCollapsed:false};
    try{const saved=JSON.parse(localStorage.getItem(storageKey));if(saved)state={mediaCollapsed:saved.mediaCollapsed===true,propertiesCollapsed:saved.propertiesCollapsed===true}}catch{}
    function apply(){
      workspace.classList.toggle('left-panel-collapsed',state.mediaCollapsed);
      workspace.classList.toggle('right-panel-collapsed',state.propertiesCollapsed);
      for(const [id,collapsed,name] of [['toggleMediaPanelBtn',state.mediaCollapsed,'медиа'],['togglePropertiesPanelBtn',state.propertiesCollapsed,'свойств']]){
        const button=$(id),label=`${collapsed?'Развернуть':'Свернуть'} панель ${name}`;
        button.setAttribute('aria-expanded',String(!collapsed));button.setAttribute('aria-label',label);button.title=label;
      }
      $('sidebarContent').inert=state.mediaCollapsed;document.querySelector('.tabs').inert=state.mediaCollapsed;$('inspectorContent').inert=state.propertiesCollapsed;
      fitPreview();
    }
    for(const [id,key] of [['toggleMediaPanelBtn','mediaCollapsed'],['togglePropertiesPanelBtn','propertiesCollapsed']])$(id).onclick=()=>{
      closeClipMenu();state[key]=!state[key];apply();try{localStorage.setItem(storageKey,JSON.stringify(state))}catch{}
    };
    apply();
  }
  function bindTimelinePanel(){
    const editor=$('app'),panel=$('timelinePanel'),divider=$('timelineDivider'),button=$('toggleTimelineBtn');
    const storageKey='montazhnaya-layout-v1';
    let height=window.innerHeight*.4,collapsed=false;
    try{const saved=JSON.parse(localStorage.getItem(storageKey));if(saved){if(Number.isFinite(saved.timelineHeight))height=saved.timelineHeight;collapsed=saved.collapsed===true}}catch{}
    const limits=()=>{const max=Math.max(0,editor.clientHeight-document.querySelector('.topbar').offsetHeight-document.querySelector('.statusbar').offsetHeight-divider.offsetHeight-180);return {min:Math.min(140,max),max}};
    const save=()=>{try{localStorage.setItem(storageKey,JSON.stringify({timelineHeight:height,collapsed}))}catch{}};
    function apply(){
      const range=limits(),visibleHeight=collapsed?0:clamp(height,range.min,range.max);
      editor.style.setProperty('--timeline-height',`${visibleHeight}px`);
      editor.classList.toggle('timeline-collapsed',collapsed);
      button.setAttribute('aria-expanded',String(!collapsed));button.querySelector('span').textContent=collapsed?'Развернуть дорожки':'Свернуть дорожки';
      panel.inert=collapsed;divider.setAttribute('aria-valuemin','0');divider.setAttribute('aria-valuemax',String(Math.round(range.max)));divider.setAttribute('aria-valuenow',String(Math.round(visibleHeight)));
    }
    function toggle(){closeClipMenu();collapsed=!collapsed;apply();save();requestAnimationFrame(()=>{fitPreview();renderTimeline()})}
    button.onclick=toggle;
    divider.onpointerdown=e=>{
      if(e.button!==0||button.contains(e.target))return;
      e.preventDefault();closeClipMenu();
      const origin=e.clientY,startHeight=panel.getBoundingClientRect().height,previous={height,collapsed};
      divider.setPointerCapture(e.pointerId);document.body.classList.add('resizing-timeline');
      divider.onpointermove=ev=>{if(!divider.hasPointerCapture(ev.pointerId))return;const delta=origin-ev.clientY;if(Math.abs(delta)<3)return;const range=limits();height=clamp(startHeight+delta,range.min,range.max);collapsed=false;apply()};
      const clear=()=>{document.body.classList.remove('resizing-timeline');divider.onpointermove=null;divider.onpointerup=null;divider.onpointercancel=null};
      divider.onpointerup=ev=>{if(divider.hasPointerCapture(ev.pointerId))divider.releasePointerCapture(ev.pointerId);clear();save();fitPreview()};
      divider.onpointercancel=()=>{height=previous.height;collapsed=previous.collapsed;clear();apply()};
    };
    divider.onkeydown=e=>{
      if(e.target!==divider)return;
      if(e.key==='Enter'||e.key===' '){e.preventDefault();e.stopPropagation();toggle()}
      else if(e.key==='ArrowUp'||e.key==='ArrowDown'){e.preventDefault();e.stopPropagation();const range=limits();height=clamp((collapsed?range.min:panel.getBoundingClientRect().height)+(e.key==='ArrowUp'?20:-20),range.min,range.max);collapsed=false;apply();save()}
    };
    window.addEventListener('resize',apply);apply();
  }
  function closeClipMenu(){document.getElementById('clipContextMenu')?.remove()}
  function showClipMenu(e,id){
    e.preventDefault();e.stopPropagation();closeClipMenu();
    const found=findItem(id);if(!found)return;
    const {item,track}=found;
    const time=clamp(item.start+(e.clientX-e.currentTarget.getBoundingClientRect().left)/zoom,item.start,item.start+item.duration);
    if(!selectedItemIds().includes(id))selectItem(id);
    const menu=document.createElement('div');menu.id='clipContextMenu';menu.className='clip-context-menu';menu.setAttribute('role','menu');menu.setAttribute('aria-label','Действия с клипом');menu.tabIndex=-1;
    const actions=[
      ['Разрезать здесь',()=>{selectItem(id);seek(time);splitAtPlayhead(false)},time-item.start<.03||item.start+item.duration-time<.03],
      ['Удалить',()=>removeItem(id,false),false],
      ['Удалить со сдвигом',()=>removeItem(id,true),false],
      ...(canHaveTransition(track,item)&&item.transitionIn&&item.transitionIn!=='none'?[['Удалить переход',()=>removeTransition(id),false]]:[]),
      ['Объединить выделенные ячейки',mergeSelected,!!mergeReason()],
      ['Связать видео и звук',linkSelected,!!linkReason()],
      ['Развязать видео и звук',unlinkSelected,!unlinkGroups().size],
      ...(['video','image'].includes(item.kind)?[['Копировать оформление',()=>copyAppearance(item),false],['Применить оформление к выделенным',pasteAppearance,!appearanceClipboard]]:[]),
      ...(track.type==='audio'?[['Сохранить выделенный звук в MP3',()=>{$('exportBtn').click();$('exportScope').value='selection';$('exportFormat').value='audio/mp3';updateExportOptions()},false]]:[]),
      ...(item.kind==='compound'?[['Разъединить на исходные клипы',()=>unmergeClip(id),false]]:[])
    ];
    for(const [label,action,disabled] of actions){
      const button=document.createElement('button');button.type='button';button.textContent=label;button.setAttribute('role','menuitem');button.disabled=track.locked||disabled;
      button.onclick=()=>{closeClipMenu();const current=findItem(id);if(current&&!current.track.locked)action()};menu.append(button);
    }
    menu.oncontextmenu=event=>event.preventDefault();
    document.body.append(menu);
    const rect=menu.getBoundingClientRect();
    menu.style.left=`${clamp(e.clientX,8,window.innerWidth-rect.width-8)}px`;
    menu.style.top=`${clamp(e.clientY,8,window.innerHeight-rect.height-8)}px`;
    (menu.querySelector('button:not(:disabled)')||menu).focus({preventScroll:true});
  }
  function bindClipMenuDismissal(){
    document.addEventListener('pointerdown',e=>{const menu=$('clipContextMenu');if(menu&&!menu.contains(e.target))closeClipMenu()});
    window.addEventListener('resize',closeClipMenu);
    document.addEventListener('scroll',closeClipMenu,true);
    document.addEventListener('keydown',e=>{
      const menu=$('clipContextMenu');if(!menu)return;
      if(e.key==='Escape'){e.preventDefault();e.stopImmediatePropagation();closeClipMenu();return}
      if(menu.classList.contains('marker-style-menu')&&['INPUT','TEXTAREA'].includes(document.activeElement?.tagName))return;
      if(['ArrowDown','ArrowUp','Home','End'].includes(e.key)){
        e.preventDefault();e.stopImmediatePropagation();const buttons=[...menu.querySelectorAll('button:not(:disabled)')];if(!buttons.length)return;
        const index=buttons.indexOf(document.activeElement);
        const next=e.key==='Home'?0:e.key==='End'?buttons.length-1:(index+(e.key==='ArrowDown'?1:-1)+buttons.length)%buttons.length;
        buttons[next].focus();
      }
    },true);
  }
  function renderBottomRuler(){
    const ruler=$('bottomRuler');if(!ruler)return;
    ruler.style.width=$('timelineInner').style.width;$('bottomRulerTicks').innerHTML=$('ruler').innerHTML;
    let markers=$('bottomMarkerLayer');if(!markers){markers=document.createElement('div');markers.id='bottomMarkerLayer';markers.className='marker-layer bottom-marker-layer';ruler.append(markers)}markers.replaceChildren();
    for(const marker of project.markers||[]){markers.append(renderMarker(marker))}
    ruler.setAttribute('aria-valuemax',String(duration()));syncBottomRulerScroll();
  }
  function syncBottomRulerScroll(){
    const viewport=$('timelineScroll'),bottom=$('bottomRulerScroll');if(!bottom)return;
    bottom.style.marginRight=`${Math.max(0,viewport.offsetWidth-viewport.clientWidth)}px`;bottom.scrollLeft=viewport.scrollLeft;
  }
  function bindBottomRuler(){
    const ruler=$('bottomRuler');$('timelineScroll').addEventListener('scroll',syncBottomRulerScroll,{passive:true});
    const move=event=>seek((event.clientX-ruler.getBoundingClientRect().left)/zoom);
    ruler.onpointerdown=e=>{if(e.button!==0||exporting)return;e.preventDefault();ruler.focus({preventScroll:true});move(e);ruler.setPointerCapture(e.pointerId);ruler.onpointermove=ev=>{if(ruler.hasPointerCapture(ev.pointerId))move(ev)};const clear=ev=>{if(ruler.hasPointerCapture(ev.pointerId))ruler.releasePointerCapture(ev.pointerId);ruler.onpointermove=ruler.onpointerup=ruler.onpointercancel=null};ruler.onpointerup=clear;ruler.onpointercancel=clear};
    ruler.onkeydown=e=>{if(exporting||e.ctrlKey||e.metaKey||e.altKey)return;if(['ArrowLeft','ArrowRight','Home','End'].includes(e.key)){e.preventDefault();e.stopPropagation();seek(e.key==='Home'?0:e.key==='End'?duration():playhead+(e.key==='ArrowRight'?1:-1)/(project.fps||30))}};
    syncBottomRulerScroll();
  }
  function bindTimelineWheel(){
    const viewport=$('timelineScroll'),panel=$('timelinePanel');
    panel.title='Колёсико — масштаб дорожек. Ctrl + колёсико — прокрутка влево / вправо.';
    panel.addEventListener('wheel',e=>{
      const raw=e.deltaY||e.deltaX;if(!raw)return;
      e.preventDefault();
      const unit=e.deltaMode===1?16:e.deltaMode===2?viewport.clientWidth:1;
      if(e.ctrlKey){viewport.scrollLeft=clamp(viewport.scrollLeft+raw*unit,0,Math.max(0,viewport.scrollWidth-viewport.clientWidth));return}
      if(!e.deltaY)return;
      const rect=viewport.getBoundingClientRect();
      const offset=clamp(e.clientX-rect.left-viewport.clientLeft,0,viewport.clientWidth);
      const time=(viewport.scrollLeft+offset)/zoom;
      const delta=clamp(e.deltaY*unit,-240,240);
      const next=clamp(Math.round(zoom*Math.exp(-delta*.0015)),20,240);
      if(next===zoom)return;
      zoom=next;$('zoomSlider').value=zoom;renderTimeline();
      viewport.scrollLeft=time*zoom-offset;
    },{passive:false});
  }

  function parseTimestamp(value){const parts=value.replace(',','.').split(':').map(Number);return parts.length===3?parts[0]*3600+parts[1]*60+parts[2]:parts.length===2?parts[0]*60+parts[1]:number(parts[0])}
  function parseSubtitleCues(text){
    const cues=[];for(const block of text.replace(/^\uFEFF/,'').replace(/\r/g,'').split(/\n\s*\n/)){
      const lines=block.split('\n'),index=lines.findIndex(line=>/-->/.test(line));if(index<0)continue;
      const match=lines[index].match(/^\s*((?:\d{1,}:)?\d{2}:\d{2}[,.]\d{3})\s*-->\s*((?:\d{1,}:)?\d{2}:\d{2}[,.]\d{3})(?:\s|$)/);if(!match)continue;
      const start=parseTimestamp(match[1]),end=parseTimestamp(match[2]),caption=lines.slice(index+1).join('\n').trim().replace(/<[^>]+>/g,'');
      if(Number.isFinite(start)&&Number.isFinite(end)&&start>=0&&end>start&&caption)cues.push({start,end,text:caption});
    }return cues;
  }
  function insertSubtitleAsset(asset,start=playhead,trackId=null){
    if(exporting||!asset.cues?.length)return;let track=trackId?findTrack(trackId):null;
    if(trackId&&track?.type!=='text')return toast('Перетащите титры на текстовую дорожку T');
    if(track?.locked)return toast('Разблокируйте дорожку '+track.label);
    const at=clamp(start,0,86400);let first;pause();mutate(()=>{
      if(!track){track=defaultTrack('text',nextTrackNumber('text'));tracks().unshift(track)}track.subtitleWorkshop=true;
      for(const cue of asset.cues){const item={id:uid(),kind:'subtitle',style:'subtitle',text:cue.text,start:at+cue.start,duration:cue.end-cue.start,size:42,color:'#ffffff',outline:'#000000',outlineWidth:3,x:0,y:25,scale:1,rotation:0,opacity:1,fadeIn:0,fadeOut:0};track.items.push(item);first??=item}
    });selectItem(first.id);seek(first.start);toast(`Добавлено реплик: ${asset.cues.length}`);return first;
  }
  async function importSubtitles(file){const epoch=projectEpoch;await importFiles([file]);if(epoch!==projectEpoch)return;const asset=[...assets.values()].find(a=>a.file===file&&a.type==='subtitle');if(!asset)return;insertSubtitleAsset(asset,0);tab='subtitles';refresh()}

  function downloadBlob(blob,name){const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),60000)}
  function downloadSrt(){const items=visiblePlaybackItems().map(x=>x.item).filter(i=>i.kind==='subtitle').sort((a,b)=>a.start-b.start);const ts=t=>formatClipTime(t).replace(/:(\d{3})$/,',$1');const text=items.map((x,i)=>`${i+1}\n${ts(x.start)} --> ${ts(x.start+x.duration)}\n${x.text}\n`).join('\n');downloadBlob(new Blob([text],{type:'text/plain;charset=utf-8'}),'subtitles.srt')}
  function saveProject(){project.assetManifest=currentMediaManifest();downloadBlob(new Blob([JSON.stringify(project,null,2)],{type:'application/json'}),`${project.name.replace(/[\\/:*?"<>|]/g,'_')||'project'}.json`);queueSave();toast('Проект сохранён. Исходные файлы храните отдельно.')}
  function migrateTrackGroups(saved){
    const extra=[];
    for(const track of saved.tracks){
      if(track.type==='video'){
        const overlays=track.items.filter(overlayKind);
        if((track.items.length&&overlays.length===track.items.length)||(!track.items.length&&track.role==='overlay')){track.type='text';delete track.role}
        else if(overlays.length){const textTrack={...track,id:uid(),type:'text',items:overlays};delete textTrack.role;extra.push(textTrack);track.items=track.items.filter(i=>!overlayKind(i));delete track.role}
      }
    }
    saved.tracks.push(...extra);
    const prefix=track=>track.type==='text'?'T':track.type==='audio'?'S':'V',used=new Set(saved.tracks.filter(t=>new RegExp('^'+prefix(t)+'\\d+$').test(t.label)).map(t=>t.label)),seen=new Set();
    for(const track of saved.tracks){const expected=prefix(track);if(new RegExp('^'+expected+'\\d+$').test(track.label)&&!seen.has(track.label)){seen.add(track.label);continue}if(/^[VATS]\d+$/.test(track.label)){let n=1;while(used.has(expected+n))n++;track.label=expected+n;used.add(track.label);seen.add(track.label)}}
    return saved;
  }
  function migrateLegacy(old){if(old?.version===2)return migrateTrackGroups(old);const migrated=freshProject();if(!old||!Array.isArray(old.clips))return migrated;migrated.name=old.name||migrated.name;migrated.ratio=old.ratio||migrated.ratio;const video=migrated.tracks.find(t=>t.type==='video'),audio=migrated.tracks.find(t=>t.type==='audio');let offset=0;for(const c of old.clips){video.items.push({id:c.id||uid(),kind:'video',assetId:c.assetId,start:offset,duration:c.duration||5,sourceIn:c.trimIn||0,speed:1,volume:c.volume??1,opacity:1,scale:1,x:0,y:0,rotation:0,brightness:1,contrast:1,saturation:1,fadeIn:0,fadeOut:0});offset+=c.duration||5}if(old.music)audio.items.push({id:uid(),kind:'audio',assetId:old.music.assetId,start:0,duration:offset,sourceIn:0,speed:1,volume:old.music.volume??.6,fadeIn:0,fadeOut:0});if(old.titles?.length){const textTrack=defaultTrack('text',1);migrated.tracks.unshift(textTrack);for(const t of old.titles)textTrack.items.push({id:t.id||uid(),kind:'title',style:'title',text:t.text,start:t.start,duration:t.duration,size:t.size||48,color:t.color||'#fff',x:0,y:(t.y??.78)*100-50,scale:1,rotation:0,opacity:1,fadeIn:0,fadeOut:0})}return migrated}
  async function openProject(file){try{const raw=JSON.parse(await file.text());if(!raw.tracks&&!raw.clips)throw Error('Неизвестный формат');pause();projectEpoch++;project=migrateLegacy(raw);await loadProjectMedia(project);for(const {item} of leafItems())if(item.assetId&&assets.get(item.assetId)?.type==='image')item.kind='image';separateLegacyAudio();selected=null;playhead=0;undoStack.length=0;redoStack.length=0;$('projectName').value=project.name;refresh();queueSave();const missing=[...new Set(leafItems().map(({item})=>item.assetId).filter(id=>id&&!assets.has(id)))];toast(missing.length?`Проект открыт. Добавьте исходные файлы (${missing.length}).`:'Проект открыт.')}catch(e){toast(`Не удалось открыть проект: ${e.message}`)}}
  function openDb(){return new Promise((resolve,reject)=>{const request=indexedDB.open('montazhnaya-v1',1);request.onupgradeneeded=()=>{request.result.createObjectStore('assets',{keyPath:'id'});request.result.createObjectStore('project')};request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error)})}
  async function dbWrite(store,value,key){const db=await openDb();try{await new Promise((resolve,reject)=>{const tx=db.transaction(store,'readwrite');tx.objectStore(store).put(value,key);tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error)})}finally{db.close()}}
  function currentMediaAssets(){const ids=project.mediaLibraryVersion===1?new Set((project.assetManifest||[]).map(a=>a.id)):null;return [...assets.values()].filter(asset=>!ids||ids.has(asset.id))}
  function currentMediaManifest(){return [...currentMediaAssets().map(a=>({id:a.id,name:a.name,type:a.type})),...(project.assetManifest||[]).filter(a=>!assets.has(a.id))]}
  function snapshotAssetIds(snapshot){const ids=new Set((snapshot.assetManifest||[]).map(a=>a.id));const visit=item=>{if(item.assetId)ids.add(item.assetId);for(const child of item.parts||[])visit(child)};for(const track of snapshot.tracks||[])for(const item of track.items||[])visit(item);return ids}
  function persist(){
    const epoch=projectEpoch,list=currentMediaAssets();project.assetManifest=currentMediaManifest();project.mediaLibraryVersion=1;const snapshot=JSON.parse(JSON.stringify(project));
    persistQueue=persistQueue.catch(()=>{}).then(async()=>{if(epoch!==projectEpoch)return;await dbWrite('project',snapshot,'current');for(const asset of list){if(epoch!==projectEpoch)return;if(!asset.stored){await dbWrite('assets',{id:asset.id,name:asset.name,type:asset.type,file:asset.file});asset.stored=true}}if(epoch===projectEpoch&&Date.now()-lastAutoVersion>60000)await saveVersion(true)}).catch(e=>{console.warn('Auto save failed:',e);status('Автосохранение не удалось. Скачайте проект JSON и сохраните исходные файлы.')});return persistQueue;
  }
  async function loadProjectMedia(snapshot,legacyAll=false){
    const epoch=projectEpoch,ids=snapshotAssetIds(snapshot),db=await openDb();let records;
    try{records=await new Promise((resolve,reject)=>{const r=db.transaction('assets').objectStore('assets').getAll();r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)})}finally{db.close()}
    for(const record of records){if(epoch!==projectEpoch)return;if(!legacyAll&&!ids.has(record.id))continue;if(assets.has(record.id))continue;const url=URL.createObjectURL(record.file);try{const meta=await mediaMetadata(record.file,url,record.type);if(epoch!==projectEpoch){URL.revokeObjectURL(url);return}const asset={...record,url,...meta,stored:true};assets.set(record.id,asset);queueAssetAnalysis(asset)}catch{URL.revokeObjectURL(url)}}
    if(epoch===projectEpoch){const desired=legacyAll?[...assets.values()]:[...assets.values()].filter(a=>ids.has(a.id));const missing=(snapshot.assetManifest||[]).filter(a=>!assets.has(a.id));snapshot.assetManifest=[...desired.map(a=>({id:a.id,name:a.name,type:a.type})),...missing];snapshot.mediaLibraryVersion=1}
  }
  async function restore(){const epoch=projectEpoch;try{const db=await openDb();let saved;try{saved=await new Promise((resolve,reject)=>{const r=db.transaction('project').objectStore('project').get('current');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)})}finally{db.close()}if(epoch!==projectEpoch)return;if(saved)project=migrateLegacy(saved);await loadProjectMedia(project,!!saved&&saved.mediaLibraryVersion!==1);if(epoch!==projectEpoch)return;for(const {item} of leafItems())if(item.assetId&&assets.get(item.assetId)?.type==='image')item.kind='image';separateLegacyAudio()}catch(e){console.warn('Restore failed:',e)}if(epoch!==projectEpoch)return;$('projectName').value=project.name;setCanvasSize();refresh()}
  function resetProjectState(){
    pause();clearTimeout(saveTimer);projectEpoch++;analysisQueue.length=0;
    for(const state of elements.values()){state.el.pause();state.source?.disconnect();state.exportGain?.disconnect();state.monitorGain?.disconnect();state.el.removeAttribute?.('src');state.el.load?.()}elements.clear();
    for(const asset of assets.values()){if(asset.url)URL.revokeObjectURL(asset.url);delete asset.decodedPromise}assets.clear();
    project=freshProject();selected=null;playhead=0;undoStack.length=0;redoStack.length=0;showHiddenMedia=false;tab='media';ripple=false;exportSelection=null;appearanceClipboard=null;pendingTemplateItem=null;lastAutoVersion=Date.now();lastVersionContent='';
    $('mediaInput').value='';$('srtInput').value='';$('projectName').value=project.name;updateInsertModeButton();refresh();status('Новый проект: добавьте видео, фото или звук.');
  }
  async function pruneMediaForNewProject(snapshot){
    await versionWrite.catch(()=>{});const protectedIds=new Set(projectVersions.flatMap(v=>[...snapshotAssetIds(v.project)]));const db=await openDb();
    try{await new Promise((resolve,reject)=>{const tx=db.transaction(['assets','project'],'readwrite');tx.objectStore('project').put(snapshot,'current');const versions=tx.objectStore('project').get('versions');versions.onsuccess=()=>{for(const version of versions.result||[])for(const id of snapshotAssetIds(version.project))protectedIds.add(id);const cursor=tx.objectStore('assets').openCursor();cursor.onsuccess=()=>{const entry=cursor.result;if(!entry)return;if(!protectedIds.has(entry.key))entry.delete();entry.continue()}};tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error)})}finally{db.close()}
  }
  async function newProject(confirmed=false){
    if(exporting)return;if(confirmed!==true){$('newProjectDialog').showModal();return}$('newProjectDialog').close();
    subtitleDrawMode=false;subtitleTrackId=null;subtitleSearch='';subtitlePlayUntil=null;resetProjectState();const snapshot=JSON.parse(JSON.stringify(project));persistQueue=persistQueue.catch(()=>{}).then(()=>pruneMediaForNewProject(snapshot));
    try{await persistQueue;toast('Новый проект создан. Список Медиа очищен.')}catch(e){console.warn('Media cleanup failed:',e);status('Проект очищен, но очистку кэша не удалось сохранить. Проверьте свободное место в браузере.')}
  }


  async function connectAudio(){if(!audioContext){audioContext=new (window.AudioContext||window.webkitAudioContext)();audioDestination=audioContext.createMediaStreamDestination();audioClock=audioContext.createOscillator();const zero=audioContext.createGain();zero.gain.value=0;audioClock.connect(zero).connect(audioDestination);audioClock.start()}for(const {track,item} of playbackItems()){if(track.type!=='audio'||item.kind!=='audio')continue;const state=elements.get(item.id);if(!state||state.source)continue;try{state.source=audioContext.createMediaElementSource(state.el);state.exportGain=audioContext.createGain();state.monitorGain=audioContext.createGain();state.source.connect(state.exportGain).connect(audioDestination);state.source.connect(state.monitorGain).connect(audioContext.destination)}catch(e){console.warn('Audio connection:',e)}}syncElements()}
  function supportedMime(preferred){const candidates=preferred==='video/mp4'?['video/mp4;codecs=avc1.42E01E,mp4a.40.2','video/mp4']:['video/webm;codecs=vp9,opus','video/webm;codecs=vp8,opus','video/webm'];return candidates.find(type=>MediaRecorder.isTypeSupported(type))}
  let exportEnd=0, previousSize=null, exportInterval;
  async function startExport(){if($('exportFormat').value==='audio/mp3')return exportMp3();if(exporting)return;if(!configureExportScope())return;if(duration()<=0)return toast('Добавьте клипы на линию');if(!window.MediaRecorder||!canvas.captureStream)return toast('Экспорт не поддерживается этим браузером');const mime=supportedMime($('exportFormat').value);if(!mime)return toast('Формат не поддерживается. Выберите WebM.');pause();exporting=true;discardExport=false;exportMime=mime;exportChunks=[];const height=$('exportResolution').value==='source'?project.resolution:number($('exportResolution').value),fps=number($('exportFps').value);previousSize={w:canvas.width,h:canvas.height};setCanvasSize(height);const range=exportBounds();playhead=range.start;exportEnd=range.end;if(exportEnd<=playhead){exporting=false;setCanvasSize();return toast('Конец экспорта должен быть после начала. Снимите границу повторным кликом.')}try{const hasSound=playbackItems().some(({track,item})=>item.kind==='audio'&&track.type==='audio'&&!item.muted&&audible(track)&&exportAllows(item)&&((item.volume??1)>0||item.keyframes?.volume?.some(f=>f.value>0)));if(hasSound){await connectAudio();await audioContext.resume()}syncElements(true);const stream=canvas.captureStream(fps);if(hasSound)for(const track of audioDestination.stream.getAudioTracks())stream.addTrack(track);recorder=new MediaRecorder(stream,{mimeType:mime,videoBitsPerSecond:height>=1080?9000000:height>=720?5000000:2500000});recorder.ondataavailable=e=>{if(e.data.size)exportChunks.push(e.data)};recorder.onerror=e=>{console.error(e);toast('Ошибка кодирования видео');discardExport=true;finishExport()};recorder.onstop=()=>{stream.getTracks().forEach(t=>t.stop());if(discardExport)return;const extension=exportMime.startsWith('video/mp4')?'mp4':'webm';const blob=new Blob(exportChunks,{type:exportMime});if(blob.size<1000){toast('Экспорт завершился пустым файлом. Попробуйте другой формат или браузер.');return}downloadBlob(blob,`${project.name.replace(/[\\/:*?"<>|]/g,'_')||'video'}.${extension}`);toast('Видео сохранено')};recorder.start(1000);$('startExportBtn').disabled=true;$('exportProgress').hidden=false;$('exportStatus').textContent='Подготовка видео…';exportInterval=setInterval(()=>{const percent=clamp((playhead-exportBounds().start)/(exportEnd-exportBounds().start)*100,0,100);$('exportProgress').value=percent;$('exportStatus').textContent=`Экспорт: ${Math.round(percent)}%`},250);lastTick=0;raf=requestAnimationFrame(tick)}catch(e){console.error(e);discardExport=true;finishExport();toast(`Экспорт не удался: ${e.message}`)}}
  function finishExport(){if(!exporting)return;exportSelection=null;exporting=false;cancelAnimationFrame(raf);clearInterval(exportInterval);for(const state of elements.values())state.el.pause();if(recorder?.state==='recording')recorder.stop();$('startExportBtn').disabled=false;$('exportProgress').hidden=true;if($('exportDialog').open)$('exportDialog').close();setCanvasSize(project.resolution);syncElements(true);draw()}
  function cancelExport(){if(audioExportActive){cancelMp3();return}if(exporting){discardExport=true;finishExport();toast('Экспорт отменён')}else $('exportDialog').close()}
  function snapshot(){draw();canvas.toBlob(blob=>{if(blob)downloadBlob(blob,`frame-${timecode(playhead).replaceAll(':','-')}.png`)},'image/png')}

  function handleEditorShortcut(e){
    if(e.isComposing||$('cropDialog')?.open)return;
    const code=e.code||e.key,command=e.ctrlKey||e.metaKey;
    const input=['INPUT','TEXTAREA','SELECT'].includes(document.activeElement?.tagName)||document.activeElement?.isContentEditable;
    if(command&&!e.altKey&&code==='KeyS'){e.preventDefault();saveProject();return}
    if(command&&!e.altKey&&code==='KeyZ'){e.preventDefault();document.activeElement?.blur();e.shiftKey?redo():undo();return}
    if(command&&!e.altKey&&code==='KeyY'){e.preventDefault();redo();return}
    if(!input&&command&&!e.altKey&&!e.shiftKey&&['ArrowLeft','ArrowRight'].includes(code)&&!document.querySelector('dialog[open]')){e.preventDefault();jumpToMarker(code==='ArrowLeft'?-1:1);return}
    if(tab==='subtitles'&&!command&&!document.querySelector('dialog[open]')&&!exporting){if(e.altKey&&code==='KeyN'){e.preventDefault();document.activeElement?.blur();addSubtitleOnCursor();return}if(!input&&!e.altKey){const cue=selected?.kind==='item'&&findItem(selected.id);if(cue?.item.kind==='subtitle'&&!cue.track.locked&&['BracketLeft','BracketRight'].includes(code)){e.preventDefault();setSubtitleBoundary(cue.item,code==='BracketLeft'?'start':'end');return}if(code==='Escape'&&subtitleDrawMode){e.preventDefault();subtitleDrawMode=false;renderSidebar();renderTimeline();status('Рисование зон выключено');return}}}
    if(input||command||e.altKey||document.querySelector('dialog[open]'))return;
    if(code==='Escape'&&(markerAnchorId||markerRangeEndId)){e.preventDefault();markerAnchorId=null;markerRangeEndId=null;renderMarkerRange();return}
    if(code==='Space'){e.preventDefault();togglePlayback()}
    else if(code==='ArrowLeft'){e.preventDefault();seek(playhead-1/project.fps)}
    else if(code==='ArrowRight'){e.preventDefault();seek(playhead+1/project.fps)}
    else if(code==='Delete'){e.preventDefault();deleteSelected(false)}
    else if(code==='KeyS'){e.preventDefault();splitAtPlayhead()}
    else if(code==='KeyM'){e.preventDefault();addMarker()}
    else if(code==='KeyI'){e.preventDefault();setExportBoundary('inPoint')}
    else if(code==='KeyO'){e.preventDefault();setExportBoundary('outPoint')}
  }
  function wireEvents(){document.querySelectorAll('.tab').forEach(b=>b.onclick=()=>{tab=b.dataset.tab;renderSidebar();renderTimeline()});$('mediaInput').onchange=e=>{importFiles(e.target.files);e.target.value=''};$('srtInput').onchange=e=>{if(e.target.files[0])importSubtitles(e.target.files[0]);e.target.value=''};$('projectName').onchange=e=>mutate(()=>project.name=e.target.value.trim()||'Новый проект');$('newBtn').onclick=()=>newProject();$('confirmNewProjectBtn').onclick=()=>newProject(true);$('cancelNewProjectBtn').onclick=()=>$('newProjectDialog').close();$('openProjectInput').onchange=e=>{if(e.target.files[0])openProject(e.target.files[0]);e.target.value=''};$('saveBtn').onclick=saveProject;$('undoBtn').onclick=undo;$('redoBtn').onclick=redo;$('slowMotionBtn').onclick=()=>openSlowMotion();$('shortcutsBtn').onclick=()=>$('shortcutsDialog').showModal();$('closeShortcutsBtn').onclick=()=>$('shortcutsDialog').close();$('exportBtn').onclick=()=>{if(!exporting){refreshExportFrameOption();$('exportResolution').value='source';$('exportFps').value=String(project.fps);$('exportStatus').textContent='';$('exportProgress').hidden=true;let note=$('exportRangeNote');if(!note){note=document.createElement('p');note.id='exportRangeNote';note.className='export-range-note';$('exportDialog').querySelector('.modal-body').prepend(note)}note.textContent=project.inPoint!=null||project.outPoint!=null?`Экспорт фрагмента: ${timecode(clamp(project.inPoint??0,0,duration()))} — ${timecode(clamp(project.outPoint??duration(),0,duration()))}`:'Экспорт всего монтажа';updateExportOptions();$('exportDialog').showModal()}};$('startExportBtn').onclick=startExport;$('closeExportBtn').onclick=cancelExport;$('cancelExportBtn').onclick=cancelExport;$('exportDialog').onclose=()=>{if(audioExportActive){cancelMp3();return}if(exporting){discardExport=true;finishExport()}};$('playBtn').onclick=togglePlayback;$('jumpStartBtn').onclick=()=>seek(0);$('jumpEndBtn').onclick=()=>seek(duration());$('prevFrameBtn').onclick=()=>seek(playhead-1/project.fps);$('nextFrameBtn').onclick=()=>seek(playhead+1/project.fps);$('mutePreviewBtn').onclick=()=>{previewMuted=!previewMuted;updatePreviewSoundIcon();syncElements()};$('snapshotBtn').onclick=snapshot;$('fullscreenBtn').onclick=()=>{$('canvasShell').requestFullscreen?.()};$('splitBtn').onclick=splitAtPlayhead;$('deleteBtn').onclick=()=>deleteSelected(false);$('rippleDeleteBtn').onclick=()=>deleteSelected(true);$('rippleBtn').onclick=()=>{ripple=!ripple;updateInsertModeButton();toast(ripple?'Режим V1: вставка на курсоре со сдвигом, звук на новой S-дорожке.':'Новые видео: отдельная связанная пара дорожек V + S.');status(ripple?'Добавление видео: V1 со сдвигом + новая S-дорожка':'Добавление видео: новая отдельная пара V / S')};$('snapBtn').onclick=()=>{snap=!snap;$('snapBtn').classList.toggle('active',snap)};$('markerBtn').onclick=addMarker;$('inBtn').onclick=()=>setExportBoundary('inPoint');$('outBtn').onclick=()=>setExportBoundary('outPoint');$('addVideoTrackBtn').onclick=()=>addTrack('video');$('addAudioTrackBtn').onclick=()=>addTrack('audio');$('addTextTrackBtn').onclick=()=>addTrack('text');$('zoomSlider').oninput=e=>{zoom=number(e.target.value);renderTimeline()};$('zoomOutBtn').onclick=()=>{zoom=clamp(zoom-20,20,240);$('zoomSlider').value=zoom;renderTimeline()};$('zoomInBtn').onclick=()=>{zoom=clamp(zoom+20,20,240);$('zoomSlider').value=zoom;renderTimeline()};$('fitBtn').onclick=fitTimeline;$('ruler').onpointerdown=e=>{if(e.button!==0)return;const rect=$('ruler').getBoundingClientRect();seek((e.clientX-rect.left)/zoom);$('ruler').setPointerCapture(e.pointerId);$('ruler').onpointermove=ev=>{if($('ruler').hasPointerCapture(ev.pointerId))seek((ev.clientX-rect.left)/zoom)};$('ruler').onpointerup=()=>{$('ruler').onpointermove=null;$('ruler').onpointerup=null}};window.addEventListener('resize',()=>renderTimeline());document.addEventListener('keydown',handleEditorShortcut);document.addEventListener('dragover',e=>{if(e.dataTransfer?.files?.length)e.preventDefault()});document.addEventListener('drop',e=>{if(e.dataTransfer?.files?.length){e.preventDefault();importFiles(e.dataTransfer.files)}})}
  // Linked trimming uses one timeline delta, bounded by every partner's source.
  function trimEntries(item){return expandLinkedEntries([findItem(item.id)]).filter(Boolean)}
  function trimSnapshot(item){return trimEntries(item).map(e=>({...e,start:e.item.start,duration:e.item.duration,sourceIn:e.item.sourceIn||0}))}
  function applyTrim(entries,edge,delta){
    if(entries.some(e=>e.track.locked))return false;
    let min=-Infinity,max=Infinity;
    for(const e of entries){
      if(edge==='left'){min=Math.max(min,-e.start,(e.item.assetId||e.item.kind==='compound')?-e.sourceIn/(e.item.speed||1):-e.start);max=Math.min(max,e.duration-.04)}
      else{min=Math.max(min,.04-e.duration);max=Math.min(max,itemMaxDuration({...e.item,sourceIn:e.sourceIn})-e.duration)}
    }
    delta=clamp(delta,min,max);
    for(const e of entries){if(edge==='left'){e.item.start=e.start+delta;e.item.duration=e.duration-delta;e.item.sourceIn=e.sourceIn+delta*(e.item.speed||1)}else e.item.duration=e.duration+delta;e.item.fadeIn=Math.min(e.item.fadeIn||0,e.item.duration);e.item.fadeOut=Math.min(e.item.fadeOut||0,e.item.duration)}
    return true;
  }
  function setLinkedDuration(item,value){if(!applyTrim(trimSnapshot(item),'right',value-item.duration))toast('Разблокируйте связанные дорожки')}
  function startLinkedTrim(e,item,track,clip){
    const entries=trimSnapshot(item);if(entries.some(e=>e.track.locked))return toast('Разблокируйте связанные дорожки');
    e.preventDefault();pause();selected={kind:'item',id:item.id};renderInspector();
    const edge=e.target.dataset.edge,origin=e.clientX,before=JSON.stringify(project),anchor=entries.find(e=>e.item.id===item.id),visuals=new Map([...document.querySelectorAll('.timeline-clip')].map(el=>[el.dataset.itemId,el]));
    clip.setPointerCapture(e.pointerId);
    clip.onpointermove=ev=>{if(!clip.hasPointerCapture(ev.pointerId))return;const boundary=edge==='left'?anchor.start:anchor.start+anchor.duration;const delta=snapTime(boundary+(ev.clientX-origin)/zoom,item.id)-boundary;applyTrim(entries,edge,delta);for(const entry of entries){const el=visuals.get(entry.item.id);if(el){el.style.left=`${entry.item.start*zoom}px`;el.style.width=`${Math.max(8,entry.item.duration*zoom)}px`}}syncElements(true);draw()};
    const clear=()=>{clip.onpointermove=null;clip.onpointerup=null;clip.onpointercancel=null};
    clip.onpointerup=ev=>{if(clip.hasPointerCapture(ev.pointerId))clip.releasePointerCapture(ev.pointerId);clear();if(JSON.stringify(project)!==before){recordChange(before);queueSave()}refresh()};
    clip.onpointercancel=()=>{clear();project=JSON.parse(before);refresh()};
  }
  // Cache decoded samples and film strips outside the saved project.
  const analysisQueue=[];let analysisRunning=false;
  function queueAssetAnalysis(asset){if(asset.analysisQueued||['image','subtitle'].includes(asset.type)||!asset.file)return;asset.analysisQueued=true;analysisQueue.push(asset);runAssetAnalysis()}
  async function decodedAudio(asset){if(!asset.decodedPromise){asset.decodedPromise=(async()=>{const ac=new (window.AudioContext||window.webkitAudioContext)();try{return await ac.decodeAudioData(await asset.file.arrayBuffer())}finally{await ac.close()}})()}return asset.decodedPromise}
  async function runAssetAnalysis(){
    if(analysisRunning)return;analysisRunning=true;
    while(analysisQueue.length){const asset=analysisQueue.shift();try{
      const buffer=await decodedAudio(asset);if(!assets.has(asset.id))continue;const bins=Math.min(8192,buffer.length),peaks=new Float32Array(bins);
      for(let i=0;i<bins;i++){const a=Math.floor(i*buffer.length/bins),b=Math.floor((i+1)*buffer.length/bins);let peak=0;for(let ch=0;ch<buffer.numberOfChannels;ch++){const data=buffer.getChannelData(ch);for(let j=a;j<b;j++)peak=Math.max(peak,Math.abs(data[j]))}peaks[i]=peak}asset.peaks=peaks;
    }catch{asset.audioDecodeFailed=true}
    if(!assets.has(asset.id))continue;
    if(asset.type==='video')try{asset.filmstrip=await makeFilmstrip(asset);asset.thumbnail=asset.filmstrip[0]}catch{}
    delete asset.decodedPromise;if(assets.has(asset.id)){renderSidebar();renderTimeline()}}
    analysisRunning=false;
  }
  async function makeFilmstrip(asset){
    const video=document.createElement('video');video.muted=true;video.preload='auto';video.src=asset.url;
    const wait=event=>new Promise((resolve,reject)=>{const timer=setTimeout(()=>{cleanup();reject(Error('Время ожидания кадра'))},10000);const done=()=>{cleanup();resolve()},fail=()=>{cleanup();reject(Error('Не удалось прочитать кадр'))},cleanup=()=>{clearTimeout(timer);video.removeEventListener(event,done);video.removeEventListener('error',fail)};video.addEventListener(event,done,{once:true});video.addEventListener('error',fail,{once:true})});
    try{if(video.readyState<2)await wait('loadeddata');const c=document.createElement('canvas');c.width=112;c.height=64;const cx=c.getContext('2d'),frames=[];for(let i=0;i<10;i++){const time=Math.min(Math.max(0,asset.duration-.03),asset.duration*(i+.1)/10);if(Math.abs(video.currentTime-time)>.001){const ready=wait('seeked');video.currentTime=time;await ready}cx.fillStyle='#111';cx.fillRect(0,0,c.width,c.height);const fit=Math.min(c.width/video.videoWidth,c.height/video.videoHeight);cx.drawImage(video,(c.width-video.videoWidth*fit)/2,(c.height-video.videoHeight*fit)/2,video.videoWidth*fit,video.videoHeight*fit);frames.push(c.toDataURL('image/jpeg',.65))}return frames}finally{video.removeAttribute('src');video.load()}
  }
  function renderClipMedia(clip,item){
    const asset=assets.get(item.assetId);if(!asset)return;
    if(item.kind==='video'&&asset.filmstrip?.length){
      clip.querySelector('.clip-thumb')?.remove();const strip=document.createElement('div');strip.className='clip-filmstrip';
      const count=Math.min(100,Math.max(1,Math.ceil(item.duration*zoom/90)));
      for(let i=0;i<count;i++){const img=document.createElement('img');img.alt='';img.draggable=false;const source=(item.sourceIn||0)+item.duration*(i/count)*(item.speed||1);img.src=asset.filmstrip[clamp(Math.floor(source/asset.duration*asset.filmstrip.length),0,asset.filmstrip.length-1)];strip.append(img)}clip.prepend(strip);
    }
    if(item.kind==='audio'&&asset.peaks){const c=document.createElement('canvas');c.className='clip-waveform';const width=Math.min(2400,Math.max(8,Math.ceil(item.duration*zoom)));c.width=width;c.height=36;const cx=c.getContext('2d');cx.fillStyle='#89ceff';for(let x=0;x<width;x++){const a=((item.sourceIn||0)+x/width*item.duration*(item.speed||1))/asset.duration*asset.peaks.length,b=((item.sourceIn||0)+(x+1)/width*item.duration*(item.speed||1))/asset.duration*asset.peaks.length;let peak=0;for(let i=Math.max(0,Math.floor(a));i<Math.min(asset.peaks.length,Math.ceil(b));i++)peak=Math.max(peak,asset.peaks[i]);const height=Math.max(1,peak*34);cx.fillRect(x,(36-height)/2,1,height)}clip.prepend(c)}
  }
  // Context actions: close an exact gap and copy appearance without timing or links.
  function gapAt(track,time){const sorted=[...track.items].sort((a,b)=>a.start-b.start);let end=0;for(const item of sorted){if(time>=end&&time<item.start&&item.start-end>1e-6)return {start:end,end:item.start};end=Math.max(end,item.start+item.duration)}return null}
  function closeGap(track,time){const gap=gapAt(track,time);if(!gap)return;const entries=expandLinkedEntries(track.items.filter(i=>i.start>=gap.end-1e-7).map(item=>({track,item}))),delta=gap.end-gap.start;if(entries.some(e=>e.track.locked))return toast('Разблокируйте связанные дорожки');if(entries.some(e=>e.item.start<delta-1e-7))return toast('Связанный клип выходит за начало линии. Сначала развяжите эту группу.');mutate(()=>{for(const {item} of entries)item.start=Math.max(0,item.start-delta)});toast(`Убран промежуток ${delta.toFixed(3)} с`)}
  function popupActions(e,actions){e.preventDefault();e.stopPropagation();closeClipMenu();const menu=document.createElement('div');menu.id='clipContextMenu';menu.className='clip-context-menu';menu.setAttribute('role','menu');for(const [label,action,disabled] of actions){const b=document.createElement('button');b.type='button';b.textContent=label;b.setAttribute('role','menuitem');b.disabled=!!disabled;b.onclick=()=>{closeClipMenu();action()};menu.append(b)}document.body.append(menu);const r=menu.getBoundingClientRect();menu.style.left=`${clamp(e.clientX,5,window.innerWidth-r.width-5)}px`;menu.style.top=`${clamp(e.clientY,5,window.innerHeight-r.height-5)}px`;menu.querySelector('button:not(:disabled)')?.focus()}
  function canHaveTransition(track,item){return ['video','text'].includes(track.type)&&['video','image','title','subtitle','shape','countdown'].includes(item.kind)}
  function transitionDropTarget(track,time){if(track.locked||!['video','text'].includes(track.type))return null;const candidates=track.items.filter(item=>canHaveTransition(track,item)).sort((a,b)=>Math.abs(a.start-time)-Math.abs(b.start-time));return candidates.find(item=>Math.abs(item.start-time)*zoom<=50||(time>=item.start&&time<=item.start+item.duration))||null}
  function applyTransition(track,item,type){if(exporting||track.locked||!canHaveTransition(track,item))return false;mutate(()=>{item.transitionIn=type;item.transitionDuration=type==='none'?0:Math.min(.65,item.duration)});return true}
  function removeTransition(id){const found=findItem(id);if(!found||found.track.locked||exporting||!canHaveTransition(found.track,found.item))return;mutate(()=>{found.item.transitionIn='none';found.item.transitionOut='none';found.item.transitionDuration=0});toast('Переход удалён')}
  function renderTextTransitionControls(root,item,track){
    if(!canHaveTransition(track,item))return;const body=clipSection(root,'transition','Переход в начале');const controls=document.createElement('fieldset');controls.disabled=track.locked;controls.className='clip-controls';body.append(controls);
    inspectorField(controls,'Тип перехода',item.transitionIn||'none',type=>applyTransition(track,item,type),{values:[['none','Без перехода'],['dissolve','Плавное появление'],['fade','Затухание'],['slide-left','Сдвиг влево'],['slide-right','Сдвиг вправо'],['wipe','Шторка'],['zoom','Приближение']]});
    if(item.transitionIn&&item.transitionIn!=='none'){clipSlider(controls,item,'transitionDuration','Длительность перехода',Math.min(item.duration,transitionSeconds(item)),.01,item.duration,.01,v=>item.transitionDuration=v,v=>`${v.toFixed(2)} с`);const remove=document.createElement('button');remove.type='button';remove.className='sidebar-action';remove.textContent='Удалить переход';remove.onclick=()=>removeTransition(item.id);controls.append(remove)}
  }
  function bindLaneExtras(lane,track){
    lane.oncontextmenu=e=>{if(e.target!==lane)return;const time=(e.clientX-lane.getBoundingClientRect().left)/zoom,gap=gapAt(track,time);popupActions(e,[[gap?`Убрать промежуток (${(gap.end-gap.start).toFixed(3)} с)`:'Здесь нет промежутка',()=>closeGap(track,time),!gap||track.locked]])};
    lane.ondragover=e=>{if(e.dataTransfer.types.includes('application/x-montazhnaya-transition')&&['video','text'].includes(track.type)){e.preventDefault();lane.classList.add('drop-target')}else if(e.dataTransfer.types.includes('application/x-montazhnaya-asset')){e.preventDefault();lane.classList.add('drop-target')}};
    lane.ondrop=e=>{e.preventDefault();lane.classList.remove('drop-target');const transition=e.dataTransfer.getData('application/x-montazhnaya-transition');if(transition){const item=transitionDropTarget(track,(e.clientX-lane.getBoundingClientRect().left)/zoom);if(!item)return toast('Добавьте переход на видео или текст; звук не поддерживает переходы');applyTransition(track,item,transition);selectItem(item.id)}else createItem(e.dataTransfer.getData('application/x-montazhnaya-asset'),track.id,(e.clientX-lane.getBoundingClientRect().left)/zoom,{newSoundTrack:true})};
  }
  const appearanceKeys=['fit','scale','x','y','rotation','flipH','flipV','brightness','contrast','saturation','temperature','vignette','sepia','look','blend','crop','opacity','chromaKey'];let appearanceClipboard=null;
  function copyAppearance(item){appearanceClipboard={};for(const key of appearanceKeys)if(item[key]!==undefined)appearanceClipboard[key]=JSON.parse(JSON.stringify(item[key]));toast('Оформление скопировано')}
  function pasteAppearance(){const targets=selectedEntries().filter(e=>['video','image'].includes(e.item.kind));if(!appearanceClipboard||!targets.length)return toast('Скопируйте оформление и выберите видео или фото');if(targets.some(e=>e.track.locked))return toast('Разблокируйте дорожки');mutate(()=>{for(const {item} of targets)for(const key of appearanceKeys){if(key in appearanceClipboard)item[key]=JSON.parse(JSON.stringify(appearanceClipboard[key]));else delete item[key]}});toast(`Оформление применено: ${targets.length}`)}
  function startTransitionDrag(e,type,card){
    if(e.button!==0||exporting)return;e.preventDefault();const origin={x:e.clientX,y:e.clientY};let moved=false,ghost=null;card.setPointerCapture(e.pointerId);
    card.onpointermove=ev=>{if(Math.hypot(ev.clientX-origin.x,ev.clientY-origin.y)<5&&!moved)return;moved=true;if(!ghost){ghost=document.createElement('div');ghost.className='fade-drag-readout';ghost.textContent='Переход → видео / текст';document.body.append(ghost)}ghost.style.left=`${ev.clientX+12}px`;ghost.style.top=`${ev.clientY-30}px`};
    const clear=()=>{ghost?.remove();card.onpointermove=card.onpointerup=card.onpointercancel=null};
    card.onpointerup=ev=>{if(card.hasPointerCapture(ev.pointerId))card.releasePointerCapture(ev.pointerId);clear();if(!moved)return;card.dataset.dragged='1';setTimeout(()=>card.dataset.dragged='0',0);const lane=[...document.querySelectorAll('.lane')].find(el=>{const r=el.getBoundingClientRect();return ev.clientX>=r.left&&ev.clientX<=r.right&&ev.clientY>=r.top&&ev.clientY<=r.bottom});const track=lane&&findTrack(lane.dataset.trackId);const item=track&&transitionDropTarget(track,(ev.clientX-lane.getBoundingClientRect().left)/zoom);if(!item)return toast('Бросьте переход на ячейку видео или текста. На звук переходы не добавляются.');applyTransition(track,item,type);selectItem(item.id);toast('Переход добавлен. Крестик на ячейке удаляет переход.')};
    card.onpointercancel=clear;
  }
  function bindTransitionHandle(clip,item,track){const band=clip.querySelector('.transition-band');if(!band||!canHaveTransition(track,item))return;const remove=document.createElement('button');remove.type='button';remove.className='transition-remove';remove.title='Удалить переход';remove.setAttribute('aria-label',remove.title);remove.append(trackIcon('close'));remove.disabled=track.locked;remove.onpointerdown=e=>e.stopPropagation();remove.onclick=e=>{e.preventDefault();e.stopPropagation();removeTransition(item.id)};clip.append(remove);if(track.locked)return;const h=document.createElement('button');h.type='button';h.className='transition-resize';h.title='Потяните, чтобы изменить длительность перехода';h.setAttribute('aria-label',h.title);band.append(h);h.onpointerdown=e=>{if(e.button!==0||exporting)return;e.stopPropagation();e.preventDefault();const before=JSON.stringify(project),initial=transitionSeconds(item),origin=e.clientX;h.setPointerCapture(e.pointerId);const tip=document.createElement('div');tip.className='fade-drag-readout';document.body.append(tip);const update=()=>{tip.textContent=`Переход: ${transitionSeconds(item).toFixed(2)} с`;tip.style.left=`${clamp(e.clientX,8,window.innerWidth-190)}px`;tip.style.top=`${Math.max(8,e.clientY-38)}px`};update();h.onpointermove=ev=>{item.transitionDuration=clamp(initial+(ev.clientX-origin)/zoom,.04,item.duration);band.style.width=`${item.transitionDuration*zoom}px`;update();draw()};const clear=()=>{tip.remove();h.onpointermove=h.onpointerup=h.onpointercancel=null};h.onpointerup=()=>{clear();if(JSON.stringify(project)!==before){recordChange(before);queueSave()}refresh()};h.onpointercancel=()=>{clear();project=JSON.parse(before);refresh()}}}
  // Numeric animation points are stored in source time, so trimming/splitting preserves them.
  function keyframeTime(item,time){return (item.sourceIn||0)+(time-item.start)*(item.speed||1)}
  function keyframeValue(item,key,time=playhead){const frames=item.keyframes?.[key];const base=item[key]??(['scale','opacity','volume'].includes(key)?1:0);if(!frames?.length)return base;const t=keyframeTime(item,time),sorted=frames;if(t<=sorted[0].time)return sorted[0].value;for(let i=1;i<sorted.length;i++)if(t<=sorted[i].time){const a=sorted[i-1],b=sorted[i],p=(t-a.time)/Math.max(.000001,b.time-a.time);return a.value+(b.value-a.value)*p}return sorted.at(-1).value}
  function setKeyframe(item,key,value,time=playhead){const t=keyframeTime(item,clamp(time,item.start,item.start+item.duration));item.keyframes??={};const frames=item.keyframes[key]??=[];const existing=frames.find(f=>Math.abs(f.time-t)<.00001);if(existing)existing.value=value;else frames.push({id:uid(),time:t,value});frames.sort((a,b)=>a.time-b.time)}
  const keyframePropertyState=new Map();
  function renderKeyframes(root,item){
    const compound=item.kind==='compound',audio=compound?item.trackType==='audio':item.kind==='audio';const found=findItem(item.id);const section=clipSection(root,'keyframes','Ключевые кадры');const properties=audio?[['volume','Громкость']]:[['x','По горизонтали'],['y','По вертикали'],['scale','Масштаб'],['rotation','Поворот'],['opacity','Непрозрачность']];
    let property=keyframePropertyState.get(item.id)||properties[0][0];const select=document.createElement('select');select.setAttribute('aria-label','Параметр анимации');for(const [key,label] of properties){const o=document.createElement('option');o.value=key;o.textContent=label;select.append(o)}select.value=property;section.append(select);const value=document.createElement('input');value.type='number';value.step='.01';value.setAttribute('aria-label','Значение ключевого кадра');section.append(value);const buttons=document.createElement('div');buttons.className='enhancement-actions';section.append(buttons);const add=document.createElement('button');add.type='button';add.textContent='◇ На курсоре';add.disabled=found?.track.locked;buttons.append(add);const list=document.createElement('div');list.className='keyframe-list';section.append(list);
    const render=()=>{property=select.value;value.value=Number(keyframeValue(item,property).toFixed(3));value.min=['scale','opacity','volume'].includes(property)?0:-1000;value.max=property==='volume'?2:property==='opacity'?1:property==='scale'?5:1000;list.replaceChildren();for(const frame of item.keyframes?.[property]||[]){const row=document.createElement('div');const go=document.createElement('button');go.type='button';go.textContent=`${((frame.time-(item.sourceIn||0))/(item.speed||1)).toFixed(2)} с → ${frame.value}`;go.onclick=()=>{seek(item.start+(frame.time-(item.sourceIn||0))/(item.speed||1));render()};const del=document.createElement('button');del.type='button';del.textContent='×';del.title='Удалить ключевой кадр';del.disabled=found?.track.locked;del.onclick=()=>mutate(()=>{item.keyframes[property]=item.keyframes[property].filter(f=>f.id!==frame.id)});row.append(go,del);list.append(row)}};
    add.onclick=()=>mutate(()=>setKeyframe(item,property,clamp(number(value.value),number(value.min),number(value.max))));select.onchange=()=>{keyframePropertyState.set(item.id,select.value);render()};render();const note=document.createElement('p');note.className='note';note.textContent='Поставьте курсор в клип, задайте значение и добавьте точку. Между точками значение меняется плавно. Без точек действует обычная настройка.';section.append(note);
  }
  // Reusable text styles, stored with the project and included in its JSON.
  const textStyleKeys=['style','font','size','bold','italic','align','color','outline','outlineWidth','bg','scale','opacity'];
  let pendingTemplateItem=null;
  function saveTextTemplate(item){pendingTemplateItem=item.id;$('templateName').value=`Подпись ${(project.textTemplates||[]).length+1}`;$('textTemplateDialog').showModal();$('templateName').focus();$('templateName').select()}
  function commitTextTemplate(){const item=findItem(pendingTemplateItem)?.item,name=$('templateName').value.trim();if(!item||!name)return;const style={};for(const key of textStyleKeys)if(item[key]!==undefined)style[key]=item[key];mutate(()=>{project.textTemplates??=[];project.textTemplates.push({id:uid(),name,style})});$('textTemplateDialog').close();toast('Шаблон сохранён во вкладке «Текст»')}

  function renderSavedTextTemplates(root){if(!project.textTemplates?.length)return;const heading=document.createElement('div');heading.className='section-heading';heading.textContent='МОИ ШАБЛОНЫ';root.prepend(heading);const grid=document.createElement('div');grid.className='template-grid saved-templates';for(const template of project.textTemplates){const row=document.createElement('div');const b=document.createElement('button');b.type='button';b.className='template';b.textContent=template.name;b.onclick=()=>{const before=JSON.stringify(project);addText(template.style.style||'title');const item=findItem(selected.id)?.item;if(item){Object.assign(item,template.style);undoStack.pop();recordChange(before);refresh();queueSave()}};const del=document.createElement('button');del.type='button';del.className='template-remove';del.textContent='×';del.title='Удалить шаблон';del.onclick=()=>mutate(()=>project.textTemplates=project.textTemplates.filter(t=>t.id!==template.id));row.append(b,del);grid.append(row)}heading.after(grid)}
  // Named A/B versions and automatic recovery snapshots live outside undo history.
  let projectVersions=[],versionWrite=Promise.resolve(),lastAutoVersion=0,lastVersionContent='';
  function writeVersions(){const snapshot=JSON.parse(JSON.stringify(projectVersions));versionWrite=versionWrite.catch(()=>{}).then(()=>dbWrite('project',snapshot,'versions'));return versionWrite}
  async function saveVersion(automatic=false){const snapshot=JSON.parse(JSON.stringify(project));snapshot.assetManifest=currentMediaManifest();const content=JSON.stringify(snapshot);if(automatic&&content===lastVersionContent)return;const n=Math.max(0,...projectVersions.filter(v=>!v.automatic).map(v=>v.number||0))+1;projectVersions.push({id:uid(),name:automatic?'Автокопия':`v${n}`,number:automatic?null:n,automatic,date:Date.now(),project:snapshot});const autos=projectVersions.filter(v=>v.automatic);if(autos.length>15){const remove=new Set(autos.slice(0,-15).map(v=>v.id));projectVersions=projectVersions.filter(v=>!remove.has(v.id))}lastAutoVersion=Date.now();lastVersionContent=content;for(const asset of currentMediaAssets())if(!asset.stored&&asset.file){await dbWrite('assets',{id:asset.id,name:asset.name,type:asset.type,file:asset.file});asset.stored=true}await writeVersions();if(!automatic){renderVersions();toast(`Версия v${n} сохранена`)}}
  async function loadVersions(){try{const db=await openDb();projectVersions=await new Promise((resolve,reject)=>{const r=db.transaction('project').objectStore('project').get('versions');r.onsuccess=()=>resolve(r.result||[]);r.onerror=()=>reject(r.error)});db.close()}catch{}lastAutoVersion=Date.now()}
  function matchingVersions(query=''){
    const terms=query.toLocaleLowerCase('ru-RU').trim().split(/\s+/).filter(Boolean);
    return [...projectVersions].reverse().filter(version=>{const text=`${version.name} ${version.project.name} ${new Date(version.date).toLocaleString('ru-RU')}`.toLocaleLowerCase('ru-RU');return terms.every(term=>text.includes(term))});
  }
  async function deleteVersion(id){
    const version=projectVersions.find(v=>v.id===id);if(!version)return;
    if(!confirm(`Удалить ${version.name} · ${version.project.name} (${new Date(version.date).toLocaleString('ru-RU')})?\nТекущий монтаж останется без изменений. Восстановить удалённую версию будет нельзя.`))return;
    const index=projectVersions.indexOf(version);projectVersions=projectVersions.filter(v=>v.id!==id);renderVersions();
    try{await writeVersions();toast('Версия удалена')}catch(e){projectVersions.splice(Math.min(index,projectVersions.length),0,version);renderVersions();toast(`Не удалось удалить версию: ${e.message}`)}
  }
  function renderVersions(){
    const root=$('versionsList');if(!root)return;root.replaceChildren();
    const versions=matchingVersions($('versionsSearch')?.value||'');
    $('versionsCount').textContent=`Показано: ${versions.length} из ${projectVersions.length}`;
    for(const version of versions){
      const row=document.createElement('div');row.className='version-row';const info=document.createElement('div');info.className='version-info';
      const name=document.createElement('strong');name.textContent=`${version.name} · ${version.project.name}`;
      const meta=document.createElement('small');meta.textContent=new Date(version.date).toLocaleString('ru-RU');info.append(name,meta);
      const actions=document.createElement('div');actions.className='version-actions';
      const open=document.createElement('button');open.type='button';open.textContent='Открыть';open.onclick=async()=>{await saveVersion(true);const before=JSON.stringify(project);pause();projectEpoch++;project=migrateLegacy(JSON.parse(JSON.stringify(version.project)));await loadProjectMedia(project);selected=null;playhead=0;recordChange(before);refresh();queueSave();$('versionsDialog').close();toast(`Открыта ${version.name}. Предыдущий монтаж сохранён в версиях.`)};
      const remove=document.createElement('button');remove.type='button';remove.className='version-delete';remove.title=`Удалить ${version.name} · ${version.project.name}`;remove.setAttribute('aria-label',remove.title);remove.append(trackIcon('trash'));remove.onclick=()=>deleteVersion(version.id);
      actions.append(open,remove);row.append(info,actions);root.append(row);
    }
    if(!versions.length){const empty=document.createElement('p');empty.className='note';empty.textContent=projectVersions.length?'Версии не найдены. Измените запрос или очистите поиск.':'Сохраните первую версию. Исходные файлы общие для всех версий.';root.append(empty)}
  }
  // Export selection: selected cells plus their linked partners, with gaps preserved.
  let exportSelection=null;
  function selectionBounds(entries){return {start:Math.min(...entries.map(e=>e.item.start)),end:Math.max(...entries.map(e=>e.item.start+e.item.duration))}}
  function configureExportScope(){exportSelection=$('exportScope').value==='selection'?expandLinkedEntries(selectedEntries()):null;if(exportSelection&&!exportSelection.length){toast('Сначала выделите ячейки на дорожках');return false}return true}
  function exportAllows(item){return !exportSelection||exportSelection.some(e=>e.item.id===(item._compoundRoot||item.id))}
  function exportBounds(){return exportSelection?selectionBounds(exportSelection):{start:clamp(project.inPoint??0,0,duration()),end:clamp(project.outPoint??duration(),0,duration())}}
  // MP3 is encoded locally. WSOLA preserves pitch when changing clip speed.
  let audioExportToken=0,audioExportActive=false;
  function cancelMp3(){audioExportToken++;audioExportActive=false;exporting=false;exportSelection=null;$('startExportBtn').disabled=false;$('exportProgress').hidden=true;if($('exportDialog').open)$('exportDialog').close();draw();toast('Экспорт звука отменён')}
  function updateCenterGuides(item){
    document.querySelectorAll('.preview-center-guide').forEach(el=>el.remove());
    const rect=canvas.getBoundingClientRect(),shell=$('canvasShell').getBoundingClientRect();
    for(const [axis,value] of [['x',item.x||0],['y',item.y||0]])if(Math.abs(value)<.001){const line=document.createElement('div');line.className=`preview-center-guide ${axis}`;line.style.left=`${rect.left-shell.left+(axis==='x'?rect.width/2:0)}px`;line.style.top=`${rect.top-shell.top+(axis==='y'?rect.height/2:0)}px`;line.style.width=axis==='x'?'1px':`${rect.width}px`;line.style.height=axis==='y'?'1px':`${rect.height}px`;$('canvasShell').append(line)}
  }
  function stretchAudio(channels,speed){
    if(Math.abs(speed-1)<.00001)return channels;
    const length=Math.max(1,Math.round(channels[0].length/speed)),window=1024,hop=256,search=128,output=channels.map(()=>new Float32Array(length+window)),weight=new Float32Array(length+window);
    let previous=-1;
    for(let out=0;out<length;out+=hop){let input=Math.min(Math.max(0,channels[0].length-window),Math.round(out*speed));if(previous>=0){let best=-Infinity,bestAt=input;const reference=previous+hop;for(let cand=Math.max(0,input-search);cand<=Math.min(channels[0].length-window,input+search);cand+=4){let dot=0,a=0,b=0;for(let j=0;j<window-hop;j+=8){const x=channels[0][reference+j]||0,y=channels[0][cand+j]||0;dot+=x*y;a+=x*x;b+=y*y}const score=dot/Math.sqrt(a*b+1e-12);if(score>best){best=score;bestAt=cand}}input=bestAt}previous=input;for(let j=0;j<window&&out+j<output[0].length;j++){const w=.5-.5*Math.cos(2*Math.PI*j/(window-1));weight[out+j]+=w;for(let ch=0;ch<channels.length;ch++)output[ch][out+j]+=(channels[ch][input+j]||0)*w}}
    return output.map(channel=>{const result=channel.subarray(0,length);for(let i=0;i<length;i++)result[i]=weight[i]>1e-6?result[i]/weight[i]:0;return result});
  }
  async function exportMp3(){
    if(exporting||!configureExportScope())return;if(typeof lamejs==='undefined')return toast('Перезапустите редактор через файл запуска: не загружен локальный MP3-кодировщик');const range=exportBounds(),sound=playbackItems().filter(e=>e.track.type==='audio'&&e.item.kind==='audio'&&exportAllows(e.item)&&audible(e.track)&&!e.item.muted&&e.item.start<range.end&&e.item.start+e.item.duration>range.start);
    if(!sound.length)return toast('В выбранном участке нет звуковых ячеек');if(range.end<=range.start)return toast('Проверьте границы экспорта');
    pause();exporting=true;audioExportActive=true;const token=++audioExportToken;$('startExportBtn').disabled=true;$('exportProgress').hidden=false;const sampleRate=44100,length=Math.ceil((range.end-range.start)*sampleRate);
    try{if(length>sampleRate*60*30)throw Error('Для MP3 выберите участок не длиннее 30 минут');const mix=[new Float32Array(length),new Float32Array(length)];
      for(let n=0;n<sound.length;n++){if(token!==audioExportToken)return;const {item}=sound[n],asset=assets.get(item.assetId);if(!asset)throw Error('Исходный звуковой файл не найден');$('exportStatus').textContent=`Подготовка звука: ${n+1}/${sound.length}`;const decoded=await decodedAudio(asset);const sourceStart=Math.max(0,item.sourceIn||0),sourceEnd=Math.min(decoded.duration,sourceStart+item.duration*(item.speed||1));const startSample=Math.floor(sourceStart*decoded.sampleRate),endSample=Math.ceil(sourceEnd*decoded.sampleRate);const channels=[0,1].map(ch=>decoded.getChannelData(Math.min(ch,decoded.numberOfChannels-1)).slice(startSample,endSample));const stretched=stretchAudio(channels,item.speed||1);const from=Math.max(range.start,item.start,item._activeStart??-Infinity),to=Math.min(range.end,item.start+item.duration,item._activeEnd??Infinity);for(let i=Math.max(0,Math.ceil((from-range.start)*sampleRate));i<Math.min(length,Math.ceil((to-range.start)*sampleRate));i++){const local=range.start+i/sampleRate-item.start,source=local*decoded.sampleRate,index=Math.floor(source),fraction=source-index;const fi=item.fadeIn>0?clamp(local/item.fadeIn,0,1):1,fo=item.fadeOut>0?clamp((item.duration-local)/item.fadeOut,0,1):1,gain=keyframeValue(item,'volume',range.start+i/sampleRate)*fi*fo*groupFadeGain(item,range.start+i/sampleRate);for(let ch=0;ch<2;ch++)mix[ch][i]+=((stretched[ch][index]||0)*(1-fraction)+(stretched[ch][index+1]||0)*fraction)*gain}await new Promise(resolve=>setTimeout(resolve,0))}
      const encoder=new lamejs.Mp3Encoder(2,sampleRate,192),chunks=[];
      for(let offset=0;offset<length;offset+=1152){if(token!==audioExportToken)return;const count=Math.min(1152,length-offset),pcm=mix.map(ch=>{const data=new Int16Array(count);for(let i=0;i<count;i++)data[i]=Math.round(clamp(ch[offset+i],-1,1)*32767);return data});const data=encoder.encodeBuffer(pcm[0],pcm[1]);if(data.length)chunks.push(new Uint8Array(data));if(offset%(1152*100)===0){$('exportProgress').value=offset/length*100;$('exportStatus').textContent=`MP3: ${Math.round(offset/length*100)}%`;await new Promise(resolve=>setTimeout(resolve,0))}}
      const tail=encoder.flush();if(tail.length)chunks.push(new Uint8Array(tail));if(token!==audioExportToken)return;downloadBlob(new Blob(chunks,{type:'audio/mpeg'}),`${project.name.replace(/[\\/:*?"<>|]/g,'_')||'sound'}.mp3`);toast('Звук сохранён в MP3');exporting=false;audioExportActive=false;$('exportDialog').close();
    }catch(e){toast(`MP3: ${e.message}`)}finally{for(const asset of assets.values())delete asset.decodedPromise;if(token===audioExportToken){exporting=false;audioExportActive=false;$('startExportBtn').disabled=false;$('exportProgress').hidden=true;exportSelection=null;draw()}}
  }
  function updateExportOptions(){
    const mp3=$('exportFormat').value==='audio/mp3';$('exportResolution').closest('label').hidden=mp3;$('exportFps').closest('label').hidden=mp3;
    const hint=$('exportDialog').querySelector('.muted');hint.textContent=mp3?'MP3 создаётся на этом компьютере. Сохраняются обрезка, скорость, громкость и затухания.':'Экспорт видео идёт в реальном времени. Не сворачивайте окно до окончания.';
    const note=$('exportRangeNote');if(!note)return;const entries=expandLinkedEntries(selectedEntries());
    if($('exportScope').value==='selection'){const bounds=entries.length?selectionBounds(entries):null;note.textContent=bounds?`Выделено ячеек: ${entries.length}. ${timecode(bounds.start)} — ${timecode(bounds.end)}`:'Сначала выделите ячейки на дорожках'}
    else note.textContent=project.inPoint!=null||project.outPoint!=null?`Экспорт фрагмента: ${timecode(clamp(project.inPoint??0,0,duration()))} — ${timecode(clamp(project.outPoint??duration(),0,duration()))}`:'Экспорт всего монтажа';
  }
  function bindEnhancements(){
    const tools=document.querySelector('.editing-tools');for(const [id,icon,label,action] of [['copyAppearanceBtn','paintbrush','Копировать оформление выбранного видео',()=>{const e=selectedEntries().find(e=>['video','image'].includes(e.item.kind));if(e)copyAppearance(e.item);else toast('Выберите видео или фото')}],['pasteAppearanceBtn','clipboard','Применить скопированное оформление к выделенным видео',pasteAppearance]]){const b=document.createElement('button');b.id=id;b.type='button';b.title=label;b.setAttribute('aria-label',label);b.append(trackIcon(icon));b.onclick=action;tools.append(b)}
    const versions=document.createElement('button');versions.type='button';versions.className='icon-btn';versions.id='versionsBtn';versions.title='Версии проекта: v1, v2, v3 и автокопии';versions.setAttribute('aria-label',versions.title);versions.append(trackIcon('layers'));versions.onclick=()=>{renderVersions();$('versionsDialog').showModal()};$('saveBtn').after(versions);$('versionsSearch').oninput=renderVersions;$('closeVersionsBtn').onclick=()=>$('versionsDialog').close();$('saveVersionBtn').onclick=()=>saveVersion(false).catch(e=>toast(`Не удалось сохранить версию: ${e.message}`));
    $('exportScope').onchange=updateExportOptions;$('exportFormat').onchange=updateExportOptions;
    $('saveTextTemplateBtn').onclick=commitTextTemplate;$('cancelTextTemplateBtn').onclick=()=>$('textTemplateDialog').close();$('textTemplateForm').onsubmit=e=>{e.preventDefault();commitTextTemplate()};
    loadVersions();
  }

  wireEvents();bindToolbarIcons();updateInsertModeButton();bindMergeButton();bindLinkButtons();bindTrackAddIcons();bindTimelineWheel();bindBottomRuler();bindClipMenuDismissal();bindTimelinePanel();bindSidePanels();bindFloatingInspector();bindPreviewFit();bindPreviewEditing();bindEnhancements();bindUnmergeButton();bindMarkerNavigation();bindVideoTools();bindToolbarLayout();if(window.MediaRecorder&&supportedMime('video/mp4'))$('exportFormat').value='video/mp4';restore();
})();

