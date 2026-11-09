import { NetClient } from '../net/NetClient.ts';
import { isRoomCode, normalizeRoom } from '../net/protocol.ts';
import { toast } from './ControlsPanel.ts';

const NAME_KEY = 'grid.mp.name';
const COLOR_KEY = 'grid.mp.color';
const SERVER_KEY = 'grid.mp.server';
/** Tron palette: cyan/white first, amber accent, then the other neons. */
export const PLAYER_COLORS = ['#00eaff', '#ffb000', '#ff2bd6', '#3dff8b', '#ffffff', '#ff4a3d', '#8a7bff', '#ffe14d'];

const store = {
  get(k: string): string | null {
    try { return localStorage.getItem(k); } catch { return null; }
  },
  set(k: string, v: string): void {
    try { localStorage.setItem(k, v); } catch { /* private mode */ }
  },
};

/**
 * Grid Link: create or join a multiplayer room, copy the invite link, see who's on the Grid,
 * chat. Toggled by the ◈ button or O. In the hangar only the join / create controls show;
 * the roster and chat are for flight. `?room=CODE&server=ws://host:port` joins on load.
 */
export class MultiplayerPanel {
  readonly toggleBtn: HTMLButtonElement;
  readonly root: HTMLDivElement;
  private readonly body: HTMLDivElement;
  private readonly dot: HTMLSpanElement;

  constructor(private readonly net: NetClient, parent: HTMLElement = document.body) {
    this.toggleBtn = document.createElement('button');
    this.toggleBtn.id = 'mp-toggle';
    this.toggleBtn.className = 'panel';
    this.toggleBtn.type = 'button';
    this.toggleBtn.title = 'Multiplayer: Grid Link (O)';
    this.toggleBtn.setAttribute('aria-controls', 'mp-panel');
    this.toggleBtn.setAttribute('aria-expanded', 'false');
    this.dot = document.createElement('span');
    this.dot.className = 'mp-dot';
    this.toggleBtn.append(this.dot, document.createTextNode(' GRID LINK'));
    this.toggleBtn.addEventListener('click', () => { this.toggle(); this.toggleBtn.blur(); });

    this.root = document.createElement('div');
    this.root.id = 'mp-panel';
    this.root.className = 'panel hidden';
    this.root.setAttribute('role', 'dialog');
    this.root.setAttribute('aria-label', 'Multiplayer');
    this.body = document.createElement('div');
    this.root.append(this.body);
    parent.append(this.toggleBtn, this.root);

    window.addEventListener('keydown', (e) => {
      const el = e.target as HTMLElement | null;
      if (el && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable)) {
        if (e.code === 'Escape' && this.root.contains(el)) el.blur();
        return;
      }
      if (e.code === 'KeyO' && !e.repeat && !e.ctrlKey && !e.metaKey && !e.altKey) this.toggle();
    });

    net.onChange = () => this.render();
    net.onNotice = (n) => {
      if (n.kind === 'join') toast(`${n.name} entered the Grid`);
      else if (n.kind === 'leave') toast(`${n.name} derezzed from the Grid`);
      else if (n.kind === 'chat' && this.root.classList.contains('hidden')) toast(`${n.name}: ${n.text}`, 4000);
    };
    this.render();
  }

  private fallbackName = `Program-${Math.floor(1000 + Math.random() * 9000)}`;
  private fallbackColor = PLAYER_COLORS[Math.floor(Math.random() * 4)];

  get name(): string {
    return store.get(NAME_KEY) || this.fallbackName;
  }

  get color(): string {
    const c = store.get(COLOR_KEY);
    return c && PLAYER_COLORS.includes(c) ? c : this.fallbackColor;
  }

  /** Join from `?room=CODE&server=ws://…` if present. */
  autoJoin(params: URLSearchParams): void {
    const room = params.get('room');
    if (!room) return;
    const server = params.get('server') || store.get(SERVER_KEY) || NetClient.defaultServer();
    const code = normalizeRoom(room);
    if (!isRoomCode(code)) {
      toast(`"${room}" is not a room code (5 letters)`);
      return;
    }
    this.connect(server, code);
  }

  toggle(open = this.root.classList.contains('hidden')): void {
    this.root.classList.toggle('hidden', !open);
    this.toggleBtn.setAttribute('aria-expanded', String(open));
    if (open) this.render();
  }

  private connect(server: string, room: string): void {
    const name = this.name, color = this.color;
    store.set(NAME_KEY, name);
    store.set(COLOR_KEY, color);
    store.set(SERVER_KEY, server);
    this.net.connect({ server, room, name, color });
  }

  render(): void {
    const net = this.net;
    this.dot.dataset.status = net.status;
    this.toggleBtn.lastChild!.textContent = net.connected ? ` ${net.room} · ${net.players.size + 1}` : ' GRID LINK';
    if (this.root.classList.contains('hidden')) return;
    const b = this.body;
    // Keep a half-typed chat message (and its focus) across re-renders.
    const oldInput = b.querySelector<HTMLInputElement>('.mp-chat-input');
    const draft = oldInput?.value ?? '';
    const refocus = !!oldInput && document.activeElement === oldInput;
    b.replaceChildren();
    const head = el('div', 'mp-head');
    const h = el('h3', '', 'GRID LINK');
    const close = el('button', 'mp-close', '✕') as HTMLButtonElement;
    close.type = 'button';
    close.title = 'Close (O)';
    close.addEventListener('click', () => this.toggle(false));
    head.append(h, close);
    const status = el('div', `mp-status mp-${net.status}`, net.statusText);
    status.setAttribute('role', 'status');
    b.append(head, status);

    if (net.connected) {
      const room = el('div', 'mp-room');
      room.append(el('span', '', 'ROOM'), el('b', '', net.room));
      const actions = el('div', 'mp-actions');
      const copy = button('COPY INVITE', () => {
        const link = net.inviteLink();
        const done = () => toast('Invite link copied');
        navigator.clipboard?.writeText(link).then(done, () => prompt('Invite link', link));
        if (!navigator.clipboard) prompt('Invite link', link);
      });
      const leave = button('LEAVE', () => net.disconnect(), 'mp-leave');
      actions.append(copy, leave);
      b.append(room, actions);

      const online = el('div', 'mp-online-only');
      const list = el('ul', 'mp-players');
      list.append(playerRow(this.name, this.color, 'you'));
      for (const p of net.players.values()) list.append(playerRow(p.name, p.color, `${p.craft.name}${p.latest?.m === 'hangar' ? ' · hangar' : p.latest?.x ? ' · derezzed' : ''}`));
      online.append(el('h4', '', `ON THE GRID · ${net.players.size + 1}/16`), list);
      const log = el('div', 'mp-chat');
      for (const c of net.chat.slice(-8)) {
        const line = el('div', '');
        const who = el('b', '', `${c.name}: `);
        who.style.color = c.color;
        line.append(who, document.createTextNode(c.text));
        log.append(line);
      }
      const input = document.createElement('input');
      input.type = 'text';
      input.maxLength = 280;
      input.placeholder = 'Message (Enter)';
      input.setAttribute('aria-label', 'Chat message');
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          net.sendChat(input.value);
          input.value = '';
          this.render();
        }
      });
      input.className = 'mp-chat-input';
      input.value = draft;
      online.append(log, input);
      b.append(online);
      if (refocus) input.focus();
      return;
    }

    // Offline: identity, server, create / join.
    const nameIn = field(b, 'Name', 'text', this.name, (v) => store.set(NAME_KEY, v.trim().slice(0, 24) || this.name));
    nameIn.maxLength = 24;
    const colors = el('div', 'mp-colors');
    colors.setAttribute('role', 'radiogroup');
    colors.setAttribute('aria-label', 'Colour');
    const current = this.color;
    for (const c of PLAYER_COLORS) {
      const sw = el('button', 'mp-swatch') as HTMLButtonElement;
      sw.type = 'button';
      sw.style.setProperty('--c', c);
      sw.setAttribute('role', 'radio');
      sw.setAttribute('aria-checked', String(c === current));
      sw.setAttribute('aria-label', c);
      sw.addEventListener('click', () => { store.set(COLOR_KEY, c); this.render(); });
      colors.append(sw);
    }
    b.append(colors);
    const serverIn = field(b, 'Server', 'text', store.get(SERVER_KEY) || NetClient.defaultServer(), (v) => store.set(SERVER_KEY, v.trim()));
    const codeIn = field(b, 'Room code', 'text', '', () => {});
    codeIn.maxLength = 5;
    codeIn.placeholder = 'ABCDE';
    codeIn.autocapitalize = 'characters';
    codeIn.addEventListener('input', () => { codeIn.value = codeIn.value.toUpperCase().replace(/[^A-Z]/g, ''); });
    const actions = el('div', 'mp-actions');
    const join = button('JOIN', () => {
      const code = normalizeRoom(codeIn.value);
      if (!isRoomCode(code)) { toast('Room codes are 5 letters'); codeIn.focus(); return; }
      this.connect(serverIn.value.trim(), code);
    });
    const create = button('CREATE ROOM', () => this.connect(serverIn.value.trim(), ''), 'mp-primary');
    codeIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') join.click(); });
    actions.append(create, join);
    b.append(actions);
    b.append(el('p', 'muted small', 'Run the relay with npm run server (Bun). Up to 16 programs per room.'));
  }
}

function el(tag: string, cls: string, text?: string): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function button(text: string, onClick: () => void, cls = ''): HTMLButtonElement {
  const b = el('button', `mp-btn ${cls}`.trim(), text) as HTMLButtonElement;
  b.type = 'button';
  b.addEventListener('click', () => { onClick(); b.blur(); });
  return b;
}

function field(parent: HTMLElement, label: string, type: string, value: string, onChange: (v: string) => void): HTMLInputElement {
  const l = el('label', 'mp-field');
  l.append(el('span', '', label));
  const input = document.createElement('input');
  input.type = type;
  input.value = value;
  input.spellcheck = false;
  input.addEventListener('change', () => onChange(input.value));
  l.append(input);
  parent.append(l);
  return input;
}

function playerRow(name: string, color: string, detail: string): HTMLLIElement {
  const li = el('li', '') as HTMLLIElement;
  const dot = el('span', 'mp-pdot');
  dot.style.background = color;
  dot.style.boxShadow = `0 0 6px ${color}`;
  li.append(dot, el('b', '', name));
  if (detail) li.append(el('small', '', detail));
  return li;
}
