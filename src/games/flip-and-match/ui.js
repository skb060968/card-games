/**
 * Flip & Match — UI Module
 *
 * Renders gameplay screen: card grid, player score bar,
 * event messages, results, lobby, and ready indicators.
 */

import { renderCardFace, renderCardBack } from '../../shared/card-renderer.js';

/* ======= GAMEPLAY RENDERING ======= */

/**
 * Renders the full Flip & Match gameplay screen.
 * @param {object} state - GameState
 * @param {number} localPlayerIndex
 * @param {Function} onFlip - callback(cardIndex) when a face-down card is tapped
 */
export function renderGameplay(state, localPlayerIndex, onFlip) {
  const playersBar = document.getElementById('fm-players-bar');
  const gridArea = document.getElementById('fm-grid-area');

  if (playersBar) {
    renderPlayerBar(playersBar, state.players, state.currentPlayerIndex, localPlayerIndex);
  }

  if (gridArea) {
    const isMyTurn = state.currentPlayerIndex === localPlayerIndex;
    renderGrid(gridArea, state.board, isMyTurn, onFlip);
  }
}

/**
 * Renders compact players bar with collected counts.
 */
function renderPlayerBar(container, players, currentPlayerIndex, localPlayerIndex) {
  container.innerHTML = '';

  players.forEach((player, i) => {
    const slot = document.createElement('div');
    slot.className = 'sr-player-chip';
    if (i === currentPlayerIndex) slot.classList.add('sr-chip-active');
    if (i === localPlayerIndex) slot.classList.add('sr-chip-me');

    const emoji = document.createElement('span');
    emoji.className = 'sr-chip-emoji';
    emoji.textContent = player.emoji;

    const info = document.createElement('span');
    info.className = 'sr-chip-info';
    const displayName = i === localPlayerIndex ? 'You' : player.name;
    const count = player.collected ? player.collected.length : 0;
    info.textContent = `${displayName} (${count})`;

    slot.appendChild(emoji);
    slot.appendChild(info);
    container.appendChild(slot);
  });
}

/**
 * Renders the card grid — 52 cards in rows.
 */
function renderGrid(container, board, isMyTurn, onFlip) {
  container.innerHTML = '';

  const grid = document.createElement('div');
  grid.className = 'fm-grid';

  board.forEach((slot, i) => {
    const cell = document.createElement('div');
    cell.className = 'fm-cell';
    cell.dataset.index = String(i);

    if (slot.state === 'down') {
      const cardEl = renderCardBack();
      cardEl.classList.add('fm-grid-card');

      if (isMyTurn) {
        cell.classList.add('fm-tappable');
        cardEl.style.cursor = 'pointer';
        cardEl.addEventListener('click', () => {
          if (onFlip) onFlip(i);
        });
      } else {
        cardEl.style.cursor = 'default';
      }

      cell.appendChild(cardEl);
    } else if (slot.state === 'up') {
      const cardEl = renderCardFace(slot.card);
      cardEl.classList.add('fm-grid-card');
      cardEl.style.cursor = 'default';
      cell.appendChild(cardEl);
    } else {
      // collected — empty slot
      cell.classList.add('fm-collected');
    }

    grid.appendChild(cell);
  });

  container.appendChild(grid);
}

/* ======= EVENT BAR ======= */

/**
 * Sets the event message bar text.
 * @param {string} message
 */
export function setEventMessage(message) {
  const bar = document.getElementById('fm-event-bar');
  if (bar) bar.textContent = message || '';
}

/* ======= RESULTS ======= */

/**
 * Renders the results screen.
 * @param {object} state
 */
export function renderResults(state) {
  const display = document.getElementById('fm-winner-display');
  const resultsList = document.getElementById('fm-results-list');

  if (display) {
    display.innerHTML = '';

    if (state.isTie && state.tiedIndices && state.tiedIndices.length > 1) {
      const tieEl = document.createElement('div');
      tieEl.className = 'winner-name';
      const names = state.tiedIndices.map((i) => state.players[i].name).join(' & ');
      tieEl.textContent = `🤝 Tie: ${names}`;
      display.appendChild(tieEl);

      const countEl = document.createElement('div');
      countEl.className = 'winner-bounty';
      countEl.textContent = `${state.players[state.tiedIndices[0]].collected.length} cards each`;
      display.appendChild(countEl);
    } else if (state.winnerIndex != null && state.players[state.winnerIndex]) {
      const winner = state.players[state.winnerIndex];
      const emojiEl = document.createElement('div');
      emojiEl.className = 'winner-emoji';
      emojiEl.textContent = winner.emoji;

      const nameEl = document.createElement('div');
      nameEl.className = 'winner-name';
      nameEl.textContent = `${winner.name} wins!`;

      const countEl = document.createElement('div');
      countEl.className = 'winner-bounty';
      countEl.textContent = `${winner.collected.length} cards collected`;

      display.appendChild(emojiEl);
      display.appendChild(nameEl);
      display.appendChild(countEl);
    } else {
      const drawEl = document.createElement('div');
      drawEl.className = 'winner-name';
      drawEl.textContent = 'Game ended — no winner';
      display.appendChild(drawEl);
    }
  }

  if (resultsList) {
    resultsList.innerHTML = '';

    // Sort players by collected count descending
    const ranked = state.players
      .map((p, i) => ({ ...p, index: i }))
      .sort((a, b) => b.collected.length - a.collected.length);

    ranked.forEach((player) => {
      const li = document.createElement('li');
      const nameSpan = document.createElement('span');
      nameSpan.textContent = `${player.emoji} ${player.name}`;
      const countSpan = document.createElement('span');
      countSpan.className = 'bounty-value';
      countSpan.textContent = `🃏 ${player.collected.length} cards`;
      li.appendChild(nameSpan);
      li.appendChild(countSpan);
      resultsList.appendChild(li);
    });
  }
}

/* ======= LOBBY ======= */

/**
 * Renders lobby player list.
 * @param {Array<{name, emoji}>} players
 */
export function renderLobbyPlayers(players) {
  const list = document.getElementById('fm-lobby-player-list');
  if (!list) return;
  list.innerHTML = '';

  players.forEach((player, index) => {
    const li = document.createElement('li');
    const emojiSpan = document.createElement('span');
    emojiSpan.textContent = player.emoji || '😀';
    const nameSpan = document.createElement('span');
    nameSpan.textContent = player.name || `Player ${index + 1}`;
    nameSpan.style.flex = '1';
    li.appendChild(emojiSpan);
    li.appendChild(nameSpan);
    if (index === 0) {
      const badge = document.createElement('span');
      badge.className = 'host-badge';
      badge.textContent = 'HOST';
      li.appendChild(badge);
    }
    list.appendChild(li);
  });
}

/* ======= READY INDICATORS ======= */

/**
 * Renders ready indicators for play-again flow.
 */
export function renderReadyIndicators(playerNames, readyPlayers, leftPlayers) {
  const container = document.getElementById('fm-ready-indicators');
  if (!container) return;
  container.hidden = false;
  container.innerHTML = '';

  const readySet = readyPlayers instanceof Set ? readyPlayers : new Set(readyPlayers);
  const leftSet = leftPlayers instanceof Set ? leftPlayers : new Set(leftPlayers || []);

  playerNames.forEach((name, index) => {
    const dot = document.createElement('div');
    dot.className = 'ready-dot';
    if (readySet.has(index)) dot.classList.add('ready');
    if (leftSet.has(index)) dot.classList.add('not-ready');
    const circle = document.createElement('div');
    circle.className = 'dot';
    const label = document.createElement('span');
    label.className = 'dot-name';
    label.textContent = name;
    dot.appendChild(circle);
    dot.appendChild(label);
    container.appendChild(dot);
  });
}
