let choseRenderer=false;
let sceneRendererMode="cpu";
let gpuSceneRenderer=null;
let propBuildMs=null;
const benchmarkStatus=document.getElementById("propBenchmarkStatus");
const cpuButton=document.getElementById("cpuScene");
const gpuButton=document.getElementById("gpuScene");
const replayButton=document.getElementById("replayProps");
const propLayout=document.getElementById("propLayout");
const gpuSceneLayer=document.getElementById("gpuSceneLayer");
const effectsLayer=document.getElementById("sceneEffectsLayer");
const effectsContext=effectsLayer.getContext("2d");
let rendererIssue="";
const standardSpawns=Object.fromEntries(Object.entries(propSpawns));
const denseSpawns=Object.fromEntries(Object.keys(propSpawns).map(type=>[type,[]]));
for(let i=0;i<96;i++){
  const type=i%8===0?"plastic-barrier":i%8===4?"concrete-barrier":i%8===6?"wet-floor-sign":"traffic-cone";
  denseSpawns[type].push([(i%12-5.5)*77,(Math.floor(i/12)-3.5)*64,(i%3-1)*.21]);
}

function showBenchmarkStatus(){
  const baked=[...propModels.values()].filter(model=>model.benchmarkSource==="build").length;
  const cached=propModels.size-baked;
  const startup=propBuildMs===null?"Building prop models…":
    "Prop load "+Math.round(propBuildMs)+" ms ("+baked+" built, "+cached+" cached)";
  const gpu=gpuSceneRenderer?" · GPU upload CPU "+gpuSceneRenderer.uploadMs().toFixed(1)+" ms":"";
  const mode=sceneRendererMode==="gpu"?" · Models use cached GPU buffers":"";
  const value=startup+gpu+mode+(rendererIssue?" · "+rendererIssue:"");
  if(benchmarkStatus.value!==value)benchmarkStatus.value=value;
}

async function measurePropBuild(){
  const start=performance.now();
  await loadProps();
  propBuildMs=performance.now()-start;
  replayButton.disabled=false;
  showBenchmarkStatus();
}

function useSceneRenderer(mode){
  if(mode==="gpu"&&!gpuSceneRenderer){
    try{
      gpuSceneRenderer=makeGpuSceneRenderer(gpuSceneLayer);
    }catch(error){
      gpuButton.disabled=true;
      rendererIssue=error.message;
      showBenchmarkStatus();
      return;
    }
  }
  sceneRendererMode=mode;
  gpuSceneLayer.hidden=mode!=="gpu";
  cpuButton.setAttribute("aria-pressed",String(mode==="cpu"));
  gpuButton.setAttribute("aria-pressed",String(mode==="gpu"));
  for(const id of ["meshMode","detailNormal","subpixelAA","specularAA"]){
    document.getElementById(id).disabled=mode==="gpu";
  }
  lastAngle=null;lastSpacing=null;lastSquash=null;
  resetFrameMeter();
  showBenchmarkStatus();
}

function enableGpuWhenReady(preview){
  if(preview||choseRenderer||gpuButton.disabled||gpuSceneRenderer)return;
  useSceneRenderer("gpu");
}

function drawSceneEffects(target,gpuMode,width,height,centerX,centerY,scale,aimScale){
  const crosshair=activeStack?.ant&&aimPointer.active;
  const shot=isTank()&&tankShot.particles.length>0;
  effectsLayer.hidden=!(gpuMode&&(crosshair||shot));
  if(!crosshair&&!shot)return;
  if(gpuMode){
    if(effectsLayer.width!==width||effectsLayer.height!==height){
      effectsLayer.width=width;
      effectsLayer.height=height;
    }
    effectsContext.clearRect(0,0,width,height);
    target=effectsContext;
  }
  if(shot)drawTankShotEffects(target,centerX,centerY,scale);
  if(crosshair)drawAntAim(target,width,height,aimScale);
}

function drawGpuVehicleShadow(target,centerX,groundY,scale){
  const {radius,spine}=vehicleFootprint();
  const x=centerX+(robot.x-camera.x)*scale;
  const angle=Math.atan2(Math.sin(robot.heading)*view.squash,Math.cos(robot.heading));
  target.fillStyle="rgba(16,22,29,.36)";
  target.beginPath();
  target.ellipse(x+4*scale,groundY+3*scale,
    (radius+spine)*scale,radius*view.squash*scale,angle,0,TAU);
  target.fill();
}

function placeBenchmarkVehicle(){
  if(isTank())resetTank();
  setMode("manual");
  clearInputs();
  Object.assign(robot,{x:0,y:25,heading:2.46,velocity:0,omega:0,steering:0});
  camera.x=0;camera.y=18;
  if(isTank())tankDrive.turretHeading=robot.heading;
  lastAngle=null;
}

function replayPropMotion(){
  resetProps();
  placeBenchmarkVehicle();
  for(const [index,item] of yardProps.entries()){
    if(!item.model||!item.inverseMass)continue;
    const angle=index*2.399963;
    item.vx=Math.cos(angle)*36*item.inverseMass;
    item.vy=Math.sin(angle)*36*item.inverseMass;
    item.spin=(index%2?1:-1)*1.25*item.inverseMass;
    if(item.tips){
      item.rise=27;
      impartPropTorque(item,Math.cos(angle),Math.sin(angle),42);
    }
  }
  resetFrameMeter();
}

replayButton.disabled=true;
cpuButton.addEventListener("click",()=>{choseRenderer=true;useSceneRenderer("cpu");});
gpuButton.addEventListener("click",()=>{choseRenderer=true;useSceneRenderer("gpu");});
replayButton.addEventListener("click",replayPropMotion);
propLayout.addEventListener("change",()=>{
  Object.assign(propSpawns,propLayout.value==="dense"?denseSpawns:standardSpawns);
  resetProps();
  placeBenchmarkVehicle();
  resetFrameMeter();
});

gpuSceneLayer.addEventListener("webglcontextlost",event=>{
  event.preventDefault();
  gpuSceneRenderer=null;
  gpuButton.disabled=true;
  rendererIssue="WebGL context lost; using CPU";
  useSceneRenderer("cpu");
});
gpuSceneLayer.addEventListener("webglcontextrestored",()=>{
  gpuButton.disabled=false;
  rendererIssue="";
  if(!choseRenderer)enableGpuWhenReady(false);
  else showBenchmarkStatus();
});
