const SUBPIXEL_OFFSETS=[[-.25,-.25],[.25,-.25],[-.25,.25],[.25,.25]];
const SAMPLE_COUNT=Uint8Array.of(0,1,1,2,1,2,2,3,1,2,2,3,2,3,3,4);
const vehicleEdges={},propEdges={};
let activeEdges=null;

function beginSubpixelPass(state){
  if(!subpixelAAEnabled){activeEdges=null;return;}
  const size=BUFFER*BUFFER_HEIGHT;
  if(state.coverage?.length!==size){
    state.coverage=new Uint8Array(size);
    state.shadow=new Uint32Array(size);
    state.color=new Uint32Array(size);
  }
  state.coverage.fill(0);
  state.shadow.set(spritePixels);
  activeEdges=state;
}

// Mesh coverage follows the actual projected triangle, including when the center misses.
function triangleCoverage(u,v,du,dv,eu,ev){
  let mask=0;
  const du0=du*.25,dv0=dv*.25,eu0=eu*.25,ev0=ev*.25;
  for(let sample=0;sample<4;sample++){
    const sx=sample&1?1:-1,sy=sample&2?1:-1;
    const a=u+sx*du0+sy*eu0,b=v+sx*dv0+sy*ev0;
    if(a>=-1e-6&&b>=-1e-6&&a+b<=1.000001)mask|=1<<sample;
  }
  return mask;
}

// Tipped sprites use 2×2 splats. Sample the unrounded footprint of each splat.
function splatCoverage(x,y){
  if(!activeEdges)return;
  for(let iy=Math.ceil(y-.75);iy<=Math.floor(y+1.75);iy++){
    if(iy<1||iy>=BUFFER_HEIGHT-1)continue;
    for(let ix=Math.ceil(x-.75);ix<=Math.floor(x+1.75);ix++){
      if(ix<1||ix>=BUFFER-1)continue;
      const i=iy*BUFFER+ix;
      if(activeEdges.coverage[i]===15)continue;
      for(let s=0;s<4;s++){
        const sx=ix+SUBPIXEL_OFFSETS[s][0]-x,sy=iy+SUBPIXEL_OFFSETS[s][1]-y;
        if(sx>=-.5&&sx<1.5&&sy>=-.5&&sy<1.5)activeEdges.coverage[i]|=1<<s;
      }
    }
  }
}

function stackFootprint(part){
  const {model,x:cx,y:cy,z:baseZ,yaw,roll,mirror}=part;
  const {width:w,length:l,layers:n,area,bounds}=model;
  const cx0=part.pivotX??(w-1)/2,cy0=part.pivotY??(l-1)/2;
  const spacing=part.spacing??view.spacing;
  const step=model.layerStep*(part.heightScale??1);
  const c=Math.cos(yaw),s=Math.sin(yaw),rc=Math.cos(roll??0),rs=Math.sin(roll??0);
  const sx=mirror&&roll===null?-1:1,sy=part.flipY?-1:1;
  const rows=[];
  let minX=Infinity,maxX=-Infinity,minY=Infinity,maxY=-Infinity;
  for(let layer=n-1;layer>=0;layer--){
    const box=roll===null?bounds[layer]:{left:0,right:w-1,top:0,bottom:l-1};
    if(box.right<box.left)continue;
    const x0=(box.left-cx0-.5)*sx,x1=(box.right-cx0+.5)*sx;
    const y0=(box.top-cy0-.5)*sy,y1=(box.bottom-cy0+.5)*sy;
    const u=cx+Math.round((part.flexX??0)*(1-layer/(n-1)));
    const lift=Math.round((baseZ+layer*step)*spacing);
    const v=cy+Math.round((part.flexY??0)*(1-layer/(n-1)))-lift;
    const thickness=Math.max(1,Math.min(Math.ceil(step),lift-Math.round((baseZ+(layer-1)*step)*spacing),
      lift-Math.round(baseZ*spacing)+1));
    const left=u+Math.min(x0*c,x1*c)+Math.min(-y0*s,-y1*s);
    const right=u+Math.max(x0*c,x1*c)+Math.max(-y0*s,-y1*s);
    const top=v+(Math.min(x0*s,x1*s)+Math.min(y0*c,y1*c))*view.squash;
    const bottom=v+(Math.max(x0*s,x1*s)+Math.max(y0*c,y1*c))*view.squash+thickness-1;
    rows.push({u,v,left,right,top,bottom,thickness,layer});
    minX=Math.min(minX,left);maxX=Math.max(maxX,right);
    minY=Math.min(minY,top);maxY=Math.max(maxY,bottom);
  }
  return {model,w,l,n,area,cx0,cy0,roll,mirror,c,s,rc,rs,sx,sy,rows,minX,maxX,minY,maxY};
}

function stackHit(part,x,y){
  if(x<part.minX||x>part.maxX||y<part.minY||y>part.maxY)return false;
  const {model,w,l,n,area,cx0,cy0,roll,mirror,c,s,rc,rs,sx,sy,rows}=part;
  for(const row of rows){
    if(x<row.left||x>row.right||y<row.top||y>row.bottom)continue;
    const dx=x-row.u;
    for(let t=0;t<row.thickness;t++){
      const dy=(y-row.v-t)/view.squash;
      let a=Math.round(cx0+(dx*c+dy*s)*sx),b=Math.round(cy0+(-dx*s+dy*c)*sy);
      if(a<0||a>=w||b<0||b>=l)continue;
      let z=row.layer;
      if(roll!==null){
        const dz=z-(n-1)/2,dy0=b-cy0;
        a=mirror?w-1-a:a;
        b=Math.round(cy0+rc*dy0-rs*dz*model.layerStep);
        z=Math.round((n-1)/2+rs*dy0/model.layerStep+rc*dz);
        if(b<0||b>=l||z<0||z>=n)continue;
      }
      if(model.volume[z*area+b*w+a])return true;
    }
  }
  return false;
}

// The layer renderer traces exact sample positions only where the center mask changes.
function sampleStackEdges(parts){
  if(!activeEdges)return;
  const footprints=parts.map(stackFootprint),{coverage}=activeEdges;
  for(let y=1;y<BUFFER_HEIGHT-1;y++)for(let x=1,i=y*BUFFER+1;x<BUFFER-1;x++,i++){
    const center=bodyMask[i];
    if(center===bodyMask[i-1]&&center===bodyMask[i+1]&&center===bodyMask[i-BUFFER]&&center===bodyMask[i+BUFFER]&&
       center===bodyMask[i-BUFFER-1]&&center===bodyMask[i-BUFFER+1]&&
       center===bodyMask[i+BUFFER-1]&&center===bodyMask[i+BUFFER+1]){
      coverage[i]=center?15:0;
      continue;
    }
    let mask=0;
    for(let sample=0;sample<4;sample++){
      const [dx,dy]=SUBPIXEL_OFFSETS[sample];
      for(const part of footprints)if(stackHit(part,x+dx,y+dy)){
        mask|=1<<sample;break;
      }
    }
    coverage[i]=mask;
  }
}

function layerOver(back,front,amount){
  const a=(front>>>24)*amount, b=(back>>>24)*(1-a/255);
  if(a+b===0)return 0;
  const r=((front&255)*a+(back&255)*b)/(a+b);
  const g=((front>>>8&255)*a+(back>>>8&255)*b)/(a+b);
  const blue=((front>>>16&255)*a+(back>>>16&255)*b)/(a+b);
  return pack(Math.round(r),Math.round(g),Math.round(blue),Math.round(a+b));
}

function finishSubpixelPass(outline){
  if(!activeEdges)return false;
  const {coverage,shadow,color}=activeEdges;
  color.set(spritePixels);
  for(let y=1;y<BUFFER_HEIGHT-1;y++)for(let x=1,i=y*BUFFER+1;x<BUFFER-1;x++,i++){
    const filled=SAMPLE_COUNT[coverage[i]];
    if(filled===4&&bodyMask[i])continue;
    const left=i-1,right=i+1,above=i-BUFFER,below=i+BUFFER;
    const neighborSamples=Math.max(SAMPLE_COUNT[coverage[left]],SAMPLE_COUNT[coverage[right]],
      SAMPLE_COUNT[coverage[above]],SAMPLE_COUNT[coverage[below]]);
    const samples=filled||(bodyMask[i]?1:0);
    if(!samples&&!neighborSamples)continue;
    let background=shadow[i];
    if(neighborSamples>samples)background=layerOver(background,outline,(neighborSamples-samples)/4);
    if(!samples){spritePixels[i]=background;continue;}
    const nearest=bodyMask[i]?i:bodyMask[left]?left:bodyMask[right]?right:
      bodyMask[above]?above:bodyMask[below]?below:bodyMask[above-1]?above-1:
      bodyMask[above+1]?above+1:bodyMask[below-1]?below-1:bodyMask[below+1]?below+1:-1;
    spritePixels[i]=layerOver(background,nearest>=0?color[nearest]:outline,samples/4);
  }
  activeEdges=null;
  return true;
}

function specularSpread(model,index){
  if(!specularAAEnabled)return 0;
  const data=detailNormal?model.specularDetail:model.specularBase;
  return (data?.[index]??0)/255*.24;
}


function ggxHighlight(roughness,normalDot,variance){
  const a=roughness*roughness,a2=Math.min(1,a*a+variance);
  const d=normalDot*normalDot*(a2-1)+1;
  // The legacy peak cap can hide the filter, so lower it where normals disagree.
  return Math.min(2.4/(1+4*variance),a2/(d*d)*.63);
}
