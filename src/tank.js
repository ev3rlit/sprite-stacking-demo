const isTank=()=>selectedAsset?.id==="tank";
const tankPartsByRatio=new Map();
const tankMounts={halfTrack:45,baseHeight:13,turretRingY:-6,turretPivot:.325};
const tankDrive={trackTravel:[0,0],turretHeading:0,pointer:null};
const {turret:tankTurretAsset,track:tankTrackAsset}=ASSETS.tank.attachments;
mobilityProfiles.tank={hint:"W / S forward and reverse · A / D steer · Mouse rotates turret · Click / F to fire · Space to stop"};
tuningDefinitions.tank=[
  {id:"forward",label:"Forward Speed",min:25,max:120,step:1,base:74,unit:" px/s"},
  {id:"reverse",label:"Reverse Speed",min:14,max:65,step:1,base:39,unit:" px/s"},
  {id:"turn",label:"Turn Rate",min:40,max:135,step:5,base:83,unit:"°/s"},
];

function configureTankUI(){
  patrolButton.hidden=isTank();
  if(isTank()){
    setMode("manual");
    canvas.style.cursor="crosshair";
  }
}

function resetTank(){
  Object.assign(robot,{x:-90,y:-38,heading:-.28,velocity:0,omega:0,steering:0});
  tankDrive.trackTravel.fill(0);
  tankDrive.turretHeading=robot.heading;
  tankDrive.pointer=null;
  resetTankShotEffects();
  camera.x=robot.x*.72;
  camera.y=robot.y*.72;
  setMode("manual");
  resetMobility();
  lastAngle=null;
}

canvas.addEventListener("pointermove",event=>{
  if(!isTank()||event.pointerType==="touch")return;
  const rect=canvas.getBoundingClientRect();
  tankDrive.pointer={x:(event.clientX-rect.left)/rect.width,y:(event.clientY-rect.top)/rect.height};
});
canvas.addEventListener("pointerleave",()=>{tankDrive.pointer=null;});

function updateTank(dt){
  const settings=activeTuning();
  const throttle=input("forward")-input("reverse");
  const steering=input("right")-input("left");
  const targetSpeed=throttle>=0?throttle*settings.forward:throttle*settings.reverse;
  const turnRate=settings.turn*Math.PI/180;
  robot.velocity+=(targetSpeed-robot.velocity)*(1-Math.exp(-9*dt));
  robot.omega+=(steering*turnRate-robot.omega)*(1-Math.exp(-12*dt));
  if(!throttle&&Math.abs(robot.velocity)<.2)robot.velocity=0;
  if(!steering&&Math.abs(robot.omega)<.008)robot.omega=0;
  const turn=robot.omega*dt,middle=robot.heading+turn/2;
  const c=Math.cos(middle),s=Math.sin(middle);
  const x=clamp(robot.x+robot.velocity*dt*c,-YARD_X+48,YARD_X-48);
  const y=clamp(robot.y+robot.velocity*dt*s,-YARD_Y+48,YARD_Y-48);
  const heading=wrap(robot.heading+turn);
  const contact=resolvePropContact(x,y,heading,dt);
  const nextX=clamp(contact.x,-YARD_X+48,YARD_X-48);
  const nextY=clamp(contact.y,-YARD_Y+48,YARD_Y-48);
  const travel=clamp((nextX-robot.x)*c+(nextY-robot.y)*s,Math.min(0,robot.velocity*dt),Math.max(0,robot.velocity*dt));
  Object.assign(robot,{x:nextX,y:nextY,heading,velocity:robot.velocity*(1-contact.loss)});
  const turnTravel=turn*tankMounts.halfTrack/ART_PIXELS_PER_UNIT;
  tankDrive.trackTravel[0]+=travel-turnTravel;
  tankDrive.trackTravel[1]+=travel+turnTravel;
  if(Math.abs(travel)+Math.abs(turn)>1e-5)lastAngle=null;

  if(tankDrive.pointer){
    const x=tankDrive.pointer.x-renderPose.x;
    const y=(tankDrive.pointer.y-renderPose.y)*renderPose.pitch/view.squash;
    if(Math.hypot(x,y)>.018){
      const change=wrap(Math.atan2(y,x)-tankDrive.turretHeading);
      if(Math.abs(change)>.0007){
        tankDrive.turretHeading=wrap(tankDrive.turretHeading+change*(1-Math.exp(-16*dt)));
        lastAngle=null;
      }
    }
  }
  const follow=1-Math.exp(-5*dt);
  camera.x+=(robot.x*.72-camera.x)*follow;
  camera.y+=(robot.y*.72-camera.y)*follow;
  updateTankShotEffects(dt);
  status.value=travel>.001?"Forward":travel<-.001?"Reverse":Math.abs(turn)>.002?"Turning":"Stopped";
  speed.value=Math.round(Math.abs(travel)/Math.max(dt,.001))+" px/s";
}

function requestTankParts(ratio){
  if(tankPartsByRatio.has(ratio))return;
  tankPartsByRatio.set(ratio,null);
  Promise.all([buildProp(tankTurretAsset,ratio),buildProp(tankTrackAsset,ratio)]).then(([turret,track])=>{
    tankPartsByRatio.set(ratio,{turret,track,muzzle:findTankMuzzle(turret)});
    if(isTank()){lastAngle=null;lastSpacing=null;}
  }).catch(error=>{
    if(isTank())pipelineStatus.value="Could not load the turret or tracks";
    console.warn(error.message);
  });
}

function tankBufferRadius(){return isTank()?99*activeStack.ratio:0;}
function tankBufferTop(){return isTank()?103*activeStack.ratio:0;}

function tankParts(heading){
  const ratio=activeStack.ratio,yaw=heading-Math.PI/2;
  const c=Math.cos(yaw),s=Math.sin(yaw);
  const parts=[{model:chassis,x:PIVOT_X,y:PIVOT_Y,z:tankMounts.baseHeight*ratio,yaw,roll:null}];
  requestTankParts(ratio);
  const attachments=tankPartsByRatio.get(ratio);
  if(!attachments)return parts;
  const {track,turret}=attachments;
  for(const [index,side] of [-1,1].entries()){
    const x=side*tankMounts.halfTrack*ratio;
    parts.push({model:track,x:PIVOT_X+x*c,y:PIVOT_Y+x*s*view.squash,z:0,
      yaw,roll:null,mirror:side<0,trackShift:tankDrive.trackTravel[index]*ART_PIXELS_PER_UNIT*ratio});
  }
  const ringY=tankMounts.turretRingY*ratio;
  parts.push({model:turret,x:PIVOT_X-ringY*s,y:PIVOT_Y+ringY*c*view.squash,
    z:tankMounts.baseHeight*ratio+(chassis.layers-1)*chassis.layerStep-2*ratio,
    yaw:tankDrive.turretHeading-Math.PI/2,roll:null,pivotY:(turret.length-1)*tankMounts.turretPivot});
  return parts;
}

// Map the tread surface around a closed loop in its local YZ section.
function trackBeltColor(model,x,y,z,shift,base){
  const radius=(model.layers-1)*model.layerStep/2;
  const span=(model.length-1)/2-radius;
  const u=y-(model.length-1)/2,v=z-radius;
  const distanceFromCenter=Math.hypot(u-clamp(u,-span,span),v);
  if(distanceFromCenter<radius*.77)return base;
  let distance;
  if(u>span)distance=2*span+(Math.atan2(v,u-span)+Math.PI/2)*radius;
  else if(u < -span){
    const angle=Math.atan2(v,u+span);
    distance=4*span+Math.PI*radius+((angle<0?angle+TAU:angle)-Math.PI/2)*radius;
  }else distance=v<0?u+span:3*span-u+Math.PI*radius;
  const repeatLength=(model.length-1)*.80;
  const phase=((distance+shift)%repeatLength+repeatLength)%repeatLength;
  const tread=samplePlane(model.sourceTop,model.width,model.length,x,(model.length-1)*.10+phase);
  if(!tread)return base;
  const mix=(a,b)=>Math.round(a*.23+b*.77);
  return pack(mix(base&255,tread&255),mix(base>>>8&255,tread>>>8&255),mix(base>>>16&255,tread>>>16&255));
}
