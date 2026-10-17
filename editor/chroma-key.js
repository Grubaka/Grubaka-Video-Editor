/* Local chroma key. The same surface is used by preview and timeline export. */
(() => {
  'use strict';
  const clamp=(n,a,b)=>Math.max(a,Math.min(b,n));
  function settings(value={}){const color=/^#[0-9a-f]{6}$/i.test(value.color||'')?value.color:'#33b340';return {color,rgb:[1,3,5].map(i=>parseInt(color.slice(i,i+2),16)/255),strength:clamp(Number(value.strength??35)||0,0,100)/100,softness:clamp(Number(value.softness??20)||0,0,100)/100,spill:clamp(Number(value.spill??65)||0,0,100)/100}}
  // Chroma distance ignores luminance so shaded areas of a screen remain removable.
  function keyPixels(data,value){const p=settings(value),[kr,kg,kb]=p.rgb,ky=.299*kr+.587*kg+.114*kb,ku=kb-ky,kv=kr-ky,threshold=p.strength*.8,soft=Math.max(.001,p.softness*.35),dominant=kg>kr&&kg>kb?1:kb>kr&&kb>kg?2:-1;
    for(let i=0;i<data.length;i+=4){const r=data[i]/255,g=data[i+1]/255,b=data[i+2]/255,y=.299*r+.587*g+.114*b,d=Math.hypot(b-y-ku,r-y-kv),t=clamp((d-threshold)/soft,0,1),alpha=p.strength===0?1:t*t*(3-2*t);data[i+3]=Math.round(data[i+3]*alpha);if(dominant>=0){const other=dominant===1?Math.max(r,b):Math.max(r,g),c=dominant===1?g:b;data[i+dominant]=Math.round(255*(c-Math.max(0,c-other)*p.spill*(1-clamp((d-threshold-soft)/.25,0,1))))}}
    return data;
  }
  function gpuSurface(){const canvas=document.createElement('canvas'),gl=canvas.getContext('webgl',{alpha:true,premultipliedAlpha:false,preserveDrawingBuffer:true,depth:false,antialias:false});if(!gl)return null;
    const shader=(type,source)=>{const s=gl.createShader(type);gl.shaderSource(s,source);gl.compileShader(s);if(!gl.getShaderParameter(s,gl.COMPILE_STATUS))throw Error(gl.getShaderInfoLog(s));return s};
    const program=gl.createProgram();gl.attachShader(program,shader(gl.VERTEX_SHADER,'attribute vec2 point;varying vec2 uv;void main(){uv=vec2((point.x+1.0)*.5,1.0-(point.y+1.0)*.5);gl_Position=vec4(point,0,1);}'));
    gl.attachShader(program,shader(gl.FRAGMENT_SHADER,`precision mediump float;varying vec2 uv;uniform sampler2D frame;uniform vec3 key;uniform float strength;uniform float softness;uniform float spill;
      void main(){vec4 pixel=texture2D(frame,uv);vec3 c=pixel.rgb;float y=dot(c,vec3(.299,.587,.114));float ky=dot(key,vec3(.299,.587,.114));float d=length(vec2(c.b-y,c.r-y)-vec2(key.b-ky,key.r-ky));float threshold=strength*.8;float soft=max(.001,softness*.35);float a=strength==0.0?1.0:smoothstep(threshold,threshold+soft,d);float amount=spill*(1.0-clamp((d-threshold-soft)/.25,0.0,1.0));if(key.g>key.r&&key.g>key.b)c.g-=max(0.0,c.g-max(c.r,c.b))*amount;else if(key.b>key.r&&key.b>key.g)c.b-=max(0.0,c.b-max(c.r,c.g))*amount;gl_FragColor=vec4(c,pixel.a*a);}`));
    gl.linkProgram(program);if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw Error(gl.getProgramInfoLog(program));gl.useProgram(program);const buffer=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,buffer);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,1,-1,-1,1,1,1]),gl.STATIC_DRAW);const point=gl.getAttribLocation(program,'point');gl.enableVertexAttribArray(point);gl.vertexAttribPointer(point,2,gl.FLOAT,false,0,0);const texture=gl.createTexture();gl.bindTexture(gl.TEXTURE_2D,texture);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);const uniforms=Object.fromEntries(['key','strength','softness','spill'].map(n=>[n,gl.getUniformLocation(program,n)]));
    return {canvas,draw(source,w,h,value){if(gl.isContextLost())throw Error('WebGL context lost');if(canvas.width!==w||canvas.height!==h){canvas.width=w;canvas.height=h}gl.viewport(0,0,w,h);gl.bindTexture(gl.TEXTURE_2D,texture);gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL,false);gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,source);const p=settings(value);gl.uniform3fv(uniforms.key,p.rgb);for(const n of ['strength','softness','spill'])gl.uniform1f(uniforms[n],p[n]);gl.drawArrays(gl.TRIANGLE_STRIP,0,4);return canvas}};
  }
  let gpu,attempted=false,cpu,last=null;
  function render(source,w,h,value){const stamp=typeof source.currentTime==='number'?source.currentTime:0,signature=JSON.stringify(value);if(last?.source===source&&last.stamp===stamp&&last.signature===signature&&last.w===w&&last.h===h)return last.surface;
    let surface;if(!attempted){attempted=true;try{gpu=gpuSurface()}catch{gpu=null}}
    if(gpu)try{surface=gpu.draw(source,w,h,value)}catch{gpu=null}
    if(!surface){cpu??=document.createElement('canvas');if(cpu.width!==w||cpu.height!==h){cpu.width=w;cpu.height=h}const cx=cpu.getContext('2d',{willReadFrequently:true});cx.clearRect(0,0,w,h);cx.drawImage(source,0,0,w,h);const pixels=cx.getImageData(0,0,w,h);keyPixels(pixels.data,value);cx.putImageData(pixels,0,0);surface=cpu}
    last={source,stamp,signature,w,h,surface};return surface;
  }
  window.MontazhnayaChroma={render,keyPixels,settings};
})();
