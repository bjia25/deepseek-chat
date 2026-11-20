/* DeepSeek 聊天页 —— 纯前端逻辑，聊天记录保存在浏览器 localStorage */
(function () {
  'use strict';

  var DS = window.DSMarkdown || {
    escapeHtml: function (s) {
      return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
      });
    },
    render: function (s) {
      return DS.escapeHtml(s).replace(/\n/g, '<br>');
    },
  };

  var STORAGE_KEY = 'deepseek-chat:v1';
  var MAX_CONTEXT_MESSAGES = 30;
  var MODELS = ['deepseek-chat', 'deepseek-reasoner'];
  var DEFAULT_SYSTEM_PROMPT =
    '你是 DeepSeek，一个聪明、友好、乐于助人的中文 AI 助手。回答自然、准确，必要时用列表或代码说明。';

  var SUGGESTIONS = [
    {
      label: '写一封请假邮件',
      detail: '理由：身体不舒服，语气正式',
      prompt: '帮我写一封请假邮件，理由是我今天身体不太舒服需要休息一天，语气正式一点。',
    },
    {
      label: '解释大模型',
      detail: '用大白话讲给外行听',
      prompt: '用大白话解释一下大模型是怎么工作的，假设我完全没接触过 AI。',
    },
    {
      label: '推荐周末电影',
      detail: '5 部，各一句推荐理由',
      prompt: '推荐 5 部适合周末看的电影，每部附一句推荐理由，不要太小众。',
    },
    {
      label: '润色自我介绍',
      detail: '刚毕业的产品经理',
      prompt: '帮我润色一段自我介绍：我是一名刚毕业的产品经理，喜欢研究用户需求，做过两个小产品。',
    },
  ];

  var el = {
    messages: document.getElementById('messages'),
    input: document.getElementById('input'),
    send: document.getElementById('send'),
    modelSwitch: document.getElementById('model-switch'),
    themeToggle: document.getElementById('theme-toggle'),
    themeIcon: document.getElementById('theme-icon'),
    newChatTop: document.getElementById('new-chat-top'),
    newChatDrawer: document.getElementById('new-chat-drawer'),
    drawer: document.getElementById('drawer'),
    drawerOpen: document.getElementById('drawer-open'),
    drawerClose: document.getElementById('drawer-close'),
    scrim: document.getElementById('scrim'),
    convList: document.getElementById('conv-list'),
    openSettings: document.getElementById('open-settings'),
    settingsPanel: document.getElementById('settings-panel'),
    settingsClose: document.getElementById('settings-close'),
    systemPrompt: document.getElementById('system-prompt'),
    saveSettings: document.getElementById('save-settings'),
    clearAll: document.getElementById('clear-all'),
    gate: document.getElementById('gate'),
    gateForm: document.getElementById('gate-form'),
    gateInput: document.getElementById('gate-input'),
    gateError: document.getElementById('gate-error'),
    toast: document.getElementById('toast'),
  };

  var state = {
    conversations: [],
    activeId: null,
    settings: {
      model: 'deepseek-chat',
      systemPrompt: DEFAULT_SYSTEM_PROMPT,
      theme: 'auto',
    },
    authRequired: false,
    authed: true,
    streaming: false,
    abort: null,
    rafPending: false,
  };

  var SSE_DONE = { done: true };

  /* ------------------------------------------------------------------ */
  /* 基础工具                                                           */
  /* ------------------------------------------------------------------ */

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function pad2(n) {
    return n < 10 ? '0' + n : String(n);
  }

  function relTime(ts) {
    var date = new Date(ts);
    var now = new Date();
    var diff = now.getTime() - date.getTime();
    if (diff < 60 * 1000) return '刚刚';
    if (diff < 60 * 60 * 1000) return Math.floor(diff / 60000) + ' 分钟前';
    if (date.toDateString() === now.toDateString()) return pad2(date.getHours()) + ':' + pad2(date.getMinutes());
    var yesterday = new Date(now.getTime() - 86400000);
    if (date.toDateString() === yesterday.toDateString()) return '昨天';
    if (date.getFullYear() === now.getFullYear()) return date.getMonth() + 1 + '月' + date.getDate() + '日';
    return date.getFullYear() + '/' + (date.getMonth() + 1) + '/' + date.getDate();
  }

  function makeTitle(text) {
    var line = String(text).split('\n')[0].replace(/[#>*`_~\[\]]/g, '').trim();
    if (!line) return '新对话';
    return line.length > 26 ? line.slice(0, 26) + '…' : line;
  }

  function readJson(response) {
    return response.json().catch(function () {
      return null;
    });
  }

  var toastTimer = 0;
  function toast(message) {
    el.toast.textContent = message;
    el.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      el.toast.hidden = true;
    }, 2200);
  }

  function copyText(text) {
    if (!text) return;
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(
        function () {
          toast('已复制');
        },
        function () {
          fallbackCopy(text);
        }
      );
    } else {
      fallbackCopy(text);
    }
  }

  function fallbackCopy(text) {
    var area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.top = '-1000px';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    try {
      document.execCommand('copy');
      toast('已复制');
    } catch (error) {
      toast('复制失败，请手动选择');
    }
    area.remove();
  }

  /* ------------------------------------------------------------------ */
  /* 本地存储                                                           */
  /* ------------------------------------------------------------------ */

  function normalizeMessage(message) {
    if (!message || typeof message !== 'object') return null;
    if (message.role !== 'user' && message.role !== 'assistant') return null;
    if (typeof message.content !== 'string') return null;
    return {
      id: typeof message.id === 'string' ? message.id : uid(),
      role: message.role,
      content: message.content,
      reasoning: typeof message.reasoning === 'string' ? message.reasoning : '',
      error: typeof message.error === 'string' ? message.error : '',
      stopped: Boolean(message.stopped),
      ts: Number(message.ts) || Date.now(),
      streaming: false,
    };
  }

  function loadState() {
    var data = null;
    try {
      data = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    } catch (error) {
      data = null;
    }
    if (!data || typeof data !== 'object') return;

    if (Array.isArray(data.conversations)) {
      state.conversations = data.conversations
        .filter(function (conv) {
          return conv && typeof conv.id === 'string' && Array.isArray(conv.messages);
        })
        .slice(0, 60)
        .map(function (conv) {
          return {
            id: conv.id,
            title: typeof conv.title === 'string' && conv.title ? conv.title : '新对话',
            model: MODELS.indexOf(conv.model) !== -1 ? conv.model : 'deepseek-chat',
            createdAt: Number(conv.createdAt) || Date.now(),
            updatedAt: Number(conv.updatedAt) || Number(conv.createdAt) || Date.now(),
            messages: conv.messages.map(normalizeMessage).filter(Boolean),
          };
        });
    }

    if (data.settings && typeof data.settings === 'object') {
      if (MODELS.indexOf(data.settings.model) !== -1) state.settings.model = data.settings.model;
      if (typeof data.settings.systemPrompt === 'string') state.settings.systemPrompt = data.settings.systemPrompt;
      if (['auto', 'light', 'dark'].indexOf(data.settings.theme) !== -1) state.settings.theme = data.settings.theme;
    }

    if (typeof data.activeId === 'string') state.activeId = data.activeId;
    var exists = state.conversations.some(function (conv) {
      return conv.id === state.activeId;
    });
    if (!exists) state.activeId = state.conversations.length ? state.conversations[0].id : null;
  }

  function saveState() {
    try {
      var conversations = state.conversations.filter(function (conv) {
        return conv.messages.length > 0 || conv.id === state.activeId;
      });
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          conversations: conversations,
          settings: state.settings,
          activeId: state.activeId,
        })
      );
    } catch (error) {
      /* 存储被禁用或已满：不影响当前会话 */
    }
  }

  /* ------------------------------------------------------------------ */
  /* 会话                                                               */
  /* ------------------------------------------------------------------ */

  function getActiveConversation() {
    for (var i = 0; i < state.conversations.length; i += 1) {
      if (state.conversations[i].id === state.activeId) return state.conversations[i];
    }
    return null;
  }

  function getOrCreateConversation() {
    var conv = getActiveConversation();
    if (conv) return conv;
    conv = {
      id: uid(),
      title: '新对话',
      model: state.settings.model,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: [],
    };
    state.conversations.unshift(conv);
    state.activeId = conv.id;
    return conv;
  }

  function startNewChat() {
    if (state.streaming) stopStreaming();
    var conv = {
      id: uid(),
      title: '新对话',
      model: state.settings.model,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: [],
    };
    state.conversations.unshift(conv);
    state.activeId = conv.id;
    closeDrawer();
    renderDrawer();
    renderMessages();
    saveState();
    updateModelSwitch();
    el.input.focus();
  }

  function selectConversation(id) {
    if (state.streaming) stopStreaming();
    state.activeId = id;
    var conv = getActiveConversation();
    if (conv && MODELS.indexOf(conv.model) !== -1) state.settings.model = conv.model;
    updateModelSwitch();
    closeDrawer();
    renderMessages();
    renderDrawer();
    saveState();
    el.input.focus();
  }

  function deleteConversation(id, button) {
    if (button.dataset.confirm !== '1') {
      button.dataset.confirm = '1';
      button.textContent = '删除?';
      button.classList.add('confirm');
      setTimeout(function () {
        button.dataset.confirm = '';
        button.textContent = '✕';
        button.classList.remove('confirm');
      }, 3000);
      return;
    }
    if (state.streaming) stopStreaming();
    state.conversations = state.conversations.filter(function (conv) {
      return conv.id !== id;
    });
    if (state.activeId === id) {
      var next = state.conversations[0];
      state.activeId = next ? next.id : null;
      if (next && MODELS.indexOf(next.model) !== -1) state.settings.model = next.model;
      updateModelSwitch();
    }
    saveState();
    renderDrawer();
    renderMessages();
  }

  /* ------------------------------------------------------------------ */
  /* 渲染：抽屉                                                         */
  /* ------------------------------------------------------------------ */

  function renderDrawer() {
    el.convList.innerHTML = '';
    var list = state.conversations.filter(function (conv) {
      return conv.messages.length > 0;
    });

    if (!list.length) {
      var empty = document.createElement('p');
      empty.className = 'empty-hint';
      empty.textContent = '还没有对话，发条消息开始吧。';
      el.convList.appendChild(empty);
      return;
    }

    list.forEach(function (conv) {
      var item = document.createElement('div');
      item.className = 'conv-item' + (conv.id === state.activeId ? ' active' : '');
      item.setAttribute('role', 'listitem');

      var open = document.createElement('button');
      open.type = 'button';
      open.className = 'conv-open';

      var title = document.createElement('span');
      title.className = 'conv-title';
      title.textContent = conv.title || '新对话';

      var time = document.createElement('span');
      time.className = 'conv-time';
      time.textContent = relTime(conv.updatedAt || conv.createdAt);

      open.appendChild(title);
      open.appendChild(time);
      open.addEventListener('click', function () {
        selectConversation(conv.id);
      });

      var del = document.createElement('button');
      del.type = 'button';
      del.className = 'conv-del';
      del.title = '删除对话';
      del.textContent = '✕';
      del.addEventListener('click', function (event) {
        event.stopPropagation();
        deleteConversation(conv.id, del);
      });

      item.appendChild(open);
      item.appendChild(del);
      el.convList.appendChild(item);
    });
  }

  /* ------------------------------------------------------------------ */
  /* 渲染：消息                                                         */
  /* ------------------------------------------------------------------ */

  function buildWelcome() {
    var wrap = document.createElement('div');
    wrap.className = 'welcome';
    wrap.innerHTML =
      '<div class="welcome-orb"><svg viewBox="0 0 24 24" aria-hidden="true">' +
      '<path d="M4 6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-5.5L8 20.5V16H6a2 2 0 0 1-2-2z" fill="currentColor"/>' +
      '</svg></div>' +
      '<h1>你好，我是 DeepSeek</h1>' +
      '<p>随便聊聊吧 —— 工作、学习、写作，或者只是说说今天过得怎么样。</p>';

    var chips = document.createElement('div');
    chips.className = 'chips';
    SUGGESTIONS.forEach(function (item) {
      var chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'chip';
      chip.innerHTML = DS.escapeHtml(item.label) + '<span>' + DS.escapeHtml(item.detail) + '</span>';
      chip.addEventListener('click', function () {
        el.input.value = item.prompt;
        updateComposer();
        sendMessage();
      });
      chips.appendChild(chip);
    });
    wrap.appendChild(chips);
    return wrap;
  }

  function buildReasoning() {
    var details = document.createElement('details');
    details.className = 'reasoning';
    details.open = true;
    details.innerHTML = '<summary>思考过程</summary><div class="reasoning-body md"></div>';
    return details;
  }

  function buildActions() {
    var wrap = document.createElement('div');
    wrap.className = 'msg-actions';

    var copy = document.createElement('button');
    copy.type = 'button';
    copy.dataset.act = 'copy';
    copy.innerHTML = '<svg class="icon"><use href="#i-copy"/></svg>复制';

    var regen = document.createElement('button');
    regen.type = 'button';
    regen.dataset.act = 'regen';
    regen.innerHTML = '<svg class="icon"><use href="#i-refresh"/></svg>重新生成';

    wrap.appendChild(copy);
    wrap.appendChild(regen);
    return wrap;
  }

  function paintBubble(row, message) {
    var bubble = row.querySelector('.bubble');
    var md = bubble.querySelector('.md');
    var isAssistant = message.role === 'assistant';

    var html = '';
    if (message.content) html = DS.render(message.content);
    if (message.error) {
      html += '<p class="error-note">⚠️ ' + DS.escapeHtml(message.error) + '</p>';
    }
    if (!html && message.streaming) {
      html = '<span class="typing"><i></i><i></i><i></i></span>';
    }
    md.innerHTML = html;

    row.classList.toggle('error', Boolean(message.error) && !message.content);
    row.classList.toggle('stopped', Boolean(message.stopped));

    if (isAssistant) {
      bubble.classList.toggle('streaming', Boolean(message.streaming));
      var actions = bubble.querySelector('.msg-actions');
      if (!message.streaming && !actions) {
        bubble.appendChild(buildActions());
      } else if (message.streaming && actions) {
        actions.remove();
      }
    }
  }

  function setReasoning(row, message) {
    var bubble = row.querySelector('.bubble');
    var existing = bubble.querySelector('.reasoning');

    if (message.reasoning) {
      if (!existing) {
        existing = buildReasoning();
        bubble.insertBefore(existing, bubble.firstChild);
      }
      existing.querySelector('.reasoning-body').innerHTML = DS.render(message.reasoning);
    } else if (existing) {
      existing.remove();
    }
  }

  function createMessageNode(message) {
    var row = document.createElement('div');
    row.className = 'msg ' + message.role;
    row.dataset.id = message.id;

    var avatar = document.createElement('div');
    avatar.className = 'avatar';
    avatar.textContent = message.role === 'user' ? '我' : 'D';

    var bubble = document.createElement('div');
    bubble.className = 'bubble';

    var md = document.createElement('div');
    md.className = 'md';
    bubble.appendChild(md);

    row.appendChild(avatar);
    row.appendChild(bubble);

    if (message.role === 'assistant' && message.reasoning) setReasoning(row, message);
    paintBubble(row, message);
    return row;
  }

  function renderMessages() {
    var conv = getActiveConversation();
    el.messages.innerHTML = '';
    if (!conv || !conv.messages.length) {
      el.messages.appendChild(buildWelcome());
      return;
    }
    for (var i = 0; i < conv.messages.length; i += 1) {
      el.messages.appendChild(createMessageNode(conv.messages[i]));
    }
    scrollToBottom(false);
  }

  function updateStreamingNode(message) {
    var row = el.messages.querySelector('[data-id="' + message.id + '"]');
    if (!row) return;
    setReasoning(row, message);
    paintBubble(row, message);

    if (!row.dataset.autoCollapsed && message.content && message.reasoning) {
      row.dataset.autoCollapsed = '1';
      var details = row.querySelector('.reasoning');
      if (details) details.open = false;
    }
  }

  function scrollToBottom(smooth) {
    var target = el.messages.scrollHeight;
    if (smooth && typeof el.messages.scrollTo === 'function') {
      el.messages.scrollTo({ top: target, behavior: 'smooth' });
    } else {
      el.messages.scrollTop = target;
    }
  }

  function scrollIfNearBottom() {
    var distance = el.messages.scrollHeight - el.messages.scrollTop - el.messages.clientHeight;
    if (distance < 160) el.messages.scrollTop = el.messages.scrollHeight;
  }

  /* ------------------------------------------------------------------ */
  /* 发送与流式接收                                                     */
  /* ------------------------------------------------------------------ */

  function AuthError() {
    this.name = 'AuthError';
    this.message = '需要访问密码';
  }
  AuthError.prototype = Object.create(Error.prototype);

  function buildContext(conv) {
    var messages = [];
    var systemPrompt = (state.settings.systemPrompt || '').trim();
    if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });

    var history = conv.messages.filter(function (message) {
      return (
        (message.role === 'user' || message.role === 'assistant') &&
        typeof message.content === 'string' &&
        message.content.trim().length > 0 &&
        !message.error
      );
    });

    var recent = history.slice(-MAX_CONTEXT_MESSAGES);
    while (recent.length && recent[recent.length - 1].role === 'assistant') recent.pop();
    for (var i = 0; i < recent.length; i += 1) {
      messages.push({ role: recent[i].role, content: recent[i].content });
    }
    return messages;
  }

  function parseSseChunk(chunk) {
    var lines = chunk.split('\n');
    var dataLines = [];
    for (var i = 0; i < lines.length; i += 1) {
      if (lines[i].indexOf('data:') === 0) dataLines.push(lines[i].slice(5).replace(/^ /, ''));
    }
    if (!dataLines.length) return null;
    var raw = dataLines.join('\n').trim();
    if (!raw) return null;
    if (raw === '[DONE]') return SSE_DONE;
    try {
      return JSON.parse(raw);
    } catch (error) {
      return null;
    }
  }

  function consumeStream(body, onEvent) {
    return new Promise(function (resolve, reject) {
      var reader = body.getReader();
      var decoder = new TextDecoder();
      var buffer = '';

      function pump() {
        reader.read().then(
          function (result) {
            if (result.done) {
              if (buffer.trim()) {
                var last = parseSseChunk(buffer);
                if (last && last !== SSE_DONE) onEvent(last);
              }
              resolve();
              return;
            }
            buffer += decoder.decode(result.value, { stream: true }).replace(/\r\n/g, '\n');
            var index;
            while ((index = buffer.indexOf('\n\n')) !== -1) {
              var chunk = buffer.slice(0, index);
              buffer = buffer.slice(index + 2);
              var payload = parseSseChunk(chunk);
              if (payload === SSE_DONE) {
                resolve();
                return;
              }
              if (payload) onEvent(payload);
            }
            pump();
          },
          reject
        );
      }
      pump();
    });
  }

  function schedulePaint(id) {
    if (state.rafPending) return;
    state.rafPending = true;
    requestAnimationFrame(function () {
      state.rafPending = false;
      var conv = getActiveConversation();
      if (!conv) return;
      for (var i = 0; i < conv.messages.length; i += 1) {
        if (conv.messages[i].id === id) {
          updateStreamingNode(conv.messages[i]);
          break;
        }
      }
      scrollIfNearBottom();
    });
  }

  async function runStream(conv, assistant) {
    state.streaming = true;
    state.abort = new AbortController();
    updateComposer();

    var payload = buildContext(conv);

    try {
      var response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: state.settings.model, messages: payload }),
        signal: state.abort.signal,
      });

      if (!response.ok) {
        var data = await readJson(response);
        var code = data && data.error ? data.error.code : '';
        if (response.status === 401 && code === 'unauthorized') {
          state.authed = false;
          showGate();
          throw new AuthError();
        }
        throw new Error((data && data.error && data.error.message) || '请求失败（HTTP ' + response.status + '）');
      }

      if (!response.body) throw new Error('当前浏览器不支持流式响应。');

      await consumeStream(response.body, function (event) {
        var choice = event.choices && event.choices[0];
        if (!choice) {
          if (event.usage) assistant.usage = event.usage;
          return;
        }
        var delta = choice.delta || {};
        if (delta.reasoning_content) {
          assistant.reasoning = (assistant.reasoning || '') + delta.reasoning_content;
        }
        if (delta.content) {
          assistant.content = (assistant.content || '') + delta.content;
        }
        schedulePaint(assistant.id);
      });

      if (!assistant.content && !assistant.reasoning) {
        throw new Error('没有收到回复，请稍后重试。');
      }
      assistant.streaming = false;
    } catch (error) {
      assistant.streaming = false;
      if (error && error.name === 'AbortError') {
        assistant.stopped = true;
        if (!assistant.content && !assistant.reasoning) assistant.error = '已停止生成。';
      } else if (error instanceof AuthError) {
        assistant.error = '请先输入访问密码。';
      } else {
        assistant.error =
          error && /Failed to fetch|NetworkError|Load failed/i.test(error.message || '')
            ? '网络连接失败，请检查网络后重试。'
            : (error && error.message) || '出了点问题，请重试。';
      }
    } finally {
      state.streaming = false;
      state.abort = null;
      updateComposer();
      conv.updatedAt = Date.now();
      saveState();
      renderDrawer();
      updateStreamingNode(assistant);
      scrollToBottom(true);
    }
  }

  async function sendMessage() {
    if (state.streaming) return;
    if (state.authRequired && !state.authed) {
      showGate();
      return;
    }
    var text = el.input.value.trim();
    if (!text) return;

    var conv = getOrCreateConversation();
    var userMessage = { id: uid(), role: 'user', content: text, ts: Date.now() };
    conv.messages.push(userMessage);
    conv.updatedAt = Date.now();

    var userCount = 0;
    for (var i = 0; i < conv.messages.length; i += 1) {
      if (conv.messages[i].role === 'user') userCount += 1;
    }
    if (userCount === 1) conv.title = makeTitle(text);

    var assistant = {
      id: uid(),
      role: 'assistant',
      content: '',
      reasoning: '',
      ts: Date.now(),
      streaming: true,
    };
    conv.messages.push(assistant);

    el.input.value = '';
    autosize();
    updateComposer();
    renderMessages();
    renderDrawer();
    saveState();

    await runStream(conv, assistant);
  }

  async function regenerate(messageId) {
    if (state.streaming) return;
    var conv = getActiveConversation();
    if (!conv) return;
    var index = -1;
    for (var i = 0; i < conv.messages.length; i += 1) {
      if (conv.messages[i].id === messageId) {
        index = i;
        break;
      }
    }
    if (index === -1) return;

    var assistant = {
      id: uid(),
      role: 'assistant',
      content: '',
      reasoning: '',
      ts: Date.now(),
      streaming: true,
    };
    conv.messages.splice(index, 1, assistant);
    renderMessages();
    saveState();
    await runStream(conv, assistant);
  }

  function stopStreaming() {
    if (state.abort) state.abort.abort();
  }

  /* ------------------------------------------------------------------ */
  /* 密码 / 设置 / 主题                                                  */
  /* ------------------------------------------------------------------ */

  function showGate() {
    el.gate.hidden = false;
    el.gateError.hidden = true;
    setTimeout(function () {
      el.gateInput.focus();
    }, 60);
  }

  async function submitGate(event) {
    event.preventDefault();
    var password = el.gateInput.value;
    if (!password) return;
    var button = el.gateForm.querySelector('button[type="submit"]');
    button.disabled = true;
    try {
      var response = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: password }),
      });
      if (!response.ok) {
        var data = await readJson(response);
        throw new Error((data && data.error && data.error.message) || '密码不正确');
      }
      state.authed = true;
      el.gate.hidden = true;
      el.gateInput.value = '';
      toast('欢迎回来');
      el.input.focus();
    } catch (error) {
      el.gateError.textContent = error.message || '登录失败，请重试。';
      el.gateError.hidden = false;
    } finally {
      button.disabled = false;
    }
  }

  function openSettings() {
    el.systemPrompt.value = state.settings.systemPrompt;
    el.settingsPanel.hidden = false;
    closeDrawer();
    el.systemPrompt.focus();
  }

  function closeSettings() {
    el.settingsPanel.hidden = true;
  }

  function saveSettings() {
    state.settings.systemPrompt = el.systemPrompt.value.trim();
    saveState();
    closeSettings();
    toast('设置已保存');
  }

  function clearAllConversations() {
    if (el.clearAll.dataset.confirm !== '1') {
      el.clearAll.dataset.confirm = '1';
      el.clearAll.textContent = '再点一次确认';
      setTimeout(function () {
        el.clearAll.dataset.confirm = '';
        el.clearAll.textContent = '清空所有对话';
      }, 3000);
      return;
    }
    if (state.streaming) stopStreaming();
    state.conversations = [];
    state.activeId = null;
    saveState();
    renderDrawer();
    renderMessages();
    el.clearAll.dataset.confirm = '';
    el.clearAll.textContent = '清空所有对话';
    closeSettings();
    toast('已清空所有对话');
  }

  function resolvedTheme() {
    if (state.settings.theme === 'auto') {
      return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    return state.settings.theme;
  }

  function applyTheme() {
    var theme = resolvedTheme();
    document.documentElement.dataset.theme = theme;
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', theme === 'dark' ? '#0d0f14' : '#f6f7f9');
    if (el.themeIcon) {
      var use = el.themeIcon.querySelector('use');
      if (use) use.setAttribute('href', theme === 'dark' ? '#i-moon' : '#i-sun');
    }
  }

  function cycleTheme() {
    var order = ['auto', 'light', 'dark'];
    var index = order.indexOf(state.settings.theme);
    state.settings.theme = order[(index + 1) % order.length];
    applyTheme();
    saveState();
    toast(
      state.settings.theme === 'auto'
        ? '主题：跟随系统'
        : state.settings.theme === 'dark'
          ? '主题：深色'
          : '主题：浅色'
    );
  }

  /* ------------------------------------------------------------------ */
  /* 输入框 / 顶栏                                                      */
  /* ------------------------------------------------------------------ */

  function autosize() {
    el.input.style.height = 'auto';
    el.input.style.height = Math.min(el.input.scrollHeight, 200) + 'px';
  }

  function updateComposer() {
    if (state.streaming) {
      el.send.disabled = false;
      el.send.classList.add('streaming');
      el.send.setAttribute('aria-label', '停止生成');
    } else {
      el.send.disabled = !el.input.value.trim();
      el.send.classList.remove('streaming');
      el.send.setAttribute('aria-label', '发送');
    }
  }

  function updateModelSwitch() {
    var buttons = el.modelSwitch.querySelectorAll('.seg');
    for (var i = 0; i < buttons.length; i += 1) {
      var isActive = buttons[i].dataset.model === state.settings.model;
      buttons[i].classList.toggle('active', isActive);
      buttons[i].setAttribute('aria-selected', isActive ? 'true' : 'false');
    }
  }

  function setModel(model) {
    if (MODELS.indexOf(model) === -1) return;
    state.settings.model = model;
    var conv = getActiveConversation();
    if (conv) conv.model = model;
    updateModelSwitch();
    saveState();
  }

  function openDrawer() {
    el.drawer.classList.add('open');
    el.drawer.setAttribute('aria-hidden', 'false');
    el.scrim.hidden = false;
  }

  function closeDrawer() {
    el.drawer.classList.remove('open');
    el.drawer.setAttribute('aria-hidden', 'true');
    el.scrim.hidden = true;
  }

  /* ------------------------------------------------------------------ */
  /* 事件                                                               */
  /* ------------------------------------------------------------------ */

  function bindEvents() {
    el.input.addEventListener('input', function () {
      autosize();
      updateComposer();
    });

    el.input.addEventListener('keydown', function (event) {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        sendMessage();
      }
    });

    el.send.addEventListener('click', function () {
      if (state.streaming) stopStreaming();
      else sendMessage();
    });

    el.modelSwitch.addEventListener('click', function (event) {
      var button = event.target.closest('.seg');
      if (button) setModel(button.dataset.model);
    });

    el.themeToggle.addEventListener('click', cycleTheme);

    el.newChatTop.addEventListener('click', startNewChat);
    el.newChatDrawer.addEventListener('click', startNewChat);

    el.drawerOpen.addEventListener('click', openDrawer);
    el.drawerClose.addEventListener('click', closeDrawer);
    el.scrim.addEventListener('click', closeDrawer);

    el.openSettings.addEventListener('click', openSettings);
    el.settingsClose.addEventListener('click', closeSettings);
    el.saveSettings.addEventListener('click', saveSettings);
    el.clearAll.addEventListener('click', clearAllConversations);

    el.settingsPanel.addEventListener('click', function (event) {
      if (event.target === el.settingsPanel) closeSettings();
    });

    el.gateForm.addEventListener('submit', submitGate);

    el.messages.addEventListener('click', function (event) {
      var copyCode = event.target.closest('.copy-code');
      if (copyCode) {
        var pre = copyCode.closest('pre');
        var code = pre ? pre.querySelector('code') : null;
        copyText(code ? code.textContent : '');
        return;
      }

      var actionButton = event.target.closest('.msg-actions button');
      if (!actionButton) return;
      var row = actionButton.closest('.msg');
      var conv = getActiveConversation();
      if (!row || !conv) return;
      var message = null;
      for (var i = 0; i < conv.messages.length; i += 1) {
        if (conv.messages[i].id === row.dataset.id) {
          message = conv.messages[i];
          break;
        }
      }
      if (!message) return;
      if (actionButton.dataset.act === 'copy') copyText(message.content);
      if (actionButton.dataset.act === 'regen') regenerate(message.id);
    });

    document.addEventListener('keydown', function (event) {
      if (event.key !== 'Escape') return;
      if (!el.settingsPanel.hidden) closeSettings();
      else if (el.drawer.classList.contains('open')) closeDrawer();
    });

    if (window.matchMedia) {
      var media = window.matchMedia('(prefers-color-scheme: dark)');
      if (typeof media.addEventListener === 'function') {
        media.addEventListener('change', function () {
          if (state.settings.theme === 'auto') applyTheme();
        });
      }
    }
  }

  async function checkSession() {
    try {
      var response = await fetch('/api/session', { cache: 'no-store' });
      if (!response.ok) return;
      var data = await response.json();
      state.authRequired = Boolean(data.authRequired);
      state.authed = !data.authRequired || Boolean(data.authed);
      if (data.authRequired && !data.authed) showGate();
      else el.input.focus();
    } catch (error) {
      /* 离线时忽略，发送消息时会给出提示 */
    }
  }

  /* ------------------------------------------------------------------ */
  /* 启动                                                               */
  /* ------------------------------------------------------------------ */

  function init() {
    loadState();
    applyTheme();
    updateModelSwitch();
    renderDrawer();
    renderMessages();
    bindEvents();
    autosize();
    updateComposer();
    checkSession();
  }

  init();
})();
