/**
 * Perfect Ten — Main Wiring Module
 *
 * Handles all Perfect Ten game flows: create/join room, lobby,
 * gameplay (draw/discard), results, session persistence.
 */

import { showScreen, showToast } from '../../platform-ui.js';
import {
  createGame,
  drawCard,
  discardCard,
  validateState,
  serializeState,
  deserializeState,
} from './engine.js';
import {
  renderGameplay,
  renderResults,
  renderLobbyPlayers,
  renderReadyIndicators,
  setNewlyDrawnIndex,
  clearSelection,
  showWinReveal,
} from './ui.js';
import {
  announceWin,
  initAudio,
  toggleMute,
  isMuted,
  warmSpeech,
  playSound,
} from '../../shared/voice-announcer.js';
import {
  createRoom,
  joinRoom,
  listenRoom,
  setupDisconnectHandler,
  endRoom,
  deleteRoom,
  resetRoom,
  firebaseRetry,
} from '../../shared/firebase-sync.js';
import { db } from '../../shared/firebase-config.js';
import { ref, get, update, remove, onValue, off } from 'firebase/database';
import { serializeCard, deserializeCard } from '../../shared/deck.js';
import { renderCardFace, renderCardBack } from '../../shared/card-renderer.js';

/* ======= CONSTANTS ======= */
const GAME_ID = 'perfect-ten';
const PT_SESSION_KEY = 'card_games_pt_session';

/* ======= STATE ======= */
let state = null;
let roomCode = null;
let playerIndex = null;
let isHost = false;
let playerNames = [];
let unsubscribeRoom = null;
let goHome = null;
// _lastDrawSource and _lastDrawnCard removed — each Firebase write now carries its own lastMove
let _isAnimating = false;

/* ======= SESSION ======= */
function saveSession() {
  if (roomCode != null && playerIndex != null) {
    try {
      localStorage.setItem(PT_SESSION_KEY, JSON.stringify({ gameId: GAME_ID, roomCode, playerIndex, isHost }));
    } catch (_) {}
  }
}
function clearSession() { localStorage.removeItem(PT_SESSION_KEY); }
function loadSession() {
  try { const r = localStorage.getItem(PT_SESSION_KEY); return r ? JSON.parse(r) : null; } catch (_) { return null; }
}

function cleanupAndGoHome() {
  if (unsubscribeRoom) { unsubscribeRoom(); unsubscribeRoom = null; }
  clearSession();
  roomCode = null; playerIndex = null; isHost = false; playerNames = []; state = null;
  if (goHome) goHome();
}

/* ======= CARD ANIMATIONS ======= */

/**
 * Animates a floating card from one rect to another.
 */
function animateCardMove(fromRect, toRect, cardEl, duration = 350) {
  return new Promise((resolve) => {
    const floater = cardEl;
    floater.style.position = 'fixed';
    floater.style.left = `${fromRect.left}px`;
    floater.style.top = `${fromRect.top}px`;
    floater.style.zIndex = '200';
    floater.style.transition = `left ${duration}ms ease-out, top ${duration}ms ease-out`;
    floater.style.pointerEvents = 'none';

    document.body.appendChild(floater);

    requestAnimationFrame(() => {
      const cardW = floater.offsetWidth;
      const cardH = floater.offsetHeight;
      floater.style.left = `${toRect.left + (toRect.width - cardW) / 2}px`;
      floater.style.top = `${toRect.top + (toRect.height - cardH) / 2}px`;
    });

    setTimeout(() => {
      if (floater.parentNode) floater.parentNode.removeChild(floater);
      resolve();
    }, duration + 20);
  });
}

function getPileRect(pileType) {
  const selector = pileType === 'draw' ? '.sr-draw-pile .card' : '.sr-discard-pile .card';
  const el = document.querySelector(`#pt-piles ${selector}`);
  if (el) return el.getBoundingClientRect();
  const container = document.querySelector(`#pt-piles .sr-${pileType}-pile`);
  return container ? container.getBoundingClientRect() : null;
}

function getHandEndRect() {
  const cards = document.querySelectorAll('#pt-hand-area .sr-arc-card');
  if (cards.length > 0) return cards[cards.length - 1].getBoundingClientRect();
  const area = document.getElementById('pt-hand-area');
  return area ? area.getBoundingClientRect() : null;
}

function getHandCardRect(index) {
  const card = document.querySelector(`#pt-hand-area .sr-arc-card[data-hand-index="${index}"]`);
  return card ? card.getBoundingClientRect() : null;
}

/* ======= FIREBASE WRITE ======= */

async function writeFullState(stateToWrite, lastMove) {
  const serialized = serializeState(stateToWrite);
  const updates = {
    game: serialized,
    lastMove: lastMove || null,
    'meta/lastActivity': Date.now(),
  };
  if (stateToWrite.status === 'playing') updates['meta/status'] = 'active';
  await firebaseRetry(() => update(ref(db, `card-games/${GAME_ID}-rooms/${roomCode}`), updates));
}

/* ======= CREATE ROOM ======= */

function wireCreateRoom() {
  const btn = document.getElementById('pt-btn-create-room');
  const submit = document.getElementById('pt-btn-create-submit');

  if (btn) btn.addEventListener('click', () => showScreen('pt-create-room'));

  if (submit) submit.addEventListener('click', async () => {
    const name = document.getElementById('pt-create-name')?.value.trim();
    if (!name) { showToast('Please enter your name'); return; }
    const picker = document.querySelector('#pt-create-room .pt-emoji-picker');
    const sel = picker?.querySelector('.emoji-btn.selected');
    const emoji = sel?.dataset.emoji || '👲';
    try {
      const result = await createRoom(GAME_ID, name, emoji);
      roomCode = result.roomCode; playerIndex = result.playerIndex; isHost = true;
      playerNames = [name]; saveSession();
      setupDisconnectHandler(GAME_ID, roomCode, playerIndex);
      setupLobby();
    } catch (err) { console.error(err); showToast('Failed to create room.'); }
  });
}

/* ======= JOIN ROOM ======= */

function wireJoinRoom() {
  const btn = document.getElementById('pt-btn-join-room');
  const submit = document.getElementById('pt-btn-join-submit');

  if (btn) btn.addEventListener('click', () => showScreen('pt-join-room'));

  if (submit) submit.addEventListener('click', async () => {
    const code = document.getElementById('pt-room-code')?.value.trim().toUpperCase();
    const name = document.getElementById('pt-join-name')?.value.trim();
    if (!code || code.length !== 4) { showToast('Enter a valid 4-character room code'); return; }
    if (!name) { showToast('Please enter your name'); return; }
    const picker = document.querySelector('#pt-join-room .pt-emoji-picker');
    const sel = picker?.querySelector('.emoji-btn.selected');
    const emoji = sel?.dataset.emoji || '👲';
    try {
      const result = await joinRoom(GAME_ID, code, name, emoji);
      if (!result.success) { showToast(result.reason || 'Failed to join'); return; }
      roomCode = code; playerIndex = result.playerIndex; isHost = false;
      saveSession();
      setupDisconnectHandler(GAME_ID, roomCode, playerIndex);
      setupLobby();
    } catch (err) { console.error(err); showToast('Failed to join room.'); }
  });
}

/* ======= LOBBY ======= */

function setupLobby() {
  showScreen('pt-lobby');
  const codeEl = document.getElementById('pt-lobby-room-code');
  if (codeEl) codeEl.textContent = roomCode;

  const btnStart = document.getElementById('pt-btn-start-online');
  const waiting = document.getElementById('pt-lobby-waiting');
  if (isHost) { if (btnStart) btnStart.hidden = false; if (waiting) waiting.hidden = true; }
  else { if (btnStart) btnStart.hidden = true; if (waiting) waiting.hidden = false; }

  setupDisconnectHandler(GAME_ID, roomCode, playerIndex);
  if (unsubscribeRoom) unsubscribeRoom();

  unsubscribeRoom = listenRoom(GAME_ID, roomCode, {
    onPlayersChange: (players) => {
      const keys = Object.keys(players).sort();
      const arr = keys.map((k) => players[k]);
      playerNames = arr.map((p) => p.name || 'Unknown');
      renderLobbyPlayers(arr);
    },
    onStatusChange: async (status) => {
      if (status === 'active' && !isHost) {
        try {
          const snap = await firebaseRetry(() => get(ref(db, `card-games/${GAME_ID}-rooms/${roomCode}`)));
          if (snap.exists()) {
            const d = snap.val();
            if (d.game && d.players) { state = deserializeState(d.game, d.players); startGame(); }
          }
        } catch (err) { console.error(err); showToast('Failed to load game.'); }
      }
      if (status === 'lobby') { state = null; setupLobby(); }
      if (status === 'ended') {
        if (state) { state.status = 'finished'; state.winnerIndex = null; renderResults(state); showScreen('pt-results'); startReadyListener(); }
      }
    },
    onGameUpdate: (gameData, lastMove) => { handleRemoteUpdate(gameData, lastMove); },
    onRoomDeleted: () => { showToast('Host has left. Room closed.', 3000); cleanupAndGoHome(); },
  });
}

function wireLobby() {
  // Share code
  const shareBtn = document.getElementById('pt-btn-share-code');
  if (shareBtn) shareBtn.addEventListener('click', async () => {
    if (!roomCode) return;
    const text = `Join my Perfect Ten room! Code: ${roomCode}`;
    if (navigator.share) { try { await navigator.share({ title: 'Perfect Ten', text, url: location.origin }); return; } catch (_) {} }
    try { await navigator.clipboard.writeText(`${text}\n${location.origin}`); showToast('Room code copied!'); } catch (_) { showToast(`Room code: ${roomCode}`); }
  });

  // Start game (host)
  const startBtn = document.getElementById('pt-btn-start-online');
  if (startBtn) startBtn.addEventListener('click', async () => {
    if (!isHost || !roomCode) return;
    if (playerNames.length < 2) { showToast('Need at least 2 players'); return; }
    try {
      const snap = await firebaseRetry(() => get(ref(db, `card-games/${GAME_ID}-rooms/${roomCode}/players`)));
      if (!snap.exists()) { showToast('No players found'); return; }
      const pd = snap.val();
      const keys = Object.keys(pd).sort();
      const infos = keys.map((k) => ({ name: pd[k].name || 'Unknown', emoji: pd[k].emoji || '😀' }));
      state = createGame(infos);
      await writeFullState(state, null);
      startGame();
    } catch (err) { console.error(err); showToast('Failed to start game.'); }
  });

  // Leave
  const leaveBtn = document.getElementById('pt-btn-leave-lobby');
  if (leaveBtn) leaveBtn.addEventListener('click', async () => {
    if (isHost && roomCode) { try { await deleteRoom(GAME_ID, roomCode); } catch (_) {} }
    else if (roomCode && playerIndex != null) { try { await remove(ref(db, `card-games/${GAME_ID}-rooms/${roomCode}/players/player_${playerIndex}`)); } catch (_) {} }
    cleanupAndGoHome();
  });
}

/* ======= GAMEPLAY ======= */

function startGame() {
  showScreen('pt-gameplay');
  const endBtn = document.getElementById('pt-btn-end-game');
  if (endBtn) endBtn.hidden = !isHost;
  renderUI();
}

function renderUI() {
  if (!state) return;
  renderGameplay(state, playerIndex, {
    onDrawPileTap: () => handleDraw('drawPile'),
    onDiscardPileTap: () => handleDraw('discardPile'),
    onHandCardTap: (idx) => handleDiscard(idx),
    onReorder: (from, to) => handleReorder(from, to),
  });
}

function renderGameplayWithState(s) {
  if (!s) return;
  renderGameplay(s, playerIndex, {
    onDrawPileTap: () => handleDraw('drawPile'),
    onDiscardPileTap: () => handleDraw('discardPile'),
    onHandCardTap: (idx) => handleDiscard(idx),
    onReorder: (from, to) => handleReorder(from, to),
  });
}

function handleReorder(fromIndex, toIndex) {
  if (!state || playerIndex == null) return;
  const hand = [...state.players[playerIndex].hand];
  const [card] = hand.splice(fromIndex, 1);
  hand.splice(toIndex, 0, card);
  const newPlayers = state.players.map((p, i) => {
    if (i === playerIndex) return { ...p, hand };
    return { ...p };
  });
  state = { ...state, players: newPlayers };
  renderUI();
}

async function handleDraw(source) {
  if (!state || state.status === 'finished') return;
  if (state.currentPlayerIndex !== playerIndex) return;
  if (state.turnPhase !== 'draw') return;
  if (_isAnimating) return;

  warmSpeech();
  clearSelection();

  const pileRect = getPileRect(source === 'drawPile' ? 'draw' : 'discard');

  try {
    const oldDiscardTop = source === 'discardPile' && state.discardPile.length > 0
      ? state.discardPile[state.discardPile.length - 1] : null;

    const newState = drawCard(state, source);
    if (newState.status === 'finished') {
      state = newState;
      await writeFullState(state, null);
      renderResults(state);
      showScreen('pt-results');
      startReadyListener();
      return;
    }
    state = newState;

    // Write 1 — after draw: write state to Firebase immediately
    const drawLastMove = {
      playerIndex,
      action: 'draw',
      drawnFrom: source,
      drawnCard: oldDiscardTop ? serializeCard(oldDiscardTop) : null,
      timestamp: Date.now(),
    };
    _isAnimating = true;
    await writeFullState(state, drawLastMove);

    // Move drawn card to middle of hand for better visibility
    const hand = [...state.players[playerIndex].hand];
    const drawnCard = hand.pop();
    const midIdx = Math.floor(hand.length / 2);
    hand.splice(midIdx, 0, drawnCard);
    const newPlayers = state.players.map((p, i) => {
      if (i === playerIndex) return { ...p, hand };
      return { ...p };
    });
    state = { ...state, players: newPlayers };

    setNewlyDrawnIndex(midIdx);
    renderUI();

    // Animate: card slides from pile to hand
    if (pileRect) {
      const midCard = document.querySelector(`#pt-hand-area .sr-arc-card[data-hand-index="${midIdx}"]`);
      const handRect = midCard ? midCard.getBoundingClientRect() : getHandEndRect();
      if (handRect) {
        playSound('throw');
        const cardEl = source === 'drawPile'
          ? renderCardBack()
          : (oldDiscardTop ? renderCardFace(oldDiscardTop) : renderCardBack());
        await animateCardMove(pileRect, handRect, cardEl);
      }
    }
    _isAnimating = false;
  } catch (err) { console.error(err); showToast('Draw failed'); _isAnimating = false; }
}

async function handleDiscard(handIndex) {
  if (!state || state.status === 'finished') return;
  if (state.currentPlayerIndex !== playerIndex) return;
  if (state.turnPhase !== 'discard') return;
  if (_isAnimating) return;

  try {
    const discardedCard = state.players[playerIndex].hand[handIndex];
    const cardRect = getHandCardRect(handIndex);

    const { newState, won } = discardCard(state, handIndex);

    const validation = validateState(newState);
    if (!validation.valid) { showToast(`Error: ${validation.error}`); return; }

    setNewlyDrawnIndex(-1);
    clearSelection();

    // Write 2 — after discard: write state to Firebase with discard lastMove
    const discardLastMove = {
      playerIndex,
      action: 'discard',
      discardedCard: serializeCard(discardedCard),
      timestamp: Date.now(),
    };

    // Set animating flag BEFORE Firebase write to block listener re-renders
    _isAnimating = true;

    await writeFullState(newState, discardLastMove);

    // Animate: card slides from hand to discard pile
    if (cardRect) {
      const oldDiscardPile = state.discardPile;
      state = newState;
      const tempState = { ...state, discardPile: oldDiscardPile };
      renderGameplayWithState(tempState);

      const discardRect = getPileRect('discard');
      if (discardRect) {
        playSound('throw');
        const faceEl = renderCardFace(discardedCard);
        await animateCardMove(cardRect, discardRect, faceEl);
      }

      _isAnimating = false;
      if (won) {
        if (typeof confetti === 'function') confetti({ particleCount: 150, spread: 70, origin: { y: 0.6 } });
        const winner = state.players[state.winnerIndex];
        announceWin(winner.name);
        await showWinReveal(winner, winner.hand, 4000);
        renderResults(state);
        showScreen('pt-results');
        startReadyListener();
        return;
      }

      renderUI();
    } else {
      state = newState;

      playSound('throw');

      _isAnimating = false;

      if (won) {
        if (typeof confetti === 'function') confetti({ particleCount: 150, spread: 70, origin: { y: 0.6 } });
        const winner = state.players[state.winnerIndex];
        announceWin(winner.name);
        await showWinReveal(winner, winner.hand, 4000);
        renderResults(state);
        showScreen('pt-results');
        startReadyListener();
        return;
      }

      renderUI();
    }
  } catch (err) { console.error(err); showToast('Discard failed'); _isAnimating = false; }
}

/* ======= REMOTE UPDATES ======= */

function handleRemoteUpdate(gameData, lastMove) {
  if (!gameData || !roomCode) return;
  if (_isAnimating) return;

  setNewlyDrawnIndex(-1);
  clearSelection();

  const playersData = {};
  playerNames.forEach((name, i) => {
    playersData[`player_${i}`] = {
      name,
      emoji: state ? state.players[i]?.emoji || '😀' : '😀',
    };
  });

  const newState = deserializeState(gameData, playersData);

  // Detect opponent draw action — animate draw only
  if (lastMove && lastMove.action === 'draw' && lastMove.playerIndex !== playerIndex) {
    const drawnFrom = lastMove.drawnFrom || 'drawPile';
    const oldDiscardPile = state ? [...state.discardPile] : [];
    state = newState;

    // Render with old discard pile if drawn from discard, so the card is still visible during animation
    if (drawnFrom === 'discardPile' && oldDiscardPile.length > 0) {
      const tempState = { ...state, discardPile: oldDiscardPile };
      renderGameplayWithState(tempState);
    } else {
      renderUI();
    }

    _isAnimating = true;

    const runDrawAnim = async () => {
      const targetEl = document.querySelector(`#pt-all-players .game-player-block[data-player-index="${lastMove.playerIndex}"]`);
      const targetRect = targetEl ? targetEl.getBoundingClientRect() : null;

      const drawPileRect = getPileRect(drawnFrom === 'discardPile' ? 'discard' : 'draw');
      if (drawPileRect && targetRect) {
        playSound('throw');
        const drawnCardData = lastMove.drawnCard ? deserializeCard(lastMove.drawnCard) : null;
        const drawCardEl = (drawnFrom === 'discardPile' && drawnCardData)
          ? renderCardFace(drawnCardData)
          : renderCardBack();
        await animateCardMove(drawPileRect, targetRect, drawCardEl, 300);
      }

      _isAnimating = false;
      // Re-render with real state (discard pile updated after draw)
      renderUI();
    };

    runDrawAnim();
    return;
  }

  // Detect opponent discard action — animate discard only
  if (lastMove && lastMove.action === 'discard' && lastMove.playerIndex !== playerIndex && lastMove.discardedCard) {
    const discardedCard = deserializeCard(lastMove.discardedCard);
    const oldDiscardPile = state ? [...state.discardPile] : [];
    state = newState;

    if (state.status === 'finished') {
      if (state.winnerIndex != null) {
        const winner = state.players[state.winnerIndex];
        if (typeof confetti === 'function') confetti({ particleCount: 150, spread: 70, origin: { y: 0.6 } });
        announceWin(winner.name);
        showWinReveal(winner, winner.hand, 4000).then(() => {
          renderResults(state);
          showScreen('pt-results');
          startReadyListener();
        });
      } else {
        renderResults(state);
        showScreen('pt-results');
        startReadyListener();
      }
      return;
    }

    // Render with old discard pile during animation to prevent duplicate card
    const tempState = { ...state, discardPile: oldDiscardPile };
    renderGameplayWithState(tempState);
    _isAnimating = true;

    const runDiscardAnim = async () => {
      const targetEl = document.querySelector(`#pt-all-players .game-player-block[data-player-index="${lastMove.playerIndex}"]`);
      const targetRect = targetEl ? targetEl.getBoundingClientRect() : null;

      const discardRect = getPileRect('discard');
      if (targetRect && discardRect) {
        playSound('throw');
        const discardEl = renderCardFace(discardedCard);
        await animateCardMove(targetRect, discardRect, discardEl, 350);
      }

      await new Promise((r) => setTimeout(r, 300));

      _isAnimating = false;
      renderUI();
    };

    runDiscardAnim();
    return;
  }

  // Fallback: old-style lastMove (combined draw+discard) for backward compatibility
  if (lastMove && lastMove.playerIndex !== playerIndex && lastMove.discardedCard && !lastMove.action) {
    const discardedCard = deserializeCard(lastMove.discardedCard);
    const drawnFrom = lastMove.drawnFrom || 'drawPile';
    const oldDiscardPile = state ? [...state.discardPile] : [];
    state = newState;

    if (state.status === 'finished') {
      if (state.winnerIndex != null) {
        const winner = state.players[state.winnerIndex];
        if (typeof confetti === 'function') confetti({ particleCount: 150, spread: 70, origin: { y: 0.6 } });
        announceWin(winner.name);
        showWinReveal(winner, winner.hand, 4000).then(() => {
          renderResults(state);
          showScreen('pt-results');
          startReadyListener();
        });
      } else {
        renderResults(state);
        showScreen('pt-results');
        startReadyListener();
      }
      return;
    }

    const tempState = { ...state, discardPile: oldDiscardPile };
    renderGameplayWithState(tempState);
    _isAnimating = true;

    const runLegacyAnim = async () => {
      const targetEl = document.querySelector(`#pt-all-players .game-player-block[data-player-index="${lastMove.playerIndex}"]`);
      const targetRect = targetEl ? targetEl.getBoundingClientRect() : null;

      const drawPileRect = getPileRect(drawnFrom === 'discardPile' ? 'discard' : 'draw');
      if (drawPileRect && targetRect) {
        playSound('throw');
        const drawnCardData = lastMove.drawnCard ? deserializeCard(lastMove.drawnCard) : null;
        const drawCardEl = (drawnFrom === 'discardPile' && drawnCardData)
          ? renderCardFace(drawnCardData)
          : renderCardBack();
        await animateCardMove(drawPileRect, targetRect, drawCardEl, 300);
      }

      if (drawnFrom === 'discardPile' && oldDiscardPile.length > 0) {
        const pileAfterDraw = oldDiscardPile.slice(0, -1);
        const midState = { ...state, discardPile: pileAfterDraw };
        renderGameplayWithState(midState);
      }

      await new Promise((r) => setTimeout(r, 400));

      const discardRect = getPileRect('discard');
      if (targetRect && discardRect) {
        playSound('throw');
        const discardEl = renderCardFace(discardedCard);
        await animateCardMove(targetRect, discardRect, discardEl, 350);
      }

      await new Promise((r) => setTimeout(r, 300));

      _isAnimating = false;
      renderUI();
    };

    runLegacyAnim();
    return;
  }

  state = newState;

  if (state.status === 'finished') {
    if (state.winnerIndex != null) {
      const winner = state.players[state.winnerIndex];
      if (typeof confetti === 'function') confetti({ particleCount: 150, spread: 70, origin: { y: 0.6 } });
      announceWin(winner.name);
      showWinReveal(winner, winner.hand, 4000).then(() => {
        renderResults(state);
        showScreen('pt-results');
        startReadyListener();
      });
    } else {
      renderResults(state);
      showScreen('pt-results');
      startReadyListener();
    }
    return;
  }

  renderUI();
}

/* ======= END GAME ======= */

function wireEndGame() {
  const btn = document.getElementById('pt-btn-end-game');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    if (!state) return;
    state.status = 'finished'; state.winnerIndex = null;
    if (roomCode) { try { await endRoom(GAME_ID, roomCode); } catch (_) {} }
    renderResults(state);
    showScreen('pt-results');
    startReadyListener();
  });
}

/* ======= RESULTS & PLAY AGAIN ======= */

function wireResults() {
  const btnAgain = document.getElementById('pt-btn-play-again');
  const btnHome = document.getElementById('pt-btn-home');

  if (btnAgain) btnAgain.addEventListener('click', async () => {
    if (isHost) {
      if (!btnAgain.dataset.hostReady) {
        btnAgain.dataset.hostReady = 'true';
        btnAgain.textContent = '▶ Start New Round';
        if (roomCode) { try { await update(ref(db, `card-games/${GAME_ID}-rooms/${roomCode}/ready`), { [`player_${playerIndex}`]: true }); } catch (_) {} }
      } else {
        if (window._ptReadyCleanup) window._ptReadyCleanup();
        btnAgain.dataset.hostReady = '';
        btnAgain.dataset.playerReady = '';
        btnAgain.textContent = 'Play Again';
        state = null;
        if (roomCode) { try { await resetRoom(GAME_ID, roomCode); } catch (e) { showToast('Failed to reset.'); } }
        setupLobby();
      }
    } else {
      if (roomCode && playerIndex != null) { try { await update(ref(db, `card-games/${GAME_ID}-rooms/${roomCode}/ready`), { [`player_${playerIndex}`]: true }); } catch (_) {} }
      btnAgain.dataset.playerReady = 'true';
      btnAgain.disabled = true;
      btnAgain.textContent = '✓ Ready';
      showToast('Waiting for host to start new round...');
    }
  });

  if (btnHome) btnHome.addEventListener('click', async () => {
    if (window._ptReadyCleanup) window._ptReadyCleanup();
    if (roomCode) {
      if (playerIndex != null) { try { await update(ref(db, `card-games/${GAME_ID}-rooms/${roomCode}/ready`), { [`player_${playerIndex}`]: 'left' }); } catch (_) {} }
      if (isHost) { try { await deleteRoom(GAME_ID, roomCode); } catch (_) {} }
      else if (playerIndex != null) { try { await remove(ref(db, `card-games/${GAME_ID}-rooms/${roomCode}/players/player_${playerIndex}`)); } catch (_) {} }
    }
    cleanupAndGoHome();
  });
}

function startReadyListener() {
  if (!roomCode) return;
  const btnAgain = document.getElementById('pt-btn-play-again');
  if (btnAgain && !btnAgain.dataset.hostReady && !btnAgain.dataset.playerReady) {
    btnAgain.disabled = false; btnAgain.textContent = 'Play Again';
  }
  if (window._ptReadyCleanup) window._ptReadyCleanup();
  const readyRef = ref(db, `card-games/${GAME_ID}-rooms/${roomCode}/ready`);
  const handler = (snap) => {
    const data = snap.val() || {};
    const ready = Object.keys(data).filter((k) => data[k] === true).map((k) => parseInt(k.replace('player_', ''), 10)).filter((n) => !isNaN(n));
    const left = Object.keys(data).filter((k) => data[k] === 'left').map((k) => parseInt(k.replace('player_', ''), 10)).filter((n) => !isNaN(n));
    renderReadyIndicators(playerNames, ready, left);
  };
  onValue(readyRef, handler);
  window._ptReadyCleanup = () => { off(readyRef, 'value', handler); window._ptReadyCleanup = null; };
}

/* ======= BACK BUTTONS & EMOJI PICKERS ======= */

function wireBackButtons() {
  const b1 = document.getElementById('pt-btn-back-online');
  if (b1) b1.addEventListener('click', () => { if (goHome) goHome(); });
  const b2 = document.getElementById('pt-btn-back-create');
  if (b2) b2.addEventListener('click', () => showScreen('pt-online-choice'));
  const b3 = document.getElementById('pt-btn-back-join');
  if (b3) b3.addEventListener('click', () => showScreen('pt-online-choice'));
}

function wireEmojiPicker(selector) {
  const picker = document.querySelector(selector);
  if (!picker) return;
  const btns = picker.querySelectorAll('.emoji-btn');
  btns.forEach((btn) => {
    btn.addEventListener('click', () => { btns.forEach((b) => b.classList.remove('selected')); btn.classList.add('selected'); });
  });
}

function wireMuteToggle() {
  const toggle = document.getElementById('pt-mute-toggle');
  if (!toggle) return;
  toggle.checked = isMuted();
  toggle.addEventListener('change', () => toggleMute());
}

/* ======= SESSION RESTORATION ======= */

export async function checkPTSession() {
  const session = loadSession();
  if (!session) return false;
  try {
    const snap = await firebaseRetry(() => get(ref(db, `card-games/${GAME_ID}-rooms/${session.roomCode}`)));
    if (!snap.exists()) { clearSession(); return false; }
    const d = snap.val();
    const status = d.meta?.status;
    if (status === 'ended') { clearSession(); return false; }

    roomCode = session.roomCode; playerIndex = session.playerIndex; isHost = session.isHost;
    if (d.players) { const keys = Object.keys(d.players).sort(); playerNames = keys.map((k) => d.players[k].name || 'Unknown'); }
    try { await update(ref(db, `card-games/${GAME_ID}-rooms/${roomCode}/players/player_${playerIndex}`), { connected: true }); } catch (_) {}

    if (status === 'lobby') { setupLobby(); return true; }
    if (status === 'active' && d.game) {
      state = deserializeState(d.game, d.players);
      setupDisconnectHandler(GAME_ID, roomCode, playerIndex);
      if (unsubscribeRoom) unsubscribeRoom();
      unsubscribeRoom = listenRoom(GAME_ID, roomCode, {
        onPlayersChange: (players) => { const keys = Object.keys(players).sort(); playerNames = keys.map((k) => players[k].name || 'Unknown'); },
        onStatusChange: async (s) => {
          if (s === 'lobby') { state = null; setupLobby(); }
          if (s === 'ended' && state) { state.status = 'finished'; state.winnerIndex = null; renderResults(state); showScreen('pt-results'); startReadyListener(); }
        },
        onGameUpdate: (gd, lm) => { handleRemoteUpdate(gd, lm); },
        onRoomDeleted: () => { showToast('Host has left. Room closed.', 3000); cleanupAndGoHome(); },
      });
      startGame();
      return true;
    }
    clearSession(); return false;
  } catch (err) { console.warn('PT rejoin failed:', err); clearSession(); return false; }
}

/* ======= INIT ======= */

export function initPerfectTen(showLandingPageFn) {
  goHome = showLandingPageFn;
  wireCreateRoom();
  wireJoinRoom();
  wireLobby();
  wireEndGame();
  wireResults();
  wireMuteToggle();
  wireBackButtons();
  wireEmojiPicker('#pt-create-room .pt-emoji-picker');
  wireEmojiPicker('#pt-join-room .pt-emoji-picker');
}
