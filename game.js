const WHEEL_NUMS = Array.of(0,32,15,19,4,21,2,25,17,34,6,27,13,36,11,30,8,23,10,5,24,16,33,1,20,14,31,9,22,18,29,7,28,12,35,3,26);
const RED_SET = new Set(Array.of(1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36));
const STEP_DEG = 360 / 37;
const PLAYER_COLORS = Array.of('#3b82f6', '#ec4899', '#a855f7', '#eab308', '#14b8a6', '#f97316');
const MQTT_URL = 'wss://broker.emqx.io:8084/mqtt';
const SPIN_DURATION_MS = 7800;

const RTC_CONFIG = {
  iceServers: Array.of(
    { urls: Array.of('stun', 'google.com', '19302').join(':') },
    { urls: Array.of('stun', 'metered.ca', '80').join(':') },
    {
      urls: Array.of('turn', 'metered.ca', '80').join(':'),
      username: 'e8dd65b92f62d3e36cae59ce',
      credential: '3bx6+71v7x2x1x4x'
    },
    {
      urls: Array.of('turn', 'metered.ca', '443').join(':'),
      username: 'e8dd65b92f62d3e36cae59ce',
      credential: '3bx6+71v7x2x1x4x'
    }
  )
};

let ws = null;
let isHost = false;
let isOffline = false;
let myId = 'u-' + Math.random().toString(36).slice(2, 9);
let myName = 'Игрок';
let roomCode = '';
let joinRetryTimer = null;
let lastAnimatedSpinId = 0;

let localStream = null;
let isMuted = false;
const peers = {};
const iceQueues = {};

let gameState = {
  mode: 'EU',
  isSpinning: false,
  spinId: 0,
  lastOutcomes: null,
  bannerHtml: 'Выберите фишку внизу и нажмите на ячейку стола',
  players: {}
};

let selectedChip = 10;
const casings = document.querySelectorAll('.wheel-casing');
const wheelAngles = Array.from(casings, () => ({ rotor: 0, ball: 0 }));
const lobbyStatus = document.getElementById('lobbyStatus');
const callBtn = document.getElementById('callBtn');

const numbersGrid = document.getElementById('numbersGrid');
for (let i = 1; i <= 36; i++) {
  const div = document.createElement('div');
  div.className = `spot ${RED_SET.has(i) ? 'c-red' : 'c-black'}`;
  div.dataset.type = 'number';
  div.dataset.val = String(i);
  div.textContent = i;
  numbersGrid.appendChild(div);
}

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
    const now = sfxCtx.currentTime;
    const osc = sfxCtx.createOscillator();
    const gain = sfxCtx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(1400, now);
    osc.frequency.exponentialRampToValueAtTime(320, now + 0.045);
    gain.gain.setValueAtTime(0.18, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.045);
    osc.connect(gain);
    gain.connect(sfxCtx.destination);
    osc.start(now);
    osc.stop(now + 0.05);
  } catch (e) {}
}

function playRouletteSpinSound() {
  try {
    initSfx();
    if (!sfxCtx) return;
    const start = sfxCtx.currentTime;

    const noiseDur = 4.6;
    const bufferSize = Math.floor(sfxCtx.sampleRate * noiseDur);
    const noiseBuffer = sfxCtx.createBuffer(1, bufferSize, sfxCtx.sampleRate);
    const data = noiseBuffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) data[i] = Math.random() * 2 - 1;

    const noise = sfxCtx.createBufferSource();
    noise.buffer = noiseBuffer;

    const bandpass = sfxCtx.createBiquadFilter();
    bandpass.type = 'bandpass';
    bandpass.Q.value = 3.5;
    bandpass.frequency.setValueAtTime(2400, start);
    bandpass.frequency.exponentialRampToValueAtTime(650, start + noiseDur);

    const noiseGain = sfxCtx.createGain();
    noiseGain.gain.setValueAtTime(0.01, start);
    noiseGain.gain.linearRampToValueAtTime(0.16, start + 0.25);
    noiseGain.gain.exponentialRampToValueAtTime(0.002, start + noiseDur);

    noise.connect(bandpass);
    bandpass.connect(noiseGain);
    noiseGain.connect(sfxCtx.destination);
    noise.start(start);
    noise.stop(start + noiseDur);

    let t = 0.05;
    let step = 0.042;
    let idx = 0;
    while (t < 7.35) {
      const hitTime = start + t;
      const osc = sfxCtx.createOscillator();
      const g = sfxCtx.createGain();

      const isDropping = t > 4.4;
      const baseFreq = isDropping ? (1900 + (idx % 3) * 280) : (1200 + (idx % 2) * 180);
      const vol = isDropping ? Math.max(0.05, 0.28 - (t - 4.4) * 0.05) : 0.09;

      osc.type = isDropping ? 'sine' : 'triangle';
      osc.frequency.setValueAtTime(baseFreq, hitTime);
      osc.frequency.exponentialRampToValueAtTime(280, hitTime + 0.032);

      g.gain.setValueAtTime(vol, hitTime);
      g.gain.exponentialRampToValueAtTime(0.001, hitTime + 0.034);

      osc.connect(g);
      g.connect(sfxCtx.destination);
      osc.start(hitTime);
      osc.stop(hitTime + 0.036);

      if (t < 3.5) step *= 1.022;
      else if (t < 5.5) step *= 1.065;
      else step *= 1.16;

      t += step;
      idx++;
    }

    const lockTime = start + 7.55;
    const lockOsc = sfxCtx.createOscillator();
    const lockGain = sfxCtx.createGain();
    lockOsc.type = 'sine';
    lockOsc.frequency.setValueAtTime(520, lockTime);
    lockOsc.frequency.exponentialRampToValueAtTime(110, lockTime + 0.09);
    lockGain.gain.setValueAtTime(0.32, lockTime);
    lockGain.gain.exponentialRampToValueAtTime(0.001, lockTime + 0.095);
    lockOsc.connect(lockGain);
    lockGain.connect(sfxCtx.destination);
    lockOsc.start(lockTime);
    lockOsc.stop(lockTime + 0.1);
  } catch (e) {}
}

function playWinChime() {
  try {
    initSfx();
    if (!sfxCtx) return;
    const now = sfxCtx.currentTime;
    Array.of(523.25, 659.25, 783.99, 1046.5).forEach((freq, i) => {
      const osc = sfxCtx.createOscillator();
      const g = sfxCtx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(freq, now + i * 0.09);
      g.gain.setValueAtTime(0.14, now + i * 0.09);
      g.gain.exponentialRampToValueAtTime(0.001, now + i * 0.09 + 0.35);
      osc.connect(g);
      g.connect(sfxCtx.destination);
      osc.start(now + i * 0.09);
      osc.stop(now + i * 0.09 + 0.36);
    });
  } catch (e) {}
}

function formatAmount(num) {
  return num >= 1000 ? (num / 1000).toFixed(num % 1000 === 0 ? 0 : 1) + 'K' : num;
}

function getPlayerTotalBet(p) {
  const sum = Object.values(p.bets || {}).reduce((a, b) => a + b, 0);
  return sum * (gameState.mode === 'MW' ? 3 : 1);
}

function renderAll() {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.mode === gameState.mode);
    btn.disabled = !isHost || gameState.isSpinning;
  });

  document.getElementById('spot00').style.display = (gameState.mode === 'US' || gameState.mode === '3Z') ? 'flex' : 'none';
  document.getElementById('spot000').style.display = (gameState.mode === '3Z') ? 'flex' : 'none';
  document.getElementById('wheelsStage').classList.toggle('multi', gameState.mode === 'MW');
  document.getElementById('resultBanner').innerHTML = gameState.bannerHtml;

  const spinBtn = document.getElementById('spinBtn');
  spinBtn.style.display = isHost ? 'inline-block' : 'none';
  spinBtn.disabled = gameState.isSpinning;
  document.getElementById('resetMyBetsBtn').disabled = gameState.isSpinning;

  const playersBar = document.getElementById('playersBar');
  playersBar.innerHTML = '';
  const pList = Object.values(gameState.players);

  pList.forEach(p => {
    const card = document.createElement('div');
    card.className = `player-card ${p.id === myId ? 'me' : ''}`;
    card.style.setProperty('--p-color', p.color);
    const callIcon = p.inCall ? (p.muted ? ' 🔇' : ' 📞') : '';
    card.innerHTML = `
      <div>
        <div class="player-name"><span class="p-dot"></span>${p.name}${callIcon} ${p.id === myId ? '(Вы)' : ''}</div>
        <div class="player-bal">${p.balance.toLocaleString('ru-RU')} ₽</div>
      </div>
      <div class="player-bet-tag">Ставка:<br><b style="color:#fff;">${getPlayerTotalBet(p)} ₽</b></div>
    `;
    playersBar.appendChild(card);
  });

  document.querySelectorAll('.spot').forEach(spot => {
    const old = spot.querySelector('.chips-stack');
    if (old) old.remove();

    const key = `${spot.dataset.type}:${spot.dataset.val}`;
    const stack = document.createElement('div');
    stack.className = 'chips-stack';

    pList.forEach(p => {
      const amt = (p.bets || {})[key];
      if (amt > 0) {
        const chipEl = document.createElement('div');
        chipEl.className = 'placed-chip';
        chipEl.style.setProperty('--p-color', p.color);
        chipEl.textContent = formatAmount(amt);
        stack.appendChild(chipEl);
      }
    });

    if (stack.children.length > 0) spot.appendChild(stack);
  });
}

function encodeVarInt(len) {
  const out = new Array();
  do {
    let digit = len % 128;
    len = Math.floor(len / 128);
    if (len > 0) digit |= 0x80;
    out.push(digit);
  } while (len > 0);
  return out;
}

function encodeStr(str) {
  const bytes = new TextEncoder().encode(str);
  return Uint8Array.of((bytes.length >> 8) & 0xff, bytes.length & 0xff, ...bytes);
}

function mqttConnectPacket(clientId) {
  const proto = encodeStr('MQTT');
  const cid = encodeStr(clientId);
  const body = Uint8Array.of(...proto, 4, 2, 0, 60, ...cid);
  return Uint8Array.of(0x10, ...encodeVarInt(body.length), ...body);
}

function mqttSubscribePacket(topic) {
  const t = encodeStr(topic);
  const body = Uint8Array.of(0, 1, ...t, 0);
  return Uint8Array.of(0x82, ...encodeVarInt(body.length), ...body);
}

function mqttPublishPacket(topic, jsonStr) {
  const t = encodeStr(topic);
  const payload = new TextEncoder().encode(jsonStr);
  const body = Uint8Array.of(...t, ...payload);
  return Uint8Array.of(0x30, ...encodeVarInt(body.length), ...body);
}

function sendPacket(payload) {
  if (isOffline) return;
  if (ws && ws.readyState === WebSocket.OPEN) {
    const topic = `royal-casino-ru/${roomCode}`;
    const jsonStr = JSON.stringify({ sender: myId, ...payload });
    ws.send(mqttPublishPacket(topic, jsonStr));
  }
}

function broadcastState() {
  if (!isHost) return;
  renderAll();
  sendPacket({ type: 'STATE', state: gameState });
}

function getAudioElement(peerId) {
  let el = document.getElementById('aud-' + peerId);
  if (!el) {
    el = document.createElement('audio');
    el.id = 'aud-' + peerId;
    el.autoplay = true;
    el.playsInline = true;
    el.setAttribute('playsinline', '');
    document.getElementById('audioBank').appendChild(el);
  }
  return el;
}

async function requestMicSafe() {
  if (localStream) return localStream;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return null;
  try {
    const micPromise = navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false
    });
    const timeoutPromise = new Promise(resolve => setTimeout(() => resolve(null), 4000));
    localStream = await Promise.race(Array.of(micPromise, timeoutPromise));
    return localStream;
  } catch (e) {
    return null;
  }
}

async function createCallConnection(remoteId, isCaller) {
  if (peers[remoteId]) peers[remoteId].close();
  iceQueues[remoteId] = new Array();

  const pc = new RTCPeerConnection(RTC_CONFIG);
  peers[remoteId] = pc;

  if (localStream) {
    localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
  }

  pc.onicecandidate = (e) => {
    if (e.candidate) sendPacket({ type: 'CALL_ICE', to: remoteId, candidate: e.candidate });
  };

  pc.ontrack = (e) => {
    const aud = getAudioElement(remoteId);
    aud.srcObject = e.streams.at(0);
    aud.play().catch(() => {});
    updateCallUi();
  };

  pc.onconnectionstatechange = () => updateCallUi();

  if (isCaller) {
    const offer = await pc.createOffer({ offerToReceiveAudio: true });
    await pc.setLocalDescription(offer);
    sendPacket({ type: 'CALL_OFFER', to: remoteId, sdp: pc.localDescription });
  }
  return pc;
}

function updateCallUi() {
  if (isOffline) {
    callBtn.className = 'call-btn no-mic';
    callBtn.textContent = 'Локальный режим';
    return;
  }
  if (!localStream) {
    callBtn.className = 'call-btn no-mic';
    callBtn.textContent = '🎤 Вкл. микрофон';
    return;
  }
  const connectedCount = Object.values(peers).filter(
    p => p.connectionState === 'connected' || p.iceConnectionState === 'connected' || p.iceConnectionState === 'completed'
  ).length;

  if (isMuted) {
    callBtn.className = 'call-btn muted';
    callBtn.textContent = connectedCount > 0 ? `🔇 Без звука (${connectedCount})` : '🔇 Без звука';
  } else {
    callBtn.className = 'call-btn';
    callBtn.textContent = connectedCount > 0 ? `📞 В звонке (${connectedCount})` : '🎤 В эфире';
  }
}

async function startCallAutomatically() {
  if (isOffline) {
    updateCallUi();
    return;
  }
  await requestMicSafe();
  isMuted = false;
  updateCallUi();

  if (isHost && gameState.players[myId]) {
    gameState.players[myId].inCall = Boolean(localStream);
    gameState.players[myId].muted = false;
    broadcastState();
  } else {
    sendPacket({ type: 'CALL_STATUS', inCall: Boolean(localStream), muted: false });
  }

  if (localStream) sendPacket({ type: 'CALL_JOIN' });
}

async function handleCallSignal(msg) {
  if (msg.to && msg.to !== myId) return;
  const remoteId = msg.sender;

  if (msg.type === 'CALL_JOIN') {
    if (!localStream) await startCallAutomatically();
    await createCallConnection(remoteId, true);
    return;
  }

  if (msg.type === 'CALL_OFFER') {
    if (!localStream) await startCallAutomatically();
    const pc = await createCallConnection(remoteId, false);
    await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    sendPacket({ type: 'CALL_ANSWER', to: remoteId, sdp: pc.localDescription });

    for (const c of (iceQueues[remoteId] || new Array())) {
      await pc.addIceCandidate(new RTCIceCandidate(c)).catch(() => {});
    }
    iceQueues[remoteId] = new Array();
    return;
  }

  if (msg.type === 'CALL_ANSWER') {
    const pc = peers[remoteId];
    if (pc) {
      await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
      for (const c of (iceQueues[remoteId] || new Array())) {
        await pc.addIceCandidate(new RTCIceCandidate(c)).catch(() => {});
      }
      iceQueues[remoteId] = new Array();
    }
    return;
  }

  if (msg.type === 'CALL_ICE' && msg.candidate) {
    const pc = peers[remoteId];
    if (pc && pc.remoteDescription) {
      await pc.addIceCandidate(new RTCIceCandidate(msg.candidate)).catch(() => {});
    } else {
      if (!iceQueues[remoteId]) iceQueues[remoteId] = new Array();
      iceQueues[remoteId].push(msg.candidate);
    }
  }
}

callBtn.addEventListener('click', async () => {
  initSfx();
  if (isOffline) return;
  document.querySelectorAll('#audioBank audio').forEach(a => a.play().catch(() => {}));

  if (!localStream) {
    callBtn.textContent = '⏳ Микрофон...';
    await startCallAutomatically();
    return;
  }

  isMuted = !isMuted;
  localStream.getAudioTracks().forEach(t => { t.enabled = !isMuted; });
  updateCallUi();

  if (isHost && gameState.players[myId]) {
    gameState.players[myId].muted = isMuted;
    broadcastState();
  } else {
    sendPacket({ type: 'CALL_STATUS', inCall: true, muted: isMuted });
  }
});

function highlightWinningSpots(outcomes) {
  document.querySelectorAll('.spot.win-glow').forEach(el => el.classList.remove('win-glow'));
  if (!outcomes) return;
  outcomes.forEach(sec => {
    const spot = document.querySelector(`.spot[data-type="number"][data-val="${sec}"]`);
    if (spot) spot.classList.add('win-glow');
  });
}

function animateWheels(outcomes) {
  if (!outcomes || !outcomes.length) return;
  playRouletteSpinSound();

  outcomes.forEach((winStr, idx) => {
    const casing = casings[idx];
    if (!casing) return;
    const rotor = casing.querySelector('.wheel-rotor');
    const track = casing.querySelector('.ball-track');
    const ball = casing.querySelector('.ball');

    ball.classList.remove('dropped');

    const visualIdx = Array.of('0', '00', '000').includes(winStr) ? 0 : WHEEL_NUMS.indexOf(Number(winStr));
    const targetAngle = visualIdx * STEP_DEG;
    const randomBallStop = Math.floor(Math.random() * 360);

    const curMod = ((wheelAngles[idx].rotor % 360) + 360) % 360;
    const desMod = ((randomBallStop - targetAngle) % 360 + 360) % 360;
    const delta = ((desMod - curMod) + 360) % 360;

    wheelAngles[idx].rotor += 2880 + delta;
    wheelAngles[idx].ball -= 4680 + (((wheelAngles[idx].ball % 360) + 360) % 360 - randomBallStop);

    rotor.style.transition = `transform ${SPIN_DURATION_MS / 1000}s cubic-bezier(0.08, 0.88, 0.16, 1)`;
    track.style.transition = `transform ${SPIN_DURATION_MS / 1000}s cubic-bezier(0.06, 0.91, 0.14, 1)`;

    rotor.style.transform = `rotate(${wheelAngles[idx].rotor}deg)`;
    track.style.transform = `rotate(${wheelAngles[idx].ball}deg)`;

    setTimeout(() => {
      ball.classList.add('dropped');
    }, 4500);
  });
}

function handleHostAction(senderId, data) {
  if (!isHost) return;

  if (data.type === 'JOIN') {
    if (!gameState.players[senderId]) {
      const idx = Object.keys(gameState.players).length;
      gameState.players[senderId] = {
        id: senderId,
        name: data.name || `Игрок ${idx + 1}`,
        color: PLAYER_COLORS[idx % PLAYER_COLORS.length],
        balance: 2000,
        bets: {},
        inCall: false,
        muted: false
      };
    }
    broadcastState();
    return;
  }

  const p = gameState.players[senderId];
  if (!p) return;

  if (data.type === 'BET' && !gameState.isSpinning) {
    const mult = gameState.mode === 'MW' ? 3 : 1;
    if (getPlayerTotalBet(p) + data.amount * mult <= p.balance) {
      p.bets[data.key] = (p.bets[data.key] || 0) + data.amount;
      broadcastState();
    }
  }

  if (data.type === 'CLEAR_BETS' && !gameState.isSpinning) {
    p.bets = {};
    broadcastState();
  }

  if (data.type === 'CALL_STATUS') {
    p.inCall = Boolean(data.inCall);
    p.muted = Boolean(data.muted);
    broadcastState();
  }
}

function processMqttBuffer(arrayBuf) {
  const buf = new Uint8Array(arrayBuf);
  let offset = 0;

  while (offset < buf.length) {
    const packetType = buf.at(offset) >> 4;
    let multiplier = 1;
    let remLen = 0;
    let pos = offset + 1;
    let digit;

    do {
      if (pos >= buf.length) return;
      digit = buf.at(pos++);
      remLen += (digit & 127) * multiplier;
      multiplier *= 128;
    } while ((digit & 128) !== 0);

    const packetEnd = pos + remLen;
    if (packetEnd > buf.length) return;

    if (packetType === 2) {
      ws.send(mqttSubscribePacket(`royal-casino-ru/${roomCode}`));
      setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send(Uint8Array.of(0xc0, 0x00));
      }, 25000);
      if (ws._onReadyCallback) {
        ws._onReadyCallback();
        ws._onReadyCallback = null;
      }
    } else if (packetType === 3) {
      const topicLen = (buf.at(pos) << 8) | buf.at(pos + 1);
      const payloadStart = pos + 2 + topicLen;
      const payloadText = new TextDecoder().decode(buf.slice(payloadStart, packetEnd));

      try {
        const msg = JSON.parse(payloadText);
        if (msg && msg.sender !== myId) {
          if (Array.of('CALL_JOIN', 'CALL_OFFER', 'CALL_ANSWER', 'CALL_ICE').includes(msg.type)) {
            handleCallSignal(msg);
          } else if (isHost) {
            handleHostAction(msg.sender, msg);
          } else if (msg.type === 'STATE') {
            if (joinRetryTimer) {
              clearInterval(joinRetryTimer);
              joinRetryTimer = null;
            }
            const wasSpinning = gameState.isSpinning;
            gameState = msg.state;
            renderAll();

            if (gameState.isSpinning && gameState.spinId > lastAnimatedSpinId) {
              lastAnimatedSpinId = gameState.spinId;
              setTimeout(() => animateWheels(gameState.lastOutcomes), 30);
            } else if (wasSpinning && !gameState.isSpinning && gameState.lastOutcomes) {
              highlightWinningSpots(gameState.lastOutcomes);
            }
          }
        }
      } catch (e) {}
    }

    offset = packetEnd;
  }
}

function connectMqtt(onSubscribed) {
  ws = new WebSocket(MQTT_URL, 'mqtt');
  ws.binaryType = 'arraybuffer';
  ws._onReadyCallback = onSubscribed;

  ws.onopen = () => ws.send(mqttConnectPacket('rc_' + myId));
  ws.onmessage = (event) => processMqttBuffer(event.data);

  ws.onerror = () => {
    lobbyStatus.style.color = '#f87171';
    lobbyStatus.textContent
