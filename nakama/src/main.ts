let InitModule: nkruntime.InitModule =
  function(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, initializer: nkruntime.Initializer) {
    
    logger.info("KhwayGame runtime module loaded.");

    initializer.registerRpc("hello_world", rpcHelloWorld);
  }

let rpcHelloWorld: nkruntime.RpcFunction = 
 function(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string){

   const data = JSON.parse(payload);
   logger.info("hello_world called with name: %s", data.name);

   const response = { message: "Hello, "+ data.name + "!"};
   return JSON.stringify(response);

 }