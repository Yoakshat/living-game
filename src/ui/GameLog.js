/**
 * GameLog — a fixed HTML overlay panel in the bottom-right corner of the game
 * showing recent player actions and merged PRs as a living history feed.
 *
 * Lives in the DOM (not world-space Phaser objects) so it stays fixed while
 * the camera scrolls. pointer-events: none ensures it never blocks game input.
 */

const POLL_INTERVAL = 5000; // ms between server fetches

export class GameLog {
  constructor(serverUrl) {
    this._serverUrl = serverUrl.replace(/\/$/, '');
    this._entries = [];
    this._nameToColor = new Map(); // player name → hex color string
    this._pollTimer = null;
    this._el = null;
    this._listEl = null;

    this._build();
    this._fetch();
    this._pollTimer = setInterval(() => this._fetch(), POLL_INTERVAL);
  }

  /** Build the DOM panel and attach it to document.body. */
  _build() {
    const panel = document.createElement('div');
    panel.id = 'game-log-panel';
    Object.assign(panel.style, {
      position:       'fixed',
      bottom:         '12px',
      right:          '12px',
      width:          '300px',
      maxHeight:      '240px',
      background:     'rgba(0,0,0,0.68)',
      borderRadius:   '6px',
      padding:        '8px',
      boxSizing:      'border-box',
      overflowY:      'auto',
      overflowX:      'hidden',
      zIndex:         '9999',
      pointerEvents:  'auto',
      fontFamily:     'monospace, monospace',
      fontSize:       '11px',
      lineHeight:     '1.4',
      display:        'flex',
      flexDirection:  'column',
      justifyContent: 'flex-end',
    });

    const list = document.createElement('div');
    Object.assign(list.style, {
      display:       'flex',
      flexDirection: 'column',
      gap:           '2px',
    });

    panel.appendChild(list);
    document.body.appendChild(panel);

    this._el = panel;
    this._listEl = list;
    this._renderPlaceholder();
  }

  _renderPlaceholder() {
    this._listEl.innerHTML = '';
    const ph = document.createElement('span');
    ph.textContent = 'No activity yet';
    Object.assign(ph.style, { color: 'rgba(255,255,255,0.3)', fontStyle: 'italic' });
    this._listEl.appendChild(ph);
  }

  /** Fetch /log from server and re-render. Fails silently. */
  async _fetch() {
    try {
      const res = await fetch(`${this._serverUrl}/log`, { cache: 'no-store' });
      if (!res.ok) return;
      const data = await res.json();
      if (!Array.isArray(data)) return;
      this._entries = data;
      this._render();
    } catch {
      // Server unreachable — keep current display
    }
  }

  /** Re-render all entries, auto-scrolling to bottom unless user scrolled up. */
  _render() {
    if (this._entries.length === 0) {
      this._renderPlaceholder();
      return;
    }

    const el = this._el;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 32;

    this._listEl.innerHTML = '';

    for (const entry of this._entries) {
      const row = document.createElement('div');
      Object.assign(row.style, {
        display:    'flex',
        gap:        '5px',
        alignItems: 'baseline',
        flexWrap:   'wrap',
      });

      // Timestamp
      const ts = document.createElement('span');
      ts.textContent = this._formatTime(entry.timestamp);
      Object.assign(ts.style, { color: 'rgba(255,255,255,0.35)', flexShrink: '0' });
      row.appendChild(ts);

      if (entry.type === 'pr_merged') {
        // PR events: gold color, full message
        const msg = document.createElement('span');
        msg.textContent = entry.message || '';
        Object.assign(msg.style, { color: '#e1c14b' });
        row.appendChild(msg);
      } else {
        // Action events: message text contains player name already
        // Render the player name portion in their assigned color, rest in default
        const playerName = entry.player;
        const message = entry.message || '';
        const color = (playerName && this._nameToColor.get(playerName)) || 'rgba(255,255,255,0.7)';

        if (playerName && message.startsWith(playerName)) {
          // Split: colored name + rest of message
          const nameSpan = document.createElement('span');
          nameSpan.textContent = playerName;
          Object.assign(nameSpan.style, { color, fontWeight: 'bold', flexShrink: '0' });

          const rest = document.createElement('span');
          rest.textContent = message.slice(playerName.length);
          Object.assign(rest.style, { color: 'rgba(220,220,220,0.9)' });

          row.appendChild(nameSpan);
          row.appendChild(rest);
        } else {
          const msg = document.createElement('span');
          msg.textContent = message;
          Object.assign(msg.style, { color: 'rgba(220,220,220,0.9)' });
          row.appendChild(msg);
        }
      }

      this._listEl.appendChild(row);
    }

    if (atBottom) el.scrollTop = el.scrollHeight;
  }

  /**
   * Called by WorldScene when it learns a player's name↔color mapping.
   * Triggers a re-render so colors update immediately.
   */
  setPlayerColor(name, hexColor) {
    this._nameToColor.set(name, hexColor);
    if (this._entries.length > 0) this._render();
  }

  /** Format ISO timestamp as HH:MM:SS in local time. */
  _formatTime(iso) {
    try {
      const d = new Date(iso);
      return [d.getHours(), d.getMinutes(), d.getSeconds()]
        .map((n) => String(n).padStart(2, '0'))
        .join(':');
    } catch {
      return '--:--:--';
    }
  }

  /** Remove the panel and stop polling. */
  destroy() {
    clearInterval(this._pollTimer);
    if (this._el && this._el.parentNode) {
      this._el.parentNode.removeChild(this._el);
    }
  }
}
