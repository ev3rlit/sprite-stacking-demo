const tankShot={cooldown:0,particles:[]};
const tracerSpeed=1820;
const impactRadius=94;

function resetTankShotEffects(){
  Object.assign(tankShot,{cooldown:0,particles:[]});
}

function findTankMuzzle(model){
  const {width,length,layers,layerStep,area,volume}=model;
  for(let y=length-1;y>=0;y--){
    let low=layers,high=-1;
    for(let z=0;z<layers;z++)for(let x=0;x<width;x++){
      if(!volume[z*area+y*width+x])continue;
      low=Math.min(low,z);
      high=Math.max(high,z);
    }
    if(high>=0)return {forward:y-(length-1)*tankMounts.turretPivot,z:(low+high)*layerStep/2};
  }
  return {forward:0,z:0};
}

function tankMuzzle({forward,z}){
  const ratio=activeStack.ratio,units=ART_PIXELS_PER_UNIT*ratio;
  const heading=tankDrive.turretHeading;
  const ring=tankMounts.turretRingY/ART_PIXELS_PER_UNIT;
  const reach=forward/units;
  return {x:robot.x+Math.cos(robot.heading)*ring+Math.cos(heading)*reach,
    y:robot.y+Math.sin(robot.heading)*ring+Math.sin(heading)*reach,
    z:(tankMounts.baseHeight*ratio+(chassis.layers-1)*chassis.layerStep-2*ratio+z)/units};
}

function spawnTankParticle(kind,origin,heading,time,options={}){
  tankShot.particles.push({kind,...origin,heading,time,age:0,...options});
}

function triggerTankShot(){
  if(!isTank()||!activeStack||tankShot.cooldown>0)return;
  const parts=tankPartsByRatio.get(activeStack.ratio);
  if(!parts?.muzzle)return;
  const heading=tankDrive.turretHeading;
  const muzzle=tankMuzzle(parts.muzzle);
  tankShot.cooldown=1.05;
  spawnTankParticle("flash",muzzle,heading,.12);
  const duration=.68,range=tracerSpeed*duration;
  const preview=traceTankStage(muzzle.x,muzzle.y,Math.cos(heading)*range,Math.sin(heading)*range);
  spawnTankParticle("bolt",muzzle,heading,duration,{speed:tracerSpeed,radius:3.2,tail:62,
    viewDistance:preview?Math.max(1,preview.t*range):range,
    impactZ:preview?tankImpactHeight(preview,muzzle.z):muzzle.z});
  for(let i=0;i<13;i++){
    const angle=heading+(Math.random()-.5)*1.3;
    const speed=11+Math.random()*33;
    spawnTankParticle("smoke",muzzle,angle,.45+Math.random()*.6,
      {speed,radius:3+Math.random()*3,spread:4+Math.random()*8});
  }
}

canvas.addEventListener("click",()=>triggerTankShot());
window.addEventListener("keydown",event=>{
  if(!isTank()||event.code!=="KeyF"||event.repeat||event.altKey||event.ctrlKey||event.metaKey)return;
  event.preventDefault();
  triggerTankShot();
});

function segmentCircleEntry(x,y,dx,dy,cx,radius){
  const ox=x-cx,a=dx*dx+dy*dy,c=ox*ox+y*y-radius*radius;
  if(c<=0)return 0;
  if(a<1e-8)return Infinity;
  const b=ox*dx+y*dy,discriminant=b*b-a*c;
  if(discriminant<0)return Infinity;
  const t=(-b-Math.sqrt(discriminant))/a;
  return t>=0&&t<=1?t:Infinity;
}

function segmentCapsuleEntry(x,y,dx,dy,capsule){
  const ox=x-capsule.x,oy=y-capsule.y;
  const u=ox*capsule.dx+oy*capsule.dy,v=-ox*capsule.dy+oy*capsule.dx;
  const du=dx*capsule.dx+dy*capsule.dy,dv=-dx*capsule.dy+dy*capsule.dx;
  const {spine,radius}=capsule;
  let near=0,far=1;
  for(const [origin,delta,limit] of [[u,du,spine],[v,dv,radius]]){
    if(Math.abs(delta)<1e-8){
      if(Math.abs(origin)>limit){near=Infinity;break;}
    }else{
      const a=(-limit-origin)/delta,b=(limit-origin)/delta;
      near=Math.max(near,Math.min(a,b));
      far=Math.min(far,Math.max(a,b));
    }
  }
  const bar=near<=far?near:Infinity;
  return Math.min(bar,segmentCircleEntry(u,v,du,dv,-spine,radius),
    segmentCircleEntry(u,v,du,dv,spine,radius));
}

function traceTankStage(x,y,dx,dy){
  let first=Infinity;
  let prop=null;
  if(dx&&Math.abs(x+dx)>YARD_X)first=((dx>0?YARD_X:-YARD_X)-x)/dx;
  if(dy&&Math.abs(y+dy)>YARD_Y)first=Math.min(first,((dy>0?YARD_Y:-YARD_Y)-y)/dy);
  for(const item of yardProps){
    if(!item.model)continue;
    const hit=segmentCapsuleEntry(x,y,dx,dy,propCapsule(item));
    if(hit<first){first=hit;prop=item;}
  }
  return first>=0&&first<=1 ? {t:first,prop} : null;
}

function tankImpactHeight(hit,muzzleHeight){
  return Math.min(muzzleHeight,hit.prop?hit.prop.halfHeight*1.2+hit.prop.hop:3);
}

function tracerAltitude(item,distance){
  return item.z+(item.impactZ-item.z)*clamp(distance/item.viewDistance,0,1);
}

function pushTankImpactProps(origin,heading){
  for(const item of yardProps){
    if(!item.model||!item.inverseMass)continue;
    const shape=propCapsule(item);
    const dx=item.x-origin.x,dy=item.y-origin.y;
    const contact=clamp(-dx*shape.dx-dy*shape.dy,-shape.spine,shape.spine);
    const leverX=shape.dx*contact,leverY=shape.dy*contact;
    const gap=Math.max(0,Math.hypot(dx+leverX,dy+leverY)-shape.radius);
    if(gap>=impactRadius)continue;

    const strength=(1-gap/impactRadius)**2;
    const distance=Math.hypot(dx,dy);
    const nx=distance>1e-4?dx/distance:Math.cos(heading);
    const ny=distance>1e-4?dy/distance:Math.sin(heading);
    const impulse=184*strength*item.inverseMass;
    item.vx+=nx*impulse;
    item.vy+=ny*impulse;
    if(item.tips){
      if(strength>.14)item.rise=Math.max(item.rise,72*strength);
      impartPropTorque(item,nx,ny,impulse*.83);
    }else{
      const inertia=shape.spine**2/3+shape.radius**2;
      const spin=(leverX*ny-leverY*nx)*impulse/inertia;
      item.spin=clamp(item.spin+spin,-4.5,4.5);
    }
  }
}

function addImpactBurst(origin,heading){
  pushTankImpactProps(origin,heading);
  spawnTankParticle("blast",origin,heading,.44,{radius:32});
  for(let i=0;i<10;i++){
    const angle=i/10*TAU+Math.random()*.32;
    spawnTankParticle("debris",origin,angle,.16+Math.random()*.20,
      {speed:37+Math.random()*100,radius:1.7+Math.random()*1.8});
  }
  for(let i=0;i<12;i++){
    const angle=Math.random()*TAU;
    spawnTankParticle("smoke",origin,angle,.48+Math.random()*.52,
      {speed:10+Math.random()*32,radius:3+Math.random()*4,spread:9+Math.random()*9,impact:true});
  }
}

function updateTankBullet(item,dt){
  const c=Math.cos(item.heading),s=Math.sin(item.heading);
  const used=Math.min(dt,item.time-item.age);
  if(used<=0)return;
  const x=item.x+c*item.speed*item.age,y=item.y+s*item.speed*item.age;
  const dx=c*item.speed*used,dy=s*item.speed*used;
  const hit=traceTankStage(x,y,dx,dy);
  if(!hit)return;
  const point={x:x+dx*hit.t,y:y+dy*hit.t,z:tankImpactHeight(hit,item.z)};
  const travel=item.speed*(item.age+used*hit.t);
  const extent=Math.min(item.tail,travel);
  spawnTankParticle("trail",point,item.heading,.12,{tail:extent,radius:item.radius,tailZ:tracerAltitude(item,travel-extent)});
  addImpactBurst(point,item.heading);
  item.age=item.time;
}

function updateTankShotEffects(dt){
  tankShot.cooldown=Math.max(0,tankShot.cooldown-dt);
  const count=tankShot.particles.length;
  for(let i=0;i<count;i++){
    const item=tankShot.particles[i];
    if(item.kind==="bolt")updateTankBullet(item,dt);
    item.age+=dt;
  }
  tankShot.particles=tankShot.particles.filter(item=>item.age<item.time);
}

function drawTankShotEffects(target,centerX,centerY,scale){
  if(!tankShot.particles.length)return;
  target.save();
  for(const item of tankShot.particles){
    const t=item.age/item.time;
    const distance=(item.speed??0)*item.age*(item.kind==="smoke"?1-.5*t:1);
    const z=item.kind==="bolt"?tracerAltitude(item,distance):item.z;
    const x=centerX+(item.x-camera.x+Math.cos(item.heading)*distance)*scale;
    const y=centerY+((item.y-camera.y+Math.sin(item.heading)*distance)*view.squash
      -(z+(item.kind==="smoke"?t*11:0))*view.spacing)*scale;
    if(item.kind==="smoke"){
      target.globalAlpha=(1-t)**1.2*.51;
      target.fillStyle=item.impact?"#8b8580":"#aeb4bf";
      target.beginPath();
      target.arc(x,y,(item.radius+item.spread*t)*scale,0,TAU);
      target.fill();
    }else if(item.kind==="bolt"||item.kind==="trail"){
      const extent=Math.min(item.tail,item.kind==="bolt"?distance:item.tail);
      const tail=extent*scale;
      const tailZ=item.kind==="bolt"?tracerAltitude(item,distance-extent):item.tailZ;
      const tx=x-Math.cos(item.heading)*tail;
      const ty=y-Math.sin(item.heading)*tail*view.squash+(z-tailZ)*view.spacing*scale;
      const fade=item.kind==="trail"?1-t:.9;
      const gradient=target.createLinearGradient(tx,ty,x,y);
      gradient.addColorStop(0,"rgba(255,111,34,0)");
      gradient.addColorStop(.68,"#ff9b48");
      gradient.addColorStop(1,"#fff2b7");
      target.globalAlpha=fade;
      target.strokeStyle=gradient;
      target.lineWidth=item.radius*scale*.9;
      target.lineCap="round";
      target.beginPath();target.moveTo(tx,ty);target.lineTo(x,y);target.stroke();
      target.fillStyle="#fff5cc";
      target.beginPath();target.arc(x,y,item.radius*scale*.54,0,TAU);target.fill();
    }else if(item.kind==="blast"){
      const ring=(7+(impactRadius-7)*t)*scale;
      target.globalAlpha=(1-t)**1.5*.58;
      target.strokeStyle="#ffb54b";
      target.lineWidth=Math.max(1,(2.4-1.4*t)*scale);
      target.beginPath();target.ellipse(x,y,ring,ring*view.squash,0,0,TAU);target.stroke();
      const flash=(9+item.radius*t)*scale;
      const glow=target.createRadialGradient(x,y,0,x,y,flash);
      glow.addColorStop(0,"#fff4c5");
      glow.addColorStop(.3,"rgba(255,151,48,.80)");
      glow.addColorStop(1,"rgba(255,94,32,0)");
      target.globalAlpha=(1-t)**1.55;
      target.fillStyle=glow;
      target.fillRect(x-flash,y-flash,flash*2,flash*2);
    }else if(item.kind==="debris"){
      target.globalAlpha=1-t;
      target.fillStyle="#ffca75";
      target.beginPath();target.arc(x,y,item.radius*scale*(1-.5*t),0,TAU);target.fill();
    }else{
      target.globalAlpha=1-t;
      target.fillStyle="#ffbe55";
      target.beginPath();
      target.arc(x,y,(5+t*9)*scale,0,TAU);
      target.fill();
      target.fillStyle="#fff6c9";
      target.beginPath();
      target.arc(x,y,(4-t*2)*scale,0,TAU);
      target.fill();
    }
  }
  target.restore();
}
