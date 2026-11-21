function createFrameMeter(windowMs=400){
  let previous=null,frames=0,elapsed=0,renderTotal=0;
  return {
    reset(){
      previous=null;
      frames=0;
      elapsed=0;
      renderTotal=0;
    },
    sample(now,renderMs){
      if(previous===null){
        previous=now;
        return null;
      }
      const interval=now-previous;
      previous=now;
      if(interval<=0)return null;
      frames++;
      elapsed+=interval;
      renderTotal+=renderMs;
      if(elapsed<windowMs)return null;
      const sample={fps:1000*frames/elapsed,frameMs:elapsed/frames,renderMs:renderTotal/frames};
      frames=0;
      elapsed=0;
      renderTotal=0;
      return sample;
    },
  };
}
