'use strict';
const {outputSize}=require('./converter-server-utils');
function slowPlan(duration,start,end,factor,ease){
  if(!Number.isFinite(duration)||duration<=0||![2,4,8].includes(factor)||!Number.isFinite(start)||!Number.isFinite(end)||start<0||end>duration+.001||end-start<.04)throw Error('Выберите корректный участок замедления');
  if((end-start)*factor>300.001)throw Error('Замедленный участок должен быть не длиннее 300 секунд. Выберите более короткий момент.');
  const pieces=[];const add=(a,b,m)=>{if(b-a>.000001)pieces.push({start:a,end:b,factor:m})};
  add(0,start,1);const ramp=ease?Math.min(.4,(end-start)/3):0;
  if(ramp){const n=6;for(let i=0;i<n;i++){const t=(i+.5)/n,m=1+(factor-1)*(t*t*(3-2*t));add(start+i*ramp/n,start+(i+1)*ramp/n,m)}add(start+ramp,end-ramp,factor);for(let i=0;i<n;i++){const t=(i+.5)/n,m=factor-(factor-1)*(t*t*(3-2*t));add(end-ramp+i*ramp/n,end-ramp+(i+1)*ramp/n,m)}}else add(start,end,factor);
  add(end,duration,1);return {pieces,duration:pieces.reduce((sum,p)=>sum+(p.end-p.start)*p.factor,0)};
}
function tempoFilters(value){const result=[];while(value<.5-1e-9){result.push('atempo=0.5');value*=2}while(value>2+1e-9){result.push('atempo=2');value/=2}result.push(`atempo=${value.toFixed(9)}`);return result.join(',')}
function slowMotionArgs(job,options,inputArgs){
 const factor=Number(options.factor),baseSpeed=options.baseSpeed==null?1:Number(options.baseSpeed),sourceStart=options.inputStart==null?0:Number(options.inputStart),sourceEnd=options.inputEnd==null?job.meta.duration:Number(options.inputEnd);
 if(!Number.isFinite(baseSpeed)||baseSpeed<.125||baseSpeed>4||!Number.isFinite(sourceStart)||!Number.isFinite(sourceEnd)||sourceStart<0||sourceEnd>job.meta.duration+.001||sourceEnd-sourceStart<.04)throw Error('Некорректные границы исходного клипа');
 const duration=(sourceEnd-sourceStart)/baseSpeed,start=options.scope==='whole'?0:Number(options.slowStart),end=options.scope==='whole'?duration:Number(options.slowEnd);
 if(!['whole','moment'].includes(options.scope)||!['h264','vp9'].includes(options.format)||!['480','720','1080','original'].includes(options.resolution)||![24,25,30,60].includes(Number(options.fps))||!['natural','mute'].includes(options.sound)||typeof options.ease!=='boolean'||!['flow','blend','repeat'].includes(options.interpolation))throw Error('Некорректные настройки слоу-моушен');
 const plan=slowPlan(duration,start,end,factor,options.ease),fps=Number(options.fps),size=outputSize(job.meta,options.resolution),f=v=>Number(v.toFixed(9)).toString();
 const warp=plan.pieces.map(p=>`${f(p.factor)}*clip(T-${f(p.start)},0,${f(p.end-p.start)})`).join('+');
 let smoothing=options.interpolation==='flow'?`minterpolate=fps=${fps}:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1:scd=fdiff`:options.interpolation==='blend'?`minterpolate=fps=${fps}:mi_mode=blend`:`fps=${fps}`;
 const graph=[`[0:V:0]trim=start=${f(sourceStart)}:end=${f(sourceEnd)},setpts=(PTS-STARTPTS)/${f(baseSpeed)},scale=${size.width}:${size.height}:flags=lanczos,setsar=1,settb=AVTB,setpts='(${warp})/TB',tpad=stop_mode=clone:stop_duration=2,${smoothing},trim=duration=${f(plan.duration)},setpts=PTS-STARTPTS[vout]`];
 const audio=job.meta.hasAudio&&options.sound==='natural';
 if(audio){graph.push(`[0:a:0]asplit=${plan.pieces.length}${plan.pieces.map((_,i)=>`[as${i}]`).join('')}`);for(const [i,p]of plan.pieces.entries()){const target=(p.end-p.start)*p.factor;graph.push(`[as${i}]atrim=start=${f(sourceStart+p.start*baseSpeed)}:end=${f(sourceStart+p.end*baseSpeed)},asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,${tempoFilters(baseSpeed/p.factor)},apad,atrim=duration=${f(target)},asetpts=PTS-STARTPTS[a${i}]`)}graph.push(`${plan.pieces.map((_,i)=>`[a${i}]`).join('')}concat=n=${plan.pieces.length}:v=0:a=1[aout]`)}
 const args=['-hide_banner','-nostdin','-y',...inputArgs,'-i',job.input,'-filter_complex_threads','2','-filter_complex',graph.join(';'),'-map','[vout]'];if(audio)args.push('-map','[aout]');else args.push('-an');args.push('-c:v',options.format==='h264'?'libx264':'libvpx-vp9','-pix_fmt','yuv420p','-threads','4');if(options.format==='h264')args.push('-preset','fast','-crf','20','-movflags','+faststart');else args.push('-deadline','good','-cpu-used','4','-crf','28','-b:v','0');if(audio)args.push('-c:a',options.format==='h264'?'aac':'libopus','-b:a','192k');args.push('-map_metadata','-1','-t',f(plan.duration),'-progress',job.progressFile,'-nostats',job.output);return {args,size,outputDuration:plan.duration};
}
module.exports={slowPlan,tempoFilters,slowMotionArgs};
