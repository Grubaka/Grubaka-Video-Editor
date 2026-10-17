'use strict';
function outputSize(meta,resolution){const max=resolution==='original'?Math.min(meta.width,meta.height):Math.min(Number(resolution),meta.width,meta.height);const scale=max/Math.min(meta.width,meta.height);return {width:Math.max(2,Math.round(meta.width*scale/2)*2),height:Math.max(2,Math.round(meta.height*scale/2)*2)}}
module.exports={outputSize};
