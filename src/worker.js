"use strict";

const previewCount = 45;
let plates, version, baselineKey, database, newest = 0;
let jobs = Promise.resolve();
let activeProfile, isCustom=false, isProp=false;

function unpackDataUrl(data) {
  const raw = atob(data);
  const bytes = Uint8Array.from(raw, ch=>ch.charCodeAt(0));
  return new Blob([bytes],{type:"image/png"});
}

async function splitFourViews(encoded) {
  const bitmap = await createImageBitmap(unpackDataUrl(encoded));
  const {width,height} = bitmap;
  if(width>8192||height>8192||width*height>16000000){
    bitmap.close();
    throw new Error("4면 PNG의 크기를 1,600만 픽셀 이하로 줄여주세요.");
  }
  const surface = new OffscreenCanvas(width,height);
  const ctx = surface.getContext("2d",{willReadFrequently:true});
  ctx.drawImage(bitmap,0,0);
  bitmap.close();
  const rgba = ctx.getImageData(0,0,width,height);
  const data = rgba.data, count = width*height;
  const background = new Uint8Array(count);
  const queue = new Int32Array(count);
  let write = 0, read = 0;
  function visit(index) {
    if (background[index]) return;
    const i = index*4;
    if (data[i+3]>127 && Math.min(data[i],data[i+1],data[i+2])<238) return;
    background[index] = 1;
    queue[write++] = index;
  }
  for (let x=0;x<width;x++) {visit(x); visit((height-1)*width+x);}
  for (let y=1;y<height-1;y++) {visit(y*width); visit(y*width+width-1);}
  while (read<write) {
    const cell=queue[read++], x=cell%width;
    if (x) visit(cell-1);
    if (x+1<width) visit(cell+1);
    if (cell>=width) visit(cell-width);
    if (cell<count-width) visit(cell+width);
  }
  const covered = new Uint8Array(width);
  for (let i=0;i<count;i++) {
    if (background[i] || data[4*i+3]<128) data[4*i+3]=0;
    else covered[i%width]=1;
  }
  const bands=[];
  let x=0;
  while (x<width) {
    while (x<width && !covered[x]) x++;
    const left=x;
    while (x<width && covered[x]) x++;
    if (left===x) continue;
    const prior=bands.at(-1);
    if (prior && left-prior.right<width*.007) prior.right=x;
    else bands.push({left,right:x});
  }
  if (bands.length!==4) throw new Error("4면 시트에서 네 개의 실루엣을 찾을 수 없습니다.");
  ctx.putImageData(rgba,0,0);
  return bands.map(({left,right})=>{
    let top=height,bottom=0;
    for(let y=0;y<height;y++) {
      for(let x=left;x<right;x++) {
        if (data[(y*width+x)*4+3]<128) continue;
        top=Math.min(top,y);bottom=Math.max(bottom,y+1);
      }
    }
    return {surface,left,top,width:right-left,height:bottom-top};
  });
}

function fitView(region,width,height) {
  const canvas=new OffscreenCanvas(width,height);
  const ctx=canvas.getContext("2d",{willReadFrequently:true});
  ctx.imageSmoothingEnabled=true;
  ctx.imageSmoothingQuality="high";
  ctx.drawImage(region.surface,region.left,region.top,region.width,region.height,0,0,width,height);
  const pixels=new Uint32Array(ctx.getImageData(0,0,width,height).data.buffer);
  for(let i=0;i<pixels.length;i++) pixels[i]=(pixels[i]>>>24)>=128 ? pixels[i]|0xff000000 : 0;
  return pixels;
}

function paintDarker(color,gain) {
  return (255<<24) | (((color>>>16&255)*gain)<<16) | (((color>>>8&255)*gain)<<8) | ((color&255)*gain);
}

function carve(views,width,length,layers,ratio,isWheel) {
  const top=fitView(views[0],width,length);
  const side=fitView(views[1],length,layers);
  const front=fitView(views[2],width,layers);
  const rear=fitView(views[3],width,layers);
  const area=width*length;
  const volume=new Uint32Array(area*layers);
  const mask=new Uint8Array(area), covered=new Uint8Array(area);
  const lowX=new Uint16Array(area), highX=new Uint16Array(area);
  const lowY=new Uint16Array(area), highY=new Uint16Array(area);
  const corner=(width-1)*.5, halfLength=(length-1)*.5;
  for(let z=layers-1;z>=0;z--) {
    const row=layers-1-z, base=z*area;
    for(let y=0;y<length;y++) {
      const sideColor=side[row*length+length-1-y];
      let run=0;
      for(let x=0;x<width;x++) {
        const i=y*width+x;
        mask[i]=+(!!(top[i] && sideColor && (front[row*width+x] || rear[row*width+width-1-x])));
        run=mask[i] ? run+1 : 0; lowX[i]=run;
      }
      run=0;
      for(let x=width-1;x>=0;x--) {
        const i=y*width+x;
        run=mask[i] ? run+1 : 0; highX[i]=run;
      }
    }
    for(let x=0;x<width;x++) {
      let run=0;
      for(let y=0;y<length;y++) {
        const i=y*width+x;
        run=mask[i] ? run+1 : 0; lowY[i]=run;
      }
      run=0;
      for(let y=length-1;y>=0;y--) {
        const i=y*width+x;
        run=mask[i] ? run+1 : 0; highY[i]=run;
      }
    }
    for(let y=0;y<length;y++) {
      const sideColor=side[row*length+length-1-y];
      for(let x=0;x<width;x++) {
        const i=y*width+x;
        if(!mask[i]) continue;
        const edge=Math.min(lowX[i],highX[i],lowY[i],highY[i]);
        const xf=edge===lowX[i] || edge===highX[i];
        const face=(xf ? sideColor : edge===lowY[i] ? rear[row*width+width-1-x] : front[row*width+x]) || top[i];
        const above=covered[i];
        const upper=base+area<volume.length ? volume[base+i+area] : 0;
        const nearHeight=(x>0&&covered[i-1])||(x+1<width&&covered[i+1])||
          (y>0&&covered[i-width])||(y+1<length&&covered[i+width]);
        let color=(!above && (edge>2 || !nearHeight)) ? top[i] : edge>2&&upper ? upper : face;
        if (edge<=2 && above) color=paintDarker(color,.985-.035*(1-z/(layers-1)));
        volume[base+i]=color;
      }
    }
    for(let i=0;i<area;i++) covered[i] ||= mask[i];
  }
  // Reapply the existing wheel-well correction in invariant chassis coordinates.
  for(let z=0;z<layers;z++) {
    const zr=isWheel ? (z/(layers-1)-.5)*(WHEEL_DIAMETER-1) :
      z*(BASE_BODY_LAYERS-1)/(layers-1)+BODY_CLEARANCE-(WHEEL_DIAMETER-1)*.5;
    for(let y=0;y<length;y++) {
      const along=(y-halfLength)/ratio;
      const frontCut=!isCustom && ((along-FRONT_AXLE)/activeProfile.well.frontRadius)**2+(zr/activeProfile.well.zRadius)**2<1;
      const rearCut=!isCustom && ((along-REAR_AXLE)/activeProfile.well.rearRadius)**2+(zr/activeProfile.well.zRadius)**2<1;
      for(let x=0;x<width;x++) {
        const i=z*area+y*width+x;
        if(!volume[i]) continue;
        const outward=Math.abs(x-corner)/ratio;
        if(isWheel) {
          const radius=WHEEL_DIAMETER*.5+.1-Math.max(0,Math.abs(x-corner)/corner-.68)*5;
          if(zr*zr+along*along>radius*radius) volume[i]=0;
        } else {
          const limit=frontCut ? activeProfile.well.frontWidth : rearCut ? activeProfile.well.rearWidth : Infinity;
          if(outward>limit) volume[i]=0;
          else if(outward>limit-1.2/ratio) {
            const sideColor=side[(layers-1-z)*length+length-1-y];
            if(sideColor) volume[i]=paintDarker(sideColor,.72);
          }
        }
      }
    }
  }
  return {volume,views:[top,side,front,rear]};
}

function modelData(carved,width,length,layers,ratio,isWheel,physicalHeight) {
  const {volume,views}=carved;
  const area=width*length;
  const bounds=[], shadow=[], contact=[];
  const baseHeight=physicalHeight??(isWheel ? WHEEL_DIAMETER-1 : BASE_BODY_LAYERS-1);
  const layerStep=baseHeight*ratio/(layers-1);
  const shadowStride=Math.max(1,Math.round(2*ratio));
  const shadowZStride=Math.max(1,Math.round(4*layers/(baseHeight+1)));
  const footprint=new Uint8Array(area);
  for(let z=0;z<layers;z++) {
    const box={left:width,right:-1,top:length,bottom:-1};
    for(let y=0;y<length;y++) for(let x=0;x<width;x++) {
      const i=y*width+x;
      if(!volume[z*area+i]) continue;
      box.left=Math.min(box.left,x);box.right=Math.max(box.right,x);
      box.top=Math.min(box.top,y);box.bottom=Math.max(box.bottom,y);
      if((isWheel||isCustom||plates.parts) && z*layerStep<Math.max(2,12*ratio)) footprint[i]=1;
      if(z%shadowZStride===0&&y%shadowStride===0&&x%shadowStride===0) shadow.push(x,y,z);
    }
    bounds.push(box);
  }
  if (bounds.every(box=>box.right<0)) throw new Error("복원한 슬라이스에 형상이 없습니다.");
  for(let y=0;y<length;y++) for(let x=0;x<width;x++) if(footprint[y*width+x]) contact.push(x,y);
  const normals=makeNormals(volume,bounds,width,length,layers,layerStep);
  const surface=bakeSurfaceData(volume,bounds,normals,width,length,layers,isWheel,ratio,layerStep);
  const detailedNormals=bakeDetailNormals(volume,bounds,normals,surface.material,width,length,layers,isWheel,layerStep);
  const model={width,length,layers,area,volume,bounds,normals,detailedNormals,...surface,
    layerStep,shadowStride,shadow:Int16Array.from(shadow),contact:Int16Array.from(contact)};
  return {...model,...projectViewColors(model,views),...marchingCubes(model,isWheel||isProp)};
}

async function readSource() {
  if (!plates.decoded) plates.decoded=Promise.all([splitFourViews(plates.body),plates.wheel?splitFourViews(plates.wheel):null]);
  return plates.decoded;
}
async function buildStack(layers,ratio) {
  const [bodyViews,wheelViews]=await readSource();
  if(isCustom){
    const [top,side]=bodyViews;
    BASE_BODY_LENGTH=Math.min(200,Math.max(18,Math.round(BASE_BODY_LAYERS*side.width/side.height)));
    BASE_BODY_WIDTH=Math.min(132,Math.max(12,Math.round(BASE_BODY_LENGTH*top.width/top.height)));
  }
  const width=Math.round(BASE_BODY_WIDTH*ratio),length=Math.round(BASE_BODY_LENGTH*ratio);
  const body=modelData(carve(bodyViews,width,length,layers,ratio,false),width,length,layers,ratio,false);
  let wheel=null;
  if(wheelViews){
    const wheelWidth=Math.round(BASE_WHEEL_WIDTH*ratio),wheelLength=Math.round(WHEEL_DIAMETER*ratio);
    const wheelLayers=Math.max(8,Math.round(WHEEL_DIAMETER*layers/BASE_BODY_LAYERS));
    wheel=modelData(carve(wheelViews,wheelWidth,wheelLength,wheelLayers,ratio,true),wheelWidth,wheelLength,wheelLayers,ratio,true);
  }
  return {ratio,layers,body,wheel,custom:isCustom,profile:activeProfile};
}

function openCache() {
  if (!self.indexedDB) return Promise.resolve(null);
  return new Promise(resolve=>{
    try {
      const request=indexedDB.open("fillet-rover-stack-cache",2);
      request.onupgradeneeded=()=>{
        const db=request.result;
        const store=db.objectStoreNames.contains("stacks") ? request.transaction.objectStore("stacks") : db.createObjectStore("stacks");
        store.createIndex("updated","updated");
      };
      request.onerror=request.onblocked=()=>resolve(null);
      request.onsuccess=()=>resolve(request.result);
    } catch {resolve(null);}
  });
}
async function findCached(key) {
  const db=await database;
  if(!db) return null;
  return new Promise(resolve=>{
    try {
      const request=db.transaction("stacks","readonly").objectStore("stacks").get(key);
      request.onsuccess=()=>resolve(request.result?.stack ?? null);
      request.onerror=()=>resolve(null);
    } catch {resolve(null);}
  });
}
async function storeCached(key,stack) {
  const db=await database;
  if(!db) return false;
  return new Promise(resolve=>{
    try {
      const tx=db.transaction("stacks","readwrite"), table=tx.objectStore("stacks");
      tx.oncomplete=()=>resolve(true);
      tx.onerror=tx.onabort=()=>resolve(false);
      table.put({stack,updated:Date.now()},key);
      // Walk only keys, so eviction doesn't deserialize old voxel data.
      let count=0;
      const cursor=table.index("updated").openKeyCursor(null,"prev");
      cursor.onsuccess=()=>{
        const entry=cursor.result;
        if(!entry) return;
        const propStore=key.startsWith("prop:");
        if(entry.primaryKey.startsWith("prop:")===propStore && entry.primaryKey!==baselineKey && ++count>(propStore?23:2)) table.delete(entry.primaryKey);
        entry.continue();
      };
    } catch {resolve(false);}
  });
}
function sendStack(sequence,stack,source,elapsed,persistent) {
  const buffers=[];
  for(const item of [stack.body,stack.wheel,stack.center,stack.angled].filter(Boolean)) {
    for(const value of Object.values(item)) if(ArrayBuffer.isView(value)) buffers.push(value.buffer);
  }
  postMessage({type:"ready",sequence,stack,source,elapsed,persistent},buffers);
}
async function loadRequested({sequence,layers,ratio,progressive}) {
  if(sequence!==newest) return;
  const key=(isProp?"prop:":"")+version+":"+layers+":"+ratio, t=performance.now();
  const cached=await findCached(key);
  if(sequence!==newest) return;
  if(cached) {
    sendStack(sequence,cached,"disk",performance.now()-t,true);
    return;
  }
  if(plates.parts) {
    const stack=await importAnt(layers,ratio);
    const persist=await storeCached(key,stack);
    if(sequence===newest)sendStack(sequence,stack,"build",performance.now()-t,persist);
    return;
  }
  if(progressive && layers>previewCount) {
    const previewRatio=Math.min(1,ratio);
    const t0=performance.now(), previewKey=version+":"+previewCount+":"+previewRatio;
    const cachedPreview=await findCached(previewKey);
    if(sequence!==newest) return;
    const preview=cachedPreview ?? await buildStack(previewCount,previewRatio);
    if(sequence!==newest) return;
    const persist=cachedPreview ? true : await storeCached(previewKey,preview);
    if(sequence!==newest) return;
    sendStack(sequence,preview,cachedPreview ? "disk" : "build",performance.now()-t0,persist);
  }
  if(sequence!==newest) return;
  const t0=performance.now();
  const stack=await buildStack(layers,ratio);
  const persist=await storeCached(key,stack);
  if(sequence===newest) sendStack(sequence,stack,"build",performance.now()-t0,persist);
}
onmessage=({data})=>{
  if(data.type==="init") {
    plates=data.plates;
    version=data.version;
    baselineKey=(data.prop?"prop:":"")+version+":"+data.defaultLayers+":"+data.defaultRatio;
    activeProfile=data.profile;
    isCustom=!plates.wheel;isProp=!!data.prop;
    BASE_BODY_WIDTH=activeProfile.body.width;
    BASE_BODY_LENGTH=activeProfile.body.length;
    BASE_BODY_LAYERS=activeProfile.body.layers;
    BASE_WHEEL_WIDTH=activeProfile.wheel?.width??0;
    WHEEL_DIAMETER=activeProfile.wheel?.layers??0;
    BODY_CLEARANCE=activeProfile.body_clearance;
    FRONT_AXLE=activeProfile.front_axle;
    REAR_AXLE=activeProfile.rear_axle;
    database=isCustom&&!plates.parts&&!data.cache?Promise.resolve(null):openCache();
    return;
  }
  newest=data.sequence;
  if(data.type==="cancel") return;
  jobs=jobs.then(()=>loadRequested(data))
    .catch(error=>postMessage({type:"error",sequence:data.sequence,message:error.message}));
};

let BASE_BODY_LAYERS=90;
let BASE_BODY_WIDTH=80;
let BASE_BODY_LENGTH=188;
let BASE_WHEEL_WIDTH=20;
let BODY_CLEARANCE=13;
let FRONT_AXLE=48.5;
let REAR_AXLE=-56.5;
let WHEEL_DIAMETER=44;
const PROBE_REACH = [5,12];
const BLOCKER_PROBES = [
  [1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1],
  [1,1,0],[-1,1,0],[1,-1,0],[-1,-1,0],
  [1,0,1],[-1,0,1],[1,0,-1],[-1,0,-1],
  [0,1,1],[0,-1,1],[0,1,-1],[0,-1,-1],
];

function materialIndex(isWheel, x, y, z, width, length, layers, color, ratio, layerStep) {
  if (isWheel) {
    const radial = (y-(length-1)*.5)**2 + ((z-(layers-1)*.5)*layerStep)**2;
    return radial < (WHEEL_DIAMETER*ratio*.30)**2 && Math.abs(x-(width-1)*.5) > width*.32 ? 3 : 2;
  }
  const r = color&255, g = (color>>>8)&255, b = (color>>>16)&255;
  const lightness = (r+g+b)/3;
  if (z>layers*.41 && z<layers*.82 && y>length*.73 && lightness<81 && b>r+8) return 4;
  if (b>90 && b>r*1.55 && b>g*1.24) return 7;
  if (r-b > 46 && g-b > 19) return 6;
  if (z<13 && lightness>87 && Math.max(r,g,b)-Math.min(r,g,b)<17) return 1;
  return lightness < 67 ? 5 : 0;
}

function bakeSurfaceData(volume, bounds, normals, width, length, layers, isWheel, ratio, layerStep) {
  const material = new Uint8Array(volume.length);
  const ambient = new Uint8Array(volume.length);
  const area = width*length;
  for (let z = 0; z < layers; z++) {
    const box = bounds[z];
    for (let y = box.top; y <= box.bottom; y++) {
      const line = z*area+y*width;
      for (let x = box.left; x <= box.right; x++) {
        const i = line+x;
        if (!volume[i]) continue;
        material[i] = materialIndex(isWheel,x,y,z,width,length,layers,volume[i],ratio,layerStep);
        const nx = normals[i*3], ny = normals[i*3+1], nz = normals[i*3+2];
        if (!(nx || ny || nz)) continue;
        let visible = 0, covered = 0;
        for (const [dx,dy,dz] of BLOCKER_PROBES) {
          const weight = nx*dx+ny*dy+nz*dz;
          if (weight < 20) continue;
          visible += weight;
          for (const reach of PROBE_REACH) {
            const px = x+dx*reach, py = y+dy*reach, pz = Math.round(z+dz*reach/layerStep);
            if (px<0 || px>=width || py<0 || py>=length || pz<0 || pz>=layers) break;
            if (volume[pz*area+py*width+px]) {
              covered += weight*(reach === 5 ? 1 : .68);
              break;
            }
          }
        }
        const along=(y-(length-1)*.5)/ratio;
        const wellDistance = Math.min(((along-FRONT_AXLE)/26)**2,((along-REAR_AXLE)/24)**2);
        const wheelWell = !isCustom && !isWheel && z*layerStep/ratio<32 && wellDistance+((z*layerStep/ratio+BODY_CLEARANCE-(WHEEL_DIAMETER-1)/2)/25)**2<1 &&
          Math.abs(x-(width-1)*.5)/ratio>=23;
        ambient[i] = Math.round(255*(1-(visible ? .57*covered/visible : 0))*(wheelWell ? .81 : 1));
      }
    }
  }
  return {material,ambient};
}

function coatingGrain(x,y,z) {
  let seed = Math.imul(x+17,0x9e3779b1) ^ Math.imul(y+41,0x85ebca6b) ^ Math.imul(z+7,0xc2b2ae35);
  seed = Math.imul(seed^(seed>>>16),0x7feb352d);
  return ((seed^(seed>>>15)) & 255)/255-.5;
}

function bakeDetailNormals(volume,bounds,normals,material,width,length,layers,isWheel,layerStep) {
  const area = width*length, heights = new Int16Array(volume.length);
  const detail = new Int8Array(normals);
  for (let z=0; z<layers; z++) {
    const box = bounds[z], layer = z*area;
    for (let y=box.top; y<=box.bottom; y++) {
      for (let x=box.left; x<=box.right; x++) {
        const i = layer+y*width+x, color = volume[i];
        if (!color) continue;
        // The original texture supplies grooves and chips; add a dry fine grain to the coating.
        const luminance = ((color&255)*54+((color>>>8)&255)*183+((color>>>16)&255)*19)>>8;
        const kind = material[i];
        const isCoating = kind===0 || kind===6;
        let grain = 0;
        if (isCoating) {
          grain = 16*coatingGrain(x,y,z)+11*coatingGrain(x>>1,y>>1,z>>1);
        } else if (kind===2) {
          grain = 7*coatingGrain(x,y,z);
        } else if (kind===1) {
          grain = 5*coatingGrain(x>>2,y>>1,z);
        }
        heights[i] = Math.round(luminance+grain);
      }
    }
  }

  // Blend a one-pixel and a two-pixel gradient. Missing voxels use the local height,
  // so the transparent edge of a slice cannot become a false scratch or bright seam.
  function gradient(i,coordinate,limit,stride) {
    const a = coordinate>0 && volume[i-stride] ? heights[i-stride] : heights[i];
    const b = coordinate+1<limit && volume[i+stride] ? heights[i+stride] : heights[i];
    const c = coordinate>1 && volume[i-2*stride] ? heights[i-2*stride] : a;
    const d = coordinate+2<limit && volume[i+2*stride] ? heights[i+2*stride] : b;
    return .76*(b-a)+.12*(d-c);
  }

  for (let z=0; z<layers; z++) {
    const box = bounds[z], layer = z*area;
    for (let y=box.top; y<=box.bottom; y++) {
      const rollingBand = (y-(length-1)*.5)**2+((z-(layers-1)*.5)*layerStep)**2 > ((length-1)*.38)**2;
      for (let x=box.left; x<=box.right; x++) {
        const i = layer+y*width+x, offset = i*3;
        const nx = normals[offset]/127, ny = normals[offset+1]/127, nz = normals[offset+2]/127;
        if (!(nx || ny || nz)) continue;
        const kind = material[i];
        if (kind===4) continue; // preserve the smooth lens reflection
        const tread = isWheel && kind===2 && rollingBand && Math.abs(nx)<.82;
        const dx = gradient(i,x,width,1), dy = gradient(i,y,length,width), dz = gradient(i,z,layers,area)/layerStep;
        const dot = dx*nx+dy*ny+dz*nz;
        const tx = dx-nx*dot, ty = dy-ny*dot, tz = dz-nz*dot;
        const strength = tread ? .016 : kind===2 ? .005 : kind===5 ? .0028 : .0065;
        const limit = tread ? .62 : kind===2 ? .24 : .32;
        const amount = Math.min(strength,limit/Math.max(1,Math.hypot(tx,ty,tz)));
        const sx = nx-amount*tx, sy = ny-amount*ty, sz = nz-amount*tz;
        const lengthInv = 127/Math.hypot(sx,sy,sz);
        detail[offset] = Math.round(sx*lengthInv);
        detail[offset+1] = Math.round(sy*lengthInv);
        detail[offset+2] = Math.round(sz*lengthInv);
      }
    }
  }
  return detail;
}

function makeNormals(volume,bounds,WIDTH,LENGTH,LAYERS,layerStep) {
  const AREA = WIDTH*LENGTH;
  // A separable 5-tap blur of the occupancy field stabilizes normals on stepped surfaces.
  const slices = volume.length;
  const alongX = new Uint8Array(slices);
  const alongY = new Uint8Array(slices);
  const density = new Uint16Array(slices);
  for (let z = 0; z < LAYERS; z++) {
    for (let y = 0; y < LENGTH; y++) {
      const row = z*AREA + y*WIDTH;
      for (let x = 0; x < WIDTH; x++) {
        let sum = 0;
        for (let offset = -2; offset <= 2; offset++) {
          if (x + offset >= 0 && x + offset < WIDTH && volume[row+x+offset]) sum += 3-Math.abs(offset);
        }
        alongX[row+x] = sum;
      }
    }
  }
  for (let z = 0; z < LAYERS; z++) {
    for (let y = 0; y < LENGTH; y++) {
      const row = z*AREA + y*WIDTH;
      for (let x = 0; x < WIDTH; x++) {
        let sum = 0;
        for (let offset = -2; offset <= 2; offset++) {
          if (y + offset >= 0 && y + offset < LENGTH) sum += alongX[row+x+offset*WIDTH] * (3-Math.abs(offset));
        }
        alongY[row+x] = sum;
      }
    }
  }
  for (let z = 0; z < LAYERS; z++) {
    const layer = z*AREA;
    for (let i = 0; i < AREA; i++) {
      let sum = 0;
      for (let offset = -2; offset <= 2; offset++) {
        if (z + offset >= 0 && z + offset < LAYERS) sum += alongY[layer+i+offset*AREA] * (3-Math.abs(offset));
      }
      density[layer+i] = sum;
    }
  }
  const result = new Int8Array(slices * 3);
  for (let z = 0; z < LAYERS; z++) {
    const box = bounds[z];
    for (let y = box.top; y <= box.bottom; y++) {
      for (let x = box.left; x <= box.right; x++) {
        const i = z*AREA+y*WIDTH+x;
        if (!volume[i]) continue;
        const dx = (x > 0 ? density[i-1] : 0) - (x < WIDTH-1 ? density[i+1] : 0);
        const dy = (y > 0 ? density[i-WIDTH] : 0) - (y < LENGTH-1 ? density[i+WIDTH] : 0);
        const dz = (z > 0 ? density[i-AREA] : 0) - (z < LAYERS-1 ? density[i+AREA] : 0);
        const length = Math.hypot(dx,dy,dz/layerStep);
        if (length <= 0) continue;
        const inverse = 127/length;
        result[3*i] = Math.round(dx*inverse);
        result[3*i+1] = Math.round(dy*inverse);
        result[3*i+2] = Math.round(dz*inverse/layerStep);
      }
    }
  }
  return result;
}

/* Marching Cubes lookup table, three.js r180.
The MIT License

Copyright © 2010-2025 three.js authors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.

*/
const MC_TRIANGLES=Int8Array.from(atob("/////////////////////wAIA/////////////////8AAQn/////////////////AQgDCQgB/////////////wECCv////////////////8ACAMBAgr/////////////CQIKAAIJ/////////////wIIAwIKCAoJCP////////8DCwL/////////////////AAsCCAsA/////////////wEJAAIDC/////////////8BCwIBCQsJCAv/////////AwoBCwoD/////////////wAKAQAICggLCv////////8DCQADCwkLCgn/////////CQgKCggL/////////////wQHCP////////////////8EAwAHAwT/////////////AAEJCAQH/////////////wQBCQQHAQcDAf////////8BAgoIBAf/////////////AwQHAwAEAQIK/////////wkCCgkAAggEB/////////8CCgkCCQcCBwMHCQT/////CAQHAwsC/////////////wsEBwsCBAIABP////////8JAAEIBAcCAwv/////////BAcLCQQLCQsCCQIB/////wMKAQMLCgcIBP////////8BCwoBBAsBAAQHCwT/////BAcICQALCQsKCwAD/////wQHCwQLCQkLCv////////8JBQT/////////////////CQUEAAgD/////////////wAFBAEFAP////////////8IBQQIAwUDAQX/////////AQIKCQUE/////////////wMACAECCgQJBf////////8FAgoFBAIEAAL/////////AgoFAwIFAwUEAwQI/////wkFBAIDC/////////////8ACwIACAsECQX/////////AAUEAAEFAgML/////////wIBBQIFCAIICwQIBf////8KAwsKAQMJBQT/////////BAkFAAgBCAoBCAsK/////wUEAAUACwULCgsAA/////8FBAgFCAoKCAv/////////CQcIBQcJ/////////////wkDAAkFAwUHA/////////8ABwgAAQcBBQf/////////AQUDAwUH/////////////wkHCAkFBwoBAv////////8KAQIJBQAFAwAFBwP/////CAACCAIFCAUHCgUC/////wIKBQIFAwMFB/////////8HCQUHCAkDCwL/////////CQUHCQcCCQIAAgcL/////wIDCwABCAEHCAEFB/////8LAgELAQcHAQX/////////CQUICAUHCgEDCgML/////wUHAAUACQcLAAEACgsKAP8LCgALAAMKBQAIAAcFBwD/CwoFBwsF/////////////woGBf////////////////8ACAMFCgb/////////////CQABBQoG/////////////wEIAwEJCAUKBv////////8BBgUCBgH/////////////AQYFAQIGAwAI/////////wkGBQkABgACBv////////8FCQgFCAIFAgYDAgj/////AgMLCgYF/////////////wsACAsCAAoGBf////////8AAQkCAwsFCgb/////////BQoGAQkCCQsCCQgL/////wYDCwYFAwUBA/////////8ACAsACwUABQEFCwb/////AwsGAAMGAAYFAAUJ/////wYFCQYJCwsJCP////////8FCgYEBwj/////////////BAMABAcDBgUK/////////wEJAAUKBggEB/////////8KBgUBCQcBBwMHCQT/////BgECBgUBBAcI/////////wECBQUCBgMABAMEB/////8IBAcJAAUABgUAAgb/////BwMJBwkEAwIJBQkGAgYJ/wMLAgcIBAoGBf////////8FCgYEBwIEAgACBwv/////AAEJBAcIAgMLBQoG/////wkCAQkLAgkECwcLBAUKBv8IBAcDCwUDBQEFCwb/////BQELBQsGAQALBwsEAAQL/wAFCQAGBQADBgsGAwgEB/8GBQkGCQsEBwkHCwn/////CgQJBgQK/////////////wQKBgQJCgAIA/////////8KAAEKBgAGBAD/////////CAMBCAEGCAYEBgEK/////wEECQECBAIGBP////////8DAAgBAgkCBAkCBgT/////AAIEBAIG/////////////wgDAggCBAQCBv////////8KBAkKBgQLAgP/////////AAgCAggLBAkKBAoG/////wMLAgABBgAGBAYBCv////8GBAEGAQoECAECAQsICwH/CQYECQMGCQEDCwYD/////wgLAQgBAAsGAQkBBAYEAf8DCwYDBgAABgT/////////BgQICwYI/////////////wcKBgcICggJCv////////8ABwMACgcACQoGBwr/////CgYHAQoHAQcIAQgA/////woGBwoHAQEHA/////////8BAgYBBggBCAkIBgf/////AgYJAgkBBgcJAAkDBwMJ/wcIAAcABgYAAv////////8HAwIGBwL/////////////AgMLCgYICggJCAYH/////wIABwIHCwAJBwYHCgkKB/8BCAABBwgBCgcGBwoCAwv/CwIBCwEHCgYBBgcB/////wgJBggGBwkBBgsGAwEDBv8ACQELBgf/////////////BwgABwAGAwsACwYA/////wcLBv////////////////8HBgv/////////////////AwAICwcG/////////////wABCQsHBv////////////8IAQkIAwELBwb/////////CgECBgsH/////////////wECCgMACAYLB/////////8CCQACCgkGCwf/////////BgsHAgoDCggDCgkI/////wcCAwYCB/////////////8HAAgHBgAGAgD/////////AgcGAgMHAAEJ/////////wEGAgEIBgEJCAgHBv////8KBwYKAQcBAwf/////////CgcGAQcKAQgHAQAI/////wADBwAHCgAKCQYKB/////8HBgoHCggICgn/////////BggECwgG/////////////wMGCwMABgAEBv////////8IBgsIBAYJAAH/////////CQQGCQYDCQMBCwMG/////wYIBAYLCAIKAf////////8BAgoDAAsABgsABAb/////BAsIBAYLAAIJAgoJ/////woJAwoDAgkEAwsDBgQGA/8IAgMIBAIEBgL/////////AAQCBAYC/////////////wEJAAIDBAIEBgQDCP////8BCQQBBAICBAb/////////CAEDCAYBCAQGBgoB/////woBAAoABgYABP////////8EBgMEAwgGCgMAAwkKCQP/CgkEBgoE/////////////wQJBQcGC/////////////8ACAMECQULBwb/////////BQABBQQABwYL/////////wsHBggDBAMFBAMBBf////8JBQQKAQIHBgv/////////BgsHAQIKAAgDBAkF/////wcGCwUECgQCCgQAAv////8DBAgDBQQDAgUKBQILBwb/BwIDBwYCBQQJ/////////wkFBAAIBgAGAgYIB/////8DBgIDBwYBBQAFBAD/////BgIIBggHAgEIBAgFAQUI/wkFBAoBBgEHBgEDB/////8BBgoBBwYBAAcIBwAJBQT/BAAKBAoFAAMKBgoHAwcK/wcGCgcKCAUECgQICv////8GCQUGCwkLCAn/////////AwYLAAYDAAUGAAkF/////wALCAAFCwABBQUGC/////8GCwMGAwUFAwH/////////AQIKCQULCQsICwUG/////wALAwAGCwAJBgUGCQECCv8LCAULBQYIAAUKBQIAAgX/BgsDBgMFAgoDCgUD/////wUICQUCCAUGAgMIAv////8JBQYJBgAABgL/////////AQUIAQgABQYIAwgCBgII/wEFBgIBBv////////////8BAwYBBgoDCAYFBgkICQb/CgEACgAGCQUABQYA/////wADCAUGCv////////////8KBQb/////////////////CwUKBwUL/////////////wsFCgsHBQgDAP////////8FCwcFCgsBCQD/////////CgcFCgsHCQgBCAMB/////wsBAgsHAQcFAf////////8ACAMBAgcBBwUHAgv/////CQcFCQIHCQACAgsH/////wcFAgcCCwUJAgMCCAkIAv8CBQoCAwUDBwX/////////CAIACAUCCAcFCgIF/////wkAAQUKAwUDBwMKAv////8JCAIJAgEIBwIKAgUHBQL/AQMFAwcF/////////////wAIBwAHAQEHBf////////8JAAMJAwUFAwf/////////CQgHBQkH/////////////wUIBAUKCAoLCP////////8FAAQFCwAFCgsLAwD/////AAEJCAQKCAoLCgQF/////woLBAoEBQsDBAkEAQMBBP8CBQECCAUCCwgEBQj/////AAQLAAsDBAULAgsBBQEL/wACBQAFCQILBQQFCAsIBf8JBAUCCwP/////////////AgUKAwUCAwQFAwgE/////wUKAgUCBAQCAP////////8DCgIDBQoDCAUEBQgAAQn/BQoCBQIEAQkCCQQC/////wgEBQgFAwMFAf////////8ABAUBAAX/////////////CAQFCAUDCQAFAAMF/////wkEBf////////////////8ECwcECQsJCgv/////////AAgDBAkHCQsHCQoL/////wEKCwELBAEEAAcEC/////8DAQQDBAgBCgQHBAsKCwT/BAsHCQsECQILCQEC/////wkHBAkLBwkBCwILAQAIA/8LBwQLBAICBAD/////////CwcECwQCCAMEAwIE/////wIJCgIHCQIDBwcECf////8JCgcJBwQKAgcIBwACAAf/AwcKAwoCBwQKAQoABAAK/wEKAggHBP////////////8ECQEEAQcHAQP/////////BAkBBAEHAAgBCAcB/////wQAAwcEA/////////////8ECAf/////////////////CQoICgsI/////////////wMACQMJCwsJCv////////8AAQoACggICgv/////////AwEKCwMK/////////////wECCwELCQkLCP////////8DAAkDCQsBAgkCCwn/////AAILCAAL/////////////wMCC/////////////////8CAwgCCAoKCAn/////////CQoCAAkC/////////////wIDCAIICgABCAEKCP////8BCgL/////////////////AQMICQEI/////////////wAJAf////////////////8AAwj//////////////////////////////////////w=="),c=>c.charCodeAt(0));
// Reproject each exposed voxel from its best visible orthographic view.
function projectViewColors(model,views) {
  const {width:w,length:l,layers:h,area,volume,normals,layerStep}=model;
  const [top,side,front,rear]=views;
  const topZ=new Int16Array(area).fill(-1);
  const frontY=new Int16Array(w*h).fill(-1), rearY=new Int16Array(w*h).fill(l);
  const rightX=new Int16Array(l*h).fill(-1), leftX=new Int16Array(l*h).fill(w);
  for(let z=0;z<h;z++) {
    const base=z*area;
    for(let y=0;y<l;y++) for(let x=0;x<w;x++) {
      const p=y*w+x;
      if(!volume[base+p]) continue;
      topZ[p]=z;
      const py=z*w+x,px=z*l+y;
      frontY[py]=Math.max(frontY[py],y);
      rearY[py]=Math.min(rearY[py],y);
      rightX[px]=x;
      leftX[px]=Math.min(leftX[px],x);
    }
  }
  const out=new Uint32Array(volume.length);
  const reach=Math.max(1.65,layerStep*1.3);
  for(let z=0;z<h;z++) {
    const imageRow=h-1-z,base=z*area;
    for(let y=0;y<l;y++) for(let x=0;x<w;x++) {
      const p=y*w+x,i=base+p;
      if(!volume[i])continue;
      const n=i*3,nx=normals[n]/127,ny=normals[n+1]/127,nz=normals[n+2]/127;
      const px=z*l+y,py=z*w+x;
      const tx=side[imageRow*l+l-1-y], ty=ny>=0?front[imageRow*w+x]:rear[imageRow*w+w-1-x];
      const tz=top[p];
      let wx=tx&&Math.abs((nx>=0?rightX[px]:leftX[px])-x)<=reach ? nx*nx : 0;
      let wy=ty&&Math.abs((ny>=0?frontY[py]:rearY[py])-y)<=reach ? ny*ny : 0;
      let wz=tz&&nz>0&&(topZ[p]-z)*layerStep<=reach ? nz*nz : 0;
      if(wx+wy+wz<.05) {
        const distanceX=Math.min(x-leftX[px],rightX[px]-x);
        const distanceY=Math.min(y-rearY[py],frontY[py]-y);
        const distanceZ=(topZ[p]-z)*layerStep;
        wx=tx?1/(1+distanceX*distanceX):0;
        wy=ty?1/(1+distanceY*distanceY):0;
        wz=tz?1/(1+distanceZ*distanceZ):0;
        if(wx+wy+wz<=0)continue;
      }
      const dominant=wx>=wy&&wx>=wz?tx:wy>=wz?ty:tz;
      // Preserve strong authored boundaries, such as glass next to painted metal.
      const colorDistance=(a,b)=>Math.max(Math.abs((a&255)-(b&255)),
        Math.abs((a>>>8&255)-(b>>>8&255)),Math.abs((a>>>16&255)-(b>>>16&255)));
      if(colorDistance(tx,dominant)>66)wx=0;
      if(colorDistance(ty,dominant)>66)wy=0;
      if(colorDistance(tz,dominant)>66)wz=0;
      const inverse=1/(wx+wy+wz);
      const r=Math.round(((tx&255)*wx+(ty&255)*wy+(tz&255)*wz)*inverse);
      const g=Math.round(((tx>>>8&255)*wx+(ty>>>8&255)*wy+(tz>>>8&255)*wz)*inverse);
      const b=Math.round(((tx>>>16&255)*wx+(ty>>>16&255)*wy+(tz>>>16&255)*wz)*inverse);
      out[i]=0xff000000|b<<16|g<<8|r;
    }
  }
  return {viewColors:out,sourceTop:top,sourceSide:side,sourceFront:front,sourceRear:rear,
    topZ,frontY,rearY,rightX,leftX};
}

const CORNERS=[[0,0,0],[1,0,0],[1,1,0],[0,1,0],[0,0,1],[1,0,1],[1,1,1],[0,1,1]];
const EDGES=[[0,1],[1,2],[2,3],[3,0],[4,5],[5,6],[6,7],[7,4],[0,4],[1,5],[2,6],[3,7]];

function marchingCubes(model,isWheel) {
  const {width:w,length:l,layers:h,area,layerStep,volume}=model;
  const depth=(h-1)*layerStep;
  const target=isWheel ? 32 : 68;
  const step=Math.max(1,Math.max(w,l,depth)/target);
  const bx=-step,by=-step,bz=-step;
  const nx=Math.ceil(w/step)+3,ny=Math.ceil(l/step)+3,nz=Math.ceil(depth/step)+3;
  const plane=nx*ny, count=plane*nz;
  const field=new Float32Array(count);
  function solid(x,y,z) {
    return x>=0&&x<w&&y>=0&&y<l&&z>=0&&z<h&&volume[z*area+y*w+x] ? 1 : 0;
  }
  function sample(x,y,z) {
    const qz=z/layerStep,a=Math.floor(x),b=Math.floor(y),c=Math.floor(qz);
    const tx=x-a,ty=y-b,tz=qz-c;
    let sum=0;
    for(let iz=0;iz<2;iz++) for(let iy=0;iy<2;iy++) for(let ix=0;ix<2;ix++){
      sum+=solid(a+ix,b+iy,c+iz)*(ix?tx:1-tx)*(iy?ty:1-ty)*(iz?tz:1-tz);
    }
    return sum;
  }
  for(let z=0;z<nz;z++) for(let y=0;y<ny;y++) for(let x=0;x<nx;x++) {
    const u=bx+x*step,v=by+y*step,t=bz+z*step,j=z*plane+y*nx+x;
    const k=step*.27;
    field[j]=.7*sample(u,v,t)+.05*(sample(u-k,v,t)+sample(u+k,v,t)+sample(u,v-k,t)+sample(u,v+k,t)+sample(u,v,t-k)+sample(u,v,t+k));
  }
  const edgeIndices=new Int32Array(count*3).fill(-1);
  const xyz=[], normal=[], indices=[];
  const cornerIndex=[0,1,1+nx,nx,plane,plane+1,plane+nx+1,plane+nx];
  const diff=(i,axis)=> (field[i-axis]??0)-(field[i+axis]??0);
  function vertex(x,y,z,base,edge) {
    const [a,b]=EDGES[edge], A=CORNERS[a],B=CORNERS[b];
    const sa=base+cornerIndex[a],sb=base+cornerIndex[b];
    const axis=A[0]!==B[0]?0:A[1]!==B[1]?1:2;
    const cacheIndex=Math.min(sa,sb)*3+axis;
    if(edgeIndices[cacheIndex]>=0)return edgeIndices[cacheIndex];
    const t=(.5-field[sa])/(field[sb]-field[sa]);
    const id=xyz.length/3;
    xyz.push(bx+(x+A[0]+(B[0]-A[0])*t)*step,
      by+(y+A[1]+(B[1]-A[1])*t)*step,
      bz+(z+A[2]+(B[2]-A[2])*t)*step);
    const gx=diff(sa,1)*(1-t)+diff(sb,1)*t;
    const gy=diff(sa,nx)*(1-t)+diff(sb,nx)*t;
    const gz=diff(sa,plane)*(1-t)+diff(sb,plane)*t;
    const d=Math.hypot(gx,gy,gz)||1;
    normal.push(Math.round(gx*127/d),Math.round(gy*127/d),Math.round(gz*127/d));
    edgeIndices[cacheIndex]=id;
    return id;
  }
  for(let z=0;z<nz-1;z++) for(let y=0;y<ny-1;y++) for(let x=0;x<nx-1;x++){
    const base=z*plane+y*nx+x;
    let group=0;
    for(let c=0;c<8;c++) if(field[base+cornerIndex[c]]<.5)group|=1<<c;
    let row=group*16;
    while(MC_TRIANGLES[row]>=0){
      indices.push(vertex(x,y,z,base,MC_TRIANGLES[row++]));
    }
  }
  return {meshXYZ:Float32Array.from(xyz),meshNormals:Int8Array.from(normal),meshIndices:Uint32Array.from(indices)};
}
async function readAntPart(part) {
  const {w,h,n,source}=part;
  const bitmap=await createImageBitmap(unpackDataUrl(source));
  if(bitmap.width!==w*n||bitmap.height!==h){
    bitmap.close();
    throw new Error("개미 메카 슬라이스 치수가 예상값과 다릅니다.");
  }
  const canvas=new OffscreenCanvas(bitmap.width,bitmap.height);
  const ctx=canvas.getContext("2d",{willReadFrequently:true});
  ctx.drawImage(bitmap,0,0);
  bitmap.close();
  const pixels=new Uint32Array(ctx.getImageData(0,0,canvas.width,h).data.buffer);
  const volume=new Uint32Array(w*h*n);
  for(let z=0;z<n;z++) for(let y=0;y<h;y++){
    const src=y*w*n+z*w,dst=z*w*h+y*w;
    for(let x=0;x<w;x++){
      const color=pixels[src+x];
      if((color>>>24)>=128)volume[dst+x]=color|0xff000000;
    }
  }
  return {w,h,n,volume};
}

function sampleAxis(size,sourceSize,centers){
  const low=new Uint16Array(size),high=new Uint16Array(size);
  const weight=new Float32Array(size);
  for(let i=0;i<size;i++){
    const raw=centers?(i+.5)*sourceSize/size-.5:i*(sourceSize-1)/(size-1);
    const p=Math.max(0,Math.min(sourceSize-1,raw));
    low[i]=Math.floor(p);high[i]=Math.min(sourceSize-1,low[i]+1);weight[i]=p-low[i];
  }
  return {low,high,weight};
}

function resampleAntVolume(source,w,h,n){
  const {w:ow,h:oh,n:on,volume:original}=source;
  if(w===ow&&h===oh&&n===on)return original.slice();
  const volume=new Uint32Array(w*h*n);
  const ax=sampleAxis(w,ow,true),ay=sampleAxis(h,oh,true),az=sampleAxis(n,on,false);
  const originalArea=ow*oh;
  for(let z=0;z<n;z++) for(let y=0;y<h;y++) for(let x=0;x<w;x++){
    let alpha=0,r=0,g=0,b=0;
    for(let iz=0;iz<2;iz++){
      const wz=iz?az.weight[z]:1-az.weight[z];
      if(wz<=0)continue;
      const layer=(iz?az.high[z]:az.low[z])*originalArea;
      for(let iy=0;iy<2;iy++){
        const wy=iy?ay.weight[y]:1-ay.weight[y];
        if(wy<=0)continue;
        const base=layer+(iy?ay.high[y]:ay.low[y])*ow;
        for(let ix=0;ix<2;ix++){
          const wx=ix?ax.weight[x]:1-ax.weight[x];
          if(wx<=0)continue;
          const color=original[base+(ix?ax.high[x]:ax.low[x])];
          if(!color)continue;
          const weight=wz*wy*wx;
          alpha+=weight;
          r+=(color&255)*weight;g+=(color>>>8&255)*weight;b+=(color>>>16&255)*weight;
        }
      }
    }
    if(alpha>=.48)volume[(z*h+y)*w+x]=0xff000000|
      Math.round(b/alpha)<<16|Math.round(g/alpha)<<8|Math.round(r/alpha);
  }
  return volume;
}

function prepareAntPart(original,n,textureRatio){
  const w=Math.round(original.w*textureRatio),h=Math.round(original.h*textureRatio);
  const volume=resampleAntVolume(original,w,h,n);
  const top=new Uint32Array(w*h),side=new Uint32Array(n*h);
  const front=new Uint32Array(n*w),rear=new Uint32Array(n*w);
  for(let z=0;z<n;z++) for(let y=0;y<h;y++){
    const base=z*w*h+y*w,row=n-1-z;
    for(let x=0;x<w;x++){
      const color=volume[base+x];
      if(!color)continue;
      top[y*w+x]=color;
      side[row*h+h-1-y]=color;
      front[row*w+x]=color;
      const rearIndex=row*w+w-1-x;
      if(!rear[rearIndex])rear[rearIndex]=color;
    }
  }
  return modelData({volume,views:[top,side,front,rear]},w,h,n,textureRatio,false,
    original.n-1);
}

async function importAnt(layers,textureRatio){
  plates.decoded??=Promise.all([plates.parts.body,plates.parts.center,plates.parts.angled].map(readAntPart));
  const [originalBody,originalCenter,originalAngled]=await plates.decoded;
  const legLayers=part=>1+Math.round((part.n-1)*(layers-1)/(originalBody.n-1));
  const body=prepareAntPart(originalBody,layers,textureRatio);
  const center=prepareAntPart(originalCenter,legLayers(originalCenter),textureRatio);
  const angled=prepareAntPart(originalAngled,legLayers(originalAngled),textureRatio);
  return {ratio:.72*textureRatio,textureRatio,layers,body,center,angled,wheel:null,custom:false,ant:true,profile:activeProfile};
}
