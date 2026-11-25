const EU_NUMBERS = "0,32,15,19,4,21,2,25,17,34,6,27,13,36,11,30,8,23,10,5,24,16,33,1,20,14,31,9,22,18,29,7,28,12,35,3,26".split(',').map(Number);
const US_NUMBERS = "0,28,9,26,30,11,7,20,32,17,5,22,34,15,3,24,36,13,1,00,27,10,25,29,12,8,19,31,18,6,21,33,16,4,23,35,14,2".split(',').map(v => v === '00' ? '00' : Number(v));
const RED_NUMS = new Set("1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36".split(',').map(Number));

let currentMode = 'EU';
let wheelNumbers = EU_NUMBERS;
let balance = 10000;
let bets = {};
let wheelAngle = 0;
let ballAngle = -Math.PI / 2;
let ballRadius = 132;
let isSpinning = false;
let lastSpinId = 0;

let mqttClient = null;
let isHost = false;
let hostPassword = '';
let currentRoomId = '';
let myName = '';
const myId = 'u-' + Math.random().toString(36).substring(2, 9);
let players = new Array();
let roomTopic = '';
let stateTopic = '';
let joinTimeout = null;
let cachedRoomState = null;

// Закодированные адреса (cdnjs + HiveMQ)
const MQTT_LIB_URL = atob('aHR0cHM6Ly9jZG5qcy5jbG91ZGZsYXJlLmNvbS9hamF4L2xpYnMvbXF0dC81LjMuNC9tcXR0Lm1pbi5qcw==');
const BROKER_URL = atob('d3NzOi8vYnJva2VyLmhpdmVtcS5jb206ODg4NC9tcXR0');

const urlParams = new URLSearchParams(window.location.search);
const linkRoom = urlParams.get('room');
document.getElementById('inputRoom').value = linkRoom || Math.random().toString(36).substring(2, 7).toUpperCase();
document.getElementById('inputName').value = 'VIP-' + Math.floor(100 + Math.random() * 900);

function ensureMqttLibrary() {
  return new Promise((resolve) => {
    if (typeof window.mqtt !== 'undefined') return resolve(true);
    const s = document.createElement('script');
    s.src = MQTT_LIB_URL;
    s.onload = () => resolve(true);
    s.onerror = () => resolve(false);
    document.head.appendChild(s);
  });
}

function setLoginStatus(text) {
  document.getElementById('loginError').innerText = text;
}

function getTotalBetAmount() {
  let sum = 0;
  for (let k in bets) sum += bets[k];
  return sum;
}

// 1. Создать комнату (Хост)
async function startAsHost() {
  myName = document.getElementById('inputName').value.trim() || 'Хост';
  currentRoomId = (document.getElementById('inputRoom').value.trim() || 'GOLD77').toUpperCase();
  hostPassword = document.getElementById('inputPass').value;
  isHost = true;

  setLoginStatus('⏳ Создание комнаты #' + currentRoomId + '...');
  document.getElementById('createBtn').disabled = true;

  const ok = await connectToBroker();
  if (!ok) {
    document.getElementById('createBtn').disabled = false;
    setLoginStatus('❌ Нет связи с сервером. Проверьте интернет.');
    return;
  }

  players = [{
    id: myId,
    name: myName,
    isHost: true,
    balance: balance,
    currentBet: 0,
    inCall: false,
    muted: false
  }];

  enterTable();
  publishRetainedState();
}

// 2. Войти в комнату друга (Гость) — работает мгновенно через Retained-состояние
async function joinAsGuest() {
  myName = document.getElementById('inputName').value.trim() || 'Игрок';
  currentRoomId = (document.getElementById('inputRoom').value.trim() || '').toUpperCase();
  const password = document.getElementById('inputPass').value;
  isHost = false;
  cachedRoomState = null;

  if (!currentRoomId) {
    setLoginStatus('❌ Введите код комнаты друга!');
    return;
  }

  setLoginStatus('⏳ Поиск комнаты #' + currentRoomId + '...');
  document.getElementById('joinBtn').disabled = true;

  const ok = await connectToBroker();
  if (!ok) {
    document.getElementById('joinBtn').disabled = false;
    setLoginStatus('❌ Не удалось подключиться к облаку.');
    return;
  }

  // Ждём мгновенный снимок комнаты от брокера (до 5 секунд)
  clearTimeout(joinTimeout);
  joinTimeout = setTimeout(() => {
    if (!cachedRoomState) {
      document.getElementById('joinBtn').disabled = false;
      setLoginStatus('❌ Комната #' + currentRoomId + ' не найдена! Проверьте код.');
    }
  }, 5000);
}

function tryEnterFromRetained(state) {
  clearTimeout(joinTimeout);
  document.getElementById('joinBtn').disabled = false;

  const enteredPass = document.getElementById('inputPass').value;
  if (state.password && state.password !== enteredPass) {
    setLoginStatus('❌ Неверный пароль от комнаты!');
    return;
  }
  if (state.players.length >= 6 && !state.players.find(p => p.id === myId)) {
    setLoginStatus('❌ В комнате уже максимум (6 игроков)!');
    return;
  }

  players = state.players;
  if (!players.find(p => p.id === myId)) {
    players.push({
      id: myId,
      name: myName,
      isHost: false,
      balance: balance,
      currentBet: 0,
      inCall: false,
      muted: false
    });
  }

  applyModeUI(state.mode || 'EU');
  enterTable();
  sendMsg({ type: 'GUEST_HELLO', name: myName, balance: balance });
}

async function connectToBroker() {
  const loaded = await ensureMqttLibrary();
  if (!loaded || typeof window.mqtt === 'undefined') return false;

  return new Promise((resolve) => {
    if (mqttClient && mqttClient.connected) {
      subscribeTopics();
      return resolve(true);
    }

    mqttClient = window.mqtt.connect(BROKER_URL, {
      clientId: 'aurelia_' + myId,
      clean: true,
      keepalive: 20,
      connectTimeout: 8000,
      reconnectPeriod: 1000
    });

    mqttClient.on('connect', () => {
      subscribeTopics();
      if (currentRoomId && document.getElementById('loginModal').style.display === 'none') {
        if (isHost) publishRetainedState();
        else syncMyStats();
      }
      resolve(true);
    });

    mqttClient.on('error', () => resolve(false));
    mqttClient.on('message', (topic, payload) => {
      try {
        const text = payload.toString();
        if (!text) return;
        const msg = JSON.parse(text);

        if (topic === stateTopic) {
          // Получен актуальный снимок комнаты с сервера
          if (!isHost) {
            if (!cachedRoomState && document.getElementById('loginModal').style.display !== 'none') {
              cachedRoomState = msg;
              tryEnterFromRetained(msg);
            } else if (document.getElementById('loginModal').style.display === 'none') {
              players = msg.players || players;
              if (!players.find(p => p.id === myId)) {
                sendMsg({ type: 'GUEST_HELLO', name: myName, balance: balance });
              }
              renderPlayersTable();
              if (msg.mode && msg.mode !== currentMode && !isSpinning) {
                applyModeUI(msg.mode);
              }
            }
          }
          return;
        }

        if (msg.from === myId) return;
        handleEventMessage(msg);
      } catch (e) {}
    });
  });
}

function subscribeTopics() {
  roomTopic = 'aurelia/vip/v6/events/' + currentRoomId;
  stateTopic = 'aurelia/vip/v6/state/' + currentRoomId;
  mqttClient.subscribe([roomTopic, stateTopic], { qos: 1 });
}

function sendMsg(data) {
  if (mqttClient && mqttClient.connected && roomTopic) {
    mqttClient.publish(roomTopic, JSON.stringify({ ...data, from: myId }), { qos: 1 });
  }
}

// Сохраняем состояние комнаты в облаке (retain: true), чтобы гости входили мгновенно
function publishRetainedState() {
  renderPlayersTable();
  if (isHost && mqttClient && mqttClient.connected && stateTopic) {
    const snapshot = {
      password: hostPassword,
      mode: currentMode,
      players: players,
      updatedAt: Date.now()
    };
    mqttClient.publish(stateTopic, JSON.stringify(snapshot), { qos: 1, retain: true });
  }
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && mqttClient && roomTopic) {
    if (!mqttClient.connected) {
      mqttClient.reconnect();
    } else {
      subscribeTopics();
      if (isHost) publishRetainedState();
      else syncMyStats();
    }
  }
});

function enterTable() {
  window.history.replaceState({}, '', `?room=${currentRoomId}`);
  document.getElementById('roomTitle').innerText = `#${currentRoomId}`;
  document.getElementById('loginModal').style.display = 'none';

  const spinBtn = document.getElementById('spinBtn');
  if (!isHost) {
    spinBtn.disabled = true;
    spinBtn.innerText = '👑 ЖДЁМ ХОСТА';
    document.querySelectorAll('.mode-group .gold-btn').forEach(btn => {
      btn.disabled = true;
      btn.title = 'Режим выбирает создатель комнаты';
    });
  } else {
    spinBtn.disabled = false;
    spinBtn.innerText = 'КРУТИТЬ БАРАБАН';
  }

  renderPlayersTable();
}

function handleEventMessage(msg) {
  if (isHost) {
    if (msg.type === 'GUEST_HELLO' || msg.type === 'PLAYER_UPDATE') {
      const existing = players.find(x => x.id === msg.from);
      if (existing) {
        if (msg.balance !== undefined) existing.balance = msg.balance;
        if (msg.currentBet !== undefined) existing.currentBet = msg.currentBet;
      } else if (players.length < 6) {
        players.push({
          id: msg.from,
          name: msg.name || 'Игрок',
          isHost: false,
          balance: msg.balance || 10000,
          currentBet: msg.currentBet || 0,
          inCall: false,
          muted: false
        });
      }
      publishRetainedState();
    } else if (msg.type === 'LEAVE') {
      players = players.filter(p => p.id !== msg.from);
      closePeer(msg.from);
      publishRetainedState();
    } else if (msg.type === 'VOICE_STATE') {
      const p = players.find(x => x.id === msg.from);
      if (p) {
        p.inCall = msg.inCall;
        p.muted = msg.muted;
        publishRetainedState();
      }
    }
  } else {
    if (msg.type === 'MODE_SET') {
      if (!isSpinning) applyModeUI(msg.mode);
    } else if (msg.type === 'SPIN_GO') {
      if (msg.spinId !== lastSpinId) {
        lastSpinId = msg.spinId;
        runSpinAnimation(msg.winningIndex);
      }
    }
  }

  // WebRTC голосовой звонок
  if (msg.to === myId) {
    if (msg.type === 'RTC_OFFER') handleReceiveOffer(msg.from, msg.offer);
    else if (msg.type === 'RTC_ANSWER') handleReceiveAnswer(msg.from, msg.answer);
    else if (msg.type === 'RTC_ICE') handleReceiveIce(msg.from, msg.candidate);
  }
  if (msg.type === 'VOICE_JOINED' && localStream) {
    createVoicePeer(msg.from, true);
  }
}

function syncMyStats() {
  const totalBet = getTotalBetAmount();
  if (isHost) {
    const me = players.find(p => p.id === myId);
    if (me) {
      me.balance = balance;
      me.currentBet = totalBet;
    }
    publishRetainedState();
  } else {
    sendMsg({ type: 'PLAYER_UPDATE', name: myName, balance: balance, currentBet: totalBet });
  }
}

window.addEventListener('beforeunload', () => {
  sendMsg({ type: 'LEAVE' });
});

function renderPlayersTable() {
  document.getElementById('playerCount').innerText = players.length;
  const list = document.getElementById('playersList');

  let html = `
    <table style="width:100%; border-collapse:collapse; font-size:12px; text-align:left;">
      <thead>
        <tr style="border-bottom:1px solid #d4af37; color:#fff3b0;">
          <th style="padding:6px 4px;">Игрок</th>
          <th style="padding:6px 4px;">Баланс</th>
          <th style="padding:6px 4px;">Ставка</th>
          <th style="padding:6px 4px; text-align:right;">Звонок</th>
        </tr>
      </thead>
      <tbody>
  `;

  players.forEach((p) => {
    const isMe = p.id === myId;
    let voiceIcon = '💬';
    if (p.inCall) voiceIcon = p.muted ? '🔇' : '🔊';

    html += `
      <tr style="border-bottom:1px solid rgba(212,175,55,0.25); background:${isMe ? 'rgba(212,175,55,0.12)' : 'transparent'};">
        <td style="padding:7px 4px; font-weight:${isMe ? 'bold' : 'normal'};">
          ${p.isHost ? '👑' : '🎲'} ${p.name} ${isMe ? '(Вы)' : ''}
        </td>
        <td style="padding:7px 4px; color:#fff3b0;">${p.balance} 🪙</td>
        <td style="padding:7px 4px; color:${p.currentBet > 0 ? '#4caf50' : '#888'}; font-weight:bold;">
          ${p.currentBet > 0 ? p.currentBet + ' 🪙' : '—'}
        </td>
        <td style="padding:7px 4px; text-align:right;">${voiceIcon}</td>
      </tr>
    `;
  });

  for (let i = players.length; i < 6; i++) {
    html += `
      <tr style="border-bottom:1px dashed rgba(212,175,55,0.2); opacity:0.45;">
        <td colspan="4" style="padding:6px 4px;">Место #${i + 1} свободно</td>
      </tr>
    `;
  }

  html += `</tbody></table>`;
  list.innerHTML = html;
}

function requestMode(mode) {
  if (!isHost || isSpinning) return;
  applyModeUI(mode);
  sendMsg({ type: 'MODE_SET', mode });
  publishRetainedState();
}

function applyModeUI(mode) {
  currentMode = mode;
  wheelNumbers = (mode === 'US') ? US_NUMBERS : EU_NUMBERS;
  document.querySelectorAll('.mode-group .gold-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('btn-' + mode).classList.add('active');

  const hints = {
    'EU': 'Европейская (одно зеро)',
    'US': 'Американская (0 и 00)',
    'FR': 'Французская (La Partage: 50% при 0)'
  };
  document.getElementById('ruleHint').innerText = hints[mode];
  buildBoard();
  drawWheel();
}

function buildBoard() {
  const grid = document.getElementById('tableGrid');
  grid.innerHTML = '';
  const zeroCol = document.createElement('div');
  zeroCol.className = 'zero-col';
  zeroCol.appendChild(createCell('0', 'green'));
  if (currentMode === 'US') zeroCol.appendChild(createCell('00', 'green'));
  grid.appendChild(zeroCol);

  for (let row = 3; row >= 1; row--) {
    for (let col = 0; col < 12; col++) {
      const num = col * 3 + row;
      grid.appendChild(createCell(String(num), RED_NUMS.has(num) ? 'red' : 'black'));
    }
  }
}

function createCell(label, cls) {
  const div = document.createElement('div');
  div.className = `cell ${cls}`;
  div.innerText = label;
  div.onclick = () => placeBet(label, div);
  return div;
}

function placeBet(target, el) {
  if (isSpinning || balance < 100) return;
  balance -= 100;
  bets[target] = (bets[target] || 0) + 100;
  document.getElementById('balance').innerText = balance;

  let badge = el.querySelector('.chip-badge');
  if (!badge) {
    badge = document.createElement('div');
    badge.className = 'chip-badge';
    el.appendChild(badge);
  }
  badge.innerText = bets[target];
  syncMyStats();
}

function clearBets() {
  if (isSpinning) return;
  for (let k in bets) balance += bets[k];
  bets = {};
  document.getElementById('balance').innerText = balance;
  document.querySelectorAll('.chip-badge').forEach(b => b.remove());
  syncMyStats();
}

const canvas = document.getElementById('wheelCanvas');
const ctx = canvas.getContext('2d');

function drawWheel() {
  const cx = 160, cy = 160, r = 142;
  const arc = (2 * Math.PI) / wheelNumbers.length;
  ctx.clearRect(0, 0, 320, 320);

  ctx.beginPath();
  ctx.arc(cx, cy, r + 14, 0, 2 * Math.PI);
  const rimGrad = ctx.createLinearGradient(0, 0, 320, 320);
  rimGrad.addColorStop(0, '#fff3b0');
  rimGrad.addColorStop(0.5, '#d4af37');
  rimGrad.addColorStop(1, '#7a5c12');
  ctx.fillStyle = rimGrad;
  ctx.fill();

  wheelNumbers.forEach((num, i) => {
    const a = wheelAngle + i * arc;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, r, a, a + arc);
    ctx.fillStyle = (num === 0 || num === '00') ? '#1b5e20' : (RED_NUMS.has(num) ? '#7a1212' : '#14110d');
    ctx.fill();
    ctx.strokeStyle = '#d4af37';
    ctx.lineWidth = 1.2;
    ctx.stroke();

    ctx.save();
    ctx.translate(cx + Math.cos(a + arc / 2) * (r - 18), cy + Math.sin(a + arc / 2) * (r - 18));
    ctx.rotate(a + arc / 2 + Math.PI / 2);
    ctx.fillStyle = '#fff3b0';
    ctx.font = 'bold 10px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(num, 0, 0);
    ctx.restore();
  });

  ctx.beginPath();
  ctx.arc(cx, cy, 44, 0, 2 * Math.PI);
  const grad = ctx.createRadialGradient(cx, cy, 4, cx, cy, 44);
  grad.addColorStop(0, '#fff8dc');
  grad.addColorStop(0.6, '#d4af37');
  grad.addColorStop(1, '#5e4308');
  ctx.fillStyle = grad;
  ctx.fill();

  const bx = cx + Math.cos(ballAngle) * ballRadius;
  const by = cy + Math.sin(ballAngle) * ballRadius;
  ctx.beginPath();
  ctx.arc(bx, by, 6.5, 0, 2 * Math.PI);
  ctx.fillStyle = '#ffffff';
  ctx.shadowColor = '#000';
  ctx.shadowBlur = 5;
  ctx.fill();
  ctx.shadowBlur = 0;
}

function requestSpin() {
  if (!isHost || isSpinning) return;
  const winningIndex = Math.floor(Math.random() * wheelNumbers.length);
  const spinId = Date.now() + Math.random();
  lastSpinId = spinId;
  sendMsg({ type: 'SPIN_GO', winningIndex, spinId });
  runSpinAnimation(winningIndex);
}

function runSpinAnimation(winningIndex) {
  isSpinning = true;
  if (isHost) document.getElementById('spinBtn').disabled = true;
  document.getElementById('statusText').innerText = 'Шарик запущен...';

  const arc = (2 * Math.PI) / wheelNumbers.length;
  const duration = 4500;
  const startTime = performance.now();
  const startWheel = wheelAngle;
  const targetWheel = startWheel + Math.PI * 10;

  const finalSectorAngle = targetWheel + winningIndex * arc + arc / 2;
  const startBall = ballAngle;
  const totalBallDelta = (finalSectorAngle - startBall) - Math.PI * 14;

  function animate(now) {
    const t = Math.min((now - startTime) / duration, 1);
    const ease = 1 - Math.pow(1 - t, 3);

    wheelAngle = startWheel + (targetWheel - startWheel) * ease;
    ballAngle = startBall + totalBallDelta * ease;
    ballRadius = t < 0.5 ? 132 : 132 - ((t - 0.5) / 0.5) * 28;

    drawWheel();
    if (t < 1) {
      requestAnimationFrame(animate);
    } else {
      isSpinning = false;
      if (isHost) document.getElementById('spinBtn').disabled = false;
      finishRound(wheelNumbers[winningIndex]);
    }
  }
  requestAnimationFrame(animate);
}

function finishRound(winNum) {
  let winAmount = 0;
  const isZero = (winNum === 0 || winNum === '00');
  const isRed = !isZero && RED_NUMS.has(winNum);

  for (let target in bets) {
    const amt = bets[target];
    if (target === String(winNum)) winAmount += amt * 36;
    else if (target === 'RED' && isRed) winAmount += amt * 2;
    else if (target === 'BLACK' && !isZero && !isRed) winAmount += amt * 2;
    else if (target === 'EVEN' && !isZero && winNum % 2 === 0) winAmount += amt * 2;
    else if (currentMode === 'FR' && winNum === 0 && ['RED', 'BLACK', 'EVEN'].includes(target)) {
      winAmount += amt * 0.5;
    }
  }

  balance += winAmount;
  document.getElementById('balance').innerText = balance;
  document.getElementById('statusText').innerText = `Выпало: ${winNum}! Выигрыш: ${winAmount} 🪙`;
  bets = {};
  document.querySelectorAll('.chip-badge').forEach(b => b.remove());
  syncMyStats();
}

let localStream = null;
let isMuted = false;
const peers = {};
const rtcConfig = {
  iceServers: [
    { urls: 'stun:google.com' },
    { urls: 'stun:stun.yandex.ru:3478' }
  ]
};

async function joinVoiceCall() {
  if (localStream) return;
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    isMuted = false;
    document.getElementById('callBtn').innerText = '🟢 В звонке';
    document.getElementById('callBtn').disabled = true;
    document.getElementById('muteBtn').disabled = false;

    sendMsg({ type: 'VOICE_JOINED' });
    updateMyVoiceState(true, false);
  } catch (e) {
    alert('Разрешите доступ к микрофону в настройках браузера.');
  }
}

function createVoicePeer(remoteId, initiator) {
  if (peers[remoteId]) return peers[remoteId];
  const pc = new RTCPeerConnection(rtcConfig);
  peers[remoteId] = pc;

  if (localStream) {
    localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
  }

  pc.onicecandidate = (e) => {
    if (e.candidate) sendMsg({ type: 'RTC_ICE', to: remoteId, candidate: e.candidate });
  };

  pc.ontrack = (e) => {
    let audio = document.getElementById('audio-' + remoteId);
    if (!audio) {
      audio = document.createElement('audio');
      audio.id = 'audio-' + remoteId;
      audio.autoplay = true;
      audio.playsInline = true;
      document.getElementById('audioContainer').appendChild(audio);
    }
    audio.srcObject = e.streams[0];
  };

  if (initiator) {
    pc.createOffer().then(offer => {
      pc.setLocalDescription(offer);
      sendMsg({ type: 'RTC_OFFER', to: remoteId, offer });
    });
  }
  return pc;
}

async function handleReceiveOffer(from, offer) {
  if (!localStream) return;
  const pc = createVoicePeer(from, false);
  await pc.setRemoteDescription(new RTCSessionDescription(offer));
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  sendMsg({ type: 'RTC_ANSWER', to: from, answer });
}

async function handleReceiveAnswer(from, answer) {
  if (peers[from]) await peers[from].setRemoteDescription(new RTCSessionDescription(answer));
}

async function handleReceiveIce(from, candidate) {
  if (peers[from]) await peers[from].addIceCandidate(new RTCIceCandidate(candidate));
}

function closePeer(remoteId) {
  if (peers[remoteId]) {
    peers[remoteId].close();
    delete peers[remoteId];
  }
  const el = document.getElementById('audio-' + remoteId);
  if (el) el.remove();
}

function toggleMute() {
  if (!localStream) return;
  isMuted = !isMuted;
  localStream.getAudioTracks().forEach(t => { t.enabled = !isMuted; });

  const btn = document.getElementById('muteBtn');
  if (isMuted) {
    btn.innerText = '🔇 Микрофон: ВЫКЛ';
    btn.classList.add('danger');
  } else {
    btn.innerText = '🎙️ Микрофон: ВКЛ';
    btn.classList.remove('danger');
  }
  updateMyVoiceState(true, isMuted);
}

function updateMyVoiceState(inCall, muted) {
  if (isHost) {
    const me = players.find(p => p.id === myId);
    if (me) { me.inCall = inCall; me.muted = muted; }
    publishRetainedState();
  } else {
    sendMsg({ type: 'VOICE_STATE', inCall, muted });
  }
}

function copyRoomLink() {
  const baseUrl = window.location.href.split('?').shift();
  const link = baseUrl + '?room=' + currentRoomId;
  navigator.clipboard?.writeText(link);
  alert(`Ссылка скопирована!\nКод комнаты: ${currentRoomId}\nТеперь друг может войти мгновенно, даже если вы свернули браузер.`);
}

buildBoard();
drawWheel();
