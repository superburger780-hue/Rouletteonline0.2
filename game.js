const EU_NUMBERS =;
const US_NUMBERS = [0,28,9,26,30,11,7,20,32,17,5,22,34,15,3,24,36,13,1,'00',27,10,25,29,12,8,19,31,18,6,21,33,16,4,23,35,14,2];
const RED_NUMS = new Set();

let currentMode = 'EU';
let wheelNumbers = EU_NUMBERS;
let balance = 10000;
let bets = {};
let wheelAngle = 0;
let ballAngle = -Math.PI / 2;
let ballRadius = 132;
let isSpinning = false;
let socket = null;

const urlParams = new URLSearchParams(window.location.search);
let currentRoomId = urlParams.get('room') || Math.random().toString(36).substring(2, 8).toUpperCase();
document.getElementById('inputRoom').value = currentRoomId;
document.getElementById('inputName').value = 'VIP-' + Math.floor(100 + Math.random() * 900);

if (typeof io !== 'undefined') {
  socket = io();

  socket.on('wrong-password', () => {
    document.getElementById('loginError').innerText = '❌ Неверный пароль от комнаты!';
  });

  socket.on('room-full', () => {
    document.getElementById('loginError').innerText = '❌ В комнате уже максимум (6 игроков)!';
  });

  socket.on('join-success', ({ roomId }) => {
    currentRoomId = roomId;
    window.history.replaceState({}, '', `?room=${roomId}`);
    document.getElementById('roomTitle').innerText = `#${roomId}`;
    document.getElementById('loginModal').style.display = 'none';
  });

  socket.on('room-state', ({ players, mode }) => {
    applyModeUI(mode);
    renderPlayersList(players);
  });

  socket.on('mode-updated', (mode) => applyModeUI(mode));
  socket.on('spin-started', ({ winningIndex }) => runSpinAnimation(winningIndex));
  setupWebRTCSignaling();
}

function submitJoin() {
  const playerName = document.getElementById('inputName').value.trim() || 'Игрок';
  const roomId = document.getElementById('inputRoom').value.trim().toUpperCase() || currentRoomId;
  const password = document.getElementById('inputPass').value;

  if (socket) {
    socket.emit('join-room', { roomId, password, playerName });
  } else {
    document.getElementById('roomTitle').innerText = `#${roomId}`;
    document.getElementById('loginModal').style.display = 'none';
    renderPlayersList([{ id: 'local', name: playerName, inCall: false, muted: false }]);
  }
}

function renderPlayersList(players) {
  document.getElementById('playerCount').innerText = players.length;
  const list = document.getElementById('playersList');
  list.innerHTML = '';

  players.forEach((p, idx) => {
    const isMe = (socket && p.id === socket.id) || p.id === 'local';
    let voiceBadge = '💬 В чате';
    if (p.inCall) {
      voiceBadge = p.muted ? '🔇 Микрофон выкл.' : '🔊 Говорит';
    }
    list.innerHTML += `
      <div class="player-slot">
        <span>${idx === 0 ? '👑' : '🎲'} ${p.name} ${isMe ? '(Вы)' : ''}</span>
        <span style="font-size:12px; color:${p.inCall && !p.muted ? '#4caf50' : '#d4af37'};">${voiceBadge}</span>
      </div>`;
  });

  for (let i = players.length; i < 6; i++) {
    list.innerHTML += `<div class="player-slot empty"><span>Место #${i + 1} свободно</span></div>`;
  }
}

function requestMode(mode) {
  if (isSpinning) return;
  if (socket) socket.emit('change-mode', mode);
  else applyModeUI(mode);
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
  if (socket) socket.emit('request-spin');
  else runSpinAnimation(Math.floor(Math.random() * wheelNumbers.length));
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
    else if (currentMode === 'FR' && winNum === 0 && ['RED','BLACK','EVEN'].includes(target)) {
      winAmount += amt * 0.5;
    }
  }

  balance += winAmount;
  document.getElementById('balance').innerText = balance;
  document.getElementById('statusText').innerText = `Выпало: ${winNum}! Выигрыш: ${winAmount} 🪙`;
  bets = {};
  document.querySelectorAll('.chip-badge').forEach(b => b.remove());
}

// === ГОЛОСОВОЙ ЗВОНОК И КНОПКА ВКЛ/ВЫКЛ МИКРОФОНА ===
let localStream = null;
let isMuted = false;
const peers = {};
const rtcConfig = { iceServers: [{ urls: 'stun:google.com' }] };

async function joinVoiceCall() {
  if (localStream) return;
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    isMuted = false;
    document.getElementById('callBtn').innerText = '🟢 В звонке';
    document.getElementById('callBtn').disabled = true;
    document.getElementById('muteBtn').disabled = false;

    if (socket) socket.emit('voice-status', { inCall: true, muted: false });
  } catch (e) {
    alert('Разрешите доступ к микрофону в браузере (сайт должен быть открыт по HTTPS).');
  }
}

function toggleMute() {
  if (!localStream) return;
  isMuted = !isMuted;
  localStream.getAudioTracks().forEach(track => {
    track.enabled = !isMuted;
  });

  const btn = document.getElementById('muteBtn');
  if (isMuted) {
    btn.innerText = '🔇 Микрофон: ВЫКЛ';
    btn.classList.add('danger');
  } else {
    btn.innerText = '🎙️ Микрофон: ВКЛ';
    btn.classList.remove('danger');
  }

  if (socket) socket.emit('voice-status', { inCall: true, muted: isMuted });
}

function setupWebRTCSignaling() {
  socket.on('user-joined-voice', (remoteId) => {
    if (localStream && !peers[remoteId]) createPeer(remoteId, true);
  });
  socket.on('webrtc-offer', async ({ from, offer }) => {
    if (!localStream) return;
    const pc = createPeer(from, false);
    await pc.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.emit('webrtc-answer', { to: from, answer });
  });
  socket.on('webrtc-answer', async ({ from, answer }) => {
    if (peers[from]) await peers[from].setRemoteDescription(new RTCSessionDescription(answer));
  });
  socket.on('webrtc-ice', async ({ from, candidate }) => {
    if (peers[from]) await peers[from].addIceCandidate(new RTCIceCandidate(candidate));
  });
  socket.on('user-left-voice', (remoteId) => {
    if (peers[remoteId]) { peers[remoteId].close(); delete peers[remoteId]; }
    const el = document.getElementById('audio-' + remoteId);
    if (el) el.remove();
  });
}

function createPeer(remoteId, initiator) {
  const pc = new RTCPeerConnection(rtcConfig);
  peers[remoteId] = pc;
  localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
  pc.onicecandidate = (e) => {
    if (e.candidate) socket.emit('webrtc-ice', { to: remoteId, candidate: e.candidate });
  };
  pc.ontrack = (e) => {
    let audio = document.getElementById('audio-' + remoteId);
    if (!audio) {
      audio = document.createElement('audio');
      audio.id = 'audio-' + remoteId;
      audio.autoplay = true;
      document.getElementById('audioContainer').appendChild(audio);
    }
    audio.srcObject = e.streams;
  };
  if (initiator) {
    pc.createOffer().then(offer => {
      pc.setLocalDescription(offer);
      socket.emit('webrtc-offer', { to: remoteId, offer });
    });
  }
  return pc;
}

function copyRoomLink() {
  const link = window.location.href.split('?') + '?room=' + currentRoomId;
  navigator.clipboard?.writeText(link);
  alert(`Ссылка скопирована!\nКод комнаты: ${currentRoomId}\nСообщите друзьям пароль, если вы его задали.`);
}

buildBoard();
drawWheel();
