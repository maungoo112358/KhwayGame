import { Client, Session, type Socket, type Match, type MatchData, type MatchPresenceEvent, type Presence } from "@heroiclabs/nakama-js";

const DEVICE_ID = "nakama_device_id";
const AUTH_TOKEN = "nakama_auth_token";
const REFRESH_TOKEN = "nakama_refresh_token";
const MATCH_ID = "namaka_match_id";

const LOBBY_NAME = "main_lobby";

const RPC_HELLO_WORLD = "hello_world";
const RPC_STORAGE_TEST = "storage_test";
const RPC_SAVE_SNAPSHOT = "save_snapshot";
const RPC_LOAD_SNAPSHOT = "load_snapshot";

export const OpCode = {
    PLAYER_MOVE : 0,
    CHAT_MESSAGE: 1,
    PRIVATE_MESSAGE: 2,
} as const;

interface TestStorageValue{
  message: string,
  savedAt: number
}

const useSSL = false;
export const client = new Client("defaultkey", "127.0.0.1", "7350", useSSL);

let socket: Socket|null = null;
let currentMatch: Match|null = null;
let currentSession: Session|null = null;

const players = new Map<string,Presence>();

function getOrCreateDeviceId(): string{
    let device_Id = localStorage.getItem(DEVICE_ID);
    if(!device_Id){
        device_Id = crypto.randomUUID();
        localStorage.setItem(DEVICE_ID, device_Id);
    }
    return device_Id;
}

function saveMatchIdInLocalStroage(match_Id: string): void{
    if(match_Id.length === 0) return;
    localStorage.setItem(MATCH_ID, match_Id);
    console.log("Save MatchId: ", match_Id);
}

async function saveSnapshot(payload: string): Promise<void>{
    try{

        await client.rpc(getSession(), RPC_SAVE_SNAPSHOT, {payload});
        console.log("Save successful: ")
    }
    catch(error:unknown){
        console.log("Save Snapshot failed!");
    }
}

async function loadShapshot(match_id: string): Promise<void>{
    try{
        const response = await client.rpc(getSession(), RPC_LOAD_SNAPSHOT,{});
        const payload = response.payload as TestStorageValue;
        console.log("Load Snapshot data: ",payload.message);
    }
    catch(error: unknown){
        console.log("Cannot Load the snapshot! ", error);
    }
}

async function login(): Promise<Session>{

    const device_id = getOrCreateDeviceId();
    const session = await client.authenticateDevice(device_id, true);
    localStorage.setItem(AUTH_TOKEN, session.token);
    localStorage.setItem(REFRESH_TOKEN, session.refresh_token);
    return session;
}

async function connectSocket(session: Session): Promise<Socket>{

    const newSocket = client.createSocket(useSSL, false);

    newSocket.ondisconnect = (event: Event): void => { console.warn("Socket Disconnected: ", event); } 
        
    newSocket.onerror = (event: Event): void => { console.error("Socket Error: ", event); }
    newSocket.onmatchdata = (matchData: MatchData): void => {
        const text = new TextDecoder().decode(matchData.data);
        const payload = JSON.parse(text);
        const sender = matchData.presence?.username;
        switch(matchData.op_code){
            case OpCode.CHAT_MESSAGE:
            console.log("Chat Message from", sender, ":", payload.text);
            break;

            case OpCode.PRIVATE_MESSAGE:
            console.log("Private Message from ", sender, ":", payload.text);
            break;

            default:
            console.log("Unknow opCode: ", matchData.op_code, payload);

        }
        console.log("Match data from ", matchData.presence?.username, "opCode: ", matchData.op_code, payload);
    }

    newSocket.onmatchpresence = (event: MatchPresenceEvent): void => {
        event.joins?.forEach(p => {
            players.set(p.user_id, p);
            console.log("Player Joined: ", p.username);
        });
        event.leaves?.forEach(p => {
            players.delete(p.user_id);
            console.log("Player Left: ", p.username);
            saveSnapshot("This is our current Payload.");
        });
    }
    const appearOnline = true;

    await newSocket.connect(session, appearOnline);
    socket = newSocket;

    return newSocket;
}

export function getSocket(): Socket{
    if(!socket){
        throw new Error("Socket is not connected. Call connectSocket() first.");
    }
    return socket;
}

async function createLobby(): Promise<Match>{
    let match: Match;
    match  = await getSocket().createMatch(LOBBY_NAME);
    console.log("Created Lobby: ", match.match_id);
    return match;
}

async function joinLobby(): Promise<Match>{
   if(currentMatch){
     console.log("Already in lobby: ", currentMatch.match_id);
     return currentMatch;
   }

   const match_id = localStorage.getItem(MATCH_ID);
   let match: Match;

   if(!match_id){
        match = await createLobby();
   }
   else
   {
      try{
        match = await getSocket().joinMatch(match_id);
        console.log("Joined Lobby: ", match.match_id);
      }catch(error:unknown){
        console.log("Lobby is gone. Need to create a new Lobby. ", error);
        match = await createLobby();
      }
   }

   saveMatchIdInLocalStroage(match.match_id);
   currentMatch = match;

    loadShapshot(match.match_id);

   match.presences?.forEach(p => {
     if(p.user_id !== match.self.user_id){
        players.set(p.user_id, p);
        console.log("Already in match: ", p.username);
     }
   });
   return match;
}

export async function leaveMatch(): Promise<void>{
    if(!currentMatch) return;
    await getSocket().leaveMatch(currentMatch.match_id);
    console.log("Left Match: ", currentMatch.match_id);
    currentMatch = null;
    players.clear();
}

async function sendMatchState(opCode: number, data: object, presence?: Presence[]): Promise<void>{
    if(!currentMatch){
        throw new Error("Not in a match. Call createMatch() or joinMatch() first.");
    }
    await getSocket().sendMatchState(currentMatch.match_id, opCode, JSON.stringify(data), presence);
}

async function sendToPlayer(username: string, text: string):Promise<void>{
    const target = [...players.values()].find(p => p.username === username);

    if(!target){
        throw new Error("Player not found in match: "+username);
    }
    await sendMatchState(OpCode.PRIVATE_MESSAGE,{text},[target]);
}

export function getPlayers(): Presence[]{
    return [...players.values()];
}

function getSession(): Session{
    if(!currentSession){
        throw new Error("Not logged in. Call start() first.");
    }
    return currentSession;
}

async function storageTest(): Promise<TestStorageValue>{
    const response = await client.rpc(getSession(), RPC_STORAGE_TEST, {});
    const payload = response.payload as TestStorageValue;
    console.log("Test Storage Payload: ", payload.message);
    console.log("SaveAt: ",new Date(payload.savedAt).toLocaleDateString());
    return payload;
}

async function start(): Promise<void>{
   try{

    const session = await login();
    currentSession = session;
    console.log("Logged in: ",session.user_id);

    await connectSocket(session);
    console.log("Socket Connected!");

    const response = await client.rpc(session, RPC_HELLO_WORLD, { name: "slint" })
    // const data = JSON.stringify(response);
    const data = response.payload as { message: string };


    console.log("Hello_World NPC Call data: "+ data.message);

   }catch(error: unknown){
      console.log("Startup Failed! ",error);  
   }
}

function onKeyDown(event: KeyboardEvent): void{
    if(event.code !== "Space" || event.repeat ) return;

    const target = event.target as HTMLElement;
    if(target.tagName === "INPUT" || target.tagName === "TEXTAREA") return;

    event.preventDefault();

    sendToPlayer("tyhmtKitHF", "Hello bro")
    .then(()=> console.log("Private Message sent"))
    .catch((error: unknown)=> console.log("Send Failed! ", error) );
}

export async function main(): Promise<void>{
    try{
        await start();
        await storageTest();
        await joinLobby();

        window.addEventListener("keydown",onKeyDown);
        
    }
    catch(error: unknown){
        console.log("Could not enter lobby: ", error);
    }
}