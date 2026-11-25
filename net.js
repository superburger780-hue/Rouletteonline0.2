const WHEEL_NUMS = Array.of(0,32,15,19,4,21,2,25,17,34,6,27,13,36,11,30,8,23,10,5,24,16,33,1,20,14,31,9,22,18,29,7,28,12,35,3,26);
const RED_SET = new Set(Array.of(1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36));
const STEP_DEG = 360 / 37;
const PLAYER_COLORS = Array.of('#3b82f6', '#ec4899', '#a855f7', '#eab308', '#14b8a6', '#f97316', '#f43f5e', '#84cc16');
const MQTT_BROKERS = Array.of('wss://broker.emqx.io:8084/mqtt', 'wss://broker.hivemq.com:8884/mqtt');
const SPIN_DURATION_MS = 7800;

const RTC_CONFIG = {
  iceServers: Array.of(
    { urls: Array.of('stun', 'google.com', '19302').join(':') },
    { urls: Array.of('stun', 'metered.ca', '80').join(':') },
    { urls: Array.of('turn', 'metered.ca', '80').join(':'), username: 'e8dd65b92f62d3e36cae59ce', credential: '3bx6+71v7x2x1x4x' },
    { urls: Array.of('turn', 'metered.ca', '443').join(':'), username: 'e8dd65b92f62d3e36cae59ce', credential: '3bx6+71v7x2x1x4x' }
  )
};

let ws = null, brokerIdx = 0, pingTimer = null, reconnectTimer = null, isConnected = false;
let isHost = false, isOffline = false, myId = 'u-' + Math.random().toString(36).slice(2, 9), myName = 'Игрок', roomCode = '';
let joinRetryTimer = null, lastAnimatedSpinId = 0, localStream = null, isMuted = false;
const peers = {}, iceQueues = {};

let gameState = { mode: 'EU', isSpinning: false, spinId: 0, lastOutcomes: null, bannerHtml: 'Выберите фишку внизу и нажмите на ячейку стола', players: {} };
let selectedChip = 10;
const casings = document.querySelectorAll('.wheel-casing');
const wheelAngles = Array.from(casings, () => ({ rotor: 0, ball: 0 }));
const lobbyStatus = document.getElementById('lobbyStatus');
const callBtn = document.getElementById('callBtn');
const roomBadge = document.getElementById('roomCodeBadge');

let sfxCtx = null;
function initSfx() {
  if (!sfxCtx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (Ctx) sfxCtx = new Ctx();
  }
  if (sfxCtx && sfxCtx.state === 'suspended') sfxCtx.resume();
}

function playChipClick() {
  try {
    initSfx();
    if (!sfxCtx) return;
    const now = sfxCtx.currentTime, osc = sfxCtx.createOscillator(), gain = sfxCtx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(1400, now);
    osc.frequency.exponentialRampToValueAtTime(320, now + 0.045);
    gain.gain.setValueAtTime(0.18, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.045);
    osc.connect(gain); gain.connect(sfxCtx.destination);
    osc.start(now); osc.stop(now + 0.05);
  } catch (e) {}
}

function playRouletteSpinSound() {
  try {
    initSfx();
    if (!sfxCtx) return;
    const start = sfxCtx.currentTime, noiseDur = 4.6, bufferSize = Math.floor(sfxCtx.sampleRate * noiseDur);
    const noiseBuffer = sfxCtx.createBuffer(1, bufferSize, sfxCtx.sampleRate), data = noiseBuffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) data[i] = Math.random() * 2 - 1;

    const noise = sfxCtx.createBufferSource(); noise.buffer = noiseBuffer;
    const bandpass = sfxCtx.createBiquadFilter(); bandpass.type = 'bandpass'; bandpass.Q.value = 3.5;
    bandpass.frequency.setValueAtTime(2400, start); bandpass.frequency.exponentialRampToValueAtTime(650, start + noiseDur);

    const noiseGain = sfxCtx.createGain();
    noiseGain.gain.setValueAtTime(0.01, start);
    noiseGain.gain.linearRampToValueAtTime(0.16, start + 0.25);
    noiseGain.gain.exponentialRampToValueAtTime(0.002, start + noiseDur);

    noise.connect(bandpass); bandpass.connect(noiseGain); noiseGain.connect(sfxCtx.destination);
    noise.start(start); noise.stop(start + noiseDur);

    let t = 0.05, step = 0.042, idx = 0;
    while (t < 7.35) {
      const hitTime = start + t, osc = sfxCtx.createOscillator(), g = sfxCtx.createGain();
      const isDropping = t > 4.4;
      osc.type = isDropping ? 'sine' : 'triangle';
      osc.frequency.setValueAtTime(isDropping ? (1900 + (idx % 3) * 280) : (1200 + (idx % 2) * 180), hitTime);
      osc.frequency.exponentialRampToValueAtTime(280, hitTime + 0.032);
      g.gain.setValueAtTime(isDropping ? Math.max(0.05, 0.28 - (t - 4.4) * 0.05) : 0.09, hitTime);
      g.gain.exponentialRampToValueAtTime(0.001, hitTime + 0.034);
      osc.connect(g); g.connect(sfxCtx.destination);
      osc.start(hitTime); osc.stop(hitTime + 0.036);
      step *= (t < 3.5) ? 1.022 : (t < 5.5 ? 1.065 : 1.16);
      t += step; idx++;
    }

    const lockTime = start + 7.55, lockOsc = sfxCtx.createOscillator(), lockGain = sfxCtx.createGain();
    lockOsc.type = 'sine';
    lockOsc.frequency.setValueAtTime(520, lockTime); lockOsc.frequency.exponentialRampToValueAtTime(110, lockTime + 0.09);
    lockGain.gain.setValueAtTime(0.32, lockTime); lockGain.gain.exponentialRampToValueAtTime(0.001, lockTime + 0.095);
    lockOsc.connect(lockGain); lockGain.connect(sfxCtx.destination);
    lockOsc.start(lockTime); lockOsc.stop(lockTime + 0.1);
  } catch (e) {}
}

function playWinChime() {
  try {
    initSfx();
    if (!sfxCtx) return;
    const now = sfxCtx.currentTime;
    Array.of(523.25, 659.25, 783.99, 1046.5).forEach((freq, i) => {
      const osc = sfxCtx.createOscillator(), g = sfxCtx.createGain();
      osc.type = 'triangle'; osc.frequency.setValueAtTime(freq, now + i * 0.09);
      g.gain.setValueAtTime(0.14, now + i * 0.09); g.gain.exponentialRampToValueAtTime(0.001, now + i * 0.09 + 0.35);
      osc.connect(g); g.connect(sfxCtx.destination);
      osc.start(now + i * 0.09); osc.stop(now + i * 0.09 + 0.36);
    });
  } catch (e) {}
}

function encodeVarInt(len) {
  const out = new Array();
  do { let digit = len % 128; len = Math.floor(len / 128); if (len > 0) digit |= 0x80; out.push(digit); } while (len > 0);
  return out;
}
function encodeStr(str) {
  const bytes = new TextEncoder().encode(str);
  return Uint8Array.of((bytes.length >> 8) & 0xff, bytes.length & 0xff, ...bytes);
}
function mqttConnectPacket(clientId) {
  const body = Uint8Array.of(...encodeStr('MQTT'), 4, 2, 0, 30, ...encodeStr(clientId));
  return Uint8Array.of(0x10, ...encodeVarInt(body.length), ...body);
}
function mqttSubscribePacket(topic) {
  const body = Uint8Array.of(0, 1, ...encodeStr(topic), 0);
  return Uint8Array.of(0x82, ...encodeVarInt(body.length), ...body);
}
function mqttPublishPacket(topic, jsonStr) {
  const body = Uint8Array.of(...encodeStr(topic), ...new TextEncoder().encode(jsonStr));
  return Uint8Array.of(0x30, ...encodeVarInt(body.length), ...body);
}

function sendPacket(payload) {
  if (!isOffline && ws && ws.readyState === WebSocket.OPEN && isConnected) {
    ws.send(mqttPublishPacket(`royal-casino-vip/${roomCode}`, JSON.stringify({ sender: myId, ...payload })));
  }
}

function getAudioElement(peerId) {
  let el = document.getElementById('aud-' + peerId);
  if (!el) {
    el = document.createElement('audio');
    el.id = 'aud-' + peerId; el.autoplay = true; el.playsInline = true; el.setAttribute('playsinline', '');
    document.getElementById('audioBank').appendChild(el);
  }
  return el;
}

async function requestMicSafe() {
  if (localStream) return localStream;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return null;
  try {
    const micPromise = navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
    const timeoutPromise = new Promise(resolve => setTimeout(() => resolve(null), 4000));
    localStream = await Promise.race(Array.of(micPromise, timeoutPromise));
    return localStream;
  } catch (e) { return null; }
}

async function createCallConnection(remoteId, isCaller) {
  if (peers[remoteId]) peers[remoteId].close();
  iceQueues[remoteId] = new Array();
  const pc = new RTCPeerConnection(RTC_CONFIG);
  peers[remoteId] = pc;
  if (localStream) localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
  pc.onicecandidate = (e) => { if (e.candidate) sendPacket({ type: 'CALL_ICE', to: remoteId, candidate: e.candidate }); };
  pc.ontrack = (e) => { const aud = getAudioElement(remoteId); aud.srcObject = e.streams.at(0); aud.play().catch(() => {}); updateCallUi(); };
  pc.onconnectionstatechange = () => updateCallUi();
  if (isCaller) {
    const offer = await pc.createOffer({ offerToReceiveAudio: true });
    await pc.setLocalDescription(offer);
    sendPacket({ type: 'CALL_OFFER', to: remoteId, sdp: pc.localDescription });
  }
  return pc;
}

function updateCallUi() {
  if (isOffline) { callBtn.className = 'call-btn no-mic'; callBtn.textContent = 'Локальный режим'; return; }
  if (!localStream) { callBtn.className = 'call-btn no-mic'; callBtn.textContent = '🎤 Вкл. микрофон'; return; }
  const cnt = Object.values(peers).filter(p => p.connectionState === 'connected' || p.iceConnectionState === 'connected' || p.iceConnectionState === 'completed').length;
  if (isMuted) { callBtn.className = 'call-btn muted'; callBtn.textContent = cnt > 0 ? `🔇 Без звука (${cnt})` : '🔇 Без звука'; }
  else { callBtn.className = 'call-btn'; callBtn.textContent = cnt > 0 ? `📞 В звонке (${cnt})` : '🎤 В эфире'; }
}

async function startCallAutomatically() {
  if (isOffline) { updateCallUi(); return; }
  await requestMicSafe();
  isMuted = false; updateCallUi();
  if (isHost && gameState.players[myId]) { gameState.players[myId].inCall = Boolean(localStream); gameState.players[myId].muted = false; broadcastState(); }
  else sendPacket({ type: 'CALL_STATUS', inCall: Boolean(localStream), muted: false });
  if (localStream) sendPacket({ type: 'CALL_JOIN' });
}

async function handleCallSignal(msg) {
  if (msg.to && msg.to !== myId) return;
  const remoteId = msg.sender;
  if (msg.type === 'CALL_JOIN') { if (!localStream) await startCallAutomatically(); await createCallConnection(remoteId, true); return; }
  if (msg.type === 'CALL_OFFER') {
    if (!localStream) await startCallAutomatically();
    const pc = await createCallConnection(remoteId, false);
    await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    sendPacket({ type: 'CALL_ANSWER', to: remoteId, sdp: pc.localDescription });
    for (const c of (iceQueues[remoteId] || new Array())) await pc.addIceCandidate(new RTCIceCandidate(c)).catch(() => {});
    iceQueues[remoteId] = new Array();
    return;
  }
  if (msg.type === 'CALL_ANSWER') {
    const pc = peers[remoteId];
    if (pc) {
      await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
      for (const c of (iceQueues[remoteId] || new Array())) await pc.addIceCandidate(new RTCIceCandidate(c)).catch(() => {});
      iceQueues[remoteId] = new Array();
    }
    return;
  }
  if (msg.type === 'CALL_ICE' && msg.candidate) {
    const pc = peers[remoteId];
    if (pc && pc.remoteDescription) await pc.addIceCandidate(new RTCIceCandidate(msg.candidate)).catch(() => {});
    else { if (!iceQueues[remoteId]) iceQueues[remoteId] = new Array(); iceQueues[remoteId].push(msg.candidate); }
  }
}
