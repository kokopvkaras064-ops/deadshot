'use strict';
// Deadshot.io Tournament Platform — frontend logic (talks to the Node backend)

let currentUser = null;   // { id, username, isHost, hostType, permLevel }
let teamsList = [];
let roundsData = [];
let usersList = [];

let currentAuthMode = 'login';
let activeTab = 'dashboard';
let activeHostSubTab = 'teams';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------------------------------------------------------------- API client
async function api(method, url, body) {
    const res = await fetch(url, {
        method,
        headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
        credentials: 'same-origin',
        body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
        if (res.status === 401 && currentUser) {
            currentUser = null;
            enforceAuthWall();
        }
        showToast(data.error || 'حدث خطأ غير متوقع', 'error');
        return null;
    }
    return data;
}

// Audio notification trigger using Web Audio API synthesized alert beep
function playAlertSound() {
    try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(880, ctx.currentTime);
        gain.gain.setValueAtTime(0.15, ctx.currentTime);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start();
        osc.stop(ctx.currentTime + 0.3);
    } catch (e) {
        console.log('Audio Context restricted');
    }
}

window.onload = async function () {
    await loadState();
    enforceAuthWall();
};

async function loadState() {
    const st = await api('GET', '/api/state');
    if (!st) return;
    currentUser = st.user;
    teamsList = st.teams || [];
    roundsData = st.rounds || [];
    if (currentUser && currentUser.isHost) {
        const us = await api('GET', '/api/users');
        if (us) usersList = us.users;
    } else {
        usersList = [];
    }
}

// Enforce Login Wall Screen Visibility
function enforceAuthWall() {
    const loginWall = document.getElementById('login-wall-screen');
    const mainApp = document.getElementById('main-app-wrapper');

    if (!currentUser) {
        loginWall.classList.remove('hidden');
        mainApp.classList.add('hidden');
    } else {
        loginWall.classList.add('hidden');
        mainApp.classList.remove('hidden');
        refreshAppViews();
    }
}

function setAuthMode(mode) {
    currentAuthMode = mode;
    updateAuthModalUI();
}

function updateAuthModalUI() {
    const sub = document.getElementById('modal-subtitle');
    const submitBtn = document.getElementById('auth-submit-btn');
    const loginTab = document.getElementById('auth-tab-login');
    const registerTab = document.getElementById('auth-tab-register');

    if (currentAuthMode === 'login') {
        sub.textContent = 'منصة إدارة البطولات - يرجى تسجيل الدخول للوصول';
        submitBtn.textContent = 'تسجيل الدخول';
        loginTab.classList.add('active');
        registerTab.classList.remove('active');
    } else {
        sub.textContent = 'إنشاء حساب جديد للوصول لمباريات وبطولات Deadshot.io';
        submitBtn.textContent = 'إنشاء الحساب الآن';
        registerTab.classList.add('active');
        loginTab.classList.remove('active');
    }
}

async function handleAuthSubmit(event) {
    event.preventDefault();
    const username = document.getElementById('auth-username').value.trim();
    const password = document.getElementById('auth-password').value.trim();

    if (!username || !password) {
        showToast('يرجى ملء جميع الحقول المطلوبة', 'error');
        return;
    }

    if (currentAuthMode === 'register') {
        const data = await api('POST', '/api/register', { username, password });
        if (!data) return;
        showToast(username.toLowerCase().endsWith('.host') ? 'تم إنشاء حساب منظم بنجاح!' : 'تم إنشاء الحساب بنجاح!', 'success');
    } else {
        const data = await api('POST', '/api/login', { username, password });
        if (!data) return;
        showToast(`أهلاً بك مجدداً, ${data.user.username}!`, 'success');
    }
    document.getElementById('auth-username').value = '';
    document.getElementById('auth-password').value = '';
    await loadState();
    enforceAuthWall();
}

async function logout() {
    await api('POST', '/api/logout');
    currentUser = null;
    teamsList = [];
    roundsData = [];
    usersList = [];
    switchTab('dashboard');
    document.getElementById('login-wall-screen').classList.remove('hidden');
    document.getElementById('main-app-wrapper').classList.add('hidden');
    showToast('تم تسجيل الخروج بنجاح', 'info');
}

async function refreshAppViews() {
    await loadState();
    if (!currentUser) { enforceAuthWall(); return; }
    renderUserStatusBar();
    renderDashboard();
    renderRoundsView();
    renderProfileTab();
    renderHostPanel();
    if (activeTab === 'host') switchTab('host');
}

// Render Top User Info Bar
function renderUserStatusBar() {
    const container = document.getElementById('user-status-bar');
    const navHostBtn = document.getElementById('nav-host');

    if (currentUser) {
        const isPrimary = currentUser.hostType === 'primary';
        const isHost = currentUser.isHost;

        if (isHost) {
            navHostBtn.classList.remove('hidden');
            document.getElementById('host-tab-badge').textContent = isPrimary ? 'PRIMARY' : 'HOST';
        } else {
            navHostBtn.classList.add('hidden');
        }

        container.innerHTML = `
            <div class="flex items-center gap-3">
                <div class="text-left hidden sm:block">
                    <div class="text-xs font-black text-white flex items-center gap-1 justify-end">
                        ${esc(currentUser.username)}
                        ${isPrimary ? '👑' : isHost ? '🛡️' : ''}
                    </div>
                    <div class="text-[10px] text-cyan-400 font-mono">${isPrimary ? 'Primary Host' : isHost ? 'Secondary Host' : 'لاعب معتمد'}</div>
                </div>
                <button onclick="logout()" class="px-3.5 py-1.5 bg-red-600/20 hover:bg-red-600/40 text-red-400 border border-red-500/30 rounded-xl text-xs font-bold transition">
                    خروج
                </button>
            </div>
        `;
    }
}

// Primary / Secondary Host Permission Checks (UI only — the server enforces these too)
function canManageTeams() {
    if (!currentUser) return false;
    if (currentUser.hostType === 'primary') return true;
    if (!currentUser.isHost) return false;
    const lvl = currentUser.permLevel || 'full';
    return (lvl === 'full' || lvl === 'teams_only');
}

function canManageSchedule() {
    if (!currentUser) return false;
    if (currentUser.hostType === 'primary') return true;
    if (!currentUser.isHost) return false;
    const lvl = currentUser.permLevel || 'full';
    return (lvl === 'full' || lvl === 'schedule_only');
}

// Navigation Switcher
function switchTab(tabName) {
    activeTab = tabName;
    document.querySelectorAll('.tab-content').forEach(el => el.classList.add('hidden'));
    document.querySelectorAll('.nav-btn').forEach(el => el.classList.remove('active'));

    const target = document.getElementById(`tab-${tabName}`);
    if (target) target.classList.remove('hidden');

    const btn = document.getElementById(`nav-${tabName}`);
    if (btn) btn.classList.add('active');

    if (tabName === 'host') {
        const isHost = currentUser && currentUser.isHost;
        const isPrimary = currentUser && currentUser.hostType === 'primary';

        const allowed = document.getElementById('host-allowed-view');
        const denied = document.getElementById('host-denied-view');

        if (!currentUser || !isHost) {
            allowed.classList.add('hidden');
            denied.classList.remove('hidden');
        } else {
            allowed.classList.remove('hidden');
            denied.classList.add('hidden');

            const pill = document.getElementById('host-role-pill');
            const permBtn = document.getElementById('subnav-permissions');
            const notice = document.getElementById('secondary-perm-notice');

            if (isPrimary) {
                pill.textContent = 'الهوست الرئيسي (Primary Host)';
                pill.className = 'px-3 py-1 rounded-full text-xs font-black bg-amber-500/20 text-amber-300 border border-amber-500/50';
                permBtn.classList.remove('hidden');
                notice.textContent = 'تحكم كامل في جميع الجداول والفرق وإدارة صلاحيات الهوستات الفرعية.';
            } else {
                pill.textContent = 'هوست فرعي (Secondary Host)';
                pill.className = 'px-3 py-1 rounded-full text-xs font-black bg-purple-500/20 text-purple-300 border border-purple-500/50';
                permBtn.classList.add('hidden');

                const lvl = currentUser.permLevel || 'full';
                const permDesc = {
                    full: 'صلاحيات كاملة للجداول والفرق',
                    schedule_only: 'صلاحيات المواعيد والجداول فقط (ممنوع تعديل الفرق)',
                    teams_only: 'صلاحيات الفرق واللاعبين فقط (ممنوع تعديل المواعيد)',
                    readonly: 'وضع العرض فقط (بدون أي صلاحيات تعديل)'
                };
                notice.textContent = `مستوى صلاحيتك: ${permDesc[lvl] || permDesc.full}`;

                if (activeHostSubTab === 'permissions') switchHostSubTab('teams');
            }
        }
    }
}

// Host Sub-Tab Switcher
function switchHostSubTab(sub) {
    const isPrimary = currentUser && currentUser.hostType === 'primary';
    if (sub === 'permissions' && !isPrimary) {
        showToast('هذه اللوحة مخصصة للهوست الرئيسي فقط!', 'error');
        return;
    }

    activeHostSubTab = sub;
    document.querySelectorAll('.host-sub-content').forEach(el => el.classList.add('hidden'));
    document.querySelectorAll('.subnav-btn').forEach(el => {
        el.classList.remove('bg-amber-500', 'text-gray-950');
        el.classList.add('text-gray-400');
    });

    document.getElementById(`host-sub-${sub}`).classList.remove('hidden');
    const btn = document.getElementById(`subnav-${sub}`);
    if (btn) {
        btn.classList.add('bg-amber-500', 'text-gray-950');
        btn.classList.remove('text-gray-400');
    }
}

// Render Dashboard Tab
function renderDashboard() {
    const myTeamContainer = document.getElementById('my-team-card-container');
    let userTeam = null;

    if (currentUser) {
        userTeam = teamsList.find(t => t.members.includes(currentUser.username));
    }

    const sorted = [...teamsList].sort((a, b) => b.points - a.points);

    if (userTeam) {
        const rank = sorted.findIndex(t => t.id === userTeam.id) + 1;
        myTeamContainer.innerHTML = `
            <div class="glass-panel p-6 rounded-3xl border-red-500/30 bg-gradient-to-r from-red-950/30 via-darkcard to-gray-900 relative overflow-hidden">
                <div class="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
                    <div class="space-y-1">
                        <div class="flex items-center gap-2">
                            <span class="text-xs bg-red-500/20 text-red-400 border border-red-500/40 px-2.5 py-0.5 rounded-md font-mono">فريقك الحالي</span>
                            <span class="text-xs text-gray-400">الترتيب عالمياً: <strong class="text-amber-400">#${rank}</strong></span>
                        </div>
                        <h2 class="text-3xl font-black text-white">${esc(userTeam.name)}</h2>
                        <p class="text-xs text-gray-400">أعضاء الفريق: ${userTeam.members.map(esc).join(', ')}</p>
                    </div>
                    <div class="flex items-center gap-6 bg-gray-950/60 p-4 rounded-2xl border border-gray-800">
                        <div class="text-center">
                            <span class="text-[10px] text-gray-400 block uppercase font-mono">إجمالي النقاط</span>
                            <span class="text-2xl font-black text-amber-400">${userTeam.points}</span>
                        </div>
                        <div class="w-px h-8 bg-gray-800"></div>
                        <div class="text-center">
                            <span class="text-[10px] text-gray-400 block uppercase font-mono">الأعضاء</span>
                            <span class="text-2xl font-black text-cyan-400">${userTeam.members.length}</span>
                        </div>
                    </div>
                </div>
            </div>
        `;
    } else {
        myTeamContainer.innerHTML = `
            <div class="glass-panel p-6 rounded-3xl text-center space-y-2 border-gray-800">
                <p class="text-sm text-gray-300">أنت لست منضماً لأي فريق حالياً. انضم إلى فريق عبر لوحة المنظمين!</p>
            </div>
        `;
    }

    const leaderboardGrid = document.getElementById('teams-leaderboard-grid');
    leaderboardGrid.innerHTML = '';

    sorted.forEach((team, idx) => {
        const isMyTeam = userTeam && userTeam.id === team.id;
        const card = document.createElement('div');
        card.className = `p-5 rounded-2xl bg-darkcard/90 border transition-all duration-200 ${isMyTeam ? 'border-red-500/60 shadow-[0_0_15px_rgba(255,42,95,0.2)]' : 'border-gray-800 hover:border-gray-700'}`;
        card.innerHTML = `
            <div class="flex justify-between items-center mb-3">
                <span class="w-7 h-7 rounded-lg flex items-center justify-center text-xs font-black ${idx === 0 ? 'bg-amber-500 text-gray-950' : idx === 1 ? 'bg-gray-300 text-gray-950' : idx === 2 ? 'bg-amber-700 text-white' : 'bg-gray-800 text-gray-400'}">
                    ${idx + 1}
                </span>
                <span class="text-xs font-mono font-bold text-amber-400 bg-amber-500/10 px-2 py-0.5 rounded border border-amber-500/20">${team.points} PTS</span>
            </div>
            <h4 class="font-bold text-white text-base ${isMyTeam ? 'text-red-400' : ''}">${esc(team.name)} ${isMyTeam ? '(فريقك)' : ''}</h4>
            <p class="text-xs text-gray-400 mt-2 line-clamp-1">الأعضاء: ${team.members.length > 0 ? team.members.map(esc).join(', ') : 'لا يوجد أعضاء'}</p>
        `;
        leaderboardGrid.appendChild(card);
    });
}

// Render Public Rounds & Matches
function renderRoundsView() {
    const container = document.getElementById('public-rounds-list');
    container.innerHTML = '';

    if (roundsData.length === 0) {
        container.innerHTML = `<p class="text-sm text-gray-400 text-center py-6">لا توجد جولات مضافة حالياً.</p>`;
        return;
    }

    roundsData.forEach(round => {
        const roundDiv = document.createElement('div');
        roundDiv.className = 'bg-gray-900/60 p-5 rounded-2xl border border-gray-800 space-y-4';

        let matchesHtml = '';
        round.matches.forEach(m => {
            const isWinner1 = m.winner === m.team1;
            const isWinner2 = m.winner === m.team2;
            matchesHtml += `
                <div class="flex flex-col sm:flex-row items-center justify-between p-4 bg-darkbg rounded-xl border border-gray-800 gap-3">
                    <div class="flex items-center gap-3 w-full sm:w-2/5 justify-between sm:justify-start">
                        <span class="font-bold text-sm ${isWinner1 ? 'text-emerald-400 font-black' : 'text-white'}">${esc(m.team1)}</span>
                        <span class="px-2 py-0.5 bg-gray-800 rounded font-mono text-xs text-amber-400">${m.score1}</span>
                    </div>
                    <div class="text-xs font-mono text-gray-500 uppercase">VS</div>
                    <div class="flex items-center gap-3 w-full sm:w-2/5 justify-between sm:justify-end">
                        <span class="px-2 py-0.5 bg-gray-800 rounded font-mono text-xs text-amber-400">${m.score2}</span>
                        <span class="font-bold text-sm ${isWinner2 ? 'text-emerald-400 font-black' : 'text-white'}">${esc(m.team2)}</span>
                    </div>
                </div>
            `;
        });

        roundDiv.innerHTML = `
            <div class="flex justify-between items-center border-b border-gray-800 pb-3">
                <h3 class="font-bold text-white text-base flex items-center gap-2">
                    <span>🎯</span> ${esc(round.title)}
                </h3>
                <span class="text-xs text-gray-400 font-mono">${round.matches.length} مباريات</span>
            </div>
            <div class="space-y-2">${matchesHtml}</div>
        `;
        container.appendChild(roundDiv);
    });
}

// Render Profile Tab
function renderProfileTab() {
    if (!currentUser) return;

    const isPrimary = currentUser.hostType === 'primary';
    const isHost = currentUser.isHost;

    document.getElementById('profile-username').textContent = currentUser.username;
    document.getElementById('profile-role-badge').innerHTML = isPrimary
        ? `<span class="px-3 py-1 bg-amber-500/20 text-amber-300 border border-amber-500/40 rounded-full text-xs font-bold">Primary Host 👑</span>`
        : isHost
        ? `<span class="px-3 py-1 bg-purple-500/20 text-purple-300 border border-purple-500/40 rounded-full text-xs font-bold">Secondary Host 🛡️</span>`
        : `<span class="px-3 py-1 bg-cyan-500/20 text-cyan-300 border border-cyan-500/40 rounded-full text-xs font-bold">لاعب معتمد 🎯</span>`;

    const userTeam = teamsList.find(t => t.members.includes(currentUser.username));
    document.getElementById('profile-team-name').textContent = userTeam ? userTeam.name : 'غير منضم لفريق';
    document.getElementById('profile-team-points').textContent = userTeam ? userTeam.points : '0';
}

async function changePassword() {
    if (!currentUser) return;
    const input = document.getElementById('change-pass-input');
    const newPass = input.value.trim();
    const passwordRegex = /^[a-zA-Z0-9]{6,}$/;

    if (!passwordRegex.test(newPass)) {
        showToast('كلمة المرور يجب أن تكون أكثر من 5 خانات وتحتوي على حروف وأرقام فقط', 'error');
        return;
    }

    const data = await api('POST', '/api/password', { newPassword: newPass });
    if (!data) return;
    input.value = '';
    showToast('تم تغيير كلمة المرور بنجاح!', 'success');
}

// Host Panel Rendering
function renderHostPanel() {
    renderHostTeamsManager();
    renderHostRoundsManager();
    renderHostPermissionsTable();
}

// Host Teams Manager UI
function renderHostTeamsManager() {
    const container = document.getElementById('host-teams-management-list');
    const createCard = document.getElementById('host-create-team-card');
    const allowed = canManageTeams();

    if (!allowed) {
        createCard.classList.add('opacity-50', 'pointer-events-none');
    } else {
        createCard.classList.remove('opacity-50', 'pointer-events-none');
    }

    container.innerHTML = '';

    teamsList.forEach(team => {
        const teamDiv = document.createElement('div');
        teamDiv.className = 'bg-gray-900/80 p-4 rounded-2xl border border-gray-800 space-y-3';

        let membersBadgeHtml = team.members.map(m => `
            <span class="inline-flex items-center gap-1 bg-gray-800 text-gray-200 text-xs px-2.5 py-1 rounded-lg border border-gray-700">
                ${esc(m)}
                ${allowed ? `<button data-name="${esc(m)}" data-team="${team.id}" onclick="removePlayerFromTeam(this.dataset.team, this.dataset.name)" class="text-red-400 hover:text-red-300 font-bold ml-1">✕</button>` : ''}
            </span>
        `).join('');

        teamDiv.innerHTML = `
            <div class="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-2 border-b border-gray-800 pb-2">
                <div class="flex items-center gap-2">
                    <input type="text" value="${esc(team.name)}" ${!allowed ? 'disabled' : ''} data-team="${team.id}" onchange="renameTeam(this.dataset.team, this.value)" class="bg-darkbg border border-gray-700 px-2.5 py-1 rounded-lg text-sm font-bold text-white focus:border-amber-400 outline-none disabled:opacity-60">
                    ${allowed ? `<button data-team="${team.id}" onclick="deleteTeam(this.dataset.team)" class="px-2 py-1 bg-red-600/20 text-red-400 border border-red-500/30 rounded-lg text-xs hover:bg-red-600/40">حذف</button>` : ''}
                </div>
                <div class="flex items-center gap-2">
                    <span class="text-xs text-gray-400">النقاط:</span>
                    <input type="number" value="${team.points}" ${!allowed ? 'disabled' : ''} data-team="${team.id}" onchange="updateTeamPoints(this.dataset.team, this.value)" class="w-20 bg-darkbg border border-gray-700 px-2 py-1 rounded-lg text-sm font-mono text-amber-400 text-center focus:border-amber-400 outline-none disabled:opacity-60">
                </div>
            </div>
            <div class="space-y-2">
                <span class="text-xs text-gray-400 block">أعضاء الفريق:</span>
                <div class="flex flex-wrap gap-1.5">${membersBadgeHtml || '<span class="text-xs text-gray-500">لا يوجد أعضاء</span>'}</div>
                ${allowed ? `
                <div class="flex gap-2 pt-1">
                    <input type="text" id="add-member-input-${team.id}" placeholder="إضافة اسم لاعب..." class="bg-darkbg border border-gray-700 px-2.5 py-1 rounded-lg text-xs text-white focus:border-amber-400 outline-none">
                    <button data-team="${team.id}" onclick="addPlayerToTeam(this.dataset.team)" class="px-3 py-1 bg-amber-500 hover:bg-amber-400 text-gray-950 font-bold rounded-lg text-xs">إضافة</button>
                </div>
                ` : ''}
            </div>
        `;
        container.appendChild(teamDiv);
    });
}

async function createNewTeam() {
    if (!canManageTeams()) {
        showToast('غير مصرح لك بتعديل الفرق!', 'error');
        return;
    }
    const input = document.getElementById('new-team-input');
    const name = input.value.trim();
    if (!name) return;

    const data = await api('POST', '/api/teams', { name });
    if (!data) return;
    input.value = '';
    showToast('تم إنشاء الفريق بنجاح', 'success');
    await refreshAppViews();
}

async function renameTeam(teamId, newName) {
    if (!canManageTeams()) return;
    if (!newName.trim()) return;
    const data = await api('PATCH', `/api/teams/${teamId}`, { name: newName.trim() });
    if (!data) return;
    showToast('تم تعديل اسم الفريق', 'success');
    await refreshAppViews();
}

async function updateTeamPoints(teamId, newPts) {
    if (!canManageTeams()) return;
    const data = await api('PATCH', `/api/teams/${teamId}`, { points: parseInt(newPts) || 0 });
    if (!data) return;
    await refreshAppViews();
}

async function deleteTeam(teamId) {
    if (!canManageTeams()) return;
    const data = await api('DELETE', `/api/teams/${teamId}`);
    if (!data) return;
    showToast('تم حذف الفريق', 'info');
    await refreshAppViews();
}

async function addPlayerToTeam(teamId) {
    if (!canManageTeams()) return;
    const input = document.getElementById(`add-member-input-${teamId}`);
    const username = input.value.trim();
    if (!username) return;

    const data = await api('POST', `/api/teams/${teamId}/members`, { username });
    if (!data) return;
    showToast(`تم إضافة ${username} للفريق`, 'success');
    await refreshAppViews();
}

async function removePlayerFromTeam(teamId, username) {
    if (!canManageTeams()) return;
    const data = await api('DELETE', `/api/teams/${teamId}/members/${encodeURIComponent(username)}`);
    if (!data) return;
    showToast(`تم إزالة ${username}`, 'info');
    await refreshAppViews();
}

// Host Rounds Manager
function renderHostRoundsManager() {
    const container = document.getElementById('host-rounds-container');
    const addRoundBtn = document.getElementById('add-round-btn');
    const allowed = canManageSchedule();

    if (!allowed) {
        addRoundBtn.classList.add('hidden');
    } else {
        addRoundBtn.classList.remove('hidden');
    }

    container.innerHTML = '';

    roundsData.forEach(round => {
        const roundBox = document.createElement('div');
        roundBox.className = 'glass-panel p-5 rounded-3xl space-y-4 border-gray-800';

        let matchesRows = round.matches.map((m) => `
            <div class="flex flex-col md:flex-row items-center justify-between p-3 bg-darkbg rounded-xl border border-gray-800 gap-3">
                <div class="flex items-center gap-2 w-full md:w-1/3">
                    <input type="text" value="${esc(m.team1)}" ${!allowed ? 'disabled' : ''} data-round="${round.id}" data-match="${m.id}" data-field="team1" onchange="updateMatchTeam(this.dataset.round, this.dataset.match, this.dataset.field, this.value)" class="w-full bg-gray-900 border border-gray-700 px-2 py-1 rounded text-xs text-white disabled:opacity-60">
                    <input type="number" value="${m.score1}" ${!allowed ? 'disabled' : ''} data-round="${round.id}" data-match="${m.id}" onchange="updateMatchScore(this.dataset.round, this.dataset.match, 1, this.value)" class="w-12 bg-gray-900 border border-gray-700 px-1 py-1 rounded text-xs text-amber-400 text-center disabled:opacity-60">
                </div>
                <span class="text-xs font-mono text-gray-500">VS</span>
                <div class="flex items-center gap-2 w-full md:w-1/3">
                    <input type="number" value="${m.score2}" ${!allowed ? 'disabled' : ''} data-round="${round.id}" data-match="${m.id}" onchange="updateMatchScore(this.dataset.round, this.dataset.match, 2, this.value)" class="w-12 bg-gray-900 border border-gray-700 px-1 py-1 rounded text-xs text-amber-400 text-center disabled:opacity-60">
                    <input type="text" value="${esc(m.team2)}" ${!allowed ? 'disabled' : ''} data-round="${round.id}" data-match="${m.id}" data-field="team2" onchange="updateMatchTeam(this.dataset.round, this.dataset.match, this.dataset.field, this.value)" class="w-full bg-gray-900 border border-gray-700 px-2 py-1 rounded text-xs text-white disabled:opacity-60">
                </div>
                <div class="flex items-center gap-2">
                    <button data-t1="${esc(m.team1)}" data-t2="${esc(m.team2)}" onclick="triggerMatchAlarm(this.dataset.t1, this.dataset.t2)" class="px-2.5 py-1 bg-red-600/30 hover:bg-red-600 text-red-300 rounded text-xs font-bold transition">🔔 تنبيه</button>
                    ${allowed ? `<button data-round="${round.id}" data-match="${m.id}" onclick="deleteMatch(this.dataset.round, this.dataset.match)" class="text-red-400 hover:text-red-300 text-xs">✕</button>` : ''}
                </div>
            </div>
        `).join('');

        roundBox.innerHTML = `
            <div class="flex justify-between items-center border-b border-gray-800 pb-3 flex-wrap gap-2">
                <input type="text" value="${esc(round.title)}" ${!allowed ? 'disabled' : ''} data-round="${round.id}" onchange="renameRound(this.dataset.round, this.value)" class="bg-darkbg border border-gray-700 px-3 py-1.5 rounded-xl text-sm font-bold text-white focus:border-cyan-400 outline-none disabled:opacity-60">
                ${allowed ? `
                <div class="flex items-center gap-2">
                    <button data-round="${round.id}" onclick="addMatchToRound(this.dataset.round)" class="px-3 py-1 bg-cyan-600 hover:bg-cyan-500 text-white rounded-lg text-xs font-bold">+ مباراة</button>
                    <button data-round="${round.id}" onclick="deleteRound(this.dataset.round)" class="px-3 py-1 bg-red-600/20 text-red-400 border border-red-500/30 rounded-lg text-xs hover:bg-red-600/40">حذف الجولة</button>
                </div>
                ` : ''}
            </div>
            <div class="space-y-2">${matchesRows || '<p class="text-xs text-gray-500">لا توجد مباريات في هذه الجولة</p>'}</div>
        `;
        container.appendChild(roundBox);
    });
}

async function addNewRound() {
    if (!canManageSchedule()) return;
    const data = await api('POST', '/api/rounds', {});
    if (!data) return;
    showToast('تمت إضافة جولة جديدة', 'success');
    await refreshAppViews();
}

async function renameRound(roundId, newTitle) {
    if (!canManageSchedule()) return;
    if (!newTitle.trim()) return;
    const data = await api('PATCH', `/api/rounds/${roundId}`, { title: newTitle.trim() });
    if (!data) return;
    await refreshAppViews();
}

async function deleteRound(roundId) {
    if (!canManageSchedule()) return;
    const data = await api('DELETE', `/api/rounds/${roundId}`);
    if (!data) return;
    showToast('تم حذف الجولة', 'info');
    await refreshAppViews();
}

async function addMatchToRound(roundId) {
    if (!canManageSchedule()) return;
    const data = await api('POST', `/api/rounds/${roundId}/matches`, {});
    if (!data) return;
    await refreshAppViews();
}

async function updateMatchTeam(roundId, matchId, field, val) {
    if (!canManageSchedule()) return;
    const data = await api('PATCH', `/api/matches/${matchId}`, { [field]: val });
    if (!data) return;
    await refreshAppViews();
}

async function updateMatchScore(roundId, matchId, teamNum, score) {
    if (!canManageSchedule()) return;
    const data = await api('PATCH', `/api/matches/${matchId}`, { ['score' + teamNum]: parseInt(score) || 0 });
    if (!data) return;
    await refreshAppViews();
}

async function deleteMatch(roundId, matchId) {
    if (!canManageSchedule()) return;
    const data = await api('DELETE', `/api/matches/${matchId}`);
    if (!data) return;
    await refreshAppViews();
}

function triggerMatchAlarm(team1, team2) {
    playAlertSound();
    const banner = document.getElementById('live-match-banner');
    const text = document.getElementById('banner-match-text');
    text.textContent = `مواجهة حية متوقعة بين ${team1} وَ ${team2}! استعد للقتال!`;
    banner.classList.remove('hidden');
    showToast('تم إرسال إشعار التنبيه بإنذار صوتي!', 'success');
}

function dismissBanner() {
    document.getElementById('live-match-banner').classList.add('hidden');
}

// Primary Host Permissions Table
function renderHostPermissionsTable() {
    const tbody = document.getElementById('hosts-permissions-table-body');
    if (!tbody) return;

    tbody.innerHTML = '';

    usersList.forEach(user => {
        const isPrimary = user.hostType === 'primary';
        const isHost = user.isHost;
        const permLevel = user.permLevel || 'full';

        const tr = document.createElement('tr');
        tr.className = 'hover:bg-gray-800/40 transition';

        tr.innerHTML = `
            <td class="p-3 font-bold text-white flex items-center gap-2">
                ${esc(user.username)}
                ${isPrimary ? '👑' : isHost ? '🛡️' : ''}
            </td>
            <td class="p-3">
                ${isPrimary
            ? '<span class="text-amber-400 font-bold text-xs bg-amber-500/10 px-2.5 py-1 rounded-md border border-amber-500/30">Primary Host</span>'
            : isHost
                ? '<span class="text-purple-400 font-bold text-xs bg-purple-500/10 px-2.5 py-1 rounded-md border border-purple-500/30">Secondary Host</span>'
                : '<span class="text-gray-400 text-xs">لاعب عادي</span>'}
            </td>
            <td class="p-3">
                ${isPrimary ? `
                    <span class="text-xs text-amber-300 font-bold">صلاحيات مطلقة (Primary)</span>
                ` : isHost ? `
                    <select data-user="${user.id}" onchange="updateSecondaryPermission(this.dataset.user, this.value)" class="bg-darkbg border border-gray-700 text-cyan-400 text-xs rounded-xl p-2 focus:border-cyan-400 outline-none">
                        <option value="full" ${permLevel === 'full' ? 'selected' : ''}>تحكم كامل (جداول وروندات وفرق)</option>
                        <option value="schedule_only" ${permLevel === 'schedule_only' ? 'selected' : ''}>تعديل الجداول والمواعيد فقط</option>
                        <option value="teams_only" ${permLevel === 'teams_only' ? 'selected' : ''}>تعديل الفرق واللاعبين فقط</option>
                        <option value="readonly" ${permLevel === 'readonly' ? 'selected' : ''}>عرض فقط (بدون أي صلاحيات تعديل)</option>
                    </select>
                ` : `
                    <span class="text-xs text-gray-500">لا ينطبق</span>
                `}
            </td>
            <td class="p-3 text-center">
                ${isPrimary ? `
                    <span class="text-xs text-amber-500 font-mono">مالك المنصة</span>
                ` : `
                    <div class="flex items-center justify-center gap-2">
                        ${!isHost ? `
                            <button data-user="${user.id}" data-name="${esc(user.username)}" onclick="promoteToSecondary(this.dataset.user, this.dataset.name)" class="px-3 py-1 bg-purple-600/30 hover:bg-purple-600/60 text-purple-300 border border-purple-500/40 rounded-lg text-xs transition">ترقية لـ Secondary Host</button>
                        ` : `
                            <button data-user="${user.id}" data-name="${esc(user.username)}" onclick="demoteToUser(this.dataset.user, this.dataset.name)" class="px-3 py-1 bg-red-600/20 hover:bg-red-600/50 text-red-300 border border-red-500/30 rounded-lg text-xs transition">تنزيل إلى لاعب عادي</button>
                        `}
                    </div>
                `}
            </td>
        `;
        tbody.appendChild(tr);
    });
}

async function updateSecondaryPermission(userId, permLevel) {
    if (!currentUser || currentUser.hostType !== 'primary') return;
    const data = await api('PATCH', `/api/users/${userId}/perm`, { permLevel });
    if (!data) return;
    const target = usersList.find(x => x.id === Number(userId));
    showToast(`تم تحديث صلاحيات ${target ? target.username : userId}`, 'success');
    await refreshAppViews();
}

async function promoteToSecondary(userId, username) {
    if (!currentUser || currentUser.hostType !== 'primary') return;
    const data = await api('POST', `/api/users/${userId}/promote`);
    if (!data) return;
    showToast(`تم ترقية ${username} إلى Secondary Host`, 'success');
    await refreshAppViews();
}

async function demoteToUser(userId, username) {
    if (!currentUser || currentUser.hostType !== 'primary') return;
    const data = await api('POST', `/api/users/${userId}/demote`);
    if (!data) return;
    showToast(`تم تنزيل ${username} إلى مستخدم عادي`, 'info');
    await refreshAppViews();
}

// Toast Notification System
function showToast(msg, type = 'info') {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');

    const colors = {
        success: 'bg-emerald-950/90 border-emerald-500 text-emerald-200',
        error: 'bg-red-950/90 border-red-500 text-red-200',
        info: 'bg-amber-950/90 border-amber-500 text-amber-200'
    };

    toast.className = `p-3.5 rounded-2xl border backdrop-blur-md shadow-2xl font-bold text-xs flex items-center gap-2 pointer-events-auto transition-all duration-300 ${colors[type] || colors.info}`;
    toast.innerHTML = `<span>${type === 'success' ? '✅' : type === 'error' ? '❌' : 'ℹ️'}</span> <span>${esc(msg)}</span>`;

    container.appendChild(toast);
    setTimeout(() => {
        toast.classList.add('opacity-0', '-translate-y-2');
        setTimeout(() => toast.remove(), 300);
    }, 3500);
}
