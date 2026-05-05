/**
 * Card Games Platform — Main Entry Point
 *
 * Wires platform landing page, Patte Par Patta game flows,
 * Firebase sync, animations, voice, session persistence,
 * and service worker registration.
 */

import { showScreen, renderLandingPage, showToast } from './platform-ui.js';

import {
  createGame,
  throwCard,
  advanceTurn,
  checkWinCondition,
  validateState,
} from './games/patte-par-patta/engine.js';

import {
  renderGameplay,
  renderLobbyPlayers,
  renderResults,
  renderReadyIndicators,
  setEventMessage,
} from './games/patte-par-patta/ui.js';

import { animateSweep, animateThrowToPile } from './shared/animation-manager.js';
import { renderCardFace } from './shared/card-renderer.js';
import { coinRain } from './shared/win-pot-calculator.js';
import {
  announceCapture,
  announceWin,
  initAudio,
  toggleMute,
  isMuted,
  warmSpeech,
  playSound,
} from './shared/voice-announcer.js';
import { deserializeCard } from './shared/deck.js';
import {
  createRoom,
  joinRoom,
  listenRoom,
  writeThrow,
  writeGameState,
  setupDisconnectHandler,
  endRoom,
  deleteRoom,
  resetRoom,
  firebaseRetry,
} from './shared/firebase-sync.js';
import { db } from './shared/firebase-config.js';
import { ref, get, update, remove, onValue, off } from 'firebase/database';
import { initSimpleRummy, checkSRSession } from './games/simple-rummy/main-sr.js';
import { initBluff, checkBluffSession } from './games/bluff/main-bluff.js';
import { initFlipMatch, checkFMSession } from './games/flip-and-match/main-fm.js';
import { initPerfectTen, checkPTSession } from './games/perfect-ten/main-pt.js';
import { initPoker, checkPKSession } from './games/poker/main-pk.js';

/* ======= CONSTANTS ======= */

const GAME_ID = 'patte-par-patta';
const SESSION_KEY = 'card_games_session';

const GAME_CONFIGS = [
  { id: 'patte-par-patta', name: 'Patte Par Patta', image: '/images/ppp-card.png', available: true },
  { id: 'simple-rummy', name: 'Rummy', image: '/images/rummy-card.png', available: true },
  { id: 'bluff', name: 'Bluff', image: '/images/bluff-card.jpeg', available: true },
  { id: 'flip-and-match', name: 'Flip & Match', image: '/images/fm-card.jpeg', available: true },
  { id: 'perfect-ten', name: 'Perfect Ten', image: '/images/pt-card.jpeg', available: true },
  { id: 'poker', name: 'Poker', image: '/images/poker-card.jpeg', available: true },
];

/* ======= STATE ======= */

let state = null;
let isProcessingTurn = false;

// Online state
let roomCode = null;
let playerIndex = null;
let isHost = false;
let playerNames = [];
let unsubscribeRoom = null;
let _resultsShown = false;

/* ======= DOM REFERENCES ======= */

const muteToggle = document.getElementById('mute-toggle');
const btnPlayAgain = document.getElementById('btn-play-again');
const btnHome = document.getElementById('btn-home');
const btnEndGame = document.getElementById('btn-end-game');

/* ======= SESSION HELPERS ======= */

function saveSession() {
  if (roomCode != null && playerIndex != null) {
    try {
      localStorage.setItem(SESSION_KEY, JSON.stringify({
        gameId: GAME_ID,
        roomCode,
        playerIndex,
        isHost,
      }));
    } catch (_) {}
  }
}

function clearSession() {
  localStorage.removeItem(SESSION_KEY);
}

function loadSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

/* ======= CLEANUP ======= */

function cleanupAndGoHome() {
  if (unsubscribeRoom) { unsubscribeRoom(); unsubscribeRoom = null; }
  clearSession();
  roomCode = null;
  playerIndex = null;
  isHost = false;
  playerNames = [];
  state = null;
  showLandingPage();
}

function showLandingPage() {
  renderLandingPage(GAME_CONFIGS, handleGameSelect);
  showScreen('landing-page');
}

/* ======= DESERIALIZE GAME STATE ======= */

function deserializeGameState(gameData, playersData) {
  const playerKeys = Object.keys(playersData).sort();
  const players = playerKeys.map((key, i) => {
    const pData = playersData[key];
    const rawHand = (gameData.hands && gameData.hands[key]) || [];
    const rawBounty = (gameData.bounties && gameData.bounties[key]) || [];
    const hand = Array.isArray(rawHand)
      ? rawHand.map(deserializeCard)
      : Object.values(rawHand).map(deserializeCard);
    const bounty = Array.isArray(rawBounty)
      ? rawBounty.map(deserializeCard)
      : Object.values(rawBounty).map(deserializeCard);
    const eliminated = (gameData.eliminated && gameData.eliminated[key]) || false;

    return {
      name: pData.name || `Player ${i + 1}`,
      emoji: pData.emoji || '😀',
      hand,
      bounty,
      eliminated,
      connected: pData.connected !== false,
    };
  });

  const rawPile = gameData.pile || [];
  const pile = Array.isArray(rawPile)
    ? rawPile.map(deserializeCard)
    : Object.values(rawPile).map(deserializeCard);

  return {
    players,
    pile,
    currentPlayerIndex: gameData.currentPlayerIndex || 0,
    deckSize: gameData.deckSize || 52,
    status: gameData.status || 'playing',
    winnerIndex: gameData.winnerIndex != null ? gameData.winnerIndex : null,
  };
}

/* ======= LANDING PAGE & GAME SELECT (Task 9.1) ======= */

function handleGameSelect(gameId) {
  if (gameId === 'patte-par-patta') {
    showScreen('ppp-online-choice');
  } else if (gameId === 'simple-rummy') {
    showScreen('sr-online-choice');
  } else if (gameId === 'bluff') {
    showScreen('bl-online-choice');
  } else if (gameId === 'flip-and-match') {
    showScreen('fm-online-choice');
  } else if (gameId === 'perfect-ten') {
    showScreen('pt-online-choice');
  } else if (gameId === 'poker') {
    showScreen('pk-online-choice');
  } else {
    showToast('Coming Soon!');
  }
}

/* ======= CREATE ROOM (Task 9.2) ======= */

function wireCreateRoom() {
  const btnCreateRoom = document.getElementById('btn-create-room');
  const btnCreateSubmit = document.getElementById('btn-create-submit');

  if (btnCreateRoom) {
    btnCreateRoom.addEventListener('click', () => {
      showScreen('ppp-create-room');
    });
  }

  if (btnCreateSubmit) {
    btnCreateSubmit.addEventListener('click', async () => {
      const nameInput = document.getElementById('create-name-input');
      const name = nameInput ? nameInput.value.trim() : '';
      if (!name) {
        showToast('Please enter your name');
        return;
      }

      const emojiPicker = document.querySelector('#ppp-create-room .emoji-picker');
      const selectedBtn = emojiPicker ? emojiPicker.querySelector('.emoji-btn.selected') : null;
      const emoji = selectedBtn ? selectedBtn.dataset.emoji : '👲';

      try {
        const result = await createRoom(GAME_ID, name, emoji);
        roomCode = result.roomCode;
        playerIndex = result.playerIndex;
        isHost = true;
        playerNames = [name];
        saveSession();
        setupDisconnectHandler(GAME_ID, roomCode, playerIndex);
        setupLobby();
      } catch (err) {
        console.error('Failed to create room:', err);
        showToast('Failed to create room. Check your connection.');
      }
    });
  }
}

/* ======= JOIN ROOM (Task 9.3) ======= */

function wireJoinRoom() {
  const btnJoinRoom = document.getElementById('btn-join-room');
  const btnJoinSubmit = document.getElementById('btn-join-submit');

  if (btnJoinRoom) {
    btnJoinRoom.addEventListener('click', () => {
      showScreen('ppp-join-room');
    });
  }

  if (btnJoinSubmit) {
    btnJoinSubmit.addEventListener('click', async () => {
      const codeInput = document.getElementById('room-code-input');
      const nameInput = document.getElementById('join-name-input');
      const code = codeInput ? codeInput.value.trim().toUpperCase() : '';
      const name = nameInput ? nameInput.value.trim() : '';

      if (!code || code.length !== 4) {
        showToast('Please enter a valid 4-character room code');
        return;
      }
      if (!name) {
        showToast('Please enter your name');
        return;
      }

      const emojiPicker = document.querySelector('#ppp-join-room .emoji-picker');
      const selectedBtn = emojiPicker ? emojiPicker.querySelector('.emoji-btn.selected') : null;
      const emoji = selectedBtn ? selectedBtn.dataset.emoji : '👲';

      try {
        const result = await joinRoom(GAME_ID, code, name, emoji);
        if (!result.success) {
          showToast(result.reason || 'Failed to join room');
          return;
        }
        roomCode = code;
        playerIndex = result.playerIndex;
        isHost = false;
        saveSession();
        setupDisconnectHandler(GAME_ID, roomCode, playerIndex);
        setupLobby();
      } catch (err) {
        console.error('Failed to join room:', err);
        showToast('Failed to join room. Check your connection.');
      }
    });
  }
}

/* ======= LOBBY (Task 9.4) ======= */

function setupLobby() {
  showScreen('ppp-lobby');

  const lobbyRoomCode = document.getElementById('lobby-room-code');
  if (lobbyRoomCode) lobbyRoomCode.textContent = roomCode;

  const btnStartOnline = document.getElementById('btn-start-online');
  const lobbyWaiting = document.getElementById('lobby-waiting');

  if (isHost) {
    if (btnStartOnline) btnStartOnline.hidden = false;
    if (lobbyWaiting) lobbyWaiting.hidden = true;
  } else {
    if (btnStartOnline) btnStartOnline.hidden = true;
    if (lobbyWaiting) lobbyWaiting.hidden = false;
  }

  setupDisconnectHandler(GAME_ID, roomCode, playerIndex);

  if (unsubscribeRoom) unsubscribeRoom();

  unsubscribeRoom = listenRoom(GAME_ID, roomCode, {
    onPlayersChange: (players) => {
      const keys = Object.keys(players).sort();
      const playerArr = keys.map((k) => players[k]);
      playerNames = playerArr.map((p) => p.name || 'Unknown');
      renderLobbyPlayers(playerArr, isHost);
    },

    onStatusChange: async (status) => {
      if (status === 'active' && !isHost) {
        try {
          const roomRef = ref(db, `card-games/${GAME_ID}-rooms/${roomCode}`);
          const snapshot = await firebaseRetry(() => get(roomRef));
          if (snapshot.exists()) {
            const roomData = snapshot.val();
            if (roomData.game && roomData.players) {
              state = deserializeGameState(roomData.game, roomData.players);
              startOnlineGame();
            }
          }
        } catch (err) {
          console.error('Failed to fetch game state:', err);
          showToast('Failed to load game data.');
        }
      }

      if (status === 'lobby') {
        state = null;
        setupLobby();
      }

      if (status === 'ended') {
        if (state) {
          state.status = 'finished';
          state.winnerIndex = null;
          renderResults(state);
          showScreen('ppp-results');
          startReadyListener();
        }
      }
    },

    onGameUpdate: (gameData, lastMove) => {
      handleRemoteGameUpdate(gameData, lastMove);
    },

    onRoomDeleted: () => {
      showToast('Host has left. Room closed.', 3000);
      cleanupAndGoHome();
    },
  });
}

function wireLobby() {
  // Share Code
  const btnShareCode = document.getElementById('btn-share-code');
  if (btnShareCode) {
    btnShareCode.addEventListener('click', async () => {
      if (!roomCode) return;
      const shareText = `Join my Card Games room! Room code: ${roomCode}`;
      const shareUrl = window.location.origin;

      if (navigator.share) {
        try {
          await navigator.share({ title: 'Card Games', text: shareText, url: shareUrl });
          return;
        } catch (_) {}
      }

      try {
        await navigator.clipboard.writeText(`${shareText}\n${shareUrl}`);
        showToast('Room code copied!');
      } catch (_) {
        showToast(`Room code: ${roomCode}`);
      }
    });
  }

  // Start Game (host)
  const btnStartOnline = document.getElementById('btn-start-online');
  if (btnStartOnline) {
    btnStartOnline.addEventListener('click', async () => {
      if (!isHost || !roomCode) return;

      if (playerNames.length < 2) {
        showToast('Need at least 2 players to start');
        return;
      }

      try {
        const playersRef = ref(db, `card-games/${GAME_ID}-rooms/${roomCode}/players`);
        const snapshot = await firebaseRetry(() => get(playersRef));
        if (!snapshot.exists()) {
          showToast('No players found');
          return;
        }

        const playersData = snapshot.val();
        const playerKeys = Object.keys(playersData).sort();
        const playerInfos = playerKeys.map((key) => ({
          name: playersData[key].name || 'Unknown',
          emoji: playersData[key].emoji || '😀',
        }));

        const metaRef = ref(db, `card-games/${GAME_ID}-rooms/${roomCode}/meta`);
        const metaSnap = await firebaseRetry(() => get(metaRef));
        const deckCount = metaSnap.exists() ? (metaSnap.val().deckCount || 1) : 1;

        state = createGame(playerInfos, deckCount);
        await writeGameState(GAME_ID, roomCode, state);
        startOnlineGame();
      } catch (err) {
        console.error('Failed to start game:', err);
        showToast('Failed to start game. Try again.');
      }
    });
  }

  // Leave lobby
  const btnLeaveLobby = document.getElementById('btn-leave-lobby');
  if (btnLeaveLobby) {
    btnLeaveLobby.addEventListener('click', async () => {
      if (isHost && roomCode) {
        try { await deleteRoom(GAME_ID, roomCode); } catch (_) {}
      } else if (roomCode && playerIndex != null) {
        try {
          const playerRef = ref(db, `card-games/${GAME_ID}-rooms/${roomCode}/players/player_${playerIndex}`);
          await remove(playerRef);
        } catch (_) {}
      }
      cleanupAndGoHome();
    });
  }
}

/* ======= GAMEPLAY (Task 9.5) ======= */

function startOnlineGame() {
  _resultsShown = false;
  showScreen('ppp-gameplay');
  setEventMessage('');

  if (btnEndGame) btnEndGame.hidden = !isHost;

  renderGameplay(state, playerIndex);
  isProcessingTurn = false;
}

/** Handles local player card tap. */
async function handleCardTap(handIndex) {
  if (!state || state.status === 'finished' || isProcessingTurn) return;
  if (state.currentPlayerIndex !== playerIndex) return;
  isProcessingTurn = true;

  try {
    const currentPlayer = state.players[playerIndex];
    const thrownCard = state.players[playerIndex].hand[handIndex];
    const { newState, captured } = throwCard(state, handIndex);

    const validation = validateState(newState);
    if (!validation.valid) {
      console.error('State validation failed:', validation.error);
      showToast(`Error: ${validation.error}`);
      isProcessingTurn = false;
      return;
    }

    // Check win before advancing turn
    const winResult = checkWinCondition(newState);
    let stateToWrite;
    if (winResult.finished) {
      stateToWrite = { ...newState, status: 'finished', winnerIndex: winResult.winnerIndex };
    } else {
      stateToWrite = advanceTurn(newState);
    }

    // Write to Firebase first (Req 12.1)
    try {
      await writeThrow(GAME_ID, roomCode, playerIndex, thrownCard, captured, stateToWrite);
    } catch (err) {
      console.error('Failed to write throw:', err);
      showToast('Failed to sync move. Try again.');
      isProcessingTurn = false;
      return;
    }

    // Animate locally
    const currentSlot = document.querySelector(`.player-slot[data-player-index="${playerIndex}"] .player-slot-deck .card`);
    const pileArea = document.getElementById('pile-area');

    playSound('throw');

    if (currentSlot && pileArea) {
      const deckRect = currentSlot.getBoundingClientRect();
      const pileRect = pileArea.getBoundingClientRect();
      const faceEl = renderCardFace(thrownCard);
      await animateThrowToPile(deckRect, pileRect, faceEl);
    }

    if (captured) {
      playSound('capture');

      const pileCard = document.getElementById('pile-card');
      if (pileCard) {
        pileCard.classList.add('pile-capture-shake');
        await new Promise((r) => setTimeout(r, 1000));
        pileCard.classList.remove('pile-capture-shake');
      }

      const pileEl = document.getElementById('pile-card');
      const deckCard = document.querySelector(`.player-slot[data-player-index="${playerIndex}"] .player-slot-deck .card`);
      if (pileEl && deckCard) {
        const targetRect = deckCard.getBoundingClientRect();
        await animateSweep(pileEl, targetRect);
      }
      announceCapture(currentPlayer.name);
      setEventMessage(`${currentPlayer.emoji} ${currentPlayer.name} captured the pile!`);
    }

    // Update local state
    state = stateToWrite;

    if (newState.players[playerIndex].eliminated) {
      showToast(`${newState.players[playerIndex].name} is out of cards!`);
    }

    if (winResult.finished) {
      if (winResult.draw) {
        setEventMessage('Game is a draw!');
      } else if (!_resultsShown) {
        _resultsShown = true;
        const winner = state.players[winResult.winnerIndex];
        await announceWin(winner.name);
        if (typeof confetti === 'function') {
          confetti({ particleCount: 150, spread: 70, origin: { y: 0.6 } });
        }
        coinRain();
      }
      renderResults(state);
      showScreen('ppp-results');
      startReadyListener();
      isProcessingTurn = false;
      return;
    }

    // Re-render (no pre-render of pile during animation)
    renderGameplay(state, playerIndex);
  } catch (err) {
    console.error('Error during card tap:', err);
    showToast('Something went wrong');
  } finally {
    isProcessingTurn = false;
  }
}

/** Handles remote game updates from Firebase. */
function handleRemoteGameUpdate(gameData, lastMove) {
  if (!gameData || !roomCode) return;
  if (isProcessingTurn) return;

  const playersData = {};
  playerNames.forEach((name, i) => {
    playersData[`player_${i}`] = {
      name,
      emoji: state ? state.players[i]?.emoji || '😀' : '😀',
    };
  });

  const newState = deserializeGameState(gameData, playersData);

  // Detect remote move
  if (state && newState.currentPlayerIndex !== state.currentPlayerIndex) {
    const prevPlayerIdx = state.currentPlayerIndex;
    if (prevPlayerIdx !== playerIndex) {
      const prevPlayer = state.players[prevPlayerIdx];
      const newPrevPlayer = newState.players[prevPlayerIdx];
      const wasCaptured = state.pile.length > 0 && newState.pile.length === 0;

      // Save old pile BEFORE updating state
      const oldPile = [...state.pile];

      // Figure out the thrown card from lastMove or derive it
      let thrownCard = null;
      if (lastMove && lastMove.card) {
        thrownCard = deserializeCard(lastMove.card);
      }

      state = newState;

      // Render with old pile during animation (prevents duplicate card)
      const tempState = { ...state, pile: oldPile };
      renderGameplay(tempState, playerIndex);

      isProcessingTurn = true;

      const opponentDeck = document.querySelector(`.player-slot[data-player-index="${prevPlayerIdx}"] .player-slot-deck .card`);
      const pileArea = document.getElementById('pile-area');

      const runAnimation = async () => {
        // Step 1: Throw animation (card slides from deck to pile, flips)
        playSound('throw');
        if (opponentDeck && pileArea && thrownCard) {
          const deckRect = opponentDeck.getBoundingClientRect();
          const pileRect = pileArea.getBoundingClientRect();
          const faceEl = renderCardFace(thrownCard);
          await animateThrowToPile(deckRect, pileRect, faceEl);
        }

        if (wasCaptured) {
          // After throw lands, briefly show the pile with the thrown card on top
          // so the capture shake/sweep has something visible
          const pileWithThrown = [...oldPile, thrownCard].filter(Boolean);
          const captureState = { ...state, pile: pileWithThrown };
          renderGameplay(captureState, playerIndex);

          // Step 2: Capture shake + glow
          playSound('capture');

          const pileCard = document.getElementById('pile-card');
          if (pileCard) {
            pileCard.classList.add('pile-capture-shake');
            await new Promise((r) => setTimeout(r, 1000));
            pileCard.classList.remove('pile-capture-shake');
          }

          announceCapture(prevPlayer.name);
          setEventMessage(`${prevPlayer.emoji} ${prevPlayer.name} captured the pile!`);

          // Step 3: Sweep pile towards opponent's deck
          const pileEl = document.getElementById('pile-card');
          const deckAfter = document.querySelector(`.player-slot[data-player-index="${prevPlayerIdx}"] .player-slot-deck .card`);
          if (pileEl && deckAfter) {
            const targetRect = deckAfter.getBoundingClientRect();
            await animateSweep(pileEl, targetRect);
          }
        }

        if (!prevPlayer.eliminated && newPrevPlayer.eliminated) {
          setEventMessage(`${prevPlayer.emoji} ${prevPlayer.name} is out of cards!`);
        }

        // Final render with real state (empty pile after capture, or new pile after throw)
        renderGameplay(state, playerIndex);
        isProcessingTurn = false;
      };

      runAnimation();
      return;
    }
  }

  _finishRemoteUpdate(newState);
}

function _finishRemoteUpdate(newState) {
  state = newState;

  if (state.status === 'finished' || (state.winnerIndex != null && state.winnerIndex >= 0)) {
    state.status = 'finished';
    const winner = state.players[state.winnerIndex];
    if (winner && !_resultsShown) {
      _resultsShown = true;
      announceWin(winner.name);
      if (typeof confetti === 'function') {
        confetti({ particleCount: 150, spread: 70, origin: { y: 0.6 } });
      }
      coinRain();
    }
    renderResults(state);
    showScreen('ppp-results');
    startReadyListener();
    return;
  }

  renderGameplay(state, playerIndex);
  isProcessingTurn = false;
}

/** Delegated card tap handler on gameplay screen. */
function wireCardTapHandler() {
  const gameScreen = document.getElementById('ppp-gameplay');
  if (!gameScreen) return;

  gameScreen.addEventListener('click', (e) => {
    const cardEl = e.target.closest('.card');
    if (!cardEl) return;

    warmSpeech();

    const slotDeck = cardEl.closest('.player-slot-deck');
    if (!slotDeck) return;

    const slot = slotDeck.closest('.player-slot');
    if (!slot || !slot.classList.contains('my-turn')) return;

    const handIndex = parseInt(cardEl.dataset.handIndex, 10);
    if (isNaN(handIndex)) return;

    handleCardTap(handIndex);
  });
}

/* ======= END GAME ======= */

function wireEndGame() {
  if (!btnEndGame) return;

  btnEndGame.addEventListener('click', async () => {
    if (!state) return;

    state.status = 'finished';
    state.winnerIndex = null;

    if (roomCode) {
      try { await endRoom(GAME_ID, roomCode); } catch (_) {}
    }

    renderResults(state);
    showScreen('ppp-results');
    startReadyListener();
  });
}

/* ======= RESULTS & PLAY AGAIN (Task 9.6) ======= */

function wireResults() {
  btnPlayAgain.addEventListener('click', async () => {
    if (isHost) {
      if (!btnPlayAgain.dataset.hostReady) {
        // First click: signal readiness
        btnPlayAgain.dataset.hostReady = 'true';
        btnPlayAgain.textContent = '▶ Start New Round';
        if (roomCode) {
          try {
            await update(ref(db, `card-games/${GAME_ID}-rooms/${roomCode}/ready`), {
              [`player_${playerIndex}`]: true,
            });
          } catch (_) {}
        }
      } else {
        // Second click: reset room to lobby
        if (window._readyCleanup) window._readyCleanup();
        btnPlayAgain.dataset.hostReady = '';
        btnPlayAgain.dataset.playerReady = '';
        btnPlayAgain.textContent = 'Play Again';
        state = null;
        if (roomCode) {
          try {
            await resetRoom(GAME_ID, roomCode);
          } catch (err) {
            console.error('Failed to reset room:', err);
            showToast('Failed to reset room.');
          }
        }
        setupLobby();
      }
    } else {
      // Non-host: signal readiness
      if (roomCode && playerIndex != null) {
        try {
          await update(ref(db, `card-games/${GAME_ID}-rooms/${roomCode}/ready`), {
            [`player_${playerIndex}`]: true,
          });
        } catch (_) {}
      }
      btnPlayAgain.dataset.playerReady = 'true';
      btnPlayAgain.disabled = true;
      btnPlayAgain.textContent = '✓ Ready';
      showToast('Waiting for host to start new round...');
    }
  });

  btnHome.addEventListener('click', async () => {
    if (window._readyCleanup) window._readyCleanup();

    if (roomCode) {
      // Signal left
      if (playerIndex != null) {
        try {
          await update(ref(db, `card-games/${GAME_ID}-rooms/${roomCode}/ready`), {
            [`player_${playerIndex}`]: 'left',
          });
        } catch (_) {}
      }

      if (isHost) {
        try { await deleteRoom(GAME_ID, roomCode); } catch (_) {}
      }
    }

    cleanupAndGoHome();
  });
}

function startReadyListener() {
  if (!roomCode) return;

  // Only reset button if player hasn't already clicked ready
  if (!btnPlayAgain.dataset.hostReady && !btnPlayAgain.dataset.playerReady) {
    btnPlayAgain.disabled = false;
    btnPlayAgain.textContent = 'Play Again';
  }

  // Clean up previous listener if any
  if (window._readyCleanup) window._readyCleanup();

  const readyRef = ref(db, `card-games/${GAME_ID}-rooms/${roomCode}/ready`);

  const readyHandler = (snapshot) => {
    const data = snapshot.val() || {};
    const readyIndices = Object.keys(data)
      .filter((k) => data[k] === true)
      .map((k) => parseInt(k.replace('player_', ''), 10))
      .filter((n) => !isNaN(n));
    const leftIndices = Object.keys(data)
      .filter((k) => data[k] === 'left')
      .map((k) => parseInt(k.replace('player_', ''), 10))
      .filter((n) => !isNaN(n));
    renderReadyIndicators(playerNames, readyIndices, leftIndices);
  };
  onValue(readyRef, readyHandler);

  window._readyCleanup = () => {
    off(readyRef, 'value', readyHandler);
    window._readyCleanup = null;
  };
}

/* ======= EMOJI PICKER WIRING ======= */

function wireEmojiPicker(containerSelector) {
  const picker = document.querySelector(containerSelector);
  if (!picker) return;

  const buttons = picker.querySelectorAll('.emoji-btn');
  buttons.forEach((btn) => {
    btn.addEventListener('click', () => {
      buttons.forEach((b) => b.classList.remove('selected'));
      btn.classList.add('selected');
    });
  });
}

/* ======= BACK BUTTONS ======= */

function wireBackButtons() {
  const btnBackOnline = document.getElementById('btn-back-online');
  if (btnBackOnline) {
    btnBackOnline.addEventListener('click', () => showLandingPage());
  }

  const btnBackCreate = document.getElementById('btn-back-create');
  if (btnBackCreate) {
    btnBackCreate.addEventListener('click', () => showScreen('ppp-online-choice'));
  }

  const btnBackJoin = document.getElementById('btn-back-join');
  if (btnBackJoin) {
    btnBackJoin.addEventListener('click', () => showScreen('ppp-online-choice'));
  }
}

/* ======= MUTE TOGGLE ======= */

function wireMuteToggle() {
  if (!muteToggle) return;
  muteToggle.checked = isMuted();
  muteToggle.addEventListener('change', () => {
    toggleMute();
  });
}

/* ======= SESSION RESTORATION ======= */

async function checkSession() {
  const session = loadSession();
  if (!session) return false;

  try {
    const roomRef = ref(db, `card-games/${GAME_ID}-rooms/${session.roomCode}`);
    const snapshot = await firebaseRetry(() => get(roomRef));

    if (!snapshot.exists()) {
      clearSession();
      return false;
    }

    const roomData = snapshot.val();
    const status = roomData.meta?.status;

    if (status === 'ended') {
      clearSession();
      return false;
    }

    roomCode = session.roomCode;
    playerIndex = session.playerIndex;
    isHost = session.isHost;

    if (roomData.players) {
      const keys = Object.keys(roomData.players).sort();
      playerNames = keys.map((k) => roomData.players[k].name || 'Unknown');
    }

    // Mark connected
    try {
      await update(ref(db, `card-games/${GAME_ID}-rooms/${roomCode}/players/player_${playerIndex}`), {
        connected: true,
      });
    } catch (_) {}

    if (status === 'lobby') {
      setupLobby();
      return true;
    }

    if (status === 'active' && roomData.game) {
      state = deserializeGameState(roomData.game, roomData.players);

      setupDisconnectHandler(GAME_ID, roomCode, playerIndex);

      if (unsubscribeRoom) unsubscribeRoom();
      unsubscribeRoom = listenRoom(GAME_ID, roomCode, {
        onPlayersChange: (players) => {
          const keys = Object.keys(players).sort();
          playerNames = keys.map((k) => players[k].name || 'Unknown');
        },
        onStatusChange: async (newStatus) => {
          if (newStatus === 'lobby') {
            state = null;
            setupLobby();
          }
          if (newStatus === 'ended' && state) {
            state.status = 'finished';
            state.winnerIndex = null;
            renderResults(state);
            showScreen('ppp-results');
            startReadyListener();
          }
        },
        onGameUpdate: (gameData, lastMove) => {
          handleRemoteGameUpdate(gameData, lastMove);
        },
        onRoomDeleted: () => {
          showToast('Host has left. Room closed.', 3000);
          cleanupAndGoHome();
        },
      });

      startOnlineGame();
      return true;
    }

    clearSession();
    return false;
  } catch (err) {
    console.warn('Failed to rejoin room:', err);
    clearSession();
    return false;
  }
}

/* ======= SERVICE WORKER ======= */

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;

  window.addEventListener('load', async () => {
    try {
      const registration = await navigator.serviceWorker.register('/sw.js');
      console.log('Service Worker registered');

      if (registration.waiting) {
        showUpdateToast(registration);
      }

      registration.addEventListener('updatefound', () => {
        const newWorker = registration.installing;
        if (!newWorker) return;

        newWorker.addEventListener('statechange', () => {
          if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
            showUpdateToast(registration);
          }
        });
      });
    } catch (err) {
      console.warn('Service Worker registration failed:', err.message);
    }
  });
}

function showUpdateToast(registration) {
  const updateToast = document.getElementById('update-toast');
  const updateBtn = document.getElementById('update-refresh-btn');
  if (!updateToast) return;

  updateToast.hidden = false;

  if (updateBtn && !updateBtn._listenerAdded) {
    updateBtn._listenerAdded = true;
    updateBtn.addEventListener('click', () => {
      updateToast.hidden = true;
      if (registration.waiting) {
        registration.waiting.postMessage({ type: 'SKIP_WAITING' });
      }
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        window.location.reload();
      });
    });
  }
}

/* ======= INITIALIZATION ======= */

async function init() {
  initAudio();

  wireCreateRoom();
  wireJoinRoom();
  wireLobby();
  wireCardTapHandler();
  wireEndGame();
  wireResults();
  wireMuteToggle();
  wireBackButtons();
  wireEmojiPicker('#ppp-create-room .emoji-picker');
  wireEmojiPicker('#ppp-join-room .emoji-picker');

  initSimpleRummy(showLandingPage, GAME_CONFIGS);
  initBluff(showLandingPage);
  initFlipMatch(showLandingPage);
  initPerfectTen(showLandingPage);
  initPoker(showLandingPage);

  registerServiceWorker();

  const rejoined = await checkSession();

  if (!rejoined) {
    const srRejoined = await checkSRSession();
    if (!srRejoined) {
      const blRejoined = await checkBluffSession();
      if (!blRejoined) {
        const fmRejoined = await checkFMSession();
        if (!fmRejoined) {
          const ptRejoined = await checkPTSession();
          if (!ptRejoined) {
            const pkRejoined = await checkPKSession();
            if (!pkRejoined) {
              showLandingPage();
            }
          }
        }
      }
    }
  }
}

init();
