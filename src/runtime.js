"use strict";
const ART_PIXELS_PER_UNIT = 2;
const TAU = Math.PI * 2;
const DEFAULT_VIEW = {spacing:1, squash:.75, scale:.5};
const view = {...DEFAULT_VIEW};
const viewSliders = Object.keys(view).map(key=>{
  const input = document.getElementById(key);
  const output = document.getElementById(key+"Value");
  function sync() {
    view[key] = input.valueAsNumber;
    const suffix = key === "scale" ? "×" : "";
    output.value = view[key].toFixed(2)+suffix;
    input.setAttribute("aria-valuetext",output.value);
  }
  input.addEventListener("input",sync);
  sync();
  return {key,input,sync};
});
const environmentView={propSpacing:1,floorBrightness:1};
const mobilitySpacing=new Map();
const environmentSliders=Object.keys(environmentView).map(key=>{
  const input=document.getElementById(key),output=document.getElementById(key+"Value");
  function sync(){
    const value=input.valueAsNumber;
    environmentView[key]=value;
    output.value=key==="floorBrightness"?Math.round(value*100)+"%":value.toFixed(2);
    input.setAttribute("aria-valuetext",output.value);
  }
  input.addEventListener("input",sync);
  sync();
  return {input,sync};
});

document.getElementById("resetEnvironment").addEventListener("click",()=>{
  for(const {input,sync} of environmentSliders){input.value=1;sync();}
  for(const slider of viewSliders)if(slider.key!=="spacing"){
    slider.input.value=DEFAULT_VIEW[slider.key];
    slider.sync();
  }
});

const tintedFloor=document.createElement("canvas");
let lastBrightness=null;
function currentFloor(){
  if(environmentView.floorBrightness===1)return floorCanvas;
  if(lastBrightness!==environmentView.floorBrightness){
    tintedFloor.width=floorCanvas.width;tintedFloor.height=floorCanvas.height;
    const ctx=tintedFloor.getContext("2d");
    ctx.filter="brightness("+environmentView.floorBrightness+")";
    ctx.drawImage(floorCanvas,0,0);
    lastBrightness=environmentView.floorBrightness;
  }
  return tintedFloor;
}

document.getElementById("resetView").addEventListener("click",()=>{
  resetMobilityTuning();
  const spacing=viewSliders.find(slider=>slider.key==="spacing");
  spacing.input.value=DEFAULT_VIEW.spacing;
  spacing.sync();
  layerSlider.value=selectedAsset.parts?.body.n??DEFAULT_LAYERS;
  textureSlider.value=selectedAsset.parts?1:DEFAULT_TEXTURE_SCALE;
  syncResolutionLabels();
  commitLayerCount();
});
let PIVOT_X = 146;
let BUFFER = 0, BUFFER_HEIGHT = 0, PIVOT_Y = 0;
const KEY = {x:-.48, y:-.34, z:.68};
const HALF_LIGHT = Math.hypot(KEY.x,KEY.y,KEY.z+1);
let BODY_CLEARANCE = 13;
let FRONT_AXLE = 48.5, REAR_AXLE = -56.5;
let WHEEL_DIAMETER = 44;
let TIRE_RADIUS = WHEEL_DIAMETER/(2*ART_PIXELS_PER_UNIT);
let WHEELBASE = (FRONT_AXLE-REAR_AXLE)/ART_PIXELS_PER_UNIT;
let HALF_TRACK = 36.5/ART_PIXELS_PER_UNIT, CENTER_TO_REAR = -REAR_AXLE/ART_PIXELS_PER_UNIT;
const wheelMounts = [
  {index:0,side:-1,front:true}, {index:1,side:1,front:true},
  {index:2,side:-1,front:false},{index:3,side:1,front:false},
];
const YARD_X = 700, YARD_Y = 465;
const TRACK_X = 385, TRACK_Y = 250;
const canvas = document.getElementById("yard");
const ctx = canvas.getContext("2d");
const sampleCanvas=document.createElement("canvas");
const sampleCtx=sampleCanvas.getContext("2d");
const supersampleButton=document.getElementById("supersample");
const frameMeter=createFrameMeter();
const frameFps=document.getElementById("frameFps");
const frameTime=document.getElementById("frameTime");
const renderTime=document.getElementById("renderTime");

function resetFrameMeter(){
  frameMeter.reset();
  frameFps.value="—";
  frameTime.value="— ms";
  renderTime.value="— ms";
}

function sampleFrameMeter(now,renderMs){
  if(document.hidden||!activeStack)return;
  const sample=frameMeter.sample(now,renderMs);
  if(!sample)return;
  frameFps.value=sample.fps.toFixed(0);
  frameTime.value=sample.frameMs.toFixed(1)+" ms";
  renderTime.value=sample.renderMs.toFixed(1)+" ms";
}

let supersampling=true;
function syncSampling() {
  supersampleButton.setAttribute("aria-pressed",String(supersampling));
  canvas.style.imageRendering=supersampling ? "auto" : "pixelated";
}
supersampleButton.addEventListener("click",()=>{
  supersampling=!supersampling;
  syncSampling();
  resetFrameMeter();
});
syncSampling();
const spriteCanvas = document.createElement("canvas");
const spriteCtx = spriteCanvas.getContext("2d");
let rollMap;
let sprite, spritePixels, bodyMask, projectedCells, depth, castMask, contactMask;
let spriteTop = 0, spriteBottom = 0;

function sizeSpriteBuffer() {
  const topArt = Math.max(tankBufferTop(),(chassis.layers-1)*chassis.layerStep+(activeStack.ant?31*activeStack.textureRatio:BODY_CLEARANCE*activeStack.ratio),
    tire?(tire.layers-1)*tire.layerStep:0);
  const lift = Math.ceil(topArt*view.spacing);
  const radius = Math.ceil(Math.max(tankBufferRadius(),activeStack.ant?91*activeStack.textureRatio:0,Math.hypot(chassis.width,chassis.length)/2,
    tire?Math.hypot(REAR_AXLE,HALF_TRACK*ART_PIXELS_PER_UNIT)*activeStack.ratio+
      Math.hypot(tire.width,tire.length)/2:0))+4;
  const pivotX = radius+8;
  const halfFootprint = Math.ceil(radius*view.squash);
  const pivotY = lift+halfFootprint+12;
  const height = pivotY+halfFootprint+Math.ceil(lift*view.squash*-KEY.y/KEY.z)+14;
  const width = pivotX+Math.ceil(lift*-KEY.x/KEY.z)+radius+14;
  if (height===BUFFER_HEIGHT && width===BUFFER && pivotX===PIVOT_X && pivotY===PIVOT_Y) return;
  BUFFER=width; BUFFER_HEIGHT=height; PIVOT_Y=pivotY; PIVOT_X=pivotX;
  spriteCanvas.width = width; spriteCanvas.height = height;
  sprite = spriteCtx.createImageData(width,height);
  spritePixels = new Uint32Array(sprite.data.buffer);
  bodyMask = new Uint8Array(spritePixels.length);
  projectedCells = new Int32Array((2*radius+1)*width);
  depth = new Float32Array(spritePixels.length);
  castMask = new Uint8Array(spritePixels.length);
  contactMask = new Uint8Array(spritePixels.length);
}
const patrolButton = document.getElementById("patrol");
const manualButton = document.getElementById("manual");
const status = document.getElementById("status");
const speed = document.getElementById("speed");
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");
const robot = {
  x: 0, y: 0, heading: 0, velocity: 0, omega: 0, steering: 0, wheelRoll:new Float64Array(4),
  mode: reduceMotion.matches ? "manual" : "patrol",
};
const camera = {x: 0, y: 0};
const heldKeys = new Set();
const heldTouches = new Map();
const touchButtons = [...document.querySelectorAll("[data-key]")];
const bindings = {KeyQ:"turnLeft",KeyE:"turnRight",KeyW:"forward",ArrowUp:"forward",KeyS:"reverse",ArrowDown:"reverse",KeyA:"left",ArrowLeft:"left",KeyD:"right",ArrowRight:"right"};
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const wrap = angle => ((angle + Math.PI) % TAU + TAU) % TAU - Math.PI;
const pack = (r, g, b, a = 255) => (a << 24) | (b << 16) | (g << 8) | r;
let chassis, tire;
let lastAngle = null, lastSteering = null, lastSpacing = null, lastSquash = null;
const lastRoll = new Float64Array(4);
let materialLight = true;
let lastMaterialLight = null;
let detailNormal = true, lastDetailNormal = null;
const detailNormalButton = document.getElementById("detailNormal");
detailNormalButton.addEventListener("click",()=>{
  detailNormal = !detailNormal;
  detailNormalButton.setAttribute("aria-pressed",String(detailNormal));
});
const materialLightButton = document.getElementById("materialLight");
materialLightButton.addEventListener("click",()=>{
  materialLight = !materialLight;
  materialLightButton.setAttribute("aria-pressed",String(materialLight));
});
let size = {width:0, height:0, scale:1, density:1};

// The 4-view atlas provides the color. Use the stack's normals and material
// regions to approximate a roughness/metallic response without extra textures.
const MATERIALS = [
  {roughness:.55, metal:.08, reflectance:.045}, // powder-coated chassis
  {roughness:.35, metal:.62, reflectance:.04},  // exposed machined alloy
  {roughness:.86, metal:0, reflectance:.028},  // tire rubber
  {roughness:.42, metal:.48, reflectance:.04}, // wheel hub
  {roughness:.21, metal:0, reflectance:.075},  // lens
  {roughness:.72, metal:0, reflectance:.035},  // recessed polymer
  {roughness:.53, metal:.03, reflectance:.04}, // safety paint
  {roughness:.33, metal:.07, reflectance:.052}, // cobalt enamel
];
const LIGHT_UNIT = Math.hypot(KEY.x, KEY.y, KEY.z);
const LINEAR = Float32Array.from({length:256}, (_,i) => {
  const channel = i/255;
  return channel <= .04045 ? channel/12.92 : ((channel+.055)/1.055)**2.4;
});
const ENCODED = Uint8Array.from({length:1025}, (_,i) => {
  const channel = i/1024;
  return Math.round(255*(channel <= .0031308 ? 12.92*channel : 1.055*channel**(1/2.4)-.055));
});
function partLighting(c, s, rc, rs, mirror) {
  // Transform world-space light, view and the reflected-environment axes into atlas space.
  const offset = mirror ? -1 : 1;
  const pitch = view.squash;
  const horizontal = Math.sqrt(1-pitch*pitch);
  function local(x,y,z) {
    const sy = -x*s+y*c;
    return [offset*(x*c+y*s)/127,(sy*rc-z*rs)/127,(sy*rs+z*rc)/127];
  }
  const halfLength = Math.hypot(KEY.x/LIGHT_UNIT,KEY.y/LIGHT_UNIT+horizontal,KEY.z/LIGHT_UNIT+pitch);
  return {
    light:local(KEY.x/LIGHT_UNIT,KEY.y/LIGHT_UNIT,KEY.z/LIGHT_UNIT),
    eye:local(0,horizontal,pitch),
    half:local(KEY.x/LIGHT_UNIT/halfLength,(KEY.y/LIGHT_UNIT+horizontal)/halfLength,(KEY.z/LIGHT_UNIT+pitch)/halfLength),
    up:local(0,0,1),
    panel:local(-.68,.14,.72),
    eyeUp:pitch,
    eyePanel:.14*horizontal+.72*pitch,
  };
}

function materialPixel(color, material, ambient, nx, ny, nz, lighting, normalVariance=0) {
  const {roughness,metal,reflectance} = MATERIALS[material];
  const {light,eye,half,up,panel,eyeUp,eyePanel} = lighting;
  const nl = Math.max(0,nx*light[0]+ny*light[1]+nz*light[2]);
  const nv = clamp(nx*eye[0]+ny*eye[1]+nz*eye[2],0,1);
  const nh = clamp(nx*half[0]+ny*half[1]+nz*half[2],0,1);
  const normalUp = nx*up[0]+ny*up[1]+nz*up[2];
  const upwardReflection = clamp((2*nv*normalUp-eyeUp+1)*.5,0,1);
  const panelDot = clamp(2*nv*(nx*panel[0]+ny*panel[1]+nz*panel[2])-eyePanel,0,1);
  const edge = 1-nv, edge2 = edge*edge;
  const fresnel = edge2*edge2*edge*(.41-.31*roughness);

  // A GGX-shaped highlight, capped so single art pixels don't flare during rotation.
  const highlight = ggxHighlight(roughness,nh,normalVariance)*nl;
  const ambientDiffuse = (.73+.16*normalUp)*ambient;
  const diffuse = (ambientDiffuse+.63*nl)*(1-metal*.73);
  const panelLobe = panelDot*panelDot;
  const environment = (.12+.37*upwardReflection+.77*panelLobe*panelLobe*(1-roughness))*ambient;
  const reflection = highlight+environment;
  const dielectric = reflectance*(1-metal);
  const baseR = LINEAR[color&255], baseG = LINEAR[(color>>>8)&255], baseB = LINEAR[(color>>>16)&255];
  const specR = (dielectric+metal*baseR)*(1-fresnel)+fresnel;
  const specG = (dielectric+metal*baseG)*(1-fresnel)+fresnel;
  const specB = (dielectric+metal*baseB)*(1-fresnel)+fresnel;
  const warm = .92+.08*nl;
  const red = baseR*diffuse+specR*reflection*warm;
  const green = baseG*diffuse+specG*reflection;
  const blue = baseB*diffuse+specB*reflection*(1.08-.10*nl);
  const peak = Math.max(red,green,blue);
  const excess = Math.max(0,peak-.78);
  const shoulder = excess ? (.78+.22*excess/(excess+.22))/peak : 1;
  return pack(ENCODED[Math.round(red*shoulder*1024)], ENCODED[Math.round(green*shoulder*1024)],
    ENCODED[Math.round(blue*shoulder*1024)]);
}

function wheelSteer(side, steering) {
  const tangent = Math.tan(steering);
  return Math.atan(tangent/(1+side*HALF_TRACK/WHEELBASE*tangent));
}

function poseParts(heading) {
  if(isTank())return tankParts(heading);
  if(activeStack.ant)return antPoseParts(heading);
  const yaw = heading-Math.PI/2;
  const c = Math.cos(yaw), s = Math.sin(yaw);
  const parts = [{model:chassis,x:PIVOT_X,y:PIVOT_Y,z:BODY_CLEARANCE*activeStack.ratio,yaw,roll:null}];
  if(!tire)return parts;
  for (const mount of wheelMounts) {
    const ux = mount.side*HALF_TRACK*ART_PIXELS_PER_UNIT*activeStack.ratio;
    const uy = (mount.front ? FRONT_AXLE : REAR_AXLE)*activeStack.ratio;
    const steer = mount.front ? wheelSteer(mount.side,robot.steering) : 0;
    parts.push({
      model:tire,x:PIVOT_X+ux*c-uy*s,y:PIVOT_Y+(ux*s+uy*c)*view.squash,z:0,
      yaw:yaw+steer,roll:robot.wheelRoll[mount.index], mirror:mount.side < 0,
    });
  }
  return parts;
}

function makeRollMap(model, angle) {
  const {length,layers,area,width} = model;
  const centerY = (length-1)*.5, centerZ = (layers-1)*.5;
  const c = Math.cos(angle), s = Math.sin(angle);
  for (let z = 0; z < layers; z++) {
    const dz = z-centerZ;
    for (let y = 0; y < length; y++) {
      const dy = y-centerY;
      const sy = Math.round(centerY+c*dy-s*dz*model.layerStep);
      const sz = Math.round(centerZ+s*dy/model.layerStep+c*dz);
      rollMap[z*length+y] = sy>=0 && sy<length && sz>=0 && sz<layers ? sz*area+sy*width : -1;
    }
  }
}

function drawPart(part) {
  const {model,x:cx,y:cy,z:baseZ,yaw,roll,mirror} = part;
  const {width,length,layers,area,volume,bounds,material,ambient} = model;
  const normals = detailNormal ? model.detailedNormals : model.normals;
  const isWheel = roll !== null;
  const xCenter=part.pivotX??(width-1)*.5, yCenter=part.pivotY??(length-1)*.5;
  const flipX=!!mirror&&!isWheel, flipY=!!part.flipY;
  const strideX=part.flexX??0, strideY=part.flexY??0;
  const layerStep=model.layerStep*(part.heightScale??1);
  const spacing=part.spacing??view.spacing;
  const c = Math.cos(yaw), s = Math.sin(yaw);
  const lightX = (KEY.x*c+KEY.y*s)/127;
  const worldY = (-KEY.x*s+KEY.y*c)/127, worldZ = KEY.z/127;
  const rc = Math.cos(roll ?? 0), rs = Math.sin(roll ?? 0);
  const lightY = worldY*rc-worldZ*rs, lightZ = worldY*rs+worldZ*rc;
  const halfY = worldY/HALF_LIGHT, halfX = lightX/HALF_LIGHT;
  const halfZ = (KEY.z+1)/(127*HALF_LIGHT);
  const lighting = materialLight ? partLighting(c,s,rc,rs,mirror) : null;
  if (isWheel) makeRollMap(model,roll);

  // A single inverse plane supplies coordinates to every layer of this part.
  const yBase = Math.floor(cy);
  const farX=Math.max(xCenter,width-1-xCenter)+.5,farY=Math.max(yCenter,length-1-yCenter)+.5;
  const extent=Math.hypot(farX,farY);
  const maxDy=Math.ceil(extent*view.squash)+2, maxDx=Math.ceil(extent)+2;
  const left = Math.max(1,Math.floor(cx-maxDx)), right = Math.min(BUFFER-2,Math.ceil(cx+maxDx));
  for (let row = -maxDy; row <= maxDy; row++) {
    const dy = (yBase+row-cy)/view.squash, dx = left-cx;
    let sx = c*dx+s*dy+xCenter, sy = -s*dx+c*dy+yCenter;
    let cell = (row+maxDy)*BUFFER+left;
    for (let px = left; px <= right; px++,cell++,sx+=c,sy-=s) {
      const ix=Math.round(flipX?2*xCenter-sx:sx), iy=Math.round(flipY?2*yCenter-sy:sy);
      projectedCells[cell] = ix>=0 && ix<width && iy>=0 && iy<length ? iy*width+ix : -1;
    }
  }
  for (let z = layers-1; z >= 0; z--) {
    const v = isWheel ? null : bounds[z];
    const fromX=(v?.left??0)-xCenter-.5,toX=(v?.right??width-1)-xCenter+.5;
    const fromY=(v?.top??0)-yCenter-.5,toY=(v?.bottom??length-1)-yCenter+.5;
    const x0=flipX?-toX:fromX,x1=flipX?-fromX:toX;
    const y0=flipY?-toY:fromY,y1=flipY?-fromY:toY;
    const flex=1-z/(layers-1);
    const shiftX=Math.round(strideX*flex),shiftY=Math.round(strideY*flex);
    const minX=Math.max(1,shiftX+Math.max(left,Math.floor(cx+Math.min(x0*c,x1*c)+Math.min(-y0*s,-y1*s))));
    const maxX=Math.min(BUFFER-2,shiftX+Math.min(right,Math.ceil(cx+Math.max(x0*c,x1*c)+Math.max(-y0*s,-y1*s))));
    const level=z*layerStep+baseZ;
    const lift = Math.round(level*spacing);
    // At higher XY densities a physical slice covers multiple raster rows.
    // Keep the added gaps when the Spacing control exceeds the default.
    const separation=lift-Math.round((level-layerStep)*spacing);
    const thickness=Math.max(1,Math.min(Math.ceil(layerStep),separation,
      lift-Math.round(baseZ*spacing)+1));
    const lineZero = yBase-lift+shiftY;
    const minY = Math.max(1,lineZero-maxDy,Math.floor(cy-lift+shiftY+(Math.min(x0*s,x1*s)+Math.min(y0*c,y1*c))*view.squash));
    const maxY = Math.min(BUFFER_HEIGHT-2,lineZero+maxDy,Math.ceil(cy-lift+shiftY+(Math.max(x0*s,x1*s)+Math.max(y0*c,y1*c))*view.squash));
    for (let py = minY; py <= maxY; py++) {
      let cell = (py-lineZero+maxDy)*BUFFER+minX-shiftX;
      let pxOut = py*BUFFER+minX;
      const rows=Math.min(thickness,BUFFER_HEIGHT-1-py);
      for (let px = minX; px <= maxX; px++,cell++,pxOut++) {
        let first=0;
        while(first<rows && depth[pxOut+first*BUFFER]>=level) first++;
        if(first===rows) continue;
        const position = projectedCells[cell];
        if (position < 0) continue;
        let voxel = z*area+position;
        if (isWheel) {
          const row = rollMap[z*length+Math.floor(position/width)];
          if (row < 0) continue;
          const ix = position%width;
          voxel = row+(mirror ? width-1-ix : ix);
        }
        const originalColor = volume[voxel];
        if (!originalColor) continue;
        const baseColor=(multiViewEnabled && model.viewColors[voxel])||originalColor;
        const color=part.trackShift===undefined?baseColor:trackBeltColor(model,position%width,Math.floor(position/width),z*layerStep,part.trackShift,baseColor);
        const n = voxel*3;
        const nx = normals[n], ny = (flipY?-1:1)*normals[n+1], nz = normals[n+2];
        let shaded;
        if (lighting && (nx || ny || nz)) {
          const well = isWheel && z>layers*.56 && voxel%width<width*.45 ? .78 : 1;
          shaded = materialPixel(color,material[voxel],(ambient[voxel]||255)/255*well,nx,ny,nz,lighting,specularSpread(model,voxel));
        } else {
          const signedX = mirror ? -nx : nx;
          const light = signedX*lightX+ny*lightY+nz*lightZ;
          const gain = isWheel ? 1.02+.24*light : .89+.32*light;
          const glint = isWheel ? 0 : 20*Math.max(0,(signedX*halfX+ny*halfY+nz*halfZ-.79)/.21);
          shaded = pack(
            Math.min(255,(color&255)*gain+glint),
            Math.min(255,((color>>>8)&255)*gain+glint*.94),
            Math.min(255,((color>>>16)&255)*gain+glint*.81)
          );
        }
        for(let row=first;row<rows;row++){
          const index=pxOut+row*BUFFER;
          if(depth[index]>=level) continue;
          spritePixels[index]=shaded;
          depth[index]=level;
          bodyMask[index]=1;
        }
      }
    }
  }
}

function drawGroundShadow(parts) {
  castMask.fill(0);
  contactMask.fill(0);
  for (const part of parts) {
    const {model,x:cx,y:cy,z:baseZ,yaw}=part;
    const c = Math.cos(yaw), s = Math.sin(yaw);
    const centerX=part.pivotX??(model.width-1)*.5, centerY=part.pivotY??(model.length-1)*.5;
    const mx=part.mirror?-1:1,my=part.flipY?-1:1;
    const points = model.shadow;
    for (let i = 0; i < points.length; i += 3) {
      const x=(points[i]-centerX)*mx,y=(points[i+1]-centerY)*my;
      const z=(points[i+2]*model.layerStep*(part.heightScale??1)+baseZ)*view.spacing;
      const blend=1-points[i+2]/(model.layers-1);
      const px=Math.round(cx+x*c-y*s-z*KEY.x/KEY.z+(part.flexX??0)*blend);
      const py=Math.round(cy+(x*s+y*c-z*KEY.y/KEY.z)*view.squash+(part.flexY??0)*blend);
      const stride=model.shadowStride;
      if (px<1 || px>=BUFFER-stride || py<1 || py>=BUFFER_HEIGHT-stride) continue;
      for(let row=0;row<stride;row++){
        const index=(py+row)*BUFFER+px;
        castMask.fill(1,index,index+stride);
      }
    }
    if (baseZ !== 0) continue;
    for (let i = 0; i < model.contact.length; i += 2) {
      const x=(model.contact[i]-centerX)*mx,y=(model.contact[i+1]-centerY)*my;
      const px=Math.round(cx+x*c-y*s+(part.flexX??0)),py=Math.round(cy+(x*s+y*c)*view.squash+(part.flexY??0)+2);
      contactMask[py*BUFFER+px] = 1;
    }
  }
  for (let i = BUFFER+1; i < castMask.length-BUFFER-1; i++) {
    if (contactMask[i]) {
      spritePixels[i] = pack(12,15,13,168);
      continue;
    }
    const nearby = castMask[i-1]+castMask[i+1]+castMask[i-BUFFER]+castMask[i+BUFFER];
    if (castMask[i] || nearby >= 3) spritePixels[i] = pack(14,18,16,105);
    else if (nearby) spritePixels[i] = pack(14,18,16,42);
  }
}

let meshProjection=new Float32Array(0);
const MESH_INSETS=[.55,1.6,3.15,5];
const COLOR_BOUNDARY=66;
function colorsClose(a,b) {
  return Math.abs((a&255)-(b&255))<COLOR_BOUNDARY &&
    Math.abs((a>>>8&255)-(b>>>8&255))<COLOR_BOUNDARY &&
    Math.abs((a>>>16&255)-(b>>>16&255))<COLOR_BOUNDARY;
}

function meshTextureVoxel(model,x,y,z,nx,ny,nz) {
  const {width:w,length:l,layers:h,area,volume,layerStep}=model;
  for(const inset of MESH_INSETS){
    const vx=Math.round(x-nx*inset/127), vy=Math.round(y-ny*inset/127);
    const vz=Math.round((z-nz*inset/127)/layerStep);
    if(vx<0||vx>=w||vy<0||vy>=l||vz<0||vz>=h)continue;
    const index=vz*area+vy*w+vx;
    if(volume[index])return index;
  }
  const centerX=Math.round(x),centerY=Math.round(y),centerZ=Math.round(z/layerStep);
  for(let dz=-1;dz<=1;dz++) for(let dy=-1;dy<=1;dy++) for(let dx=-1;dx<=1;dx++){
    const cx=centerX+dx,cy=centerY+dy,cz=centerZ+dz;
    if(cx>=0&&cx<w&&cy>=0&&cy<l&&cz>=0&&cz<h&&volume[cz*area+cy*w+cx])return cz*area+cy*w+cx;
  }
  return -1;
}

function samplePlane(pixels,width,height,x,y) {
  x=clamp(x,0,width-1);y=clamp(y,0,height-1);
  const x0=Math.floor(x),y0=Math.floor(y);
  const x1=Math.min(width-1,x0+1),y1=Math.min(height-1,y0+1);
  const tx=x-x0,ty=y-y0;
  const a=pixels[y0*width+x0],b=pixels[y0*width+x1],c=pixels[y1*width+x0],d=pixels[y1*width+x1];
  const wa=a?(1-tx)*(1-ty):0,wb=b?tx*(1-ty):0,wc=c?(1-tx)*ty:0,wd=d?tx*ty:0;
  const weight=wa+wb+wc+wd;
  if(weight<.22)return 0;
  return pack(
    ((a&255)*wa+(b&255)*wb+(c&255)*wc+(d&255)*wd)/weight,
    ((a>>>8&255)*wa+(b>>>8&255)*wb+(c>>>8&255)*wc+(d>>>8&255)*wd)/weight,
    ((a>>>16&255)*wa+(b>>>16&255)*wb+(c>>>16&255)*wc+(d>>>16&255)*wd)/weight);
}

function projectMeshColor(model,x,y,z,nx,ny,nz) {
  const {width:w,length:l,layers:h,layerStep}=model;
  const iz=clamp(Math.round(z/layerStep),0,h-1), ix=clamp(Math.round(x),0,w-1), iy=clamp(Math.round(y),0,l-1);
  const row=h-1-z/layerStep;
  const py=iz*w+ix,px=iz*l+iy;
  const distanceX=Math.abs(x-(nx<0?model.leftX[px]:model.rightX[px]));
  const distanceY=Math.abs(y-(ny<0?model.rearY[py]:model.frontY[py]));
  const distanceZ=Math.abs(z-model.topZ[iy*w+ix]*layerStep);
  const allowance=Math.max(2.5,Math.max(w,l)/30);
  const front=ny>=0;
  let wx=nx*nx,wy=ny*ny,wz=nz>0?nz*nz:0;
  const minimum=Math.max(wx,wy,wz)*.045;
  const xColor=wx>minimum?samplePlane(model.sourceSide,l,h,l-1-y,row):0;
  const yColor=wy>minimum?samplePlane(front?model.sourceFront:model.sourceRear,w,h,front?x:w-1-x,row):0;
  const zColor=wz>minimum?samplePlane(model.sourceTop,w,l,x,y):0;
  if(!xColor)wx=0;
  if(!yColor)wy=0;
  if(!zColor)wz=0;
  if(multiViewEnabled){
    wx*=Math.max(.01,1-(distanceX/allowance)**2);
    wy*=Math.max(.01,1-(distanceY/allowance)**2);
    wz*=Math.max(.01,1-(distanceZ/allowance)**2);
  }
  const best=wx>=wy&&wx>=wz?xColor:wy>=wz?yColor:zColor;
  if(!multiViewEnabled||!best)return best;
  if(!colorsClose(xColor,best))wx=0;
  if(!colorsClose(yColor,best))wy=0;
  if(!colorsClose(zColor,best))wz=0;
  const scale=1/(wx+wy+wz);
  return pack(
    ((xColor&255)*wx+(yColor&255)*wy+(zColor&255)*wz)*scale,
    ((xColor>>>8&255)*wx+(yColor>>>8&255)*wy+(zColor>>>8&255)*wz)*scale,
    ((xColor>>>16&255)*wx+(yColor>>>16&255)*wy+(zColor>>>16&255)*wz)*scale);
}

function drawMesh(part) {
  const {model,x:cx,y:cy,z:baseZ,yaw,roll,mirror}=part;
  const {meshXYZ:xyz,meshIndices:triangles,meshNormals:normals}=model;
  if(meshProjection.length<xyz.length)meshProjection=new Float32Array(xyz.length);
  const screen=meshProjection;
  const pitch=view.squash,spacing=part.spacing??view.spacing;
  const xCenter=part.pivotX??(model.width-1)/2, yCenter=part.pivotY??(model.length-1)/2;
  const zCenter=(model.layers-1)*model.layerStep/2;
  const flipY=part.flipY?-1:1,heightScale=part.heightScale??1;
  const side=mirror?-1:1,c=Math.cos(yaw),s=Math.sin(yaw),rc=Math.cos(roll??0),rs=Math.sin(roll??0);
  const light=partLighting(c,s,rc,rs,mirror);
  const spinCos=Math.cos(part.twist??0),spinSin=Math.sin(part.twist??0);
  if(part.twist){
    for(const ray of [light.light,light.eye,light.half,light.up,light.panel]){
      const x=ray[0],y=ray[1];
      ray[0]=x*spinCos+y*spinSin;ray[1]=-x*spinSin+y*spinCos;
    }
  }
  for(let i=0;i<xyz.length;i+=3) {
    const ux=xyz[i]-xCenter,uy=xyz[i+1]-yCenter;
    const x=(ux*spinCos-uy*spinSin)*side,y=(ux*spinSin+uy*spinCos)*flipY,z=xyz[i+2]-zCenter;
    const rotatedY=y*rc+z*rs,rotatedZ=(-y*rs+z*rc+zCenter)*heightScale+baseZ;
    const blend=1-clamp(xyz[i+2]/(2*zCenter),0,1);
    screen[i]=cx+x*c-rotatedY*s+(part.flexX??0)*blend;
    screen[i+1]=cy+(x*s+rotatedY*c)*pitch-rotatedZ*spacing+(part.flexY??0)*blend;
    screen[i+2]=rotatedZ;
  }
  const coverage=activeEdges?.coverage;
  const fringe=coverage?.length ? .25 : 0;
  for(let k=0;k<triangles.length;k+=3) {
    const a=triangles[k]*3,b=triangles[k+1]*3,d=triangles[k+2]*3;
    const ax=screen[a],ay=screen[a+1],bx=screen[b],by=screen[b+1],dx=screen[d],dy=screen[d+1];
    const ux=bx-ax,uy=by-ay,vx=dx-ax,vy=dy-ay;
    const area=ux*vy-uy*vx;
    if(area*side*flipY<=.0001) continue;
    const lx=Math.max(1,Math.ceil(Math.min(ax,bx,dx)-fringe)),rx=Math.min(BUFFER-2,Math.floor(Math.max(ax,bx,dx)+fringe));
    const ly=Math.max(1,Math.ceil(Math.min(ay,by,dy)-fringe)),ry=Math.min(BUFFER_HEIGHT-2,Math.floor(Math.max(ay,by,dy)+fringe));
    const inv=1/area, ub=vy*inv, vb=-uy*inv, uyStep=-vx*inv,vyStep=ux*inv;
    const uSpan=(Math.abs(ub)+Math.abs(uyStep))*.25;
    const vSpan=(Math.abs(vb)+Math.abs(vyStep))*.25;
    const wSpan=(Math.abs(ub+vb)+Math.abs(uyStep+vyStep))*.25;
    const zb=screen[b+2]-screen[a+2], zd=screen[d+2]-screen[a+2];
    for(let y=ly;y<=ry;y++){
      let p=y*BUFFER+lx;
      let u=((lx-ax)*vy-(y-ay)*vx)*inv;
      let v=(ux*(y-ay)-uy*(lx-ax))*inv;
      for(let x=lx;x<=rx;x++,p++,u+=ub,v+=vb){
        const w=1-u-v;
        if(coverage&&coverage[p]!==15&&u>=-uSpan&&v>=-vSpan&&w>=-wSpan){
          coverage[p]|=u>=uSpan&&v>=vSpan&&w>=wSpan ? 15 : triangleCoverage(u,v,ub,vb,uyStep,vyStep);
        }
        if(u<-.00001 || v<-.00001 || w<-.00001)continue;
        const z=screen[a+2]+u*zb+v*zd;
        if(depth[p]>=z)continue;
        let nx=normals[a]*w+normals[b]*u+normals[d]*v;
        let ny=normals[a+1]*w+normals[b+1]*u+normals[d+1]*v;
        let nz=normals[a+2]*w+normals[b+2]*u+normals[d+2]*v;
        const tx=xyz[a]*w+xyz[b]*u+xyz[d]*v;
        const ty=xyz[a+1]*w+xyz[b+1]*u+xyz[d+1]*v;
        const tz=xyz[a+2]*w+xyz[b+2]*u+xyz[d+2]*v;
        const voxel=meshTextureVoxel(model,tx,ty,tz,nx,ny,nz);
        const projected=projectMeshColor(model,tx,ty,tz,nx,ny,nz);
        if(voxel<0)continue;
        if(detailNormal){
          const n=voxel*3;
          nx+=model.detailedNormals[n]-model.normals[n];
          ny+=model.detailedNormals[n+1]-model.normals[n+1];
          nz+=model.detailedNormals[n+2]-model.normals[n+2];
        }
        const magnitude=Math.hypot(nx,ny,nz);
        const factor=magnitude>0?127/magnitude:1;
        const baseColor=projected||(multiViewEnabled&&model.viewColors[voxel])||model.volume[voxel];
        const color=part.trackShift===undefined?baseColor:trackBeltColor(model,tx,ty,tz,part.trackShift,baseColor);
        spritePixels[p]=materialLight?materialPixel(color,model.material[voxel],
          (model.ambient[voxel]||255)/255,nx*factor,ny*factor*flipY,nz*factor,light,specularSpread(model,voxel)):color;
        depth[p]=z;
        bodyMask[p]=1;
      }
    }
  }
}

const subpixelAAButton=document.getElementById("subpixelAA");
const specularAAButton=document.getElementById("specularAA");
let subpixelAAEnabled=true,specularAAEnabled=true;
for(const button of [subpixelAAButton,specularAAButton]){
  button.addEventListener("click",()=>{
    if(button===subpixelAAButton)subpixelAAEnabled=!subpixelAAEnabled;
    else specularAAEnabled=!specularAAEnabled;
    button.setAttribute("aria-pressed",String(button===subpixelAAButton?subpixelAAEnabled:specularAAEnabled));
    resetFrameMeter();
    lastAngle=null;
  });
}

const meshButton=document.getElementById("meshMode");
const multiViewButton=document.getElementById("multiViewMode");
let meshEnabled=true, multiViewEnabled=true;
for(const button of [meshButton,multiViewButton]){
  button.addEventListener("click",()=>{
    if(button===meshButton)meshEnabled=!meshEnabled;
    else multiViewEnabled=!multiViewEnabled;
    button.setAttribute("aria-pressed",String(button===meshButton?meshEnabled:multiViewEnabled));
    lastAngle=null;
  });
}

function drawRobot(heading) {
  if (!(activeStack.ant && (motion.gait>.004 || skill.remaining>0)) && heading === lastAngle && robot.steering === lastSteering &&
      view.spacing === lastSpacing && view.squash === lastSquash && materialLight === lastMaterialLight &&
      detailNormal === lastDetailNormal &&
      robot.wheelRoll.every((angle,i)=>angle===lastRoll[i])) return;
  if (view.spacing !== lastSpacing || view.squash !== lastSquash) sizeSpriteBuffer();
  lastAngle = heading;
  lastSteering = robot.steering;
  lastSpacing = view.spacing;
  lastSquash = view.squash;
  lastMaterialLight = materialLight;
  lastDetailNormal = detailNormal;
  lastRoll.set(robot.wheelRoll);
  const parts = poseParts(heading);
  spritePixels.fill(0);
  bodyMask.fill(0);
  depth.fill(-1);
  drawGroundShadow(parts);
  beginSubpixelPass(vehicleEdges);
  for (const part of parts) (meshEnabled?drawMesh:drawPart)(part);
  if(!meshEnabled)sampleStackEdges(parts);
  const outline = pack(27,29,25,220);
  const antialiased=finishSubpixelPass(outline);
  spriteTop = BUFFER_HEIGHT;
  spriteBottom = 0;
  for (let y = 1; y < BUFFER_HEIGHT-1; y++) {
    let painted = false;
    for (let x = 1, i = y*BUFFER+1; x < BUFFER-1; x++,i++) {
      if (bodyMask[i]) painted = true;
      else if (!antialiased&&(bodyMask[i-1] || bodyMask[i+1] || bodyMask[i-BUFFER] || bodyMask[i+BUFFER])) {
        spritePixels[i] = outline;
      }
    }
    if (!painted) continue;
    if (spriteTop === BUFFER_HEIGHT) spriteTop = y;
    spriteBottom = y;
  }
  spriteCtx.putImageData(sprite,0,0);
}

function resetRobot() {
  if(isTank()){resetTank();return;}
  const phase = 1.21;
  const heading = Math.atan2(TRACK_Y*Math.cos(phase),-TRACK_X*Math.sin(phase));
  Object.assign(robot,{
    x:TRACK_X*Math.cos(phase)+Math.cos(heading)*CENTER_TO_REAR,
    y:TRACK_Y*Math.sin(phase)+Math.sin(heading)*CENTER_TO_REAR,
    heading,velocity:0,omega:0,steering:0,
  });
  robot.wheelRoll.fill(0);
  resetMobility();
  if(selectedAsset?.custom) {
    Object.assign(robot,{x:0,y:0,heading:.78});
  }
  camera.x = robot.x*.62;
  camera.y = robot.y*.62;
}
function setMode(mode) {
  robot.mode = mode;
  patrolButton.setAttribute("aria-pressed",String(mode==="patrol"));
  manualButton.setAttribute("aria-pressed",String(mode==="manual"));
}
function input(action) {
  for (const code of heldKeys) if (bindings[code] === action) return 1;
  for (const button of heldTouches.values()) if (button.dataset.key === action) return 1;
  return 0;
}
function update(dt) {
  if(isTank()){updateTank(dt);return;}
  updateAbilities(dt);
  if(activeStack.ant){updateAnt(dt);return;}
  if(activeStack.custom){
    const steer=input("right")-input("left");
    robot.heading=wrap(robot.heading+dt*(steer*1.8+(robot.mode==="patrol"?activeTuning().orbit*Math.PI/180:0)));
    status.value=robot.mode==="patrol"||steer?"Rotating asset":"Stop";
    speed.value="—";
    return;
  }
  const settings=activeTuning();
  const steeringLimit=settings.steering*Math.PI/180;
  const oldHeading = robot.heading;
  let targetSpeed = 0;
  let targetSteering = 0;
  if (robot.mode === "patrol") {
    // Pure pursuit of a point ahead of the rear axle on the marked route.
    const rearX = robot.x-Math.cos(oldHeading)*CENTER_TO_REAR;
    const rearY = robot.y-Math.sin(oldHeading)*CENTER_TO_REAR;
    const phase = Math.atan2(rearY/TRACK_Y,rearX/TRACK_X);
    const rate = Math.hypot(TRACK_X*Math.sin(phase),TRACK_Y*Math.cos(phase));
    const ahead = phase+62/rate;
    const dx = TRACK_X*Math.cos(ahead)-rearX, dy = TRACK_Y*Math.sin(ahead)-rearY;
    const error = wrap(Math.atan2(dy,dx)-oldHeading);
    targetSteering = Math.abs(error) > Math.PI/2
      ? Math.sign(error)*steeringLimit
      : Math.atan2(2*WHEELBASE*Math.sin(error),Math.max(1,Math.hypot(dx,dy)));
    targetSpeed = Math.min(settings.forward,35+42*Math.max(0,Math.cos(error)));
  } else {
    const throttle = input("forward")-input("reverse");
    const steer = input("right")-input("left");
    targetSpeed = throttle<0 ? -settings.reverse : selectedAsset.id==="rover"&&skill.remaining>0 ? settings.forward*193/126 : throttle*settings.forward;
    targetSteering = steer * steeringLimit * (1-.37*Math.min(1,Math.abs(robot.velocity)/settings.forward));
  }
  targetSteering = clamp(targetSteering,-steeringLimit,steeringLimit);
  robot.steering += (targetSteering-robot.steering)*(1-Math.exp(-(settings.response??11)*dt));
  if (Math.abs(robot.steering) < .0006 && targetSteering === 0) robot.steering = 0;
  robot.velocity += (targetSpeed-robot.velocity)*(1-Math.exp(-8*dt));
  if (Math.abs(robot.velocity) < .2 && targetSpeed === 0) robot.velocity = 0;
  const curvature = Math.tan(robot.steering)/WHEELBASE;
  const desiredTravel = robot.velocity*dt;
  const desiredTurn = desiredTravel*curvature;
  const mid = oldHeading+desiredTurn*.5;
  const newHeading = wrap(oldHeading+desiredTurn);
  const rearDx = Math.cos(mid)*desiredTravel, rearDy = Math.sin(mid)*desiredTravel;
  const offsetX = (Math.cos(newHeading)-Math.cos(oldHeading))*CENTER_TO_REAR;
  const offsetY = (Math.sin(newHeading)-Math.sin(oldHeading))*CENTER_TO_REAR;
  const contact=resolvePropContact(clamp(robot.x+rearDx+offsetX,-YARD_X+55,YARD_X-55),
    clamp(robot.y+rearDy+offsetY,-YARD_Y+55,YARD_Y-55),newHeading,dt);
  const nextX=clamp(contact.x,-YARD_X+55,YARD_X-55),nextY=clamp(contact.y,-YARD_Y+55,YARD_Y-55);
  const travel=clamp((nextX-robot.x-offsetX)*Math.cos(mid)+(nextY-robot.y-offsetY)*Math.sin(mid),
    Math.min(0,desiredTravel),Math.max(0,desiredTravel));
  robot.velocity*=1-contact.loss;
  const turn = travel*curvature;
  robot.omega = turn/Math.max(.001,dt);
  robot.x = nextX;
  robot.y = nextY;
  robot.heading = wrap(oldHeading+turn);
  for (const mount of wheelMounts) {
    const rearTravel = travel+mount.side*turn*HALF_TRACK;
    const wheelTravel = mount.front ? rearTravel/Math.cos(wheelSteer(mount.side,robot.steering)) : rearTravel;
    robot.wheelRoll[mount.index] = (robot.wheelRoll[mount.index]+wheelTravel/TIRE_RADIUS)%TAU;
  }

  const tracking = size.width < 560 ? .93 : .72;
  const follow = 1-Math.exp(-4.5*dt);
  camera.x += (robot.x*tracking-camera.x)*follow;
  camera.y += (robot.y*tracking-camera.y)*follow;
  const message = skill.remaining>0&&selectedAsset.id==="rover" ? "Boost" : robot.mode === "patrol" ? "Patrolling" : travel < -.002 ? "Reverse" :
    travel > .002 ? "Forward" : Math.abs(robot.steering) > .02 ? "Steering" : "Stopped";
  const value = Math.round(Math.abs(travel)/Math.max(.001,dt))+" px/s";
  if (status.value !== message) status.value = message;
  if (speed.value !== value) speed.value = value;
}

const floorCanvas = document.createElement("canvas");
const floorOrigin={x:YARD_X+48,y:Math.ceil(YARD_Y*DEFAULT_VIEW.squash)+42};
floorCanvas.width = 2 * floorOrigin.x;
floorCanvas.height = 2 * floorOrigin.y;

function makeYard() {
  const floor = floorCanvas.getContext("2d");
  floor.fillStyle = "#2b3441";
  floor.fillRect(0, 0, floorCanvas.width, floorCanvas.height);
  floor.translate(floorOrigin.x, floorOrigin.y);
  floor.scale(1, DEFAULT_VIEW.squash);
  floor.fillStyle = "#414e5d";
  floor.fillRect(-YARD_X, -YARD_Y, 2*YARD_X, 2*YARD_Y);
  floor.fillStyle = "#515f6e";
  floor.fillRect(-YARD_X+12, -YARD_Y+12, 2*YARD_X-24, 2*YARD_Y-24);
  let seed = 93744;
  const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
  for (let i = 0; i < 22000; i++) {
    floor.fillStyle = i & 1 ? "#adb3971b" : "#25292120";
    floor.fillRect(Math.floor(-YARD_X+random()*2*YARD_X), Math.floor(-YARD_Y+random()*2*YARD_Y), random()<.85?1:3, 1);
  }
  for (let x = -YARD_X + 26; x < YARD_X; x += 83) {
    floor.fillStyle = "#41473c";
    floor.fillRect(x, -YARD_Y+13, 1, 2*YARD_Y-26);
    floor.fillStyle = "#696f60";
    floor.fillRect(x+1, -YARD_Y+13, 1, 2*YARD_Y-26);
  }
  for (let y = -YARD_Y + 30; y < YARD_Y; y += 79) {
    floor.fillStyle = "#41473c";
    floor.fillRect(-YARD_X+12, y, 2*YARD_X-24, 1.2);
  }
  floor.strokeStyle = "#b3ca63";
  floor.lineWidth = 2.5;
  floor.setLineDash([10, 8]);
  floor.beginPath();
  floor.ellipse(0, 0, TRACK_X, TRACK_Y, 0, 0, TAU);
  floor.stroke();
  floor.setLineDash([]);
  floor.strokeStyle = "#91a0ae";
  floor.lineWidth = 2;
  floor.strokeRect(-YARD_X+17, -YARD_Y+17, 2*YARD_X-34, 2*YARD_Y-34);
  for (const sign of [-1, 1]) {
    floor.save();
    floor.translate(0, sign*(YARD_Y-27));
    floor.fillStyle = "#363a30";
    floor.fillRect(-75,-6,150,12);
    floor.beginPath(); floor.rect(-75,-6,150,12); floor.clip();
    floor.strokeStyle = "#b9a34c";
    floor.lineWidth = 5;
    for (let x = -86; x < 78; x += 12) {
      floor.beginPath(); floor.moveTo(x,-6); floor.lineTo(x+12,6); floor.stroke();
    }
    floor.restore();
  }
  for (const [x,y] of scannerMarkers) {
    floor.strokeStyle = "#c3c3ae";
    floor.beginPath();
    floor.moveTo(x-11,y); floor.lineTo(x-4,y);
    floor.moveTo(x+4,y); floor.lineTo(x+11,y);
    floor.moveTo(x,y-11); floor.lineTo(x,y-4);
    floor.moveTo(x,y+4); floor.lineTo(x,y+11);
    floor.stroke();
  }
}

function resize() {
  const width = Math.max(1, Math.round(canvas.clientWidth));
  const height = Math.max(1, Math.round(canvas.clientHeight));
  const density = width < 730 ? Math.min(2, Math.max(1, Math.round(devicePixelRatio))) : 1;
  if (width === size.width && height === size.height && density === size.density) return;
  canvas.width = width*density;
  canvas.height = height*density;
  size = {width, height, scale:width >= 730 && height >= 400 ? 2 : 1, density};
  ctx.imageSmoothingEnabled = false;
}

function render() {
  const gpuMode=sceneRendererMode==="gpu";
  if(activeStack&&!gpuMode)drawRobot(robot.heading);
  const samples=supersampling ? 2 : 1;
  const width=canvas.width*samples, height=canvas.height*samples;
  const target=supersampling ? sampleCtx : ctx;
  if (supersampling && (sampleCanvas.width!==width || sampleCanvas.height!==height)) {
    sampleCanvas.width=width;
    sampleCanvas.height=height;
  }
  target.imageSmoothingEnabled=false;
  const scale=size.scale*size.density*view.scale*samples;
  const spriteScale = scale/(ART_PIXELS_PER_UNIT*(activeStack?.ratio ?? 1));
  const floorSquash = view.squash/DEFAULT_VIEW.squash;
  const centerX = width/2;
  const offsetY = (robot.y-camera.y)*view.squash*scale;
  const minGround = 12*size.density*samples-(spriteTop-PIVOT_Y)*spriteScale;
  const maxGround = height-12*size.density*samples-(spriteBottom-PIVOT_Y)*spriteScale;
  const targetY=height*.57+offsetY;
  const groundY=!activeStack||gpuMode ? targetY :
    minGround<=maxGround ? clamp(targetY,minGround,maxGround) : (minGround+maxGround)/2;
  const centerY = groundY-offsetY;
  renderPose.x=(centerX+(robot.x-camera.x)*scale)/width;
  renderPose.y=groundY/height;
  renderPose.pitch=height/width;
  target.fillStyle = "#2b3441";
  target.fillRect(0,0,width,height);
  target.drawImage(currentFloor(),
    Math.round(centerX - (floorOrigin.x + camera.x)*scale),
    Math.round(centerY - (floorOrigin.y*floorSquash + camera.y*view.squash)*scale),
    floorCanvas.width*scale,floorCanvas.height*scale*floorSquash);
  const obstacles=visibleProps(centerX,centerY,scale,width,height);
  for(const entry of obstacles)drawPropShadow(target,entry,scale);
  if(activeStack) drawAbilityEffect(target,centerX,centerY,scale,groundY);
  if(gpuMode){
    if(activeStack)drawGpuVehicleShadow(target,centerX,groundY,scale);
    gpuSceneRenderer.draw({obstacles,width,height,scale,spriteScale,centerX,groundY});
  }else{
    let obstacleIndex=0;
    while(obstacleIndex<obstacles.length&&(!activeStack||obstacles[obstacleIndex].y<=groundY)){
      drawYardProp(target,obstacles[obstacleIndex++],scale);
    }
    if(activeStack)target.drawImage(spriteCanvas,
      Math.round(centerX+(robot.x-camera.x)*scale-PIVOT_X*spriteScale),
      Math.round(groundY-PIVOT_Y*spriteScale),BUFFER*spriteScale,BUFFER_HEIGHT*spriteScale);
    while(obstacleIndex<obstacles.length)drawYardProp(target,obstacles[obstacleIndex++],scale);
  }
  drawSceneEffects(target,gpuMode,width,height,centerX,centerY,scale,size.density*samples);
  if(supersampling) {
    ctx.imageSmoothingEnabled=true;
    ctx.imageSmoothingQuality="medium";
    ctx.drawImage(sampleCanvas,0,0,canvas.width,canvas.height);
  }
}

function stop() {
  setMode("manual");
  clearInputs();
  robot.velocity = 0;
  robot.omega = 0;
  skill.remaining=0;
  motion.vx=motion.vy=0;
  updateAbilityUI();
}

function clearInputs() {
  heldKeys.clear();
  for (const button of heldTouches.values()) button.classList.remove("active");
  heldTouches.clear();
}
patrolButton.addEventListener("click", () => { clearInputs(); setMode("patrol"); });
manualButton.addEventListener("click", stop);
document.getElementById("reset").addEventListener("click", () => { clearInputs(); resetRobot(); });
window.addEventListener("keydown", event => {
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  if (event.target.matches('input[type="range"], select') && event.code.startsWith("Arrow")) return;
  if(currentMobility().keys?.includes(event.code)) {
    event.preventDefault();
    if(!event.repeat)activateAbility();
    return;
  }
  if (Object.hasOwn(bindings,event.code)) {
    if((event.code==="KeyQ"||event.code==="KeyE")&&selectedAsset.id!=="ant")return;
    event.preventDefault();
    setMode("manual");
    heldKeys.add(event.code);
  } else if (event.code === "Space") {
    if (event.target.closest(".tuning-panel button, .asset-controls button")) return;
    event.preventDefault();
    stop();
  } else if (event.code === "KeyR" && !event.repeat) {
    clearInputs();
    resetRobot();
  }
});
window.addEventListener("keyup", event => heldKeys.delete(event.code));
window.addEventListener("blur", clearInputs);
document.addEventListener("visibilitychange", () => {
  if (document.hidden) clearInputs();
  resetFrameMeter();
});
for (const button of touchButtons) {
  button.addEventListener("pointerdown", event => {
    if (event.button !== 0) return;
    event.preventDefault();
    setMode("manual");
    button.setPointerCapture(event.pointerId);
    heldTouches.set(event.pointerId, button);
    button.classList.add("active");
  });
  function release(event) {
    heldTouches.delete(event.pointerId);
    if (![...heldTouches.values()].includes(button)) button.classList.remove("active");
  }
  for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) {
    button.addEventListener(type, release);
  }
}

const tuningDefinitions={
  rover:[
    {id:"forward",label:"Top Forward Speed",min:55,max:225,step:1,base:126,unit:" px/s"},
    {id:"reverse",label:"Top Reverse Speed",min:20,max:115,step:1,base:61,unit:" px/s"},
    {id:"steering",label:"Max Steering Angle",min:12,max:44,step:1,base:32,unit:"°"},
    {id:"response",label:"Steering Response",min:4,max:25,step:.5,base:12,unit:""},
  ],
  inspection:[
    {id:"forward",label:"Top Forward Speed",min:24,max:130,step:1,base:88,unit:" px/s"},
    {id:"reverse",label:"Top Reverse Speed",min:12,max:75,step:1,base:43,unit:" px/s"},
    {id:"steering",label:"Max Steering Angle",min:15,max:46,step:1,base:36,unit:"°"},
    {id:"scanRange",label:"Scan Range",min:80,max:225,step:5,base:155,unit:" px"},
  ],
  ant:[
    {id:"walk",label:"Walk Speed",min:28,max:150,step:1,base:82,unit:" px/s"},
    {id:"turn",label:"Body Turn Speed",min:60,max:330,step:5,base:160,unit:"°/s"},
    {id:"aimResponse",label:"Mouse Aim Response",min:4,max:25,step:.5,base:14,unit:""},
    {id:"leap",label:"Leap Speed",min:112,max:290,step:1,base:214,unit:" px/s"},
  ],
  custom:[
    {id:"orbit",label:"Auto-Rotate Speed",min:10,max:135,step:1,base:34,unit:"°/s"},
  ],
};
const tuningByAsset=new Map();
const mobilityTuning=document.getElementById("mobilityTuning");

function activeTuning(){
  const id=selectedAsset.id;
  if(!tuningByAsset.has(id)){
    const definitions=tuningDefinitions[id]??tuningDefinitions.custom;
    tuningByAsset.set(id,Object.fromEntries(definitions.map(config=>[config.id,config.base])));
  }
  return tuningByAsset.get(id);
}
function resetMobilityTuning(){
  tuningByAsset.delete(selectedAsset.id);
  renderMobilityTuning();
}
function renderMobilityTuning(){
  const settings=activeTuning();
  const definitions=tuningDefinitions[selectedAsset.id]??tuningDefinitions.custom;
  const group=document.createDocumentFragment();
  for(const {id,label,min,max,step,unit} of definitions){
    const field=document.createElement("div");
    const heading=document.createElement("label");
    const result=document.createElement("output");
    const input=document.createElement("input");
    field.className="view-control";
    input.id="tune-"+id;input.type="range";input.min=min;input.max=max;input.step=step;input.value=settings[id];
    heading.htmlFor=input.id;
    heading.append(label,result);
    result.htmlFor=input.id;result.setAttribute("aria-hidden","true");
    function sync(){
      settings[id]=input.valueAsNumber;
      result.value=String(settings[id])+unit;
      input.setAttribute("aria-valuetext",result.value);
    }
    input.addEventListener("input",sync);sync();
    field.append(heading,input);
    group.append(field);
  }
  mobilityTuning.replaceChildren(group);
}
const mobilityProfiles={
  rover:{ability:"Boost",keys:["ShiftLeft","ShiftRight"],label:"Shift",active:1.35,recharge:4.2,
    hint:"WASD / arrow keys to drive · Shift to boost · Space to stop"},
  inspection:{ability:"Sensor Scan",keys:["KeyE"],label:"E",active:1.25,recharge:3.4,
    hint:"WASD / arrow keys to drive · E to scan · Space to stop"},
  ant:{ability:"Leap",keys:["KeyF"],label:"F",active:.63,recharge:2.6,
    hint:"WASD / arrow keys to move · Mouse to aim · Q/E to turn · F to leap"},
  custom:{hint:"← / → to rotate · Space to stop"},
};
const skillButton=document.getElementById("mobilityAbility");
const skillStatus=document.getElementById("abilityStatus");
const inputHelp=document.getElementById("mobilityHelp");
const aimPointer={active:false,x:0,y:0};
const renderPose={x:0,y:0,pitch:.75};
const legRig=[-1,1].flatMap((side,pair)=>[-1,0,1].map((station,index)=>({
  side,station,x:20*side,y:station*32,group:(pair+index)%2,
})));
const scannerMarkers=[[-TRACK_X-19,0],[TRACK_X+19,0],[0,-TRACK_Y-16],[0,TRACK_Y+16]];
const motion={vx:0,vy:0,phase:0,gait:0,omega:0,frequency:1,lx:0,ly:0};
const skill={remaining:0,cooldown:0,x:0,y:0,dx:0,dy:0,hits:0,triggered:0};

function currentMobility(){return mobilityProfiles[selectedAsset.id]||mobilityProfiles.custom;}
function resetMobility(){
  Object.assign(motion,{vx:0,vy:0,phase:0,gait:0,omega:0,frequency:1,lx:0,ly:0});
  Object.assign(skill,{remaining:0,cooldown:0,x:0,y:0,dx:0,dy:0,hits:0,triggered:0});
  aimPointer.active=false;
}
function configureMobilityUI(){
  const profile=currentMobility();
  inputHelp.textContent=profile.hint+" · R to reset";
  renderMobilityTuning();
  canvas.style.cursor=selectedAsset.id==="ant"?"crosshair":"";
  skillButton.hidden=!profile.ability;
  skillStatus.hidden=!profile.ability;
  if(profile.ability) skillButton.textContent=profile.ability+" · "+profile.label;
  document.querySelectorAll("[data-ant-turn]").forEach(button=>{button.hidden=selectedAsset.id!=="ant";});
  const sideButtons=document.querySelectorAll('[data-key="left"],[data-key="right"]');
  sideButtons.forEach((button,index)=>button.setAttribute("aria-label",
    selectedAsset.id==="ant"?(index?"Move right":"Move left"):(index?"Turn Right":"Turn Left")));
  updateAbilityUI();
}
function updateAbilityUI(){
  if(!currentMobility().ability)return;
  const working=skill.remaining>0;
  skillButton.disabled=!activeStack||skill.cooldown>0;
  skillButton.setAttribute("aria-pressed",String(working));
  const message=selectedAsset.id==="inspection"&&working
    ? `Scanning · Targets: ${skill.hits}`
    : working ? "Active" : skill.cooldown>0 ? `Recharging · ${skill.cooldown.toFixed(1)} s` :
      selectedAsset.id==="inspection"&&skill.triggered ? `Targets detected: ${skill.hits}` : "Ready";
  if(skillStatus.value!==message)skillStatus.value=message;
}
function activateAbility(){
  const profile=currentMobility();
  if(!activeStack||!profile.ability||skill.cooldown>0)return;
  if(selectedAsset.id!=="inspection") setMode("manual");
  skill.remaining=profile.active;
  skill.cooldown=profile.recharge;
  skill.x=robot.x; skill.y=robot.y; skill.hits=0; skill.triggered++;
  if(selectedAsset.id==="ant"){
    let x=input("right")-input("left"),y=input("reverse")-input("forward");
    if(!x&&!y){x=Math.cos(robot.heading);y=Math.sin(robot.heading);}
    const mag=Math.hypot(x,y);
    skill.dx=x/mag;skill.dy=y/mag;
  }
  updateAbilityUI();
}
function updateAbilities(dt){
  skill.remaining=Math.max(0,skill.remaining-dt);
  skill.cooldown=Math.max(0,skill.cooldown-dt);
  if(selectedAsset.id==="inspection"&&skill.remaining>0){
    const radius=9+activeTuning().scanRange*(1-skill.remaining/currentMobility().active);
    skill.hits=scannerMarkers.filter(([x,y])=>Math.hypot(x-skill.x,y-skill.y)<=radius).length;
  }
  updateAbilityUI();
}

skillButton.addEventListener("click",activateAbility);
canvas.addEventListener("pointermove",event=>{
  if(selectedAsset.id!=="ant"||event.pointerType==="touch")return;
  const box=canvas.getBoundingClientRect();
  aimPointer.x=(event.clientX-box.left)/box.width;
  aimPointer.y=(event.clientY-box.top)/box.height;
  aimPointer.active=true;
});
canvas.addEventListener("pointerleave",()=>{aimPointer.active=false;});

function updateAnt(dt){
  const previous=robot.heading,settings=activeTuning(),turn=settings.turn*Math.PI/180;
  let x=input("right")-input("left"),y=input("reverse")-input("forward");
  let heading=null;
  const rotation=input("turnRight")-input("turnLeft");
  if(rotation){
    aimPointer.active=false;
    heading=previous+rotation*turn*dt;
  } else if(aimPointer.active){
    const dx=aimPointer.x-renderPose.x,dy=(aimPointer.y-renderPose.y)/view.squash*renderPose.pitch;
    if(Math.hypot(dx,dy)>.025) heading=Math.atan2(dy,dx);
  }
  if(robot.mode==="patrol"){
    const t=Math.atan2(robot.y/TRACK_Y,robot.x/TRACK_X);
    const target=t+.22;
    x=TRACK_X*Math.cos(target)-robot.x;y=TRACK_Y*Math.sin(target)-robot.y;
    if(heading===null)heading=Math.atan2(y,x);
  }
  if(heading!==null){
    const delta=wrap(heading-previous);
    robot.heading=wrap(previous+(rotation?delta:clamp(delta*(1-Math.exp(-settings.aimResponse*dt)),-2.68*turn*dt,2.68*turn*dt)));
  }
  const mag=Math.hypot(x,y);
  const dash=skill.remaining>0;
  const limit=dash?settings.leap:robot.mode==="patrol"?Math.min(58,settings.walk):settings.walk;
  const vx=dash?skill.dx*limit:mag?x/mag*limit:0;
  const vy=dash?skill.dy*limit:mag?y/mag*limit:0;
  const smooth=1-Math.exp(-(dash?23:13)*dt);
  motion.vx+=(vx-motion.vx)*smooth;motion.vy+=(vy-motion.vy)*smooth;
  if(!vx&&Math.abs(motion.vx)<.08)motion.vx=0;
  if(!vy&&Math.abs(motion.vy)<.08)motion.vy=0;
  const oldX=robot.x,oldY=robot.y;
  const contact=resolvePropContact(clamp(robot.x+motion.vx*dt,-YARD_X+42,YARD_X-42),
    clamp(robot.y+motion.vy*dt,-YARD_Y+42,YARD_Y-42),robot.heading,dt);
  robot.x=clamp(contact.x,-YARD_X+42,YARD_X-42);
  robot.y=clamp(contact.y,-YARD_Y+42,YARD_Y-42);
  motion.vx*=1-contact.loss;
  motion.vy*=1-contact.loss;
  const ax=(robot.x-oldX)/Math.max(.001,dt),ay=(robot.y-oldY)/Math.max(.001,dt);
  const yaw=robot.heading-Math.PI/2,c=Math.cos(yaw),s=Math.sin(yaw);
  motion.lx=(ax*c+ay*s)*1.44;motion.ly=(-ax*s+ay*c)*1.44;
  motion.omega=wrap(robot.heading-previous)/Math.max(.001,dt);
  robot.velocity=Math.hypot(ax,ay);
  const footSpeed=robot.velocity+Math.abs(motion.omega)*19;
  motion.gait+=((footSpeed>2.2?1:0)-motion.gait)*smooth;
  motion.frequency=clamp(footSpeed/49,.65,dash?3.4:2.5);
  motion.phase=(motion.phase+dt*motion.frequency*motion.gait)%1;
  const track=size.width<560?.92:.72,follow=1-Math.exp(-5*dt);
  camera.x+=(robot.x*track-camera.x)*follow;
  camera.y+=(robot.y*track-camera.y)*follow;
  status.value=dash?"Leap":robot.velocity>4?"Walking":Math.abs(motion.omega)>.2?"Turning":"Idle";
  speed.value=Math.round(robot.velocity)+" px/s";
}

function antPoseParts(heading){
  const density=activeStack.textureRatio;
  const yaw=heading-Math.PI/2,c=Math.cos(yaw),s=Math.sin(yaw);
  const leap=skill.remaining>0?Math.sin(Math.PI*skill.remaining/mobilityProfiles.ant.active)*3:0;
  const bob=motion.gait*(1-Math.cos(motion.phase*Math.PI*4))*.7+leap;
  const parts=[{model:chassis,x:PIVOT_X,y:PIVOT_Y,z:(26+bob)*density,yaw,roll:null}];
  for(const leg of legRig){
    const model=leg.station===0?activeStack.center:activeStack.angled;
    const phase=(motion.phase+.5*leg.group)%1;
    const swing=phase<.56?0:(phase-.56)/.44;
    const stride=phase<.56?.5-phase/.56:swing*swing*(3-2*swing)-.5;
    const span=.56*motion.gait*stride/motion.frequency;
    const dx=clamp((motion.lx-motion.omega*(leg.y+leg.station*17))*span,-12,12);
    const dy=clamp((motion.ly+motion.omega*(leg.x+leg.side*12))*span,-13,13);
    const lift=Math.sin(Math.PI*swing)*motion.gait*(skill.remaining>0?10:7)+leap*.55;
    parts.push({model,x:PIVOT_X+(leg.x*c-leg.y*s)*density,
      y:PIVOT_Y+(leg.x*s+leg.y*c)*view.squash*density,
      z:lift*density,yaw,roll:null,mirror:leg.side<0,flipY:leg.station===-1,pivotX:4.5*density-.5,pivotY:4*density-.5,
      flexX:(dx*c-dy*s)*density,flexY:(dx*s+dy*c)*view.squash*density,
      heightScale:1+(bob-lift)/40});
  }
  return parts;
}

function drawAbilityEffect(target,centerX,centerY,scale,groundY){
  if(skill.remaining<=0)return;
  if(selectedAsset.id==="inspection"){
    const progress=1-skill.remaining/currentMobility().active,radius=(9+activeTuning().scanRange*progress)*scale;
    const cx=centerX+(skill.x-camera.x)*scale,cy=centerY+(skill.y-camera.y)*view.squash*scale;
    target.strokeStyle=`rgba(97,238,237,${.7*(1-progress)})`;
    target.lineWidth=2*size.density;
    target.beginPath();target.ellipse(cx,cy,radius,radius*view.squash,0,0,TAU);target.stroke();
    target.fillStyle=`rgba(132,255,219,${.8*(1-progress)})`;
    for(const [x,y] of scannerMarkers) {
      if(Math.hypot(x-skill.x,y-skill.y)>radius/scale)continue;
      const mx=centerX+(x-camera.x)*scale,my=centerY+(y-camera.y)*view.squash*scale;
      target.fillRect(mx-3*scale,my-3*scale,6*scale,6*scale);
    }
  } else if(selectedAsset.id==="rover"||selectedAsset.id==="ant"){
    const x=centerX+(robot.x-camera.x)*scale,backX=Math.cos(robot.heading),backY=Math.sin(robot.heading);
    target.strokeStyle=selectedAsset.id==="rover"?"#c7f944ad":"#89d4ff90";
    target.lineWidth=1.4*size.density;
    for(const side of [-1,1]){
      const distance=selectedAsset.id==="rover"?49:30;
      const sx=x+(-backX*distance-backY*side*13)*scale;
      const sy=groundY+(-backY*distance+backX*side*13)*view.squash*scale;
      target.beginPath();target.moveTo(sx,sy);target.lineTo(sx-backX*16*scale,sy-backY*16*view.squash*scale);target.stroke();
    }
  }
}


function drawAntAim(target,width,height,scale){
  if(!aimPointer.active)return;
  const x=Math.round(aimPointer.x*width),y=Math.round(aimPointer.y*height);
  target.fillStyle="#b4eeff";
  const arm=5*scale,gap=4*scale;
  target.fillRect(x-gap-arm,y,arm,scale);
  target.fillRect(x+gap,y,arm,scale);
  target.fillRect(x,y-gap-arm,scale,arm);
  target.fillRect(x,y+gap,scale,arm);
}
const PROP_ART_SCALE=.25;
const PROP_LAYERS=40;
const coneSpawns=[
  [36,257],[-29,269],[-91,246],[-150,273],[-220,247],
  [166,295],[212,312],[267,295],[319,312],
  [-315,174],[-339,117],[-310,57],[-338,-2],
  [369,72],[409,29],[362,-23],[409,-75],
  [-205,-257],[-154,-285],[-94,-254],[-37,-284],[28,-251],
  [442,-220],[500,-257],[551,-223],[-489,-238],[-533,-202],
  [-493,301],[-539,346],[465,320],[526,349],[580,315],
];
const propSpawns={
  "traffic-cone":coneSpawns.map(([x,y],i)=>[x,y,(i*.79)%TAU]),
  "wet-floor-sign":[[32,162,.14],[-182,110,-.35],[260,-96,1.1],[-550,-40,.32]],
  "plastic-barrier":[[-68,155,0],[-143,155,0],[188,120,-.32],[530,125,Math.PI/2],[-300,-350,.35]],
  "concrete-barrier":[[-65,339,0],[41,339,0],[147,339,0],[580,90,Math.PI/2],[-578,74,Math.PI/2],[9,-350,0]],
};
const yardProps=[];
const propModels=new Map();
let propLoadFailures=0;
let obstacleHits=0;
const obstacleTelemetry=document.getElementById("obstacleTelemetry");
const propTypeCount=Object.keys(PROP_ASSETS).length;

function updateObstacleTelemetry(){
  const loaded=propModels.size;
  const ready=loaded+propLoadFailures===propTypeCount;
  const value=ready ? "Props "+yardProps.length+" · Models "+loaded+"/"+propTypeCount+" · Collisions "+obstacleHits
    +(propLoadFailures?" · Load errors "+propLoadFailures:"") : "Loading yard props "+loaded+"/"+propTypeCount;
  if(obstacleTelemetry.value!==value)obstacleTelemetry.value=value;
}
function resetProps(){
  yardProps.length=0;
  obstacleHits=0;
  for(const [type,spawns] of Object.entries(propSpawns)) {
    const {inverseMass,tips}=PROP_ASSETS[type];
    for(const [x,y,yaw] of spawns) {
      const item={type,x,y,yaw,inverseMass,tips,vx:0,vy:0,tiltYaw:0,spin:0,tip:0,tipVelocity:0,
        fallen:false,hop:0,rise:0,rollSpeed:0,airBounces:0,cooldown:0};
      const model=propModels.get(type);
      if(model)setPropModel(item,model);
      yardProps.push(item);
    }
  }
  updateObstacleTelemetry();
}
document.getElementById("resetProps").addEventListener("click",resetProps);

function setPropModel(item,model) {
  const halfWidth=model.width*PROP_ART_SCALE/2,halfLength=model.length*PROP_ART_SCALE/2;
  item.model=model;
  item.radius=Math.min(halfWidth,halfLength);
  item.spine=Math.max(halfWidth,halfLength)-item.radius;
  item.axis=halfWidth>=halfLength?0:Math.PI/2;
  item.halfHeight=(model.layers-1)*model.layerStep*PROP_ART_SCALE/2;
  item.balanceAngle=Math.atan2(item.radius,item.halfHeight);
  item.inertia=item.radius*item.radius+item.halfHeight*item.halfHeight;
}

function buildProp(asset,ratio=2){
  return new Promise((resolve,reject)=>{
    const url=URL.createObjectURL(new Blob([WORKER_SOURCE],{type:"text/javascript"}));
    let propWorker;
    try{
      propWorker=new Worker(url);
      propWorker.onmessage=({data})=>{
        propWorker.terminate();
        if(data.type==="ready"){
          data.stack.body.benchmarkSource=data.source;
          resolve(data.stack.body);
        }
        else reject(new Error(data.message));
      };
      propWorker.onerror=error=>{
        propWorker.terminate();
        reject(new Error(error.message));
      };
      propWorker.postMessage({type:"init",plates:{body:asset.encoded,wheel:null},version:asset.version,
        profile:{body:{width:asset.width??18,length:asset.length??19,layers:asset.height,keepDimensions:asset.width!==undefined},body_clearance:0,front_axle:0,rear_axle:0,half_track:0},
        defaultLayers:PROP_LAYERS,defaultRatio:ratio,cache:true,prop:true});
      propWorker.postMessage({type:"stack",sequence:1,layers:PROP_LAYERS,ratio,progressive:false});
    } catch(error) {
      propWorker?.terminate();
      reject(error);
    } finally {
      URL.revokeObjectURL(url);
    }
  });
}

async function loadProps(){
  for(const [type,asset] of Object.entries(PROP_ASSETS)){
    try{
      const model=await buildProp(asset);
      if(asset.tips)model.surfaceVoxels=propSurfaceVoxels(model);
      propModels.set(type,model);
      for(const item of yardProps)if(item.type===type)setPropModel(item,model);
    } catch(error){
      propLoadFailures++;
      console.warn(type+": "+error.message);
    }
    updateObstacleTelemetry();
  }
}

const PROP_GRAVITY=350;
const NOSE_SNAP=.00001;
const TIP_SPEED_SCALE=Math.SQRT2;

function propCapsule(item){
  if(item.tip>.0001){
    const yaw=item.tiltYaw;
    return {x:item.x,y:item.y,dx:-Math.sin(yaw),dy:Math.cos(yaw),
      spine:Math.max(item.spine,(item.halfHeight-item.radius)*Math.sin(item.tip)),radius:item.radius};
  }
  const axis=item.yaw+item.axis;
  return {x:item.x,y:item.y,dx:Math.cos(axis),dy:Math.sin(axis),spine:item.spine,radius:item.radius};
}

function capsuleContact(a,b){
  const limit=a.radius+b.radius;
  const separationX=b.x-a.x,separationY=b.y-a.y;
  const broad=limit+a.spine+b.spine;
  if(Math.abs(separationX)>=broad||Math.abs(separationY)>=broad)return null;
  let best=Infinity,rx=separationX,ry=separationY;
  function pair(ax,ay,bx,by){
    const dx=bx-ax,dy=by-ay,q=dx*dx+dy*dy;
    if(q<best){best=q;rx=dx;ry=dy;}
  }
  for(const sign of [-1,1]){
    const ax=a.x+a.dx*a.spine*sign,ay=a.y+a.dy*a.spine*sign;
    const t=clamp((ax-b.x)*b.dx+(ay-b.y)*b.dy,-b.spine,b.spine);
    pair(ax,ay,b.x+b.dx*t,b.y+b.dy*t);
    const bx=b.x+b.dx*b.spine*sign,by=b.y+b.dy*b.spine*sign;
    const u=clamp((bx-a.x)*a.dx+(by-a.y)*a.dy,-a.spine,a.spine);
    pair(a.x+a.dx*u,a.y+a.dy*u,bx,by);
  }
  const determinant=a.dx*b.dy-a.dy*b.dx;
  if(Math.abs(determinant)>NOSE_SNAP){
    const u=(separationX*b.dy-separationY*b.dx)/determinant;
    const t=(separationX*a.dy-separationY*a.dx)/determinant;
    if(Math.abs(u)<=a.spine && Math.abs(t)<=b.spine) best=0;
  }
  if(best>=limit*limit)return null;
  const gap=Math.sqrt(best);
  if(gap<NOSE_SNAP){
    const centerDistance=Math.hypot(separationX,separationY);
    rx=centerDistance>NOSE_SNAP?separationX/centerDistance:1;
    ry=centerDistance>NOSE_SNAP?separationY/centerDistance:0;
    return {nx:rx,ny:ry,overlap:limit};
  }
  return {nx:rx/gap,ny:ry/gap,overlap:limit-gap};
}

function impartPropTorque(item,nx,ny,impulse,tangent=0){
  if(!item.tips)return;
  item.spin=clamp(item.spin+tangent*.052,-11,11);
  if(item.fallen){
    item.rollSpeed+=impulse*(nx*Math.cos(item.tiltYaw)+ny*Math.sin(item.tiltYaw))/item.radius*.45;
    return;
  }
  if(item.tip<.055&&Math.abs(item.tipVelocity)<.45) {
    item.tiltYaw=wrap(Math.atan2(ny,nx)-Math.PI/2);
  }
  const alignment=nx*-Math.sin(item.tiltYaw)+ny*Math.cos(item.tiltYaw);
  // A hit against the direction of lean can interrupt a rocking motion.
  item.tipVelocity=clamp(item.tipVelocity+impulse*.064*alignment*TIP_SPEED_SCALE,-14*TIP_SPEED_SCALE,16*TIP_SPEED_SCALE);
}

function advanceProp(item,dt){
  item.cooldown=Math.max(0,item.cooldown-dt);
  const air=item.hop>0||item.rise>0;
  const oldTip=item.tip,oldYaw=item.tiltYaw;
  if(item.fallen){
    const lateralX=Math.cos(item.tiltYaw),lateralY=Math.sin(item.tiltYaw);
    const across=item.vx*lateralX+item.vy*lateralY;
    const along=-item.vx*lateralY+item.vy*lateralX;
    const keepAcross=Math.exp(-(air?.55:1.4)*dt);
    const keepAlong=Math.exp(-(air?.55:4.8)*dt);
    item.vx=lateralX*across*keepAcross-lateralY*along*keepAlong;
    item.vy=lateralY*across*keepAcross+lateralX*along*keepAlong;
    const rolling=across/item.radius;
    item.rollSpeed+=(rolling-item.rollSpeed)*(1-Math.exp(-(air?1.4:9)*dt));
    if(Math.abs(item.rollSpeed)<.014)item.rollSpeed=0;
    item.yaw=wrap(item.yaw+item.rollSpeed*dt);
    item.tipVelocity+=((Math.PI/2-item.tip)*58-item.tipVelocity*8.5)*dt;
    item.tip+=item.tipVelocity*dt;
    if(item.tip>Math.PI/2){
      item.tip=Math.PI/2;
      item.tipVelocity*=-.23;
    }
    if(Math.PI/2-item.tip<.009&&Math.abs(item.tipVelocity)<.06){
      item.tip=Math.PI/2;item.tipVelocity=0;
    }
  } else {
    const damping=Math.exp(-(item.tip>item.balanceAngle?2:3.7)*dt);
    item.vx*=damping;item.vy*=damping;
    if(item.tip>0||item.tipVelocity>0){
      const lever=item.halfHeight*Math.sin(item.tip)-item.radius*Math.cos(item.tip);
      item.tipVelocity+=(PROP_GRAVITY*lever/item.inertia-item.tipVelocity*(item.tip>item.balanceAngle?1.25:2.2))*dt;
      item.tip+=item.tipVelocity*dt;
      if(item.tip<0){
        item.tip=0;
        const rebound=-item.tipVelocity*.34;
        item.tipVelocity=rebound>.58?rebound:0;
        if(item.tipVelocity)item.tiltYaw=wrap(item.tiltYaw+Math.PI);
      } else if(item.tip>=Math.PI/2){
        const impact=Math.abs(item.tipVelocity);
        item.tip=Math.PI/2;
        item.tipVelocity=-impact*.19;
        item.fallen=true;
        item.rise=Math.min(29/TIP_SPEED_SCALE,impact*6.8*PROP_ART_SCALE);
        item.airBounces++;
        item.rollSpeed=(item.vx*Math.cos(item.tiltYaw)+item.vy*Math.sin(item.tiltYaw))/item.radius;
      }
    }
    // Move the center around the supporting rim as the prop tips.
    if(item.tip!==oldTip) {
      const advance=item.halfHeight*(Math.sin(item.tip)-Math.sin(oldTip))+
        item.radius*(Math.cos(oldTip)-Math.cos(item.tip));
      item.x-=Math.sin(oldYaw)*advance;
      item.y+=Math.cos(oldYaw)*advance;
    }
    item.yaw=wrap(item.yaw+item.spin*dt);
  }
  item.spin*=Math.exp(-4.5*dt);
  if(Math.abs(item.spin)<.005)item.spin=0;
  if(Math.abs(item.vx)<.07)item.vx=0;
  if(Math.abs(item.vy)<.07)item.vy=0;
  item.x+=item.vx*dt;
  item.y+=item.vy*dt;
  if(item.hop>0||item.rise>0){
    item.rise-=PROP_GRAVITY*dt;
    item.hop+=item.rise*dt;
    if(item.hop<=0){
      item.hop=0;
      const rebound=-item.rise*.26;
      item.rise=rebound>6?rebound:0;
      item.vx*=.79;item.vy*=.79;
      if(item.rise>0)item.airBounces++;
    }
  }
}

function physicsPropStep(dt){
  const placed=yardProps.filter(item=>item.model);
  for(const item of placed){
    if(item.inverseMass)advanceProp(item,dt);
    else item.cooldown=Math.max(0,item.cooldown-dt);
  }
  const shapes=placed.map(propCapsule);
  for(let i=0;i<placed.length;i++)for(let j=i+1;j<placed.length;j++){
    const a=placed[i],b=placed[j],inverseMass=a.inverseMass+b.inverseMass;
    if(!inverseMass)continue;
    const hit=capsuleContact(shapes[i],shapes[j]);
    if(!hit)continue;
    const {nx,ny,overlap}=hit;
    const offset=overlap/inverseMass;
    a.x-=nx*offset*a.inverseMass;a.y-=ny*offset*a.inverseMass;
    b.x+=nx*offset*b.inverseMass;b.y+=ny*offset*b.inverseMass;
    shapes[i].x=a.x;shapes[i].y=a.y;shapes[j].x=b.x;shapes[j].y=b.y;
    const closing=(a.vx-b.vx)*nx+(a.vy-b.vy)*ny;
    if(closing<=0)continue;
    const impulse=closing*1.22/inverseMass;
    a.vx-=nx*impulse*a.inverseMass;a.vy-=ny*impulse*a.inverseMass;
    b.vx+=nx*impulse*b.inverseMass;b.vy+=ny*impulse*b.inverseMass;
    if(impulse>9){
      impartPropTorque(a,-nx,-ny,impulse*.62*a.inverseMass);
      impartPropTorque(b,nx,ny,impulse*.8*b.inverseMass);
    }
  }
  for(let i=0;i<placed.length;i++){
    const item=placed[i],shape=shapes[i];
    if(!item.inverseMass)continue;
    const ex=item.radius+Math.abs(shape.dx)*shape.spine;
    const ey=item.radius+Math.abs(shape.dy)*shape.spine;
    const x=clamp(item.x,-YARD_X+ex,YARD_X-ex),y=clamp(item.y,-YARD_Y+ey,YARD_Y-ey);
    if(x!==item.x){item.x=x;item.vx*=-.34;}
    if(y!==item.y){item.y=y;item.vy*=-.34;}
  }
}

function tickProps(dt){
  if(!propModels.size||dt<=0)return;
  const steps=Math.ceil(dt/(1/120));
  for(let i=0;i<steps;i++)physicsPropStep(dt/steps);
}

function vehicleFootprint(){
  if(isTank())return {radius:28,spine:15,mass:13};
  const units=ART_PIXELS_PER_UNIT*activeStack.ratio;
  if(activeStack.ant)return {radius:29,spine:17,mass:5.5};
  const hullWidth=chassis.width/(2*units);
  const tireWidth=tire? HALF_TRACK+tire.width/(2*units):0;
  const radius=Math.max(hullWidth,tireWidth);
  return {radius,spine:Math.max(0,chassis.length/(2*units)-radius),mass:selectedAsset.id==="inspection"?8:12};
}

function resolvePropContact(x,y,heading,dt){
  if(!propModels.size||!activeStack||(activeStack.custom&&!isTank()))return {x,y,loss:0};
  const {radius,spine,mass}=vehicleFootprint();
  const c=Math.cos(heading),s=Math.sin(heading);
  const vx=(x-robot.x)/Math.max(.001,dt),vy=(y-robot.y)/Math.max(.001,dt);
  let lostSpeed=0;
  for(const item of yardProps){
    if(!item.model)continue;
    const hit=capsuleContact({x,y,dx:c,dy:s,spine,radius},propCapsule(item));
    if(!hit)continue;
    const {nx,ny,overlap}=hit;
    const inverseMass=item.inverseMass+1/mass;
    const move=overlap/inverseMass;
    item.x+=nx*move*item.inverseMass;item.y+=ny*move*item.inverseMass;
    x-=nx*move/mass;y-=ny*move/mass;
    const closing=(vx-item.vx)*nx+(vy-item.vy)*ny;
    if(closing<=0)continue;
    const impulse=closing*1.15/inverseMass;
    const propImpulse=impulse*item.inverseMass;
    item.vx+=nx*propImpulse;item.vy+=ny*propImpulse;
    lostSpeed+=impulse/mass;
    if(closing<9||item.cooldown>0)continue;
    const tangent=vx*ny-vy*nx;
    if(item.tips){
      impartPropTorque(item,nx,ny,propImpulse,tangent);
      item.spin=clamp(item.spin+Math.sign((item.x-x)*c+(item.y-y)*s||1)*propImpulse*.015,-11,11);
    }
    item.cooldown=.19;
    obstacleHits++;
    updateObstacleTelemetry();
  }
  return {x,y,loss:Math.min(.6,lostSpeed/Math.max(1,Math.hypot(vx,vy)))};
}

const propCache=new Map();
let propProjection=new Int32Array(0),propDepth,propMask;

function propPose(item){
  if(item.tip<.0001)return {yaw:item.yaw,tip:0,twist:0};
  return {yaw:item.tiltYaw,tip:item.tip,twist:wrap(item.yaw-item.tiltYaw)};
}

function propSurfaceVoxels(model){
  const {width,length,layers,area,volume}=model;
  const hits=[];
  for(let z=0;z<layers;z++)for(let y=0;y<length;y++)for(let x=0;x<width;x++){
    const i=z*area+y*width+x;
    if(!volume[i])continue;
    if(!x||x===width-1||!y||y===length-1||!z||z===layers-1||
       !volume[i-1]||!volume[i+1]||!volume[i-width]||!volume[i+width]||
       !volume[i-area]||!volume[i+area])hits.push(i);
  }
  return Uint32Array.from(hits);
}

function drawTippedStack(part){
  const {model,x:cx,y:cy,z:baseZ,yaw,roll,twist,spacing}=part;
  const {width,length,layers,area,layerStep}=model;
  const c=Math.cos(yaw),s=Math.sin(yaw),rc=Math.cos(roll),rs=Math.sin(roll);
  const tc=Math.cos(twist),ts=Math.sin(twist);
  const halfX=(width-1)/2,halfY=(length-1)/2,halfZ=(layers-1)*layerStep/2;
  const rays=partLighting(c,s,rc,rs,false);
  if(twist) for(const ray of [rays.light,rays.eye,rays.half,rays.up,rays.panel]){
    const x=ray[0],y=ray[1];ray[0]=x*tc+y*ts;ray[1]=-x*ts+y*tc;
  }
  const normals=detailNormal?model.detailedNormals:model.normals;
  for(const i of model.surfaceVoxels){
    const layer=Math.floor(i/area),row=Math.floor((i%area)/width),col=i%width;
    const x=col-halfX,y=row-halfY,z=layer*layerStep-halfZ;
    const tx=x*tc-y*ts,ty=x*ts+y*tc;
    const ry=ty*rc+z*rs,level=-ty*rs+z*rc+halfZ+baseZ;
    const screenX=cx+tx*c-ry*s,screenY=cy+(tx*s+ry*c)*view.squash-level*spacing;
    const px=Math.round(screenX),py=Math.round(screenY);
    splatCoverage(screenX,screenY);
    if(px<1||px>=BUFFER-2||py<1||py>=BUFFER_HEIGHT-2)continue;
    const anchor=py*BUFFER+px;
    if(depth[anchor]>=level&&depth[anchor+1]>=level&&depth[anchor+BUFFER]>=level&&depth[anchor+BUFFER+1]>=level)continue;
    const color=(multiViewEnabled&&model.viewColors[i])||model.volume[i];
    const n=i*3;
    const lit=materialLight?materialPixel(color,model.material[i],(model.ambient[i]||255)/255,
      normals[n],normals[n+1],normals[n+2],rays,specularSpread(model,i)):color;
    for(let a=0;a<2;a++)for(let b=0;b<2;b++){
      const dst=anchor+a*BUFFER+b;
      if(level<=depth[dst])continue;
      depth[dst]=level;spritePixels[dst]=lit;bodyMask[dst]=1;
    }
  }
}

function drawPropStamp(model,tile,yaw,tip,twist){
  const height=(model.layers-1)*model.layerStep;
  const padding=Math.ceil(Math.hypot(model.width,model.length,height)/2)+5;
  const w=padding*2,h=Math.ceil(height*environmentView.propSpacing)+w;
  if(!tile.canvas){
    tile.canvas=document.createElement("canvas");
    tile.ctx=tile.canvas.getContext("2d");
  }
  if(tile.canvas.width!==w||tile.canvas.height!==h){
    tile.canvas.width=w;tile.canvas.height=h;
    tile.image=tile.ctx.createImageData(w,h);
    tile.pixels=new Uint32Array(tile.image.data.buffer);
    tile.groundY=h-padding;
  }
  if(!propDepth||propDepth.length<tile.pixels.length){
    propDepth=new Float32Array(tile.pixels.length);
    propMask=new Uint8Array(tile.pixels.length);
  }
  if(propProjection.length<tile.pixels.length)propProjection=new Int32Array(tile.pixels.length);
  const saved={w:BUFFER,h:BUFFER_HEIGHT,pixels:spritePixels,mask:bodyMask,depth,projection:projectedCells,aa:activeEdges};
  try{
    BUFFER=w;BUFFER_HEIGHT=h;spritePixels=tile.pixels;
    bodyMask=propMask;depth=propDepth;projectedCells=propProjection;
    spritePixels.fill(0);bodyMask.fill(0,0,tile.pixels.length);depth.fill(-1,0,tile.pixels.length);
    beginSubpixelPass(propEdges);
    const support=Math.cos(tip)*height*.5+Math.sin(tip)*model.length*.47-height*.5;
    const part={model,x:padding,y:tile.groundY,z:support,yaw,roll:tip||null,twist,spacing:environmentView.propSpacing};
    (meshEnabled?drawMesh:tip?drawTippedStack:drawPart)(part);
    if(!meshEnabled&&!tip)sampleStackEdges([part]);
    const outline=pack(29,39,31,216);
    if(!finishSubpixelPass(outline))for(let y=1;y<h-1;y++)for(let x=1,i=y*BUFFER+1;x<BUFFER-1;x++,i++){
      if(!bodyMask[i]&&(bodyMask[i-1]||bodyMask[i+1]||bodyMask[i-BUFFER]||bodyMask[i+BUFFER]))spritePixels[i]=outline;
    }
    tile.ctx.putImageData(tile.image,0,0);
    return tile;
  } finally {
    BUFFER=saved.w;BUFFER_HEIGHT=saved.h;spritePixels=saved.pixels;bodyMask=saved.mask;
    depth=saved.depth;projectedCells=saved.projection;activeEdges=saved.aa;
  }
}

function propStamp(item){
  const {yaw,tip,twist}=propPose(item);
  // Animated bodies keep exact angles. Only settled poses use the shared atlas cache.
  const unsettled=item.fallen?Math.PI/2-item.tip>.009:item.tip>.0001;
  const moving=unsettled||Math.abs(item.tipVelocity)>.025||Math.abs(item.rollSpeed)>.02||Math.abs(item.spin)>.02;
  if(moving)return drawPropStamp(item.model,item.tile??={},yaw,tip,twist);
  item.tile=null;
  const quantize=(angle,bins)=>Math.round(angle*bins/TAU)*TAU/bins;
  const a=quantize(yaw,24),r=tip>.01?Math.PI/2:0,t=quantize(twist,48);
  const key=[item.type,a,r,t,environmentView.propSpacing,view.squash,+meshEnabled,+multiViewEnabled,+detailNormal,+materialLight,+subpixelAAEnabled,+specularAAEnabled].join(":");
  if(propCache.has(key)){
    const tile=propCache.get(key);
    propCache.delete(key);propCache.set(key,tile);
    return tile;
  }
  const tile=drawPropStamp(item.model,{},a,r,t);
  propCache.set(key,tile);
  if(propCache.size>85)propCache.delete(propCache.keys().next().value);
  return tile;
}

function visibleProps(centerX,centerY,scale,width,height){
  const result=[];
  for(const item of yardProps){
    if(!item.model)continue;
    const x=centerX+(item.x-camera.x)*scale;
    const y=centerY+(item.y-camera.y)*view.squash*scale;
    const margin=(item.radius+item.spine+item.halfHeight)*scale;
    const visibleHeight=margin+(item.halfHeight*2+item.hop)*scale*environmentView.propSpacing;
    if(x+margin<0||x-margin>width||y+margin<0||y-visibleHeight>height)continue;
    result.push({item,x,y});
  }
  return result.sort((a,b)=>a.y-b.y);
}
function drawPropShadow(target,entry,scale){
  const {item,x,y}=entry;
  const shape=propCapsule(item);
  const angle=Math.atan2(shape.dy*view.squash,shape.dx);
  const shadowWidth=(item.radius+shape.spine)*scale;
  const shadowDepth=item.radius*scale*view.squash;
  target.fillStyle=`rgba(20,29,39,${Math.max(.1,.66-item.hop*.075)})`;
  target.beginPath();
  target.ellipse(x+2*scale,y+1.5*scale,shadowWidth,shadowDepth,angle,0,TAU);
  target.fill();
}
function drawYardProp(target,entry,scale){
  const artScale=scale*PROP_ART_SCALE;
  const tile=propStamp(entry.item);
  target.drawImage(tile.canvas,Math.round(entry.x-tile.canvas.width/2*artScale),
    Math.round(entry.y-tile.groundY*artScale-entry.item.hop*scale*environmentView.propSpacing),
    tile.canvas.width*artScale,tile.canvas.height*artScale);
}
const DEFAULT_LAYERS = 90, DEFAULT_TEXTURE_SCALE=1.5;
const layerSlider=document.getElementById("layerCount");
const layerValue=document.getElementById("layerValue");
const textureSlider=document.getElementById("textureScale");
const textureValue=document.getElementById("textureValue");
const pipelineStatus=document.getElementById("pipelineStatus");
const activeLayers=document.getElementById("activeLayers");
const inMemory=new Map();
const vehiclePicker=document.getElementById("vehiclePicker");
const vehicleOptions=[...vehiclePicker.querySelectorAll("[data-vehicle]")];
const customVehicleOption=vehicleOptions.find(button=>button.dataset.vehicle==="custom");
const assetTitle=document.getElementById("assetTitle");
const fourViewFile=document.getElementById("fourViewFile");
let selectedAsset=ASSETS.rover, importedAsset=null;
let fileRequest=0;
const lastResolution={common:{layers:DEFAULT_LAYERS,ratio:DEFAULT_TEXTURE_SCALE},ant:{layers:56,ratio:1}};
const textureRatioOf=stack=>stack.textureRatio??stack.ratio;

function syncResolutionLabels() {
  layerValue.value=String(layerSlider.valueAsNumber);
  textureValue.value=textureSlider.valueAsNumber.toFixed(2)+"×";
  layerSlider.setAttribute("aria-valuetext",layerValue.value+" layers");
  textureSlider.setAttribute("aria-valuetext",textureValue.value);
}
let activeStack=null, requestedLayers=DEFAULT_LAYERS, requestedRatio=DEFAULT_TEXTURE_SCALE, requestSequence=0, inputTimer=0, worker;

function installStack(stack) {
  if(activeStack===stack) return;
  activeStack=stack;
  resetFrameMeter();
  chassis=stack.body;
  tire=stack.wheel;
  rollMap=tire?new Int32Array(tire.layers*tire.length):null;
  lastAngle=null;
  lastSpacing=null;
  lastSquash=null;
  activeLayers.textContent=stack.ant ? `Body: ${chassis.layers} layers · Center/angled legs: ${stack.center.layers} layers` :
    `Body: ${chassis.width} × ${chassis.length} px · ${chassis.layers} layers`;
  updateAbilityUI();
  pipelineStatus.dataset.activeLayers=String(chassis.layers);
  pipelineStatus.dataset.wheelLayers=String(tire?.layers??0);
  pipelineStatus.dataset.vehicle=selectedAsset.id;
  pipelineStatus.dataset.meshTriangles=String(chassis.meshIndices.length/3);
  pipelineStatus.dataset.wheelMeshTriangles=String(tire?tire.meshIndices.length/3:0);
  pipelineStatus.dataset.textureScale=String(textureRatioOf(stack));
  pipelineStatus.dataset.bodyPixels=`${chassis.width}x${chassis.length}`;
}
function retainStack(stack) {
  const key=stack.layers+":"+textureRatioOf(stack);
  inMemory.delete(key);
  inMemory.set(key,stack);
  if(inMemory.size>3) inMemory.delete(inMemory.keys().next().value);
}
function reportStack(source,ms,persisted,preview) {
  pipelineStatus.dataset.source=source;
  enableGpuWhenReady(preview);
  pipelineStatus.dataset.elapsed=String(Math.round(ms));
  pipelineStatus.dataset.persisted=String(persisted);
  const message=source==="memory" ? "Memory cache" : source==="disk" ? "Disk cache" : selectedAsset.parts ?
    (activeStack.layers===selectedAsset.parts.body.n&&textureRatioOf(activeStack)===1?"Loaded source stack":"Resampled source stack") : "Built from source";
  const elapsed=source==="memory" ? "" : ` · ${Math.round(ms)} ms`;
  pipelineStatus.value=`${message}${elapsed}${preview ? " · Building high-resolution model" : ""}`;
}
function requestLayers(layers,ratio,progressive=false) {
  requestedLayers=layers;
  requestedRatio=ratio;
  const sequence=++requestSequence;
  const cached=inMemory.get(layers+":"+ratio);
  if(cached) {
    worker.postMessage({type:"cancel",sequence});
    retainStack(cached);
    installStack(cached);
    reportStack("memory",0,cached.persisted,false);
    return;
  }
  pipelineStatus.dataset.source="pending";
  pipelineStatus.value=`Building ${layers} layers at ${ratio.toFixed(2)}×…`;
  worker?.postMessage({type:"stack",sequence,layers,ratio,progressive});
}
function switchAsset(asset) {
  clearTimeout(inputTimer);
  lastResolution[selectedAsset.parts?"ant":"common"]={layers:layerSlider.valueAsNumber,ratio:textureSlider.valueAsNumber};
  const resolution=lastResolution[asset.parts?"ant":"common"];
  layerSlider.value=resolution.layers;
  textureSlider.value=resolution.ratio;
  syncResolutionLabels();
  worker?.terminate();
  worker=null;
  inMemory.clear();
  activeStack=null;
  chassis=null;
  tire=null;
  pipelineStatus.dataset.activeLayers="";
  pipelineStatus.dataset.vehicle="";
  activeLayers.textContent="";
  mobilitySpacing.set(selectedAsset,view.spacing);
  selectedAsset=asset;
  for(const button of vehicleOptions){
    button.setAttribute("aria-pressed",String(button.dataset.vehicle===asset.id));
  }
  const spacing=viewSliders.find(slider=>slider.key==="spacing");
  spacing.input.value=mobilitySpacing.get(asset)??DEFAULT_VIEW.spacing;
  spacing.sync();
  const {profile}=asset;
  BODY_CLEARANCE=profile.body_clearance;
  FRONT_AXLE=profile.front_axle;
  REAR_AXLE=profile.rear_axle;
  WHEEL_DIAMETER=profile.wheel?.layers??0;
  TIRE_RADIUS=WHEEL_DIAMETER/(2*ART_PIXELS_PER_UNIT);
  WHEELBASE=(FRONT_AXLE-REAR_AXLE)/ART_PIXELS_PER_UNIT;
  HALF_TRACK=profile.half_track/ART_PIXELS_PER_UNIT;
  CENTER_TO_REAR=-REAR_AXLE/ART_PIXELS_PER_UNIT;
  assetTitle.textContent=asset.title;
  patrolButton.textContent=asset.custom?"Auto-Rotate":"Auto Patrol";
  manualButton.textContent=asset.custom?"Stop":"Manual";
  document.querySelectorAll(".touch button[data-key='forward'],.touch button[data-key='reverse']")
    .forEach(button=>{button.disabled=!!asset.custom&&asset.id!=="tank";});
  status.value="Loading";
  speed.value="—";
  clearInputs();
  resetRobot();
  configureMobilityUI();
  configureTankUI();
  try {
    const workerURL=URL.createObjectURL(new Blob([WORKER_SOURCE],{type:"text/javascript"}));
    worker=new Worker(workerURL);
    URL.revokeObjectURL(workerURL);
    worker.onerror=()=>{pipelineStatus.dataset.source="error";pipelineStatus.value="Could not start the reconstruction worker.";};
    worker.onmessage=({data})=>{
      if(data.type==="ready") {
        data.stack.persisted=data.persistent;
        retainStack(data.stack);
      }
      if(data.sequence!==requestSequence) return;
      if(data.type==="error") {
        pipelineStatus.dataset.source="error";
        pipelineStatus.value=data.message;
        return;
      }
      installStack(data.stack);
      reportStack(data.source,data.elapsed,data.persistent,data.stack.layers!==requestedLayers||textureRatioOf(data.stack)!==requestedRatio);
    };
    worker.postMessage({type:"init",plates:{body:asset.body,wheel:asset.wheel,parts:asset.parts},version:asset.version,profile,
      defaultLayers:asset.parts?.body.n??DEFAULT_LAYERS,defaultRatio:asset.parts?1:DEFAULT_TEXTURE_SCALE});
    layerSlider.disabled=false;
    textureSlider.disabled=false;
    requestLayers(layerSlider.valueAsNumber,textureSlider.valueAsNumber,!asset.parts);
  } catch {
    pipelineStatus.value="This browser could not open the reconstruction worker.";
    layerSlider.disabled=true;
    textureSlider.disabled=true;
  }
}
vehiclePicker.addEventListener("click",event=>{
  const button=event.target.closest("[data-vehicle]");
  if(!button)return;
  ++fileRequest;
  const id=button.dataset.vehicle;
  const asset=id==="custom"?importedAsset:ASSETS[id];
  if(asset&&(asset!==selectedAsset||pipelineStatus.dataset.source==="error"))switchAsset(asset);
});
vehiclePicker.addEventListener("keydown",event=>{
  const controls={ArrowLeft:-1,ArrowUp:-1,ArrowRight:1,ArrowDown:1,Home:0,End:0};
  if(!Object.hasOwn(controls,event.code))return;
  const enabled=vehicleOptions.filter(button=>!button.hidden);
  const index=enabled.indexOf(event.target);
  if(index<0)return;
  event.preventDefault();
  event.stopPropagation();
  const target=event.code==="Home"?0:event.code==="End"?enabled.length-1:
    (index+controls[event.code]+enabled.length)%enabled.length;
  enabled[target].focus();
});
document.getElementById("openFourViews").addEventListener("click",()=>fourViewFile.click());
fourViewFile.addEventListener("change",()=>{
  const file=fourViewFile.files[0];
  fourViewFile.value="";
  if(!file)return;
  if(!/\.png$/i.test(file.name)||file.size>15*1024*1024){
    pipelineStatus.value="Choose a four-view PNG of 15 MB or less.";
    return;
  }
  const request=++fileRequest;
  const reader=new FileReader();
  reader.onload=()=>{
    if(request!==fileRequest)return;
    customVehicleOption.hidden=false;
    importedAsset={id:"custom",title:"Custom Four-View Asset",body:reader.result.split(",")[1],wheel:null,version:"custom",
      profile:{body:{width:80,length:188,layers:90},body_clearance:0,front_axle:0,rear_axle:0,half_track:0},
      custom:true};
    switchAsset(importedAsset);
  };
  reader.onerror=()=>{pipelineStatus.value="Could not read the PNG file.";};
  reader.readAsDataURL(file);
});

function start() {
  makeYard();
  resetProps();
  measurePropBuild();
  patrolButton.setAttribute("aria-pressed",String(robot.mode==="patrol"));
  manualButton.setAttribute("aria-pressed",String(robot.mode==="manual"));
  resize();
  new ResizeObserver(resize).observe(canvas);
  switchAsset(ASSETS.rover);
  let previous=performance.now();
  function frame(now) {
    const dt=clamp((now-previous)/1000,0,.04);
    previous=now;
    tickProps(dt);
    if(activeStack) update(dt);
    const renderStart=performance.now();
    render();
    sampleFrameMeter(now,performance.now()-renderStart);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}
function commitLayerCount() {
  clearTimeout(inputTimer);
  const count=layerSlider.valueAsNumber;
  const ratio=textureSlider.valueAsNumber;
  if (count!==requestedLayers || ratio!==requestedRatio) requestLayers(count,ratio);
}
for(const input of [layerSlider,textureSlider]) {
  input.addEventListener("input",()=>{
    syncResolutionLabels();
    clearTimeout(inputTimer);
    inputTimer=setTimeout(commitLayerCount,140);
  });
  input.addEventListener("change",commitLayerCount);
}
