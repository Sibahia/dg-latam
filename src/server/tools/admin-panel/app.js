const state = { snapshot: null, selectedToken: null, catalog: null };
const sliders = [
  ['damageMultiplier', 'Daño', '×', 0, 100, .25],
  ['playerSpeedMultiplier', 'Velocidad del jugador', '×', .25, 2.5, .05],
  ['gearDropMultiplier', 'Tasa de equipo', '×', 0, 100, .25],
  ['materialDropMultiplier', 'Tasa de material', '×', 0, 100, .25],
  ['goldMultiplier', 'Gold', '×', 0, 100, .25],
  ['xpMultiplier', 'XP', '×', 0, 100, .25]
];
const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function toast(message, error = false) {
  const el = $('toast');
  el.textContent = message;
  el.className = `toast show${error ? ' error' : ''}`;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.className = 'toast', 3200);
}
let accessToken = sessionStorage.getItem('admin_access') || '';
async function refreshAccessToken() {
  try {
    const response = await fetch('/api/admin/refresh', { method: 'POST' });
    if (!response.ok) return false;
    const data = await response.json().catch(() => ({}));
    if (!data.accessToken) return false;
    accessToken = data.accessToken;
    sessionStorage.setItem('admin_access', accessToken);
    return true;
  } catch (err) {
    return false;
  }
}
async function api(path, options = {}) {
  const doFetch = async () => {
    const headers = { 'content-type': 'application/json', ...(options.headers || {}) };
    if (accessToken) headers['authorization'] = 'Bearer ' + accessToken;
    return fetch(`/api/${path}`, { ...options, headers });
  };
  let response = await doFetch();
  if (response.status === 401 && (await refreshAccessToken())) {
    response = await doFetch();
  }
  const data = await response.json().catch(() => ({ error: 'Respuesta de servidor no válida' }));
  if (!response.ok) {
    if (response.status === 401) {
      sessionStorage.removeItem('admin_access');
      window.location.href = '/';
      return data;
    }
    throw new Error(data.error || `HTTP ${response.status}`);
  }
  return data;
}
function initSliders() {
  $('sliders').innerHTML = sliders.map(([id, label, unit, min, max, step]) =>
    `<label class="slider"><div class="slider-head"><span>${label}</span><output id="${id}Out">1${unit}</output></div><input id="${id}" type="range" min="${min}" max="${max}" step="${step}" value="1"></label>`
  ).join('');
  sliders.forEach(([id,, unit]) => $(id).addEventListener('input', () =>
    $(id + 'Out').textContent = `${Number($(id).value).toFixed(Number($(id).value) % 1 ? 2 : 0)}${unit}`
  ));
}
function render(snapshot) {
  state.snapshot = snapshot;
  if (state.selectedToken && !snapshot.players.some(p => p.token === state.selectedToken)) state.selectedToken = null;
  if (!state.selectedToken && snapshot.players.length) state.selectedToken = snapshot.players[0].token;
  $('liveDot').className = 'dot live';
  $('liveText').textContent = 'En vivo';
  $('lastUpdate').textContent = new Date(snapshot.generatedAt).toLocaleTimeString('es-ES');
  const metricIcons = [
    '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/>',
    '<path d="m3 6 9-4 9 4-9 4-9-4Z"/><path d="m3 12 9 4 9-4"/>',
    '<path d="M8 12h8M12 8v8"/><circle cx="12" cy="12" r="9"/>',
    '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'
  ];
  $('metrics').innerHTML = [
    ['Jugador en línea', snapshot.onlinePlayers, 'Sesiones activas'],
    ['Salas activas', snapshot.rooms.length, 'Instancias en vivo'],
    ['Conexiones', snapshot.connections, 'Sockets abiertos'],
    ['Tiempo del servidor', formatUptime(snapshot.uptimeSeconds), 'Sin interrupciones']
  ].map(([k, v, note], i) =>
    `<div class="metric"><div class="metric-top"><span>${k}</span><span class="metric-icon"><svg viewBox="0 0 24 24">${metricIcons[i]}</svg></span></div><b>${v}</b><span class="metric-foot"><i></i>${note}</span></div>`
  ).join('');
  $('playerCount').textContent = `${snapshot.players.length} en línea`;
  $('navPlayerCount').textContent = snapshot.players.length;
  $('players').className = 'player-list' + (snapshot.players.length ? '' : ' empty-state');
  $('players').innerHTML = snapshot.players.length
    ? snapshot.players.map(p =>
      `<button class="player ${p.token === state.selectedToken ? 'selected' : ''}" data-token="${p.token}"><span class="avatar">${esc(p.name.slice(0, 1).toUpperCase() || '?')}</span><span><b>${esc(p.name)}</b><small>${esc(p.level)} · Sala ${p.roomId}</small></span><span class="hp">${p.hp}/${p.maxHp} HP</span></button>`
    ).join('')
    : 'Esperando jugadores activos…';
  document.querySelectorAll('.player').forEach(el => el.onclick = () => { state.selectedToken = Number(el.dataset.token); render(snapshot); });
  $('roomCount').textContent = `${snapshot.rooms.length} salas`;
  $('rooms').className = 'room-list' + (snapshot.rooms.length ? '' : ' empty-state');
  $('rooms').innerHTML = snapshot.rooms.length
    ? snapshot.rooms.map(r =>
      `<div class="room"><div class="room-top"><span><b>${esc(r.level)}</b><small>Sala ${r.roomId}</small></span><span class="badge badge-outline">${r.players}P</span></div><div class="room-stats"><span>☠ ${r.hostiles} enemigos</span><span>◉ ${r.players} jugadores</span></div></div>`
    ).join('')
    : 'Esperando salas activas…';
  const target = snapshot.players.find(p => p.token === state.selectedToken);
  $('targetName').textContent = target ? target.name : 'Selecciona un jugador';
  $('targetLocation').textContent = target ? `${target.level} / ${target.roomId}` : '—';
  $('targetSummary').innerHTML = target
    ? `<div class="target-avatar">${esc(target.name.slice(0, 1).toUpperCase() || '?')}</div><div><strong>${esc(target.name)}</strong><span>${target.hp}/${target.maxHp} HP · ${esc(target.level)} · Sala ${target.roomId}</span></div>`
    : '<div class="target-avatar">?</div><div><strong>Ningún jugador seleccionado</strong><span>Selecciona un jugador de la lista para controlarlo.</span></div>';
  updateGrantPlayerSelect(snapshot);
  if (!document.activeElement?.matches('input[type="range"],input[type="checkbox"]')) syncSettings(snapshot.settings);
}
function syncSettings(s) {
  ['oneHitEnabled', 'godModeEnabled', 'freezeEnemies', 'allowPartyChangesInsideDungeons'].forEach(k => $(k).checked = Boolean(s[k]));
  sliders.forEach(([id,, unit]) => {
    $(id).value = s[id];
    $(id + 'Out').textContent = `${Number(s[id]).toFixed(Number(s[id]) % 1 ? 2 : 0)}${unit}`;
  });
}
function formatUptime(seconds) {
  const h = Math.floor(seconds / 3600), m = Math.floor(seconds % 3600 / 60);
  return h ? `${h}h ${m}m` : `${m} min`;
}
async function action(name, extra = {}) {
  const target = state.snapshot?.players.find(p => p.token === state.selectedToken);
  if (['kill-room', 'heal-player', 'kick-player'].includes(name) && !target) { toast('Primero selecciona un jugador.', true); return; }
  if (name === 'kick-player' && !confirm(`¿Desconectar a ${target.name}?`)) return;
  try {
    const result = await api('action', { method: 'POST', body: JSON.stringify({ action: name, token: target?.token, roomId: target?.roomId, ...extra }) });
    toast(name === 'kill-room' ? `${result.defeated} enemigos derrotados.` : 'Operación completada.');
  } catch (error) { toast(error.message, true); }
}
document.querySelectorAll('[data-action]').forEach(button => button.onclick = () => action(button.dataset.action));

function navigateTo(viewId) {
  const target = document.getElementById(viewId);
  if (!target?.classList.contains('view')) {
    if (target) {
      if ($('overview').hidden) {
        $('overview').hidden = false;
        $('grants-panel').hidden = true;
        document.querySelectorAll('.nav-item').forEach(n =>
          n.classList.toggle('active', n.getAttribute('href') === '#overview')
        );
      }
      requestAnimationFrame(() => target.scrollIntoView({ behavior: 'smooth', block: 'start' }));
    }
    return;
  }
  document.querySelectorAll('.view').forEach(v => v.hidden = v.id !== viewId);
  document.querySelectorAll('.nav-item').forEach(n => n.classList.toggle('active', n.getAttribute('href') === `#${viewId}`));
  if (viewId === 'grants-panel') loadCatalog();
}
document.querySelectorAll('.nav-item').forEach(item => item.onclick = e => {
  e.preventDefault();
  navigateTo(item.getAttribute('href').slice(1));
});
$('goToGrants').onclick = () => navigateTo('grants-panel');
$('refreshView').onclick = () => {
  if (state.snapshot) { render(state.snapshot); toast('Vista actualizada.'); }
  else toast('Esperando conexión en vivo del servidor.', true);
};

function updateGrantPlayerSelect(snapshot) {
  const select = $('grantPlayerSelect');
  const selectedValue = select.value;
  select.innerHTML = snapshot.players.length
    ? snapshot.players.map(p => `<option value="${p.token}">${esc(p.name)} · ${esc(p.className || '?')} · ${esc(p.level)} · Sala ${p.roomId}</option>`).join('')
    : '<option value="">Sin jugadores en línea</option>';
  if (state.selectedToken && snapshot.players.some(p => p.token === state.selectedToken)) select.value = String(state.selectedToken);
  else if (selectedValue && snapshot.players.some(p => p.token === Number(selectedValue))) select.value = selectedValue;
  updateGrantTargetInfo(snapshot);
  updateGearFilter(snapshot);
}
function currentGrantTarget() {
  const token = Number($('grantPlayerSelect').value);
  return state.snapshot?.players.find(p => p.token === token) ?? null;
}
function updateGrantTargetInfo(snapshot) {
  const target = snapshot.players.find(p => p.token === Number($('grantPlayerSelect').value));
  $('grantTargetInfo').textContent = target
    ? `Objetivo: ${target.name} (${target.className || '?'} · ${target.level}, sala ${target.roomId}, ${target.hp}/${target.maxHp} HP)`
    : 'Selecciona un jugador para comenzar.';
  if (target && !$('renameOldName').value) $('renameOldName').value = target.name;
}
function selectedGrantClass() {
  const target = state.snapshot?.players.find(p => p.token === Number($('grantPlayerSelect').value));
  return String(target?.className ?? '').trim().toLowerCase();
}
function updateGearFilter(snapshot) {
  const select = $('gearSelect');
  if (!select || !state.catalog) return;
  const previousValue = select.value;
  const className = selectedGrantClass();
  const gear = state.catalog.gear || [];
  const filtered = className
    ? gear.filter(g => String(g.usedBy || '').trim().toLowerCase() === className)
    : gear;
  const options = filtered.map(g => `<option value="${g.id}">#${g.id} — ${esc(g.displayName || g.name)}${g.rarity ? ` (${esc(g.rarity)})` : ''}</option>`).join('');
  select.innerHTML = options || '<option value="">—</option>';
  if (previousValue && [...select.options].some(option => option.value === previousValue)) {
    select.value = previousValue;
  }
}
$('grantPlayerSelect').onchange = () => {
  updateGrantTargetInfo(state.snapshot);
  updateGearFilter(state.snapshot);
};

async function loadCatalog() {
  if (state.catalog) { renderGrantsGrid(); return; }
  try {
    state.catalog = await api('catalog');
    renderGrantsGrid();
  } catch (error) { toast(error.message, true); }
}
function selectOptions(items, selected) {
  return items.map(item => `<option value="${item.id}">${esc(item.name)}${item.displayName ? ` — ${esc(item.displayName)}` : ''}</option>`).join('') || `<option value="">—</option>`;
}
function numberCard(icon, title, subtitle, kind, valueId, hint) {
  return `<div class="grant-card"><div class="grant-card-head"><span class="grant-icon">${icon}</span><span><b>${title}</b><small>${subtitle}</small></span></div>
    <div class="grant-controls"><input id="${valueId}" type="number" min="1" step="1" value="${hint}"><button class="button button-primary button-small" data-kind="${kind}">Otorgar</button></div>
    <p class="grant-hint">${hint}</p></div>`;
}
function renderGrantsGrid() {
  const catalog = state.catalog;
  if (!catalog) { $('grantsGrid').innerHTML = '<div class="empty-state">Cargando catálogo…</div>'; return; }
  const previousValues = {};
  ['mountSelect', 'petSelect', 'consumableSelect', 'gearSelect', 'consumableQuantity', 'gearTier',
    'goldAmount', 'xpAmount', 'coinsAmount', 'sigilsAmount', 'oreAmount', 'keysAmount', 'troveAmount'
  ].forEach(id => {
    const el = $(id);
    if (el) previousValues[id] = el.value;
  });
  const className = selectedGrantClass();
  const gearCatalog = (catalog.gear || []).filter(g => !className || String(g.usedBy || '').trim().toLowerCase() === className);
  const gearOptions = gearCatalog.map(g => `<option value="${g.id}">#${g.id} — ${esc(g.displayName || g.name)}${g.rarity ? ` (${esc(g.rarity)})` : ''}</option>`).join('');
  const mountsOptions = selectOptions(catalog.mounts || []);
  const petsOptions = selectOptions(catalog.pets || []);
  const consumablesOptions = selectOptions(catalog.consumables || []);
  $('grantsGrid').innerHTML = `
    <div class="grant-group"><h3>Monedas y Progreso</h3>
      <div class="grants-row">
        ${numberCard('<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M15 9a3 3 0 0 0-3-3 2 2 0 1 0 0 4 2 2 0 1 1 0 4 3 3 0 0 1-3-3M12 6v12"/></svg>', 'Gold', 'Moneda principal del juego', 'gold', 'goldAmount', 1000)}
        ${numberCard('<svg viewBox="0 0 24 24"><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1"/><circle cx="12" cy="12" r="4"/></svg>', 'XP', 'Experiencia (se aplican bonificaciones)', 'xp', 'xpAmount', 1000)}
        ${numberCard('<svg viewBox="0 0 24 24"><path d="M20 12v10H4V12M2 7h20v5H2zM12 22V7M12 7H7.5a2.5 2.5 0 0 1 0-5C11 2 12 7 12 7ZM12 7h4.5a2.5 2.5 0 0 0 0-5C13 2 12 7 12 7Z"/></svg>', 'Mammoth Coins', 'Moneda premium', 'mammothcoins', 'coinsAmount', 100)}
        ${numberCard('<svg viewBox="0 0 24 24"><path d="M6 3h12l-1.5 3H7.5L6 3ZM8 6h8l1 4H7l1-4ZM7 10h10v3H7v-3ZM9 13l1 8h4l1-8H9Z"/></svg>', 'Silver Sigils', 'Sigilos de plata para la tienda real', 'silversigils', 'sigilsAmount', 100)}
      </div>
    </div>
    <div class="grant-group"><h3>Recursos de Dragón</h3>
      <div class="grants-row">
        ${numberCard('<svg viewBox="0 0 24 24"><path d="M12 2a7 7 0 0 0-4 12.7V18h8v-3.3A7 7 0 0 0 12 2ZM9 21h6M10 6h.01M14 6h.01M11 9h2"/></svg>', 'Dragon Ore', 'Mena de dragón (se aplica al re-entrar)', 'dragonore', 'oreAmount', 100)}
        ${numberCard('<svg viewBox="0 0 24 24"><path d="M12 2v6M12 8l2.5-2.5M12 8L9.5 5.5M7 12h10M7 12l-3-3M17 12l3-3M8 15h8M8 15l-2 2M16 15l2 2M10 19h4"/></svg>', 'Dragon Keys', 'Llaves de dragón (se aplican al re-entrar)', 'dragonkeys', 'keysAmount', 10)}
        ${numberCard('<svg viewBox="0 0 24 24"><path d="M12 3a9 9 0 0 0-6 15.7V22h12v-3.3A9 9 0 0 0 12 3ZM9 21h6M12 7h.01M12 12h.01M12 17h.01M15 9l-6 6"/></svg>', 'Treasure Troves', 'Cofres de tesoro para abrir con llaves', 'trove', 'troveAmount', 10)}
      </div>
    </div>
    <div class="grant-group"><h3>Colección</h3>
      <div class="grants-row">
        <div class="grant-card"><div class="grant-card-head"><span class="grant-icon"><svg viewBox="0 0 24 24"><path d="M12 2s6 4 6 10a6 6 0 0 1-12 0c0-6 6-10 6-10Z"/><path d="M12 4v3M12 7l2-1M12 7l-2-1"/></svg></span><span><b>Monturas</b><small>Desbloquea una montura para el jugador</small></span></div>
          <div class="grant-controls"><select id="mountSelect">${mountsOptions}</select><button class="button button-primary button-small" data-kind="mount">Otorgar</button></div>
          <p class="grant-hint">Si el jugador ya la tiene, no se duplicará.</p></div>
        <div class="grant-card"><div class="grant-card-head"><span class="grant-icon"><svg viewBox="0 0 24 24"><path d="M12 4a5 5 0 0 1 5 5c0 2-1 3-1 3v5h-8v-5s-1-1-1-3a5 5 0 0 1 5-5ZM9 21h6"/></svg></span><span><b>Mascotas</b><small>Entrega una nueva mascota de nivel 1</small></span></div>
          <div class="grant-controls"><select id="petSelect">${petsOptions}</select><button class="button button-primary button-small" data-kind="pet">Otorgar</button></div>
          <p class="grant-hint">Cada entrega crea una mascota nueva con un ID único.</p></div>
      </div>
    </div>
    <div class="grant-group"><h3>Consumibles</h3>
      <div class="grants-row">
        <div class="grant-card"><div class="grant-card-head"><span class="grant-icon"><svg viewBox="0 0 24 24"><path d="M8 2h8l1 4H7l1-4ZM7 6h10l1 5H6l1-5ZM6 11h12v2H6v-2ZM9 13l1 9h4l1-9H9Z"/></svg></span><span><b>Consumibles</b><small>Pociones, catalizadores y potenciadores</small></span></div>
          <div class="grant-controls"><select id="consumableSelect">${consumablesOptions}</select><input id="consumableQuantity" type="number" min="1" step="1" value="5"><button class="button button-primary button-small" data-kind="consumable">Otorgar</button></div>
          <p class="grant-hint">La cantidad se suma al inventario existente.</p></div>
      </div>
    </div>
    <div class="grant-group"><h3>Equipo</h3>
      <div class="grants-row">
        <div class="grant-card"><div class="grant-card-head"><span class="grant-icon"><svg viewBox="0 0 24 24"><path d="M14.7 6.3a4.5 4.5 0 0 0-6 6L3 18l3 3 5.7-5.7a4.5 4.5 0 0 0 6-6L15 12l-3-3 2.7-2.7Z"/></svg></span><span><b>Equipo</b><small>Otorga un arma o armadura con rareza base</small></span></div>
          <div class="grant-controls"><select id="gearSelect">${gearOptions || '<option value="">—</option>'}</select><input id="gearTier" type="number" min="1" max="2" step="1" value="1"><button class="button button-primary button-small" data-kind="gear">Otorgar</button></div>
          <p class="grant-hint">Usa tier 1 o 2. No se duplica si ya la posee en ese tier.</p></div>
      </div>
    </div>`;
  document.querySelectorAll('#grantsGrid [data-kind]').forEach(button => button.onclick = () => submitGrant(button.dataset.kind));
  ['mountSelect', 'petSelect', 'consumableSelect', 'gearSelect', 'consumableQuantity', 'gearTier',
    'goldAmount', 'xpAmount', 'coinsAmount', 'sigilsAmount', 'oreAmount', 'keysAmount', 'troveAmount'
  ].forEach(id => {
    const el = $(id);
    const previous = previousValues[id];
    if (el && previous !== undefined) {
      if (el.tagName === 'SELECT' && [...el.options].some(option => option.value === previous)) {
        el.value = previous;
      } else if (el.tagName === 'INPUT') {
        el.value = previous;
      }
    }
  });
}
function submitGrant(kind) {
  const target = currentGrantTarget();
  if (!target) { toast('Primero selecciona un jugador en línea.', true); return; }
  const base = { kind, userId: target.userId, characterName: target.name };
  const payload = { ...base };
  switch (kind) {
    case 'gold': payload.amount = Math.max(1, Math.round(Number($('goldAmount').value) || 0)); break;
    case 'xp': payload.amount = Math.max(1, Math.round(Number($('xpAmount').value) || 0)); break;
    case 'mammothcoins': payload.amount = Math.max(1, Math.round(Number($('coinsAmount').value) || 0)); break;
    case 'silversigils': payload.amount = Math.max(1, Math.round(Number($('sigilsAmount').value) || 0)); break;
    case 'dragonore': payload.amount = Math.max(1, Math.round(Number($('oreAmount').value) || 0)); break;
    case 'dragonkeys': payload.amount = Math.max(1, Math.round(Number($('keysAmount').value) || 0)); break;
    case 'trove': payload.amount = Math.max(1, Math.round(Number($('troveAmount').value) || 0)); break;
    case 'mount': payload.mountId = Math.round(Number($('mountSelect').value)); break;
    case 'pet': payload.petTypeId = Math.round(Number($('petSelect').value)); break;
    case 'consumable':
      payload.consumableId = Math.round(Number($('consumableSelect').value));
      payload.quantity = Math.max(1, Math.round(Number($('consumableQuantity').value) || 1));
      break;
    case 'gear':
      payload.gearId = Math.round(Number($('gearSelect').value));
      if (!payload.gearId) { toast('Selecciona un equipo de la lista.', true); return; }
      payload.tier = Math.max(1, Math.min(2, Math.round(Number($('gearTier').value) || 1)));
      break;
    default: return;
  }
  api('grant', { method: 'POST', body: JSON.stringify(payload) }).then(
    result => toast(grantSuccessMessage(kind, target.name, payload, result)),
    error => toast(error.message, true)
  );
}
function grantSuccessMessage(kind, name, payload, result) {
  const fmt = (n) => Number(n ?? 0).toLocaleString('es-ES');
  switch (kind) {
    case 'gold': return `${name}: +${fmt(result.amount)} oro (${fmt(result.before)} → ${fmt(result.after)}).`;
    case 'xp': return `${name}: +${fmt(result.granted)} XP (${fmt(result.before)} → ${fmt(result.after)}).`;
    case 'mammothcoins': return `${name}: +${fmt(result.amount)} Mammoth Coins (${fmt(result.before)} → ${fmt(result.after)}).`;
    case 'silversigils': return `${name}: +${fmt(result.amount)} Silver Sigils (${fmt(result.before)} → ${fmt(result.after)}).`;
    case 'dragonore': return `${name}: +${fmt(result.amount)} Dragon Ore (${fmt(result.before)} → ${fmt(result.after)}).`;
    case 'dragonkeys': return `${name}: +${fmt(result.amount)} Dragon Keys (${fmt(result.before)} → ${fmt(result.after)}).`;
    case 'trove': return `${name}: +${fmt(result.amount)} Treasure Troves (${fmt(result.before)} → ${fmt(result.after)}).`;
    case 'mount': return `${name}: montura ${payload.mountId} otorgada.`;
    case 'pet': return `${name}: mascota ${payload.petTypeId} (id ${result.specialId}) otorgada.`;
    case 'consumable': return `${name}: +${payload.quantity}x consumible ${payload.consumableId}.`;
    case 'gear': return `${name}: equipo ${payload.gearId} tier ${payload.tier} otorgado.`;
    default: return 'Recompensa otorgada.';
  }
}

function submitRename() {
  const characterName = $('renameOldName').value.trim();
  const newName = $('renameNewName').value.trim();
  if (!characterName) { toast('Escribe el nombre actual del personaje.', true); return; }
  if (!newName) { toast('Escribe el nuevo nombre.', true); return; }
  if (newName.toLowerCase() === characterName.toLowerCase()) { toast('El nuevo nombre es igual al actual.', true); return; }
  const target = state.snapshot?.players.find(p => p.name === characterName);
  const payload = { characterName, newName };
  if (target) payload.userId = target.userId;
  api('rename', { method: 'POST', body: JSON.stringify(payload) }).then(
    result => {
      toast(`${characterName} renombrado a ${result.newName}.`);
      $('renameNewName').value = '';
      $('renameOldName').value = result.newName;
    },
    error => toast(error.message, true)
  );
}
$('renameSubmit').onclick = submitRename;
$('renameNewName').addEventListener('keydown', event => { if (event.key === 'Enter') submitRename(); });

$('saveSettings').onclick = async () => {
  const payload = {};
  ['oneHitEnabled', 'godModeEnabled', 'freezeEnemies', 'allowPartyChangesInsideDungeons'].forEach(k => payload[k] = $(k).checked);
  sliders.forEach(([id]) => payload[id] = Number($(id).value));
  try { await api('settings', { method: 'PATCH', body: JSON.stringify(payload) }); toast('Ajustes de runtime aplicados.'); }
  catch (error) { toast(error.message, true); }
};
$('resetSettings').onclick = async () => {
  try { const result = await api('reset', { method: 'POST', body: '{}' }); syncSettings(result.settings); toast('Ajustes restablecidos.'); }
  catch (error) { toast(error.message, true); }
};
$('announceForm').onsubmit = async event => {
  event.preventDefault();
  const message = $('announcement').value.trim();
  if (!message) return;
  await action('announce', { message });
  $('announcement').value = '';
};
initSliders();
const events = new EventSource('/events');
events.addEventListener('snapshot', event => {
  try { render(JSON.parse(event.data)); }
  catch (error) { toast(error.message, true); }
});
events.onerror = () => {
  $('liveDot').className = 'dot error';
  $('liveText').textContent = 'Conexión perdida';
  $('lastUpdate').textContent = 'Reintentando…';
};
