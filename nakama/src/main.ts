interface TestStorageValue{
  message: string,
  savedAt: number
}

const TEST_COLLECTION = "test";
const TEST_KEY = "test_value";


let InitModule: nkruntime.InitModule =
  function(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, initializer: nkruntime.Initializer) {
    
    logger.info("KhwayGame runtime module loaded.");

    initializer.registerRpc("hello_world %s", rpcHelloWorld);
    initializer.registerRpc("storage_test %s", rpcStorageTest);
}

let rpcHelloWorld: nkruntime.RpcFunction = 
 function(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string){

   const data = JSON.parse(payload);
   logger.info("hello_world called with name: %s", data.name);

   const response = { message: "Hello, "+ data.name + "!"};
   return JSON.stringify(response);

 }


 let rpcStorageTest: nkruntime.RpcFunction =
  function(ctx: nkruntime.Context, logger: nkruntime.Logger, nk: nkruntime.Nakama, payload: string){
    if(!ctx.userId){
      throw new Error("No user ID. This RPC must be called with a user session.");
    }
    
    const value: TestStorageValue = {
      message: "Hello from the storage",
      savedAt: Date.now()
    }

    const writeRequest: nkruntime.StorageWriteRequest = {
       collection: TEST_COLLECTION,
       key: TEST_KEY,
       userId: ctx.userId,
       value: value,
       permissionRead: 1,
       permissionWrite: 0
    }

    nk.storageWrite([writeRequest]);
    logger.info("Wrote test value for user: ", ctx.userId);

    const readRequest: nkruntime.StorageReadRequest = {
      collection: TEST_COLLECTION,
      key: TEST_KEY,
      userId: ctx.userId
    }

    const objects = nk.storageRead([readRequest]);
    if(objects.length === 0){
      throw new Error("Test value was written but could not be read back.");
    }

    const storeValue = JSON.stringify(objects[0].value as TestStorageValue);
    logger.info("Read Store Value: ", storeValue);

    return storeValue;
  }