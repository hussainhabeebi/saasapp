import legacy from './worker.js';
import {handleNativePoomas} from './live-travel-poomas-native.js';

const wrapped={
  ...legacy,
  async fetch(req,env,ctx){
    const path=new URL(req.url).pathname;
    if(path.startsWith('/live-travel/poomas/')){
      return handleNativePoomas(req,env,ctx,legacy);
    }
    return legacy.fetch(req,env,ctx);
  }
};

export default wrapped;
