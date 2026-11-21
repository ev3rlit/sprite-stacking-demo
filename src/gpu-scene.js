const gpuSceneVertex=`#version 300 es
precision highp float;
in vec3 position;
in vec3 normal;
in vec3 location;
in vec3 rotation;
in vec4 geometry;
in vec4 deformation;
in vec2 tread;
uniform vec3 dimensions;
uniform vec2 viewportSize;
uniform float artScale;
uniform float squash;
uniform float spacing;
out vec3 sourcePosition;
out vec3 sourceNormal;
out vec3 lightNormal;
flat out vec2 trackState;
void main(){
  float halfZ=dimensions.z*.5;
  vec3 p=position-vec3(geometry.xy,halfZ);
  float ct=cos(rotation.z),st=sin(rotation.z);
  vec2 base=vec2(p.x*ct-p.y*st,p.x*st+p.y*ct)*geometry.zw;
  float cr=cos(rotation.y),sr=sin(rotation.y);
  float y=base.y*cr+p.z*sr;
  float z=(-base.y*sr+p.z*cr+halfZ)*deformation.x+location.z;
  float c=cos(rotation.x),s=sin(rotation.x);
  float blend=1.-clamp(position.z/max(.0001,dimensions.z),0.,1.);
  vec2 pixel=location.xy+(vec2(base.x*c-y*s,(base.x*s+y*c)*squash-z*spacing)+
    deformation.yz*blend)*artScale;
  float sortDepth=.38-.75*deformation.w/viewportSize.y;
  gl_Position=vec4(pixel.x/viewportSize.x*2.-1.,1.-pixel.y/viewportSize.y*2.,
    sortDepth-.00012*z,1.);
  sourcePosition=position;
  trackState=tread;
  sourceNormal=normal;
  vec3 n=vec3((normal.x*ct-normal.y*st)*geometry.z,(normal.x*st+normal.y*ct)*geometry.w,normal.z);
  float ny=n.y*cr+n.z*sr;
  lightNormal=vec3(n.x*c-ny*s,n.x*s+ny*c,-n.y*sr+n.z*cr);
}`;

const gpuSceneFragment=`#version 300 es
precision highp float;
in vec3 sourcePosition;
in vec3 sourceNormal;
in vec3 lightNormal;
flat in vec2 trackState;
uniform vec3 dimensions;
uniform sampler2D topView;
uniform sampler2D sideView;
uniform sampler2D frontView;
uniform sampler2D rearView;
uniform bool materialLight;
uniform bool multiView;
out vec4 color;
float delta(vec3 a,vec3 b){
  vec3 d=abs(a-b);
  return max(d.r,max(d.g,d.b));
}
vec3 trackColor(vec3 base){
  float r=dimensions.z*.5;
  float span=(dimensions.y-1.)*.5-r;
  float u=sourcePosition.y-(dimensions.y-1.)*.5;
  float v=sourcePosition.z-r;
  if(length(vec2(u-clamp(u,-span,span),v))<r*.77)return base;
  const float pi=3.14159265;
  float distance;
  if(u>span)distance=2.*span+(atan(v,u-span)+pi*.5)*r;
  else if(u < -span){
    float angle=atan(v,u+span);
    distance=4.*span+pi*r+((angle<0.?angle+pi*2.:angle)-pi*.5)*r;
  }else distance=v<0.?u+span:3.*span-u+pi*r;
  float height=dimensions.y-1.;
  float phase=mod(distance+trackState.y,height*.80);
  vec4 strip=texture(topView,vec2((sourcePosition.x+.5)/dimensions.x,(height*.10+phase+.5)/dimensions.y));
  return strip.a>.22?mix(base,strip.rgb,.77):base;
}
void main(){
  vec3 n=normalize(sourceNormal+vec3(0.,0.,.0001));
  vec3 p=clamp((sourcePosition+.5)/vec3(dimensions.xy,dimensions.z+1.),0.,1.);
  vec4 top=texture(topView,p.xy);
  vec4 side=texture(sideView,vec2(1.-p.y,1.-p.z));
  vec4 endView=n.y>=0.?texture(frontView,vec2(p.x,1.-p.z)):texture(rearView,vec2(1.-p.x,1.-p.z));
  vec3 weight=vec3(n.x*n.x,n.y*n.y,max(0.,n.z)*max(0.,n.z)) *
    step(vec3(.45),vec3(side.a,endView.a,top.a));
  vec3 chosen=weight.x>=weight.y&&weight.x>=weight.z?side.rgb:weight.y>=weight.z?endView.rgb:top.rgb;
  if(weight.x+weight.y+weight.z<.0001){
    chosen=side.a>.45?side.rgb:endView.a>.45?endView.rgb:top.a>.45?top.rgb:vec3(.48);
  }else if(multiView){
    weight*=step(vec3(delta(side.rgb,chosen),delta(endView.rgb,chosen),delta(top.rgb,chosen)),vec3(.26));
    chosen=(side.rgb*weight.x+endView.rgb*weight.y+top.rgb*weight.z)/(weight.x+weight.y+weight.z);
  }
  if(trackState.x>.5)chosen=trackColor(chosen);
  float shade=materialLight ? .76+.26*max(0.,dot(normalize(lightNormal+vec3(0.,0.,.0001)),normalize(vec3(-.45,-.6,1.4)))) : 1.;
  color=vec4(chosen*shade,1.);
}`;

function makeGpuSceneRenderer(layer){
  const gl=layer.getContext("webgl2",{alpha:true,antialias:false});
  if(!gl)throw new Error("WebGL 2 is unavailable. CPU props remain available.");

  function shader(type,source){
    const result=gl.createShader(type);
    gl.shaderSource(result,source);
    gl.compileShader(result);
    if(!gl.getShaderParameter(result,gl.COMPILE_STATUS))throw new Error(gl.getShaderInfoLog(result));
    return result;
  }

  function makeProgram(vertex,fragment,names){
    const program=gl.createProgram();
    for(const [type,source] of [[gl.VERTEX_SHADER,vertex],[gl.FRAGMENT_SHADER,fragment]]){
      const compiled=shader(type,source);
      gl.attachShader(program,compiled);
      gl.deleteShader(compiled);
    }
    gl.linkProgram(program);
    if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw new Error(gl.getProgramInfoLog(program));
    return {program,uni:Object.fromEntries(names.map(name=>[name,gl.getUniformLocation(program,name)]))};
  }

  function texture(filter){
    const result=gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D,result);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,filter);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,filter);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
    return result;
  }

  const props=makeProgram(gpuSceneVertex,gpuSceneFragment,["viewportSize","dimensions","artScale",
    "squash","spacing","topView","sideView","frontView","rearView","materialLight","multiView"]);
  const resources=new WeakMap();
  const attributeLayout=[["location",3],["rotation",3],["geometry",4],["deformation",4],["tread",2]];
  const fieldsPerInstance=16;
  let initialUploads=0,uploads=0;

  function prepare(model){
    const start=performance.now();
    const vao=gl.createVertexArray();
    gl.bindVertexArray(vao);
    for(const [name,data,type,normalized] of [
      ["position",model.meshXYZ,gl.FLOAT,false],["normal",model.meshNormals,gl.BYTE,true],
    ]){
      const buffer=gl.createBuffer(),location=gl.getAttribLocation(props.program,name);
      gl.bindBuffer(gl.ARRAY_BUFFER,buffer);
      gl.bufferData(gl.ARRAY_BUFFER,data,gl.STATIC_DRAW);
      gl.enableVertexAttribArray(location);
      gl.vertexAttribPointer(location,3,type,normalized,0,0);
    }
    const indices=gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,indices);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER,model.meshIndices,gl.STATIC_DRAW);
    const instanceBuffer=gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER,instanceBuffer);
    let offset=0;
    for(const [name,size] of attributeLayout){
      const location=gl.getAttribLocation(props.program,name);
      gl.enableVertexAttribArray(location);
      gl.vertexAttribPointer(location,size,gl.FLOAT,false,fieldsPerInstance*4,offset*4);
      gl.vertexAttribDivisor(location,1);
      offset+=size;
    }
    const textures=[];
    const images=[[model.sourceTop,model.width,model.length],[model.sourceSide,model.length,model.layers],
      [model.sourceFront,model.width,model.layers],[model.sourceRear,model.width,model.layers]];
    for(const [index,[source,width,height]] of images.entries()){
      gl.activeTexture(gl.TEXTURE0+index);
      textures.push(texture(gl.LINEAR));
      gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,width,height,0,gl.RGBA,gl.UNSIGNED_BYTE,
        new Uint8Array(source.buffer,source.byteOffset,source.byteLength));
    }
    const resource={vao,instanceBuffer,textures,data:new Float32Array(0)};
    resources.set(model,resource);
    initialUploads+=performance.now()-start;
    uploads++;
    return resource;
  }

  function groupPart(groups,part){
    const model=part.model;
    let group=groups.get(model);
    if(!group){group=[];groups.set(model,group);}
    group.push(part);
  }

  function drawGroups(groups,artScale,spacing){
    gl.uniform1f(props.uni.artScale,artScale);
    gl.uniform1f(props.uni.spacing,spacing);
    let instances=0;
    for(const [model,group] of groups){
      const resource=resources.get(model)??prepare(model);
      if(resource.data.length<group.length*fieldsPerInstance){
        resource.data=new Float32Array(group.length*fieldsPerInstance);
      }
      let offset=0;
      for(const part of group){
        const fields=[part.x,part.y,part.z,part.yaw,part.roll??0,part.twist??0,
          part.pivotX??(model.width-1)/2,part.pivotY??(model.length-1)/2,part.mirror?-1:1,part.flipY?-1:1,
          part.heightScale??1,part.flexX??0,part.flexY??0,part.depthY,
          part.trackShift===undefined?0:1,part.trackShift??0];
        resource.data.set(fields,offset);
        offset+=fieldsPerInstance;
      }
      gl.bindVertexArray(resource.vao);
      gl.bindBuffer(gl.ARRAY_BUFFER,resource.instanceBuffer);
      gl.bufferData(gl.ARRAY_BUFFER,resource.data.subarray(0,offset),gl.STREAM_DRAW);
      for(const [index,source] of resource.textures.entries()){
        gl.activeTexture(gl.TEXTURE0+index);
        gl.bindTexture(gl.TEXTURE_2D,source);
      }
      gl.uniform3f(props.uni.dimensions,model.width,model.length,(model.layers-1)*model.layerStep);
      gl.drawElementsInstanced(gl.TRIANGLES,model.meshIndices.length,gl.UNSIGNED_INT,0,group.length);
      instances+=group.length;
    }
    return instances;
  }

  return {
    uploadMs:()=>initialUploads,
    uploadCount:()=>uploads,
    draw({obstacles,width,height,scale,spriteScale,centerX,groundY}){
      if(layer.width!==width||layer.height!==height){layer.width=width;layer.height=height;}
      gl.viewport(0,0,width,height);
      gl.clearColor(0,0,0,0);
      gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);
      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl.LEQUAL);
      gl.useProgram(props.program);
      gl.uniform2f(props.uni.viewportSize,width,height);
      gl.uniform1f(props.uni.squash,view.squash);
      gl.uniform1i(props.uni.materialLight,+materialLight);
      gl.uniform1i(props.uni.multiView,+multiViewEnabled);
      for(const [index,name] of ["topView","sideView","frontView","rearView"].entries())gl.uniform1i(props.uni[name],index);

      const previousUploads=uploads;
      const propGroups=new Map();
      for(const {x,y,item} of obstacles){
        const {yaw,tip,twist}=propPose(item);
        const model=item.model,halfZ=(model.layers-1)*model.layerStep/2;
        const support=Math.cos(tip)*halfZ+Math.sin(tip)*model.length*.47-halfZ;
        groupPart(propGroups,{model,x,y,z:support+item.hop/PROP_ART_SCALE,yaw,roll:tip,twist,depthY:y});
      }
      layer.dataset.instances=String(drawGroups(propGroups,scale*PROP_ART_SCALE,environmentView.propSpacing));
      layer.dataset.propDrawCalls=String(propGroups.size);

      const vehicleGroups=new Map();
      if(activeStack){
        const vehicleX=centerX+(robot.x-camera.x)*scale;
        for(const part of poseParts(robot.heading)){
          groupPart(vehicleGroups,{...part,x:vehicleX+(part.x-PIVOT_X)*spriteScale,
            y:groundY+(part.y-PIVOT_Y)*spriteScale,depthY:groundY});
        }
      }
      layer.dataset.vehicleParts=String(drawGroups(vehicleGroups,spriteScale,view.spacing));
      layer.dataset.vehicleDrawCalls=String(vehicleGroups.size);
      if(uploads!==previousUploads)showBenchmarkStatus();
    },
  };
}
