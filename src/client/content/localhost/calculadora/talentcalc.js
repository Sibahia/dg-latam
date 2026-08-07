(function () {
'use strict';

var DISC_ART = [
    'frostbringer', 'flameseer', 'necromancer',
    'viperblade', 'shadowstalker', 'soulthief',
    'sentinel', 'justicar', 'templar'
];

var DBCalc = {
    talents: [],
    skills: [],
    stats: [],
    socketed_stones: [],
    points_spent: 0,
    current_point: 0,
    undo: [],
    currentClassID: -1,
    currentDisciplineID: -1,
    currentClass: '',
    currentDiscipline: '',
    disciplines: [],
    classes: [],
    skill_slots: [],
    talent_slots: [],
    maxPoints: 90,
    hash: ''
};

function fetchJSON(url) {
    return fetch(url).then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
    });
}

function getOffset(el) {
    var rect = el.getBoundingClientRect();
    return {
        top: rect.top + window.pageYOffset,
        left: rect.left + window.pageXOffset
    };
}

function showTalent(el, icon) {
    if (!el || !icon) return;
    el.style.backgroundImage = 'url(icons/' + icon + '.png)';
    el.style.backgroundSize = '44px';
    el.style.backgroundPosition = 'center';
}

function formatStatValue(v) {
    var val_str = v.toFixed(2);
    var p;
    for (p = val_str.length - 1; p > 0; p--) {
        if (val_str.charAt(p) !== '0') break;
    }
    if (val_str.charAt(p) === '.') p--;
    return val_str.substr(0, p + 1);
}

/* ------------------------------------------------------------------ */
/*  Builders                                                           */
/* ------------------------------------------------------------------ */

function buildDisciplineNav() {
    var nav = document.querySelector('.dsc-nav');
    nav.innerHTML = '';
    for (var i = 0; i < DBCalc.disciplines.length; i++) {
        var cls = Math.floor(i / 3);
        var div = document.createElement('div');
        div.className = 'dsc-select dsc' + (i + 1);
        div.setAttribute('dsc_id', i);
        div.innerHTML = '<div class="dsc-tip">' + DBCalc.classes[cls] + '<br>' + DBCalc.disciplines[i] + '</div>';
        nav.appendChild(div);
    }
}

function createTalentTree() {
    var html = '';
    for (var i = 0; i < DBCalc.talent_slots.length; i++) {
        html += '<div class="talent-wrap-tree" id="tree_slot_wrap_' + i +
            '" style="left:' + (DBCalc.talent_slots[i].pos[0] - 20) + 'px; top:' +
            (DBCalc.talent_slots[i].pos[1] - 20) + 'px">';
        html += '<div class="talent-slot closed" id="tree_slot_' + i + '">';
        html += '<div class="talent-slot-label">' + DBCalc.talent_slots[i].capacity + '</div>';
        html += '<div class="talent socket"></div>';
        html += '<div class="talent-slot-level"></div>';
        html += '</div></div>';
    }
    for (var s = 0; s < DBCalc.skill_slots.length; s++) {
        html += '<div class="skill-slot" id="skill_slot_' + s +
            '" style="left:' + (DBCalc.skill_slots[s].pos[0] - 30) + 'px; top:' +
            (DBCalc.skill_slots[s].pos[1] - 30) + 'px">';
        html += '<div class="skill"></div>';
        if (s) html += '<div class="skill-lock"></div>';
        html += '</div>';
    }
    document.querySelector('.talent-tree').innerHTML = html;
}

function createTalentSelect() {
    var html = '';
    for (var i = 14; i > 0; i--) {
        html += '<div class="talent-tier">';
        for (var j = 0; j < 3; j++) {
            var slot_id = (i - 1) * 3 + j;
            html += '<div class="talent-tier-slot">';
            html += '<div class="talent-tier-bg" id="tier_slot_' + slot_id + '"></div>';
            html += '<div class="talent-wrap" id="talent_wrap_' + i + '_' + (j + 1) +
                '" tier="' + i + '" tier_pos="' + (j + 1) + '" talent_id="' + slot_id + '">';
            html += '<div id="tier_' + i + '_' + (j + 1) + '" class="talent"></div>';
            html += '<div class="talent-mask"></div>';
            html += '</div></div>';
        }
        html += '</div>';
    }
    document.querySelector('.talent-select-wrap').innerHTML = html;
}

function statIcon(si) {
    if (DBCalc.stats[si] && DBCalc.stats[si].icon) return DBCalc.stats[si].icon;
    for (var i = 0; i < DBCalc.talents.length; i++) {
        if (DBCalc.talents[i].stat === si) return DBCalc.talents[i].icon;
    }
    return null;
}

function createStatsSummary() {
    var html = '';
    for (var i = 0; i < DBCalc.stats.length; i++) {
        html += '<div class="build-stat">';
        html += '<div class="build-stat-icon-holder"><div class="talent build-stat-icon" id="stat_icon_' + i + '"></div></div>';
        html += '<div class="build-stat-value-holder"><div class="build-stat-value" id="stat_value_' + i + '">0</div></div>';
        html += '</div>';
    }
    document.querySelector('.tree-panel-right').innerHTML = html;
    for (var j = 0; j < DBCalc.stats.length; j++) {
        var icon = statIcon(j);
        if (icon) showTalent(document.getElementById('stat_icon_' + j), icon);
    }
    document.querySelectorAll('.build-stat-icon').forEach(function (el) {
        el.addEventListener('mouseenter', function () {
            var id = parseInt(this.id.split('_')[2], 10);
            showMainTooltip({ html: statTip(id), offset: getOffset(this), width: this.offsetWidth });
            highlightTreeSlots({ stat_id: id });
        });
        el.addEventListener('mouseleave', function () {
            hideMainTooltip();
            document.querySelectorAll('.talent-wrap-tree').forEach(function (e) { e.classList.remove('hover'); });
            document.querySelectorAll('.talent-wrap').forEach(function (e) { e.classList.remove('hover'); });
        });
    });
}

/* ------------------------------------------------------------------ */
/*  State                                                              */
/* ------------------------------------------------------------------ */

function resetTalents() {
    DBCalc.socketed_stones = [];
    DBCalc.points_spent = 0;
    DBCalc.current_point = 0;
    DBCalc.undo = [];
    document.querySelectorAll('.talent-wrap').forEach(function (el) {
        el.classList.remove('socketed');
        el.classList.remove('selected');
        el.querySelector('.talent').style.display = '';
    });
    document.querySelectorAll('.talent-wrap').forEach(function (el) {
        el.classList.remove('locked');
    });
    document.querySelectorAll('.talent-slot').forEach(function (el) {
        el.classList.add('closed');
    });
    document.querySelectorAll('.talent-slot-label').forEach(function (el) {
        el.classList.remove('unlocked');
    });
    document.querySelectorAll('.talent.socket').forEach(function (el) {
        el.style.display = 'none';
    });
    document.querySelectorAll('.talent-slot-level').forEach(function (el) {
        el.style.display = 'none';
    });
    document.querySelectorAll('.talent-wrap-tree').forEach(function (el) {
        el.classList.remove('hover');
    });
    unlockFirstSlots();
    updateBuildInfo();
}

function unlockFirstSlots() {
    document.getElementById('tree_slot_0').classList.remove('closed');
    document.getElementById('tree_slot_0').querySelector('.talent-slot-label').classList.add('unlocked');
    document.getElementById('tree_slot_1').classList.remove('closed');
    document.getElementById('tree_slot_1').querySelector('.talent-slot-label').classList.add('unlocked');
}

function skillPointsRequired(skill_id) {
    return Math.max(0, DBCalc.skill_slots[skill_id].pointsRequired - DBCalc.points_spent);
}

function isSkillLocked(skill_id) {
    if (skill_id) {
        var tree_slot_id = DBCalc.skill_slots[skill_id].connection;
        if (tree_slot_id !== -1 && !DBCalc.socketed_stones[tree_slot_id]) return true;
    }
    return false;
}

function skillSocketLock() {
    for (var skill_id = 1; skill_id < DBCalc.skill_slots.length; skill_id++) {
        var points_required = skillPointsRequired(skill_id);
        if (points_required > 0 || isSkillLocked(skill_id)) return DBCalc.skill_slots[skill_id].connection;
    }
    return 0;
}

function unlockSlotConnections(slot_id) {
    var skill_socket_lock = skillSocketLock();
    if (!DBCalc.talent_slots.hasOwnProperty(slot_id)) return;
    var conns = DBCalc.talent_slots[slot_id].connections || [];
    for (var sl = 0; sl < conns.length; sl++) {
        var id = conns[sl];
        if (!skill_socket_lock || id <= skill_socket_lock) {
            document.getElementById('tree_slot_' + id).classList.remove('closed');
            document.getElementById('tree_slot_' + id).querySelector('.talent-slot-label').classList.add('unlocked');
        }
    }
}

function unlockSkillSlotConnections() {
    for (var skill_id = 1; skill_id < DBCalc.skill_slots.length; skill_id++) {
        var points_required = skillPointsRequired(skill_id);
        if (points_required <= 0 && !isSkillLocked(skill_id)) {
            unlockSlotConnections(DBCalc.skill_slots[skill_id].connection);
        }
    }
}

function updateSocketsLock() {
    for (var i = 0; i < DBCalc.talent_slots.length; i++) DBCalc.talent_slots[i].locked = true;
    DBCalc.talent_slots[0].locked = false;
    DBCalc.talent_slots[1].locked = false;
    var skill_socket_lock = skillSocketLock();
    for (i = 0; i < DBCalc.talent_slots.length; i++) {
        if (DBCalc.socketed_stones.hasOwnProperty(i) && DBCalc.socketed_stones[i]) {
            DBCalc.talent_slots[i].locked = false;
            var conns = DBCalc.talent_slots[i].connections || [];
            for (var j = 0; j < conns.length; j++) {
                var id = conns[j];
                if (!skill_socket_lock || id <= skill_socket_lock) DBCalc.talent_slots[id].locked = false;
            }
        }
    }
    for (i = 0; i < DBCalc.talent_slots.length; i++) {
        var slot = document.getElementById('tree_slot_' + i);
        if (DBCalc.talent_slots[i].locked) {
            slot.classList.add('closed');
            slot.querySelector('.talent-slot-label').classList.remove('unlocked');
        } else {
            slot.classList.remove('closed');
            slot.querySelector('.talent-slot-label').classList.add('unlocked');
        }
    }
}

/* ------------------------------------------------------------------ */
/*  Actions                                                            */
/* ------------------------------------------------------------------ */

function socketStone(slot_id, tier, tier_pos, level) {
    var talent_id = (tier - 1) * 3 + tier_pos - 1;
    DBCalc.socketed_stones[slot_id] = {
        talent_level: level - 1,
        talent_id: talent_id,
        tier: tier,
        tier_pos: tier_pos
    };
    var talent_el = document.getElementById('tree_slot_' + slot_id).querySelector('.talent');
    showTalent(talent_el, DBCalc.talents[talent_id].icon);
    talent_el.style.display = 'block';
    document.getElementById('tree_slot_' + slot_id).querySelector('.talent-slot-level').textContent =
        level + '/' + DBCalc.talent_slots[slot_id].capacity;
    document.getElementById('tree_slot_' + slot_id).querySelector('.talent-slot-level').style.display = 'block';
    var wrap = document.getElementById('talent_wrap_' + tier + '_' + tier_pos);
    wrap.classList.remove('selected');
    wrap.classList.add('socketed');
    wrap.querySelector('.talent').style.display = 'none';
    unlockSlotConnections(slot_id);
    document.querySelector('.talent-tree-tip').innerHTML = talentTreeTip(slot_id);
    DBCalc.points_spent += level;
    DBCalc.current_point = DBCalc.points_spent;
    for (var l = 0; l < level; l++) DBCalc.undo.push(slot_id);
    updateBuildInfo();
    unlockSkillSlotConnections();
}

function talentTreeUndo() {
    if (!DBCalc.undo.length) return;
    var slot_id = DBCalc.undo.pop();
    DBCalc.socketed_stones[slot_id].talent_level--;
    DBCalc.points_spent--;
    DBCalc.current_point = DBCalc.points_spent;
    if (DBCalc.socketed_stones[slot_id].talent_level >= 0) {
        document.getElementById('tree_slot_' + slot_id).querySelector('.talent-slot-level').textContent =
            (DBCalc.socketed_stones[slot_id].talent_level + 1) + '/' + DBCalc.talent_slots[slot_id].capacity;
        document.getElementById('tree_slot_' + slot_id).querySelector('.talent-slot-level').style.display = 'block';
        document.querySelector('.talent-tree-tip').innerHTML = talentTreeTip(slot_id);
        updateSocketsLock();
    } else {
        var tier = DBCalc.socketed_stones[slot_id].tier;
        var tier_pos = DBCalc.socketed_stones[slot_id].tier_pos;
        DBCalc.socketed_stones[slot_id] = undefined;
        var wrap = document.getElementById('talent_wrap_' + tier + '_' + tier_pos);
        wrap.classList.remove('socketed');
        wrap.querySelector('.talent').style.display = '';
        document.getElementById('tree_slot_' + slot_id).querySelector('.talent-slot-level').style.display = 'none';
        document.getElementById('tree_slot_' + slot_id).querySelector('.talent').style.display = 'none';
        document.querySelector('.talent-tree-tip').innerHTML = talentTreeTip(slot_id);
        updateSocketsLock();
    }
    updateBuildInfo();
}

/* ------------------------------------------------------------------ */
/*  Skills and stats                                                   */
/* ------------------------------------------------------------------ */

function updateSkillSlot(slot_id) {
    var el = document.getElementById('skill_slot_' + slot_id);
    if (!el) return;
    var points_required = skillPointsRequired(slot_id);
    var lock = el.querySelector('.skill-lock');
    if (lock) lock.style.display = points_required > 0 ? '' : 'none';
    var bg_x = -65 * (slot_id + 3 * (DBCalc.currentDisciplineID % 3));
    var bg_y = -65 * 2 * DBCalc.currentClassID;
    if (points_required > 0 || isSkillLocked(slot_id)) bg_y -= 65;
    el.querySelector('.skill').style.backgroundPosition = bg_x + 'px ' + bg_y + 'px';
}

function updateBuildInfo() {
    var current_exp = Math.min(100.0, (DBCalc.points_spent / 70.0) * 100.0);
    document.querySelector('.talent-exp').style.height = current_exp + '%';
    document.querySelector('.talent-points-inactive').style.width =
        (DBCalc.points_spent * 5 + (DBCalc.points_spent ? 1 : 0)) + 'px';
    var current_point = DBCalc.points_spent ? DBCalc.current_point : 0;
    document.querySelector('.talent-points-trained').style.width =
        (current_point * 5 + (current_point ? 1 : 0)) + 'px';
    var current_tier = Math.floor(DBCalc.points_spent / 5);
    for (var i = 0; i < 14; i++) {
        for (var j = 0; j < 3; j++) {
            var w = document.getElementById('talent_wrap_' + (i + 1) + '_' + (j + 1));
            if (!w) continue;
            if (i <= current_tier) {
                w.classList.remove('locked');
                w.querySelector('.talent-mask').style.display = 'none';
            } else {
                w.classList.add('locked');
                w.querySelector('.talent-mask').style.display = 'block';
            }
        }
    }
    document.getElementById('link_button').href = encodeBuild();
    for (var s = 0; s < DBCalc.skill_slots.length; s++) updateSkillSlot(s);
    for (var k = 0; k < DBCalc.stats.length; k++) {
        var stat = DBCalc.stats[k];
        var val_prefix = stat.no_add ? '' : '+';
        if (typeof stat.parameter === 'object') {
            var val = [];
            for (var vv = 0; vv < stat.parameter.length; vv++) {
                val[vv] = 0;
                var is_percent = false;
                for (var tj = 0; tj < DBCalc.talents.length; tj++) {
                    if (DBCalc.talents[tj].stat === k) {
                        var v0 = DBCalc.talents[tj].values[vv][0];
                        if (v0.indexOf('%') !== -1) is_percent = true;
                        break;
                    }
                }
                for (var sj = 0; sj < DBCalc.talent_slots.length; sj++) {
                    if (DBCalc.socketed_stones[sj]) {
                        var talent_id = DBCalc.socketed_stones[sj].talent_id;
                        if (DBCalc.talents[talent_id].stat === k) {
                            var level = DBCalc.socketed_stones[sj].talent_level;
                            val[vv] += parseFloat(DBCalc.talents[talent_id].values[vv][level]);
                        }
                    }
                }
                val[vv] = val_prefix + formatStatValue(val[vv]) + (is_percent ? '%' : '');
            }
            document.getElementById('stat_value_' + k).textContent = val.join(' / ');
        } else {
            var val2 = 0;
            var is_percent2 = false;
            for (var tj2 = 0; tj2 < DBCalc.talents.length; tj2++) {
                if (DBCalc.talents[tj2].stat === k) {
                    var v1 = DBCalc.talents[tj2].values[0];
                    if (v1.indexOf('%') !== -1) is_percent2 = true;
                    break;
                }
            }
            for (var sj2 = 0; sj2 < DBCalc.talent_slots.length; sj2++) {
                if (DBCalc.socketed_stones[sj2]) {
                    var talent_id2 = DBCalc.socketed_stones[sj2].talent_id;
                    if (DBCalc.talents[talent_id2].stat === k) {
                        var level2 = DBCalc.socketed_stones[sj2].talent_level;
                        val2 += parseFloat(DBCalc.talents[talent_id2].values[level2]);
                    }
                }
            }
            document.getElementById('stat_value_' + k).textContent =
                val_prefix + formatStatValue(val2) + (is_percent2 ? '%' : '');
        }
    }
}

/* ------------------------------------------------------------------ */
/*  Discipline switching                                               */
/* ------------------------------------------------------------------ */

function switchDiscipline(discipline_id, slots) {
    var current_discipline = DBCalc.currentDisciplineID;
    document.querySelectorAll('.dsc-select').forEach(function (el) {
        el.classList.remove('selected');
        el.classList.remove('hover');
    });
    document.querySelector('.dsc' + (discipline_id + 1)).classList.add('selected');
    DBCalc.currentDisciplineID = discipline_id;
    DBCalc.currentClassID = Math.floor(DBCalc.currentDisciplineID / 3);
    DBCalc.currentClass = DBCalc.classes[DBCalc.currentClassID];
    DBCalc.currentDiscipline = DBCalc.disciplines[DBCalc.currentDisciplineID];
    if (current_discipline !== DBCalc.currentDisciplineID) {
        document.querySelector('.loading').style.display = 'block';
        fetchJSON('data/' + DBCalc.currentDiscipline.toLowerCase() + '.json').then(function (data) {
            document.querySelector('.loading').style.display = 'none';
            DBCalc.talents = data.talents || [];
            DBCalc.skills = data.skills || [];
            DBCalc.stats = data.stats || [];
            showTalents(200, 200, slots);
        });
    } else {
        showTalents(200, 200, slots);
    }
}

function showTalents(fade_out, fade_in, slots) {
    var treeContent = document.querySelector('.tree-content');
    treeContent.style.opacity = '0';
    window.setTimeout(function () {
        createStatsSummary();
        resetTalents();
        for (var i = 0; i < DBCalc.talents.length; i++) {
            var talent = DBCalc.talents[i];
            showTalent(document.getElementById('tier_' + talent.tier[0] + '_' + talent.tier[1]), talent.icon);
        }
        updateBuildInfo();
        document.querySelector('.discipline').className = 'discipline ' + DISC_ART[DBCalc.currentDisciplineID];
        if (slots) {
            for (var s = 0; s < slots.length; s++) {
                socketStone(slots[s].slot_id, slots[s].tier, slots[s].tier_pos, slots[s].level);
            }
            updateSocketsLock();
            DBCalc.undo = [];
        }
        treeContent.style.display = 'block';
        treeContent.style.opacity = '1';
        window.setTimeout(function () { treeContent.style.opacity = '1'; }, fade_in);
    }, fade_out);
}

/* ------------------------------------------------------------------ */
/*  Tooltips                                                           */
/* ------------------------------------------------------------------ */

function showMainTooltip(opts) {
    if (!opts.width) opts.width = 0;
    var tip = document.querySelector('.talent-tree-tip');
    tip.innerHTML = opts.html;
    tip.classList.remove('hidden');
    tip.style.display = 'block';
    tip.style.top = (opts.offset.top - 16) + 'px';
    tip.style.left = (opts.offset.left + opts.width + 8) + 'px';
}

function hideMainTooltip() {
    var tip = document.querySelector('.talent-tree-tip');
    tip.style.display = 'none';
    tip.classList.add('hidden');
}

function talentTooltip(talent, level) {
    var html = [];
    html.push('<div class="tip-name">' + talent.name + ' Talentstone</div>');
    html.push('<div class="tip-description">' + (talent.description || '') + '</div>');
    if (!level) level = 0;
    var val_prefix = talent.no_add ? '' : '+';
    if (typeof talent.parameter === 'object') {
        for (var p = 0; p < talent.parameter.length; p++) {
            var values_str = '<span class="tip-values">';
            for (var v = 0; v < talent.values[p].length; v++) {
                if (v === level) {
                    values_str += ' <span class="tip-parameter">[ ' + val_prefix + talent.values[p][v] + ' ]</span>';
                } else {
                    values_str += ' ' + val_prefix + talent.values[p][v];
                }
            }
            values_str += '</span>';
            html.push('<div class="tip-stats"><span class="tip-parameter">' + val_prefix + talent.parameter[p] + ':</span>' + values_str + '</div>');
        }
    } else {
        var values_str2 = '<span class="tip-values">';
        for (var v2 = 0; v2 < talent.values.length; v2++) {
            if (v2 === level) {
                values_str2 += ' <span class="tip-parameter">[ ' + val_prefix + talent.values[v2] + ' ]</span>';
            } else {
                values_str2 += ' ' + val_prefix + talent.values[v2];
            }
        }
        values_str2 += '</span>';
        html.push('<div class="tip-stats"><span class="tip-parameter">' + talent.parameter + ':</span>' + values_str2 + '</div>');
    }
    return html.join('\n');
}

function talentTreeTip(slot_id) {
    if (DBCalc.socketed_stones.hasOwnProperty(slot_id) && DBCalc.socketed_stones[slot_id]) {
        var talent = DBCalc.talents[DBCalc.socketed_stones[slot_id].talent_id];
        var level = DBCalc.socketed_stones[slot_id].talent_level;
        return talentTooltip(talent, level);
    }
    if (document.getElementById('tree_slot_' + slot_id).classList.contains('closed')) {
        return '<div class="tip-name">Locked Socket</div><div class="tip-description">Requires a connecting socket to be filled</div>';
    }
    return '<div class="tip-name">Empty Socket</div><div class="tip-description">Select a Talentstone to put here</div>';
}

function talentExpTip() {
    var html = [];
    var level = Math.max(10, Math.min(50, DBCalc.points_spent + 10 - 1));
    var totem_level = Math.max(1, Math.ceil((DBCalc.points_spent - 40) / 5));
    html.push('<div class="tip-description" style="margin-top:0px">Points Spent: <span class="tip-name">' + DBCalc.points_spent + ' / ' + DBCalc.maxPoints + '</span>');
    html.push('<div class="tip-description">Required Level: <span class="tip-name">' + level + '</span>');
    html.push('<div class="tip-description">Required Totem Level: <span class="tip-name">' + totem_level + '</span>');
    return html.join('\n');
}

function skillSlotTip(slot_id) {
    var html = [];
    var skill = DBCalc.skills[slot_id] || { name: '', description: '' };
    html.push('<div class="tip-name">' + skill.name + '</div>');
    html.push('<div class="tip-description">' + (skill.description || '') + '</div>');
    var points_required = skillPointsRequired(slot_id);
    if (points_required > 0) {
        html.push('<div class="tip-error">Requires ' + points_required + ' more talent points.</div>');
    } else if (isSkillLocked(slot_id)) {
        html.push('<div class="tip-error">Requires a connecting slot to be filled.</div>');
    }
    return html.join('\n');
}

function statTip(stat_id) {
    var stat = DBCalc.stats[stat_id];
    var html = [];
    html.push('<div class="tip-name">' + stat.name + ' Talentstone</div>');
    html.push('<div class="tip-description">' + (stat.description || '') + '</div>');
    if (typeof stat.parameter === 'object') {
        html.push('<div class="tip-stats tip-parameter">' + stat.parameter.join(' / ') + ': ' + document.getElementById('stat_value_' + stat_id).textContent + '</div>');
    } else {
        html.push('<div class="tip-stats tip-parameter">' + stat.parameter + ': ' + document.getElementById('stat_value_' + stat_id).textContent + '</div>');
    }
    return html.join('\n');
}

function highlightTreeSlots(opts) {
    if (opts.hasOwnProperty('talent_id')) {
        for (var i = 0; i < DBCalc.talent_slots.length; i++) {
            if (DBCalc.socketed_stones[i] && DBCalc.socketed_stones[i].talent_id === opts.talent_id) {
                document.getElementById('tree_slot_wrap_' + i).classList.add('hover');
            }
        }
    }
    if (opts.hasOwnProperty('stat_id')) {
        for (var s = 0; s < DBCalc.talent_slots.length; s++) {
            if (DBCalc.socketed_stones[s] && DBCalc.talents[DBCalc.socketed_stones[s].talent_id].stat === opts.stat_id) {
                document.getElementById('tree_slot_wrap_' + s).classList.add('hover');
            }
        }
        for (var t = 0; t < DBCalc.talents.length; t++) {
            if (DBCalc.talents[t].stat === opts.stat_id) {
                var w = document.getElementById('talent_wrap_' + DBCalc.talents[t].tier[0] + '_' + DBCalc.talents[t].tier[1]);
                if (w && !w.classList.contains('socketed') && !w.classList.contains('selected')) {
                    w.classList.add('hover');
                }
            }
        }
    }
}

/* ------------------------------------------------------------------ */
/*  Build links                                                        */
/* ------------------------------------------------------------------ */

function getBuildEncodeString() {
    var ret = '';
    for (var i = '1'.charCodeAt(0); i <= '9'.charCodeAt(0); i++) ret += String.fromCharCode(i);
    for (var a = 'a'.charCodeAt(0); a <= 'z'.charCodeAt(0); a++) ret += String.fromCharCode(a);
    for (var b = 'A'.charCodeAt(0); b <= 'Z'.charCodeAt(0); b++) ret += String.fromCharCode(b);
    return ret;
}

function encodeBuild() {
    var build_str = '#' + DBCalc.currentDisciplineID;
    var encode_str = getBuildEncodeString();
    for (var i = 0; i < DBCalc.talent_slots.length; i++) {
        var code;
        if (DBCalc.socketed_stones.hasOwnProperty(i) && DBCalc.socketed_stones[i]) {
            var talent_id = DBCalc.socketed_stones[i].talent_id;
            var level = DBCalc.socketed_stones[i].talent_level + 1;
            code = '' + level + encode_str.charAt(talent_id);
        } else {
            code = '0';
        }
        build_str += code;
    }
    for (i = build_str.length - 1; i > 1; i--) {
        if (build_str.charAt(i) !== '0') break;
    }
    return build_str.substr(0, i + 1);
}

function decodeBuild(build_str) {
    var discipline_id = parseInt(build_str.charAt(1), 10);
    if (isNaN(discipline_id)) discipline_id = 0;
    if (discipline_id < 0) discipline_id = 0;
    if (discipline_id > DBCalc.disciplines.length - 1) discipline_id = DBCalc.disciplines.length - 1;
    var slots = [];
    var slot_id = 0;
    var encode_str = getBuildEncodeString();
    for (var i = 2; i < build_str.length; i++) {
        var level = parseInt(build_str.charAt(i), 10);
        if (level) {
            i++;
            var talent_id = encode_str.indexOf(build_str.charAt(i));
            var tier = Math.floor(talent_id / 3) + 1;
            var tier_pos = (talent_id % 3) + 1;
            slots.push({ slot_id: slot_id, level: level, talent_id: talent_id, tier: tier, tier_pos: tier_pos });
        }
        slot_id++;
    }
    return { discipline_id: discipline_id, slots: slots };
}

function hashChangeEventHandler() {
    var h = location.hash;
    if (h !== DBCalc.hash) {
        DBCalc.hash = h;
        if (h && h.length > 1) {
            var build = decodeBuild(h);
            if (build) switchDiscipline(build.discipline_id, build.slots);
        }
    }
    window.setTimeout(hashChangeEventHandler, 300);
}

/* ------------------------------------------------------------------ */
/*  Handlers                                                           */
/* ------------------------------------------------------------------ */

function setTalentTreeHandlers() {
    document.querySelectorAll('.talent-slot').forEach(function (slot) {
        slot.addEventListener('click', function () {
            var id = parseInt(this.id.split('_')[2], 10);
            if (this.classList.contains('closed')) return;
            if (!DBCalc.socketed_stones.hasOwnProperty(id) || !DBCalc.socketed_stones[id]) {
                var selected = document.querySelector('.talent-wrap.selected');
                if (selected) {
                    var tier = parseInt(selected.getAttribute('tier'), 10);
                    var tier_pos = parseInt(selected.getAttribute('tier_pos'), 10);
                    socketStone(id, tier, tier_pos, 1);
                    selected.classList.remove('selected');
                    selected.classList.add('socketed');
                    selected.querySelector('.talent').style.display = 'none';
                }
            } else {
                if (DBCalc.socketed_stones[id].talent_level < DBCalc.talent_slots[id].capacity - 1) {
                    DBCalc.socketed_stones[id].talent_level++;
                    DBCalc.points_spent++;
                    DBCalc.current_point = DBCalc.points_spent;
                    DBCalc.undo.push(id);
                    updateBuildInfo();
                    document.getElementById('tree_slot_' + id).querySelector('.talent-slot-level').textContent =
                        (DBCalc.socketed_stones[id].talent_level + 1) + '/' + DBCalc.talent_slots[id].capacity;
                    document.getElementById('tree_slot_' + id).querySelector('.talent-slot-level').style.display = 'block';
                    document.querySelector('.talent-tree-tip').innerHTML = talentTreeTip(id);
                    unlockSkillSlotConnections();
                }
            }
        });
        slot.addEventListener('mouseenter', function () {
            var id = parseInt(this.id.split('_')[2], 10);
            showMainTooltip({ html: talentTreeTip(id), offset: getOffset(this), width: this.offsetWidth });
            if (DBCalc.socketed_stones[id]) {
                document.getElementById('tier_slot_' + DBCalc.socketed_stones[id].talent_id).classList.add('highlited');
                document.getElementById('tree_slot_wrap_' + id).classList.add('hover');
            }
        });
        slot.addEventListener('mouseleave', function () {
            hideMainTooltip();
            document.querySelectorAll('.talent-tier-bg').forEach(function (el) { el.classList.remove('highlited'); });
            document.querySelectorAll('.talent-wrap-tree').forEach(function (el) { el.classList.remove('hover'); });
        });
    });

    document.querySelectorAll('.skill-slot').forEach(function (slot) {
        slot.addEventListener('mouseenter', function () {
            var id = parseInt(this.id.split('_')[2], 10);
            showMainTooltip({ html: skillSlotTip(id), offset: getOffset(this), width: this.offsetWidth });
        });
        slot.addEventListener('mouseleave', hideMainTooltip);
    });
}

function setTalentSelectHandlers() {
    document.querySelectorAll('.talent-wrap').forEach(function (wrap) {
        wrap.addEventListener('mouseenter', function () {
            var talent_id = parseInt(this.getAttribute('talent_id'), 10);
            if (this.classList.contains('socketed')) {
                highlightTreeSlots({ talent_id: talent_id });
                document.getElementById('tier_slot_' + talent_id).classList.add('highlited');
                return;
            }
            if (!this.classList.contains('selected')) this.classList.add('hover');
            showMainTooltip({ html: talentTooltip(DBCalc.talents[talent_id], 0), offset: getOffset(this), width: this.offsetWidth });
        });
        wrap.addEventListener('mouseleave', function () {
            this.classList.remove('hover');
            hideMainTooltip();
            document.querySelectorAll('.talent-wrap-tree').forEach(function (el) { el.classList.remove('hover'); });
            document.querySelectorAll('.talent-tier-bg').forEach(function (el) { el.classList.remove('highlited'); });
        });
        wrap.addEventListener('click', function () {
            if (!this.classList.contains('selected') && !this.classList.contains('socketed') && !this.classList.contains('locked')) {
                document.querySelectorAll('.talent-wrap').forEach(function (el) { el.classList.remove('selected'); });
                this.classList.add('selected');
            } else {
                this.classList.remove('selected');
            }
        });
    });
}

function setDisciplineNavHandlers() {
    document.querySelectorAll('.dsc-select').forEach(function (sel) {
        sel.addEventListener('mouseenter', function () {
            if (!this.classList.contains('selected') && !this.classList.contains('locked')) this.classList.add('hover');
            var tip = this.querySelector('.dsc-tip');
            tip.classList.add('visible');
            tip.style.display = 'block';
        });
        sel.addEventListener('mouseleave', function () {
            this.classList.remove('hover');
            var tip = this.querySelector('.dsc-tip');
            tip.classList.remove('visible');
            tip.style.display = 'none';
        });
        sel.addEventListener('click', function () {
            if (!this.classList.contains('selected') && !this.classList.contains('locked')) {
                var discipline_id = parseInt(this.getAttribute('dsc_id'), 10);
                switchDiscipline(discipline_id);
            }
        });
    });
}

function bindMiscHandlers() {
    document.querySelectorAll('.buttons').forEach(function (el) {
        el.addEventListener('mouseenter', function () { this.classList.add('hover'); });
        el.addEventListener('mouseleave', function () { this.classList.remove('hover'); });
    });
    document.getElementById('reset_button').addEventListener('click', function (event) {
        event.preventDefault();
        resetTalents();
    });
    document.getElementById('undo_button').addEventListener('click', function (event) {
        event.preventDefault();
        talentTreeUndo();
    });
    document.querySelector('.talent-exp-holder').addEventListener('mouseenter', function (ev) {
        showMainTooltip({ html: talentExpTip(), offset: { top: ev.pageY, left: ev.pageX + 8 } });
    });
    document.querySelector('.talent-exp-holder').addEventListener('mouseleave', hideMainTooltip);
    document.querySelector('.talent-points-wrap').addEventListener('mouseenter', function (ev) {
        showMainTooltip({ html: talentExpTip(), offset: { top: ev.pageY + 16, left: ev.pageX + 8 } });
    });
    document.querySelector('.talent-points-wrap').addEventListener('mouseleave', hideMainTooltip);
}

/* ------------------------------------------------------------------ */
/*  Init                                                               */
/* ------------------------------------------------------------------ */

function init() {
    fetchJSON('data/tree.json').then(function (tree) {
        DBCalc.disciplines = tree.disciplines;
        DBCalc.classes = tree.classes;
        DBCalc.skill_slots = tree.skillSlots;
        DBCalc.talent_slots = tree.talentSlots;
        DBCalc.maxPoints = tree.maxPoints;
        buildDisciplineNav();
        createTalentTree();
        createTalentSelect();
        setDisciplineNavHandlers();
        setTalentSelectHandlers();
        setTalentTreeHandlers();
        bindMiscHandlers();
        unlockFirstSlots();
        var h = location.hash;
        DBCalc.hash = h;
        if (h && h.length > 1) {
            var build = decodeBuild(h);
            if (build) switchDiscipline(build.discipline_id, build.slots);
            else switchDiscipline(4);
        } else {
            switchDiscipline(4);
        }
        hashChangeEventHandler();
    }).catch(function (err) {
        var tip = document.querySelector('.talent-tree-tip');
        tip.innerHTML = '<div class="tip-name">Failed to load calculator data</div><div class="tip-error">' + err.message + '</div>';
        tip.style.display = 'block';
    });
}

document.addEventListener('DOMContentLoaded', init);
})();
