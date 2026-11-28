class ChatManager {
  constructor() {
    this.messages = [];
    this.historyEl = typeof document !== "undefined"
      ? document.getElementById("chat-history")
      : null;
    this.typingIds = new Set();
    this.maxDomMessages = typeof GAME_CONFIG !== "undefined"
      ? (GAME_CONFIG.maxChatHistoryDom || 200)
      : 200;
  }

  addMessage({ senderId, senderName, senderColor, recipientId, recipientName, text, isAI }) {
    const id = `msg-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const msg = {
      id,
      senderId,
      senderName,
      senderColor: this._sanitizeColor(senderColor),
      recipientId,
      recipientName,
      text: String(text ?? ""),
      isAI: Boolean(isAI),
      timestamp: Date.now(),
    };
    this.messages.push(msg);
    if (this.messages.length > this.maxDomMessages * 2) {
      this.messages = this.messages.slice(-this.maxDomMessages);
    }
    const forceScroll = senderId === "player";
    const shouldScroll = forceScroll || this._isNearBottom();
    this._renderMessage(msg);
    if (shouldScroll) this._scrollToBottom();
    return id;
  }

  addTypingIndicator(senderName, senderColor, recipientName) {
    const id = `typing-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    this.typingIds.add(id);
    if (!this.historyEl) return id;

    const shouldScroll = this._isNearBottom();
    const el = document.createElement("div");
    el.className = "message typing-indicator";
    el.id = id;
    const safeColor = this._sanitizeColor(senderColor);
    el.innerHTML = `
      <div class="msg-header">
        <span class="sender-name" style="color:${safeColor}">${this._escapeHtml(senderName)}</span>
        <span class="arrow">→</span>
        <span class="recipient-name">${this._escapeHtml(recipientName)}</span>
      </div>
      <div class="msg-text">
        <span class="typing-dots" aria-label="入力中">
          <span></span><span></span><span></span>
        </span>
      </div>`;
    this.historyEl.appendChild(el);
    if (shouldScroll) this._scrollToBottom();
    return id;
  }

  removeTypingIndicator(id) {
    this.typingIds.delete(id);
    if (typeof document === "undefined") return;
    const el = document.getElementById(id);
    if (el) el.remove();
  }

  _renderMessage(msg) {
    if (!this.historyEl) return;

    const el = document.createElement("div");
    const isSystem = msg.senderId === "system";
    el.className = "message"
      + (isSystem ? " system-message" : msg.isAI ? "" : " player-message");
    el.id = msg.id;

    const time = new Date(msg.timestamp).toLocaleTimeString("ja-JP", {
      hour: "2-digit",
      minute: "2-digit",
    });

    const safeColor = this._sanitizeColor(msg.senderColor);
    el.innerHTML = `
      <div class="msg-header">
        <span class="sender-name" style="color:${safeColor}">${this._escapeHtml(msg.senderName)}</span>
        <span class="arrow">→</span>
        <span class="recipient-name">${this._escapeHtml(msg.recipientName)}</span>
        <span class="msg-time">${time}</span>
      </div>
      <div class="msg-text">${this._escapeHtml(this._stripMention(msg.text))}</div>`;

    this.historyEl.appendChild(el);

    // 長時間プレイ時の DOM 肥大化を防ぐ（先頭が typing-indicator でも後続の通常メッセージを削除）
    while (this.historyEl.children.length > this.maxDomMessages) {
      let target = this.historyEl.firstElementChild;
      while (target && this.typingIds.has(target.id)) {
        target = target.nextElementSibling;
      }
      if (!target) break;
      target.remove();
    }
  }

  _isNearBottom() {
    if (!this.historyEl) return true;
    const gap = this.historyEl.scrollHeight - this.historyEl.scrollTop - this.historyEl.clientHeight;
    return gap < 80;
  }

  _scrollToBottom() {
    if (!this.historyEl) return;
    this.historyEl.scrollTop = this.historyEl.scrollHeight;
  }

  _stripMention(text) {
    const s = String(text ?? "").trim();
    const aliasPattern = "(?:全員|みんな|皆さん|みなさん|アリス|ボブ|キャロル|プレイヤー)";
    const delimRe = new RegExp(
      `^[@＠](?:[A-Za-z0-9_]+|${aliasPattern})(?![A-Za-z0-9_])(?:(?:さん|くん|君|ちゃん|様)[\\s、,:：!！]*|[\\s、,:：!！]+|$)`
    );
    if (delimRe.test(s)) {
      return s.replace(delimRe, "").trim();
    }
    const bareRe = new RegExp(
      `^[@＠](?:[A-Za-z0-9_]+|${aliasPattern})(?![A-Za-z0-9_をがにのはでともへ]|から|より|まで|って|だ|じゃ|[」』）)\\]】])`
    );
    return s.replace(bareRe, "").trim();
  }

  _sanitizeColor(color) {
    if (typeof color === "string" && /^#[0-9a-fA-F]{3,8}$/.test(color.trim())) {
      return color.trim();
    }
    return "#5C4033";
  }

  _escapeHtml(str) {
    return String(str ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  getRecentMessages(n) {
    return this.messages.slice(-n);
  }

  parseMention(text) {
    const match = String(text ?? "").trim().match(
      /^[@＠]([A-Za-z0-9_]+|アリス|ボブ|キャロル|プレイヤー)(?:さん|くん|君|ちゃん|様)?(?=$|[\s、,:：!！])/
    );
    if (match) return match[1];
    const fallback = String(text ?? "").trim().match(/^[@＠]([A-Za-z]+|アリス|ボブ|キャロル|プレイヤー)/);
    return fallback ? fallback[1] : null;
  }

  resolveCharacter(name, characters) {
    if (!name) return null;
    const aliasMap = {
      "アリス": "alice",
      "ボブ": "bob",
      "キャロル": "carol",
      "プレイヤー": "player",
    };
    const raw = String(name).trim();
    const lower = aliasMap[raw] || raw.toLowerCase();
    return characters.find(c => c.name.toLowerCase() === lower || c.id.toLowerCase() === lower) || null;
  }
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { ChatManager };
}
