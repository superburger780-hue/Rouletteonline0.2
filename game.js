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

let peer = null;
let isHost = false;
let hostPassword = '';
let currentRoomId = '';
let myName = '';
let myPeerId = '';
let hostConn = null;
const guestConns = new Map();
let players = new Array();

// Автоматическая загрузка библиотеки PeerJS с резервного CDN
function ensurePeerLibrary() {
  return new Promise((resolve) => {
    if (typeof window.Peer !== 'undefined') return resolve(true);
    const s = document.createElement('script');
    s.src = 'https:' + '//cdn.jsdelivr.net/npm/peerjs@1.5.4/dist/peerjs.min.js';
    s.onload = () => resolve(true);
    s.onerror = () => resolve(false);
    document.head.appendChild(s);
  });
}

const urlParams = new URLSearchParams(window.location.search);
const linkRoom = urlParams.get('room');
document.getElementById('inputRoom').value = linkRoom || Math.random().toString(36).substring(2, 7).toUpperCase();
document.getElementById('inputName').value = 'VIP-' + Math.floor(100 + Math.random() * 900);

// 1. Создание комнаты (Хост)
async function startAsHost() {
  myName = document.getElementById('inputName').value.trim() || 'Хост';
  currentRoomId = (document.getElementById('inputRoom').value.trim() || 'GOLD77').toUpperCase();
  hostPassword = document.getElementById('inputPass').value;
  isHost = true;

  setLoginStatus('⏳ Загрузка модуля связи...');
  document.getElementById('createBtn').disabled = true;

  const loaded = await ensurePeerLibrary();
  if (!loaded || typeof window.Peer === 'undefined') {
    setLoginStatus('⚠️ Сеть P2P недоступна, запуск локального стола...');
    players = [{ id: 'local', name: myName, isHost: true, inCall: false, muted: false }];
    setTimeout(enterTable, 500);
    return;
  }

  setLoginStatus('⏳ Создание комнаты #' + currentRoomId + '...');
  peer = new window.Peer('aurelia-vip-' + currentRoomId);

  const fallbackTimer = setTimeout(() => {
    if (!myPeerId) {
      setLoginStatus('⚠️ Долгий ответ облака, открываем стол локально...');
      players = [{ id: 'local', name: myName, isHost: true, inCall: false, muted: false }];
      enterTable();
    }
  }, 5000);

  peer.on('open', (id) => {
    clearTimeout(fallbackTimer);
    myPeerId = id;
    players = [{ id: myPeerId, name: myName, isHost: true, inCall: false, muted: false }];
    enterTable();
  });

  peer.on('error', (err) => {
    clearTimeout(fallbackTimer);
    document.getElementById('createBtn').disabled = false;
    if (err.type === 'unavailable-id') {
      setLoginStatus('❌ Этот код комнаты уже занят! Введите другой или нажмите «ВОЙТИ».');
    } else {
      setLoginStatus('⚠️ Ошибка (' + err.type + '), вход в одиночный режим...');
      players = [{ id: 'local', name: myName, isHost: true, inCall: false, muted: false }];
      setTimeout(enterTable, 800);
    }
  });

  peer.on('connection', (conn) => {
    conn.on('data', (msg) => handleHostReceive(conn, msg));
    conn.on('close', () => {
      guestConns.delete(conn.peer);
      players = players.filter(p => p.id !== conn.peer);
      removeAudio(conn.peer);
      syncRoomState();
    });
  });

  setupIncomingVoiceCalls();
}

// 2. Вход в комнату друга (Гость)
async function joinAsGuest() {
  myName = document.getElementById('inputName').value.trim() || 'Игрок';
  currentRoomId = (document.getElementById('inputRoom').value.trim() || '').toUpperCase();
  const password = document.getElementById('inputPass').value;
  isHost = false;

  if (!currentRoomId) {
    setLoginStatus('❌ Введите код комнаты друга!');
    return;
  }

  setLoginStatus('⏳ Поиск комнаты #' + currentRoomId + '...');
  document.getElementById('joinBtn').disabled = true;

  const loaded = await ensurePeerLibrary();
  if (!loaded || typeof window.Peer === 'undefined') {
    document.getElementById('joinBtn').disabled = false;
    setLoginStatus('❌ Не удалось загрузить модуль связи. Проверьте интернет.');
    return;
  }

  peer = new window.Peer();

  peer.on('open', (id) => {
    myPeerId = id;
    hostConn = peer.connect('aurelia-vip-' + currentRoomId, { reliable: true });

    hostConn.on('open', () => {
      hostConn.send({ type: 'JOIN_REQ', name: myName, password });
    });

    hostConn.on('data', (msg) => handleGuestReceive(msg));
    hostConn.on('close', () => alert('Хост закрыл комнату.'));
  });

  peer.on('error', () => {
    document.getElementById('joinBtn').disabled = false;
    setLoginStatus('❌ Комната не найдена! Проверьте код или попросите друга нажать «СОЗДАТЬ».');
  });

  setupIncomingVoiceCalls();
}

function setLoginStatus(text) {
  document.getElementById('loginError').innerText = text;
}

function enterTable() {
  window.history.replaceState({}, '', `?room=${currentRoomId}`);
  document.getElementById('roomTitle').innerText = `#${currentRoomId}`;
  document.getElementById('loginModal').style.display = 'none';
  renderPlayersList();
}

function handleHostReceive(conn, msg) {
  if (msg.type === 'JOIN_REQ') {
    if (hostPassword && hostPassword !== msg.password) {
      conn.send({ type: 'REJECT', reason: '❌ Неверный пароль от комнаты!' });
      setTimeout(() => conn.close(), 300);
      return;
    }
    if (players.length >= 6) {
      conn.send({ type: 'REJECT', reason: '❌ В комнате уже максимум (6 игроков)!' });
      setTimeout(() => conn.close(), 300);
      return;
    }
    guestConns.set(conn.peer, conn);
    players.push({ id: conn.peer, name: msg.name, isHost: false, inCall: false, muted: false });
    conn.send({ type: 'JOIN_OK', mode: currentMode, players });
    syncRoomState();
  } else if (msg.type === 'MODE_REQ' && !isSpinning) {
    applyModeUI(msg.mode);
    broadcast({ type: 'MODE_SET', mode: msg.mode });
  } else if (msg.type === 'SPIN_REQ' && !isSpinning) {
    triggerSpinAll();
  } else if (msg.type === 'VOICE_STATE') {
    const p = players.find(x => x.id === conn.peer);
    if (p) {
      p.inCall = msg.inCall;
      p.muted = msg.muted;
      syncRoomState();
    }
  }
}

function handleGuestReceive(msg) {
  document.getElementById('joinBtn').disabled = false;
  if (msg.type === 'REJECT') {
    setLoginStatus(msg.reason);
  } else if (msg.type === 'JOIN_OK') {
    players = msg.players;
    applyModeUI(msg.mode);
    enterTable();
  } else if (msg.type === 'STATE') {
    players = msg.players;
    renderPlayersList();
  } else if (msg.type === 'MODE_SET') {
    applyModeUI(msg.mode);
  } else if (msg.type === 'SPIN_GO') {
    runSpinAnimation(msg.winningIndex);
  }
}

function broadcast(data) {
  guestConns.forEach(conn => { if (conn.open) conn.send(data); });
}

function syncRoomState() {
  renderPlayersList();
  broadcast({ type: 'STATE', players });
}

function renderPlayersList() {
  document.getElementById('playerCount').innerText = players.length;
  const list = document.getElementById('playersList');
  list.innerHTML = '';

  players.forEach((p) => {
    const isMe = p.id === myPeerId || p.id === 'local';
    let voiceBadge = '💬 В комнате';
    if (p.inCall) voiceBadge = p.muted ? '🔇 Микрофон выкл.' : '🔊 В звонке';

    list.innerHTML += `
      <div class="player-slot">
        <span>${p.isHost ? '👑' : '🎲'} ${p.name} ${isMe ? '(Вы)' : ''}</span>
        <span style="font-size:12px; color:${p.inCall && !p.muted ? '#4caf50' : '#d4af37'};">${voiceBadge}</span>
      </div>`;
  });

  for (let i = players.length; i < 6; i++) {
    list.innerHTML += `<div class="player-slot empty"><span>Место #${i + 1} свободно</span></div>`;
  }
}

function requestMode(mode) {
  if (isSpinning) return;
  if (isHost) {
    applyModeUI(mode);
    broadcast({ type: 'MODE_SET', mode });
  } else if (hostConn && hostConn.open) {
    hostConn.send({ type: 'MODE_REQ', mode });
  }
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
}

function clearBets() {
  if (isSpinning) return;
  for (let k in bets) balance += bets[k];
  bets = {};
  document.getElementById('balance').innerText = balance;
  document.querySelectorAll('.chip-badge').forEach(b => b.remove());
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
  if (isSpinning) return;
  if (isHost) triggerSpinAll();
  else if (hostConn && hostConn.open) hostConn.send({ type: 'SPIN_REQ' });
}

function triggerSpinAll() {
  const winningIndex = Math.floor(Math.random() * wheelNumbers.length);
  broadcast({ type: 'SPIN_GO', winningIndex });
  runSpinAnimation(winningIndex);
}

function runSpinAnimation(winningIndex) {
  isSpinning = true;
  document.getElementById('spinBtn').disabled = true;
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
      document.getElementById('spinBtn').disabled = false;
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
}

// === ГОЛОСОВОЙ ЗВОНОК И МЬЮТ ===
let localStream = null;
let isMuted = false;

async function joinVoiceCall() {
  if (localStream) return;
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    isMuted = false;
    document.getElementById('callBtn').innerText = '🟢 В звонке';
    document.getElementById('callBtn').disabled = true;
    document.getElementById('muteBtn').disabled = false;

    players.forEach(p => {
      if (p.id !== myPeerId && p.id !== 'local' && peer) {
        const call = peer.call(p.id, localStream);
        call.on('stream', (remoteStream) => attachAudio(p.id, remoteStream));
      }
    });

    updateMyVoiceState(true, false);
  } catch (e) {
    alert('Разрешите доступ к микрофону в браузере.');
  }
}

function setupIncomingVoiceCalls() {
  if (!peer) return;
  peer.on('call', (call) => {
    call.answer(localStream || undefined);
    call.on('stream', (remoteStream) => attachAudio(call.peer, remoteStream));
  });
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
    const me = players.find(p => p.id === myPeerId || p.id === 'local');
    if (me) { me.inCall = inCall; me.muted = muted; }
    syncRoomState();
  } else if (hostConn && hostConn.open) {
    hostConn.send({ type: 'VOICE_STATE', inCall, muted });
  }
}

function attachAudio(peerId, stream) {
  let audio = document.getElementById('audio-' + peerId);
  if (!audio) {
    audio = document.createElement('audio');
    audio.id = 'audio-' + peerId;
    audio.autoplay = true;
    document.getElementById('audioContainer').appendChild(audio);
  }
  audio.srcObject = stream;
}

function removeAudio(peerId) {
  const el = document.getElementById('audio-' + peerId);
  if (el) el.remove();
}

function copyRoomLink() {
  const baseUrl = window.location.href.split('?').shift();
  const link = baseUrl + '?room=' + currentRoomId;
  navigator.clipboard?.writeText(link);
  alert(`Ссылка скопирована!\nКод комнаты: ${currentRoomId}\nПусть друзья нажмут «ВОЙТИ» и введут ваш пароль.`);
}

buildBoard();
drawWheel();
