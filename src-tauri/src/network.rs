use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::{mpsc, Mutex};
use tokio_tungstenite::{connect_async, tungstenite::protocol::Message};
use url::Url;

use webrtc::api::APIBuilder;
use webrtc::data_channel::data_channel_message::DataChannelMessage;
use webrtc::data_channel::RTCDataChannel;
use webrtc::ice_transport::ice_candidate::{RTCIceCandidate, RTCIceCandidateInit};
use webrtc::ice_transport::ice_server::RTCIceServer;
use webrtc::peer_connection::configuration::RTCConfiguration;
use webrtc::peer_connection::peer_connection_state::RTCPeerConnectionState;
use webrtc::peer_connection::sdp::session_description::RTCSessionDescription;
use webrtc::peer_connection::RTCPeerConnection;

// ── Shared State ──

pub struct MeshState {
    pub signaling_sender: Mutex<Option<mpsc::Sender<String>>>,
    pub peers: Mutex<HashMap<u32, Arc<PeerContext>>>,
    pub my_peer_id: Mutex<Option<u32>>,
}

impl MeshState {
    pub fn new() -> Self {
        Self {
            signaling_sender: Mutex::new(None),
            peers: Mutex::new(HashMap::new()),
            my_peer_id: Mutex::new(None),
        }
    }
}

pub struct PeerContext {
    pub pc: Arc<RTCPeerConnection>,
    pub channels: Mutex<HashMap<String, Arc<RTCDataChannel>>>,
}

// ── Signaling JSON Data Structures ──

#[derive(Serialize, Deserialize, Debug)]
#[serde(tag = "type")]
#[serde(rename_all = "kebab-case")]
enum SignalingMessage {
    CreateRoom,
    JoinRoom {
        #[serde(rename = "roomCode")]
        room_code: String,
    },
    RoomCreated {
        #[serde(rename = "roomCode")]
        room_code: String,
        #[serde(rename = "peerId")]
        peer_id: u32,
    },
    RoomJoined {
        #[serde(rename = "roomCode")]
        room_code: String,
        #[serde(rename = "peerId")]
        peer_id: u32,
        #[serde(rename = "existingPeers")]
        existing_peers: Vec<u32>,
    },
    PeerJoined {
        #[serde(rename = "peerId")]
        peer_id: u32,
    },
    PeerLeft {
        #[serde(rename = "peerId")]
        peer_id: u32,
    },
    Offer {
        #[serde(rename = "targetPeerId")]
        target_peer_id: u32,
        #[serde(rename = "fromPeerId")]
        from_peer_id: Option<u32>,
        sdp: RTCSessionDescription,
    },
    Answer {
        #[serde(rename = "targetPeerId")]
        target_peer_id: u32,
        #[serde(rename = "fromPeerId")]
        from_peer_id: Option<u32>,
        sdp: RTCSessionDescription,
    },
    IceCandidate {
        #[serde(rename = "targetPeerId")]
        target_peer_id: u32,
        #[serde(rename = "fromPeerId")]
        from_peer_id: Option<u32>,
        candidate: RTCIceCandidateInit,
    },
    Error {
        message: String,
    },
}

#[derive(Serialize, Clone)]
struct IncomingDataMessage {
    #[serde(rename = "peerId")]
    peer_id: u32,
    channel: String,
    data: DataPayload,
}

#[derive(Serialize, Clone)]
#[serde(untagged)]
enum DataPayload {
    Text(String),
    Binary(Vec<u8>),
}

// ── Signaling Commands ──

#[tauri::command]
pub async fn window_start_signaling(url_str: String, app: AppHandle, state: State<'_, MeshState>) -> Result<(), String> {
    let url = Url::parse(&url_str).map_err(|e| e.to_string())?;
    
    let (ws_stream, _) = connect_async(url)
        .await
        .map_err(|e| format!("WebSocket connect err: {}", e))?;
    
    let (mut write, mut read) = ws_stream.split();
    
    // Channel for outgoing signaling messages
    let (tx, mut rx) = mpsc::channel::<String>(100);
    *state.signaling_sender.lock().await = Some(tx);
    
    // Writer task
    tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            if write.send(Message::Text(msg)).await.is_err() {
                break;
            }
        }
        let _ = write.close().await;
    });
    
    let app_handle = app.clone();
    
    // Reader task
    tokio::spawn(async move {
        while let Some(msg) = read.next().await {
            if let Ok(Message::Text(text)) = msg {
                handle_signaling_message(&app_handle, text).await;
            }
        }
        let _ = app_handle.emit("signaling-disconnected", ());
    });
    
    Ok(())
}

#[tauri::command]
pub async fn signaling_create_room(state: State<'_, MeshState>) -> Result<(), String> {
    let msg = serde_json::to_string(&SignalingMessage::CreateRoom).unwrap();
    if let Some(tx) = &*state.signaling_sender.lock().await {
        let _ = tx.send(msg).await;
    }
    Ok(())
}

#[tauri::command]
pub async fn signaling_join_room(code: String, state: State<'_, MeshState>) -> Result<(), String> {
    let msg = serde_json::to_string(&SignalingMessage::JoinRoom { room_code: code }).unwrap();
    if let Some(tx) = &*state.signaling_sender.lock().await {
        let _ = tx.send(msg).await;
    }
    Ok(())
}

// ── WebRTC Actions ──

async fn create_peer_connection() -> Result<Arc<RTCPeerConnection>, String> {
    let config = RTCConfiguration {
        ice_servers: vec![RTCIceServer {
            urls: vec!["stun:stun.l.google.com:19302".to_owned()],
            ..Default::default()
        }],
        ..Default::default()
    };
    
    let api = APIBuilder::new().build();
    api.new_peer_connection(config)
        .await
        .map_err(|e| e.to_string())
        .map(Arc::new)
}

async fn handle_signaling_message(app: &AppHandle, text: String) {
    eprintln!("[Signaling IN] {}", text);
    let state: State<MeshState> = app.state();
    
    let msg: SignalingMessage = match serde_json::from_str(&text) {
        Ok(m) => m,
        Err(e) => {
            eprintln!("[Signaling Parse Error] {} - Raw: {}", e, text);
            return;
        }
    };
    
    // Emit the raw event to JS so UI can update
    let _ = app.emit("signaling-message", &msg);
    
    match msg {
        SignalingMessage::RoomCreated { peer_id, .. } => {
            *state.my_peer_id.lock().await = Some(peer_id);
        }
        SignalingMessage::RoomJoined { peer_id, existing_peers, .. } => {
            *state.my_peer_id.lock().await = Some(peer_id);
            // We are the joiner, we must create connections and offers to all existing peers
            for remote_id in existing_peers {
                if let Err(e) = setup_initiator_peer(app.clone(), remote_id).await {
                    eprintln!("Failed to setup peer {}: {}", remote_id, e);
                }
            }
        }
        SignalingMessage::PeerJoined { peer_id } => {
            // Existing peers just wait for the offer, but we can prepare the PeerConnection
            if let Err(e) = setup_receiver_peer(app.clone(), peer_id).await {
                eprintln!("Failed to setup receiver for {}: {}", peer_id, e);
            }
        }
        SignalingMessage::PeerLeft { peer_id } => {
            let mut peers = state.peers.lock().await;
            if let Some(ctx) = peers.remove(&peer_id) {
                let _ = ctx.pc.close().await;
            }
        }
        SignalingMessage::Offer { from_peer_id: Some(from_id), sdp, .. } => {
            {
                let peers = state.peers.lock().await;
                if !peers.contains_key(&from_id) {
                    // Fix Race Condition: Offer arrived before PeerJoined
                    drop(peers);
                    let _ = setup_receiver_peer(app.clone(), from_id).await;
                }
            }

            let pc = {
                let peers = state.peers.lock().await;
                if let Some(ctx) = peers.get(&from_id) {
                    ctx.pc.clone()
                } else {
                    eprintln!("Failed to get or create peer {}", from_id);
                    return;
                }
            };
            if let Err(e) = pc.set_remote_description(sdp).await {
                eprintln!("set_remote_desc error: {}", e);
                return;
            }
            if let Ok(answer) = pc.create_answer(None).await {
                if let Ok(_) = pc.set_local_description(answer.clone()).await {
                    let msg = SignalingMessage::Answer {
                        target_peer_id: from_id,
                        from_peer_id: None, // Filled by server
                        sdp: answer,
                    };
                    let json = serde_json::to_string(&msg).unwrap();
                    if let Some(tx) = &*state.signaling_sender.lock().await {
                        let _ = tx.send(json).await;
                    }
                }
            }
        }
        SignalingMessage::Answer { from_peer_id: Some(from_id), sdp, .. } => {
            let pc = {
                let peers = state.peers.lock().await;
                if let Some(ctx) = peers.get(&from_id) {
                    ctx.pc.clone()
                } else {
                    return;
                }
            };
            let _ = pc.set_remote_description(sdp).await;
        }
        SignalingMessage::IceCandidate { from_peer_id: Some(from_id), candidate, .. } => {
            let pc = {
                let peers = state.peers.lock().await;
                if let Some(ctx) = peers.get(&from_id) {
                    ctx.pc.clone()
                } else {
                    return;
                }
            };
            let _ = pc.add_ice_candidate(candidate).await;
        }
        _ => {}
    }
}

async fn setup_initiator_peer(app: AppHandle, remote_peer_id: u32) -> Result<(), String> {
    let pc = create_peer_connection().await?;
    let ctx = Arc::new(PeerContext {
        pc: pc.clone(),
        channels: Mutex::new(HashMap::new()),
    });
    
    app.state::<MeshState>().peers.lock().await.insert(remote_peer_id, ctx.clone());
    
    // Bind generic events
    bind_pc_events(app.clone(), remote_peer_id, pc.clone(), ctx.clone()).await;
    
    // Create DataChannels because we are initiator
    for name in ["chat", "file-transfer", "video-sync"] {
        let dc = pc.create_data_channel(name, None).await.map_err(|e| e.to_string())?;
        bind_dc_events(app.clone(), remote_peer_id, name.to_string(), dc.clone()).await;
        ctx.channels.lock().await.insert(name.to_string(), dc);
    }
    
    // Create offer
    let offer = pc.create_offer(None).await.map_err(|e| e.to_string())?;
    pc.set_local_description(offer.clone()).await.map_err(|e| e.to_string())?;
    
    let msg = SignalingMessage::Offer {
        target_peer_id: remote_peer_id,
        from_peer_id: None,
        sdp: offer,
    };
    
    let state = app.state::<MeshState>();
    let tx_lock = state.signaling_sender.lock().await;
    if let Some(tx) = &*tx_lock {
        let _ = tx.send(serde_json::to_string(&msg).unwrap()).await;
    }
    
    Ok(())
}

async fn setup_receiver_peer(app: AppHandle, remote_peer_id: u32) -> Result<(), String> {
    if app.state::<MeshState>().peers.lock().await.contains_key(&remote_peer_id) {
        return Ok(()); // Already configured
    }

    let pc = create_peer_connection().await?;
    let ctx = Arc::new(PeerContext {
        pc: pc.clone(),
        channels: Mutex::new(HashMap::new()),
    });
    
    app.state::<MeshState>().peers.lock().await.insert(remote_peer_id, ctx.clone());
    
    bind_pc_events(app.clone(), remote_peer_id, pc.clone(), ctx.clone()).await;
    
    // As receiver, we don't create channels, we wait for on_data_channel
    let app_clone = app.clone();
    let ctx_clone = ctx.clone();
    pc.on_data_channel(Box::new(move |dc: Arc<RTCDataChannel>| {
        let channel_name = dc.label().to_string();
        let app_c = app_clone.clone();
        let ctx_c = ctx_clone.clone();
        Box::pin(async move {
            ctx_c.channels.lock().await.insert(channel_name.clone(), dc.clone());
            bind_dc_events(app_c, remote_peer_id, channel_name, dc).await;
        })
    }));
    
    Ok(())
}

async fn bind_pc_events(app: AppHandle, remote_peer_id: u32, pc: Arc<RTCPeerConnection>, _ctx: Arc<PeerContext>) {
    let app_c1 = app.clone();
    pc.on_ice_candidate(Box::new(move |candidate: Option<RTCIceCandidate>| {
        let app_c2 = app_c1.clone();
        Box::pin(async move {
            if let Some(c) = candidate {
                if let Ok(init) = c.to_json() {
                    let msg = SignalingMessage::IceCandidate {
                        target_peer_id: remote_peer_id,
                        from_peer_id: None,
                        candidate: init,
                    };
                    let state = app_c2.state::<MeshState>();
                    let tx_lock = state.signaling_sender.lock().await;
                    if let Some(tx) = &*tx_lock {
                        let _ = tx.send(serde_json::to_string(&msg).unwrap()).await;
                    }
                }
            }
        })
    }));
    
    let app_c3 = app.clone();
    pc.on_peer_connection_state_change(Box::new(move |state: RTCPeerConnectionState| {
        let app_c4 = app_c3.clone();
        Box::pin(async move {
            #[derive(Serialize, Clone)]
            struct StateMsg { 
                #[serde(rename = "peerId")]
                peer_id: u32, 
                state: String 
            }
            let _ = app_c4.emit("peer-state", StateMsg { 
                peer_id: remote_peer_id, 
                state: state.to_string() 
            });
        })
    }));
}

async fn bind_dc_events(app: AppHandle, remote_peer_id: u32, channel_name: String, dc: Arc<RTCDataChannel>) {
    let app_c1 = app.clone();
    let name_c1 = channel_name.clone();
    
    dc.on_open(Box::new(move || {
        let app_c2 = app_c1.clone();
        let name_c2 = name_c1.clone();
        Box::pin(async move {
            #[derive(Serialize, Clone)]
            struct OpenMsg { 
                #[serde(rename = "peerId")]
                peer_id: u32, 
                channel: String 
            }
            let _ = app_c2.emit("channel-open", OpenMsg { 
                peer_id: remote_peer_id, 
                channel: name_c2 
            });
        })
    }));
    
    let app_c3 = app.clone();
    let name_c3 = channel_name.clone();
    
    dc.on_message(Box::new(move |msg: DataChannelMessage| {
        let app_c4 = app_c3.clone();
        let name_c4 = name_c3.clone();
        Box::pin(async move {
            let payload = if msg.is_string {
                DataPayload::Text(String::from_utf8_lossy(&msg.data).to_string())
            } else {
                DataPayload::Binary(msg.data.to_vec())
            };
            
            let _ = app_c4.emit("channel-message", IncomingDataMessage {
                peer_id: remote_peer_id,
                channel: name_c4,
                data: payload,
            });
        })
    }));
}

// ── IPC Messaging ──

#[tauri::command]
pub async fn send_message(
    payload: serde_json::Value, 
    state: State<'_, MeshState>
) -> Result<(), String> {
    eprintln!("[Network] Received Raw IPC Payload: {}", payload);
    
    // Fallbacks because Tauri might map camelCase to snake_case OR leave it alone depending on internal structs
    let peer_id_val = payload.get("peerId").or_else(|| payload.get("peer_id"));
    let channel_val = payload.get("channel");
    let is_binary_val = payload.get("isBinary").or_else(|| payload.get("is_binary"));
    let data_val = payload.get("data");
    
    if peer_id_val.is_none() {
        return Err(format!("Missing peerId inside payload: {}", payload));
    }
    
    let peer_id = peer_id_val.unwrap().as_u64().unwrap_or(0) as u32;
    let channel = channel_val.unwrap().as_str().unwrap_or("").to_string();
    let is_binary = is_binary_val.unwrap().as_bool().unwrap_or(false);
    let data: Vec<u8> = serde_json::from_value(data_val.unwrap().clone()).unwrap_or_default();

    let peers = state.peers.lock().await;
    if let Some(ctx) = peers.get(&peer_id) {
        let channels = ctx.channels.lock().await;
        if let Some(dc) = channels.get(&channel) {
            let res = if is_binary {
                let bytes = bytes::Bytes::from(data);
                dc.send(&bytes).await
            } else {
                let text = String::from_utf8(data).map_err(|e| e.to_string())?;
                dc.send_text(text).await
            };
            return res.map(|_| ()).map_err(|e| format!("Send error: {}", e));
        }
    }
    Err(format!("Channel {} to peer {} not found", channel, peer_id))
}

#[tauri::command]
pub async fn disconnect_all(state: State<'_, MeshState>) -> Result<(), String> {
    let mut tx_lock = state.signaling_sender.lock().await;
    *tx_lock = None; // Drop sender, closes writer loop
    
    let mut peers = state.peers.lock().await;
    for (_, ctx) in peers.drain() {
        let _ = ctx.pc.close().await;
    }
    
    *state.my_peer_id.lock().await = None;
    Ok(())
}
