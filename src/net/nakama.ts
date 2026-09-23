import { Client, Session, type Socket, type Match, type MatchData, type MatchPresenceEvent } from "@heroiclabs/nakama-js";

const DEVICE_ID = "nakama_device_id";
const AUTH_TOKEN = "nakama_auth_token";
const REFRESH_TOKEN = "nakama_refresh_token";

const LOBBY_NAME = "main_lobby";

export const OpCode = {
    PLAYER_MOVE : 0,
    CHAT_MESSAGE: 1,
}

function getOrCreateDeviceId(): string{
    let deviceId = localStorage.getItem(DEVICE_ID);
    if(!deviceId){
        deviceId = crypto.randomUUID();
        localStorage.setItem(DEVICE_ID, deviceId);
    }
    return deviceId;
}

const useSSL = false;
export const client = new Client("defaultkey", "127.0.0.1", "7350", useSSL);

let socket: Socket|null = null;
let currentMatch: Match|null = null;

async function login(): Promise<Session>{

    const deviceId = getOrCreateDeviceId();
    const session = await client.authenticateDevice(deviceId, true);
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
        console.log("Match data from ", matchData.presence?.username, "opCode: ", matchData.op_code, payload);
    }

    newSocket.onmatchpresence = (event: MatchPresenceEvent): void => {
        event.joins?.forEach(p => console.log("Player Joined: ", p.username));
        event.leaves?.forEach(p => console.log("Player Left: ", p.username));
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

async function joinLobby(): Promise<Match>{
   if(currentMatch){
     console.log("Already in lobby: ", currentMatch.match_id);
     return currentMatch;
   }

   const match = await  getSocket().createMatch(LOBBY_NAME);
   currentMatch = match;
   console.log("Joined Lobby: ", match.match_id);
   match.presences?.forEach(p => console.log("Already in the match: ", p.username));
   return match;
}

export async function leaveMatch(): Promise<void>{
    if(!currentMatch) return;
    await getSocket().leaveMatch(currentMatch.match_id);
    console.log("Left Match: ", currentMatch.match_id);
    currentMatch = null;
}

// async function sendMatchState(opCode: number, data: object): Promise<void>{
//     if(!currentMatch){
//         throw new Error("Not in a match. Call createMatch() or joinMatch() first.");
//     }
//     await getSocket().sendMatchState(currentMatch.match_id, opCode, JSON.stringify(data));
// }

async function start(): Promise<void>{
   try{

    const session = await login();
    console.log("Logged in: ",session.user_id);

    await connectSocket(session);
    console.log("Socket Connected!");

    const response = await client.rpc(session, "hello_world", { name: "slint" })
    // const data = JSON.stringify(response);
    const data = response.payload as { message: string };


    console.log("Hello_World NPC Call data: "+ data.message);

   }catch(error: unknown){
      console.log("Startup Failed! ",error);  
   }
}

export async function main(): Promise<void>{
    try{
        await start();
        await joinLobby();
    }catch(error: unknown){
        console.log("Could not enter lobby: ", error);
    }
}