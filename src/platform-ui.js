/**
 * Platform UI — Landing Page & Screen Management
 *
 * Manages screen transitions, landing page game card grid,
 * toast notifications, and custom modal dialogs.
 */

/**
 * Hides all .screen elements, then shows the one matching screenId.
 * @param {string} screenId
 */
export function showScreen(screenId) {
  const screens = document.querySelectorAll('.screen');
  screens.forEach((s) => s.setAttribute('hidden', ''));

  const target = document.getElementById(screenId);
  if (target) {
    target.removeAttribute('hidden');
  }
}

/**
 * Renders the landing page with 5 game cards in #game-cards-grid.
 * Available games get a working Play button; unavailable games get
 * a disabled button + "Coming Soon" badge + .coming-soon class.
 *
 * @param {Array<{id: string, name: string, image: string, available: boolean}>} games
 * @param {Function} onGameSelect - callback(gameId)
 */
export function renderLandingPage(games, onGameSelect) {
  const grid = document.getElementById('game-cards-grid');
  if (!grid) return;

  grid.innerHTML = '';

  games.forEach((game) => {
    const card = document.createElement('div');
    card.className = 'game-card';
    if (!game.available) card.classList.add('coming-soon');

    const img = document.createElement('img');
    img.src = game.image;
    img.alt = game.name;

    const name = document.createElement('span');
    name.className = 'game-card-name';
    name.textContent = game.name;

    const btn = document.createElement('button');
    btn.className = 'game-card-btn';
    btn.type = 'button';
    btn.textContent = 'Play';
    btn.setAttribute('aria-label', `Play ${game.name}`);

    if (game.available) {
      btn.addEventListener('click', () => onGameSelect(game.id));
    } else {
      btn.disabled = true;

      const badge = document.createElement('span');
      badge.className = 'coming-soon-badge';
      badge.textContent = 'Coming Soon';
      card.appendChild(badge);
    }

    card.appendChild(img);
    card.appendChild(name);
    card.appendChild(btn);
    grid.appendChild(card);
  });
}

/**
 * Shows a temporary toast message, auto-removes after duration.
 * @param {string} message
 * @param {number} [duration=1500]
 */
export function showToast(message, duration = 1500) {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = 'game-toast';
  toast.textContent = message;
  toast.setAttribute('role', 'alert');

  if (container) {
    container.appendChild(toast);
  } else {
    document.body.appendChild(toast);
  }

  setTimeout(() => {
    if (toast.parentNode) toast.parentNode.removeChild(toast);
  }, duration);
}

/**
 * Shows a custom modal dialog (replaces browser prompt/confirm).
 * @param {{title: string, inputPlaceholder?: string, showCancel?: boolean}} options
 * @returns {Promise<string|null>} input value or null if cancelled
 */
export function showModal(options) {
  const overlay = document.getElementById('custom-modal');
  const titleEl = document.getElementById('modal-title');
  const inputEl = document.getElementById('modal-input');
  const okBtn = document.getElementById('modal-ok');
  const cancelBtn = document.getElementById('modal-cancel');

  if (!overlay || !titleEl || !okBtn || !cancelBtn) {
    return Promise.resolve(null);
  }

  titleEl.textContent = options.title || '';

  if (options.inputPlaceholder) {
    inputEl.placeholder = options.inputPlaceholder;
    inputEl.value = '';
    inputEl.style.display = '';
  } else {
    inputEl.style.display = 'none';
  }

  cancelBtn.style.display = options.showCancel === false ? 'none' : '';

  overlay.removeAttribute('hidden');

  // Focus the input or OK button
  if (options.inputPlaceholder) {
    inputEl.focus();
  } else {
    okBtn.focus();
  }

  return new Promise((resolve) => {
    function cleanup() {
      overlay.setAttribute('hidden', '');
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
    }

    function onOk() {
      cleanup();
      resolve(options.inputPlaceholder ? inputEl.value : 'ok');
    }

    function onCancel() {
      cleanup();
      resolve(null);
    }

    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
  });
}
