// State
const state = {
    currentDate: new Date(),
    selectedDate: new Date(),
    currentView: 'tracker',
    currentRange: 'week',
    customFrom: null,
    customTo: null,
    data: {},
    profile: { name: '', gender: '', age: '' },
    chartFilter: 'all',
    chartCompare: 'off',
    trackerEditMode: false
};

const MONTHS = ['Январь','Февраль','Март','Апрель','Май','Июнь','Июль','Август','Сентябрь','Октябрь','Ноябрь','Декабрь'];
const SYMPTOMS = ['pain','fatigue','sleep','cognitive','sensory','digestive','emotional'];
const COLORS = { pain:'#FF453A', fatigue:'#FF9F0A', sleep:'#BF5AF2', cognitive:'#64D2FF', sensory:'#FF375F', digestive:'#30D158', emotional:'#FFD60A' };
const TRACKER_COLORS = { pain:'#ef4444', fatigue:'#f97316', sleep:'#8b5cf6', cognitive:'#06b6d4', sensory:'#ec4899', digestive:'#84cc16', emotional:'#f59e0b' };
const LABELS = { pain:'Боль', fatigue:'Утомляемость', sleep:'Сон', cognitive:'Когнитивные', sensory:'Сенсорная', digestive:'Пищеварение', emotional:'Эмоциональное' };
const ICONS = { pain:'fa-heartbeat', fatigue:'fa-battery-quarter', sleep:'fa-moon', cognitive:'fa-brain', sensory:'fa-eye', digestive:'fa-bowl-food', emotional:'fa-smile' };
const EMOJIS = { pain:'🔴', fatigue:'🟠', sleep:'💜', cognitive:'🔵', sensory:'💗', digestive:'💚', emotional:'🧡' };
const DESCS = { pain:'Хроническая, мышечная, головная', fatigue:'Экстремальная усталость', sleep:'Бессонница, нарушения сна', cognitive:'«Туман в голове», концентрация', sensory:'Чувствительность к свету/звуку', digestive:'СРК, тошнота, вздутие', emotional:'Тревога, депрессия' };
const MAX_EXERCISE_ROWS = 20;

let autoSaveTimer = null;
let lastFocusedEl = null;

// --- Даты ---
function getToday() {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
}

function startOfDay(d) {
    const copy = new Date(d);
    copy.setHours(0, 0, 0, 0);
    return copy;
}

function isSameDay(a, b) {
    return startOfDay(a).getTime() === startOfDay(b).getTime();
}

function isAfterToday(date) {
    return startOfDay(date).getTime() > getToday().getTime();
}

function symId(sym) {
    return sym.charAt(0).toUpperCase() + sym.slice(1);
}

function hasRecord(entry) {
    if (!entry) return false;
    if (entry.saved) return true;
    const hasExercises = Array.isArray(entry.exercises)
        && entry.exercises.some(ex => ex && (String(ex.name || '').trim() || (ex.reps || 0) > 0 || (ex.sets || 0) > 0));
    return SYMPTOMS.some(s => (entry[s] || 0) > 0)
        || hasExercises
        || !!(entry.notes && entry.notes.trim())
        || !!(entry.meds && entry.meds.trim());
}

function countDaysWithoutRecord() {
    const today = getToday();
    let days = 0;
    const check = new Date(today);
    while (days <= 365) {
        if (hasRecord(state.data[dateKey(check)])) break;
        days++;
        check.setDate(check.getDate() - 1);
    }
    return days;
}

// Init — UI сразу из localStorage, синхронизация в фоне
document.addEventListener('DOMContentLoaded', () => {
    const syncPromise = (typeof sync !== 'undefined')
        ? sync.init().then((result) => {
            if (result.merged) refreshAppFromStorage();
            return result;
        }).catch(() => {})
        : Promise.resolve();

    state.data = storage.loadEntries();
    state.profile = storage.loadProfile();
    updateProfileDisplay();
    state.selectedDate = getToday();
    state.currentDate = new Date(state.selectedDate.getFullYear(), state.selectedDate.getMonth(), 1);

    initQuickButtons();
    initExerciseEditor();
    setupTabs();
    setupAutoSave();
    renderCalendar();
    loadDataToForm();
    updateDisplay();
    updateDateNavButtons();
    updateDaysCounter();
    updateCopyBtn();
    updateTrackerView();

    const today = getToday();
    const weekAgo = new Date(today);
    weekAgo.setDate(weekAgo.getDate() - 7);
    document.getElementById('dateFrom').value = formatDateInput(weekAgo);
    document.getElementById('dateTo').value = formatDateInput(today);
    initChartFilters();
    initChartCompareFilters();
    initSyncStatusButton();

    // syncPromise — фоновая синхронизация, UI не ждёт
    void syncPromise;
});

async function retryCloudSync() {
    if (typeof sync === 'undefined') {
        showToastError('Модуль синхронизации не загружен');
        return;
    }
    if (typeof sync.ensureConfig === 'function') await sync.ensureConfig();
    if (!sync.initClient()) {
        showToastError(sync.getConfigError() || 'Синхронизация не настроена');
        return;
    }
    sync.setStatus('syncing', 'Синхронизация…');
    const result = typeof sync.syncNow === 'function'
        ? await sync.syncNow()
        : await sync.pullAndMerge();
    if (result.merged && typeof refreshAppFromStorage === 'function') refreshAppFromStorage();
    if (sync.status === 'error' || sync.status === 'disabled') {
        showToastError(sync.statusMessage || 'Синхронизация недоступна');
    } else if (sync.status === 'synced') {
        showToast('Синхронизация успешна ✓');
    }
}

function initSyncStatusButton() {
    const el = document.getElementById('syncStatus');
    if (!el || el.dataset.bound) return;
    el.dataset.bound = '1';

    el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            retryCloudSync();
        }
    });
}

function setupAutoSave() {
    SYMPTOMS.forEach(sym => {
        const slider = document.getElementById('slider' + symId(sym));
        slider.addEventListener('input', scheduleAutoSave);
    });
    document.getElementById('notesArea').addEventListener('input', scheduleAutoSave);
    document.getElementById('medsInput').addEventListener('input', scheduleAutoSave);
    document.getElementById('exerciseList')?.addEventListener('input', scheduleAutoSave);
}

function scheduleAutoSave() {
    clearTimeout(autoSaveTimer);
    autoSaveTimer = setTimeout(() => persistFormToState(false), 400);
}

// Tabs
function setupTabs() {
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', () => switchView(btn.dataset.view));
    });
}

function switchView(view) {
    if (view === 'statistics') persistFormToState(false);
    state.currentView = view;
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.view === view));
    document.querySelectorAll('.view').forEach(v => {
        v.classList.toggle('active', v.id === 'view' + view.charAt(0).toUpperCase() + view.slice(1));
    });
    document.getElementById('calBtn')?.classList.toggle('active', false);
    if (view === 'statistics') renderStats();
}

// Навигация по датам на главном экране
function shiftDate(delta) {
    const next = new Date(state.selectedDate);
    next.setDate(next.getDate() + delta);
    if (isAfterToday(next)) return;

    persistFormToState(false);
    state.trackerEditMode = false;
    state.selectedDate = startOfDay(next);
    state.currentDate = new Date(next.getFullYear(), next.getMonth(), 1);
    renderCalendar();
    updateDisplay();
    updateDateNavButtons();
    loadDataToForm();
    updateDaysCounter();
    updateCopyBtn();
    updateTrackerView();
}

function updateDateNavButtons() {
    const prevBtn = document.getElementById('datePrevBtn');
    const nextBtn = document.getElementById('dateNextBtn');
    if (!prevBtn || !nextBtn) return;

    const tomorrow = new Date(state.selectedDate);
    tomorrow.setDate(tomorrow.getDate() + 1);
    nextBtn.disabled = isAfterToday(tomorrow);
    prevBtn.disabled = false;
}

// Calendar Overlay
function openCalendar() {
    lastFocusedEl = document.activeElement;
    document.getElementById('calendarOverlay').classList.add('show');
    document.getElementById('calendarOverlay').setAttribute('aria-hidden', 'false');
    document.getElementById('calBtn')?.classList.add('active');
    const popup = document.querySelector('#calendarOverlay .calendar-popup');
    popup?.focus();
    renderCalendar();
}

function closeCalendar() {
    document.getElementById('calendarOverlay').classList.remove('show');
    document.getElementById('calendarOverlay').setAttribute('aria-hidden', 'true');
    document.getElementById('calBtn')?.classList.remove('active');
    lastFocusedEl?.focus?.();
}

document.getElementById('calendarOverlay').addEventListener('click', e => {
    if (e.target.id === 'calendarOverlay') closeCalendar();
});

function renderCalendar() {
    const y = state.currentDate.getFullYear();
    const m = state.currentDate.getMonth();
    document.getElementById('monthTitle').textContent = MONTHS[m] + ' ' + y;

    const firstDay = new Date(y, m, 1);
    const lastDay = new Date(y, m + 1, 0);
    let start = firstDay.getDay() - 1;
    if (start < 0) start = 6;
    const total = lastDay.getDate();
    const prevTotal = new Date(y, m, 0).getDate();
    const today = getToday();

    let html = '';
    for (let i = start - 1; i >= 0; i--) {
        const d = new Date(y, m - 1, prevTotal - i);
        html += dayHtml(d.getDate(), d, true, false, false);
    }
    for (let d = 1; d <= total; d++) {
        const date = new Date(y, m, d);
        html += dayHtml(d, date, false, isSameDay(date, today), isSameDay(date, state.selectedDate));
    }
    const remaining = 42 - (start + total);
    for (let d = 1; d <= remaining; d++) {
        const date = new Date(y, m + 1, d);
        html += dayHtml(d, date, true, false, false);
    }
    document.getElementById('calendarGrid').innerHTML = html;
}

function dayHtml(day, date, other, today, selected) {
    const key = dateKey(date);
    const data = state.data[key];
    const future = isAfterToday(date);
    const hasData = data && hasRecord(data);

    let heatCls = '';
    if (hasData) {
        const sum = calcEntrySum(data);
        const ratio = sum / (10 * SYMPTOMS.length);
        let level = 1;
        if (ratio >= 0.75) level = 4;
        else if (ratio >= 0.5) level = 3;
        else if (ratio >= 0.25) level = 2;
        heatCls = ' heat-' + level;
    }

    let dots = '';
    if (hasData) {
        const active = SYMPTOMS.filter(s => data[s] > 0).slice(0, 3);
        dots = '<div class="indicators">' + active.map(s => '<span class="indicator-dot" style="background:'+COLORS[s]+'"></span>').join('') + '</div>';
    }
    let cls = 'day-cell';
    if (other) cls += ' other-month';
    if (today) cls += ' today';
    if (selected) cls += ' selected';
    if (future) cls += ' disabled-day';
    cls += heatCls;
    const click = future ? '' : ' onclick="selectDate(\''+key+'\')" onkeydown="onCalendarDayKey(event,\''+key+'\')" tabindex="0" role="button" aria-label="Выбрать '+key+'"';
    return '<div class="'+cls+'"'+click+'>'+day+dots+'</div>';
}

function changeMonth(dir) {
    state.currentDate.setMonth(state.currentDate.getMonth() + dir);
    renderCalendar();
}

function goTodayCal() {
    persistFormToState(false);
    state.trackerEditMode = false;
    state.currentDate = new Date();
    state.selectedDate = getToday();
    renderCalendar();
    updateDisplay();
    updateDateNavButtons();
    loadDataToForm();
    updateDaysCounter();
    updateCopyBtn();
    updateTrackerView();
    closeCalendar();
}

function selectDate(key) {
    const [y, m, d] = key.split('-').map(Number);
    const date = startOfDay(new Date(y, m - 1, d));
    if (isAfterToday(date)) return;

    state.trackerEditMode = false;
    persistFormToState(false);
    state.selectedDate = date;
    state.currentDate = new Date(y, m - 1, 1);
    renderCalendar();
    updateDisplay();
    updateDateNavButtons();
    loadDataToForm();
    updateDaysCounter();
    updateCopyBtn();
    updateTrackerView();
    closeCalendar();
    switchView('tracker');
}

function updateDisplay() {
    const opts = { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' };
    let text = state.selectedDate.toLocaleDateString('ru-RU', opts);
    if (isSameDay(state.selectedDate, getToday())) {
        text += ' (сегодня)';
    }
    document.getElementById('selectedDateText').textContent = text;
}

// Quick buttons
function initQuickButtons() {
    SYMPTOMS.forEach(sym => {
        const container = document.getElementById('quick' + symId(sym));
        let html = '';
        for (let v = 0; v <= 10; v++) {
            const cls = v <= 3 ? 'low' : v <= 6 ? 'medium' : 'high';
            html += '<button type="button" class="quick-btn '+cls+'" data-val="'+v+'" onclick="setQuickVal(\''+sym+'\','+v+')">'+v+'</button>';
        }
        container.innerHTML = html;
    });
}

function setQuickBtnState(sym, val) {
    const container = document.getElementById('quick' + symId(sym));
    container.querySelectorAll('.quick-btn').forEach(btn => {
        btn.classList.toggle('active', parseInt(btn.dataset.val, 10) === val);
    });
}

function severityLevel(v) {
    if (v <= 3) return 'low';
    if (v <= 6) return 'medium';
    return 'high';
}

function updateSeverityVal(sym, val) {
    const el = document.getElementById('val' + symId(sym));
    el.textContent = val;
    el.className = 'severity-val sev-' + severityLevel(val);
    const slider = document.getElementById('slider' + symId(sym));
    slider?.setAttribute('aria-valuetext', `${LABELS[sym]}: ${val} из 10`);
}

function setQuickVal(sym, val) {
    document.getElementById('slider' + symId(sym)).value = val;
    updateSeverityVal(sym, val);
    setQuickBtnState(sym, val);
    updateDayIndexPreview();
    scheduleAutoSave();
}

function updateSlider(sym) {
    const slider = document.getElementById('slider' + symId(sym));
    const val = parseInt(slider.value, 10);
    updateSeverityVal(sym, val);
    setQuickBtnState(sym, val);
    updateDayIndexPreview();
    scheduleAutoSave();
}

function resetSymptoms() {
    SYMPTOMS.forEach(sym => {
        document.getElementById('slider' + symId(sym)).value = 0;
        updateSeverityVal(sym, 0);
        setQuickBtnState(sym, 0);
    });
    updateDayIndexPreview();
    persistFormToState(false);
    state.trackerEditMode = true;
    updateTrackerView();
    showToast('Симптомы сброшены');
}

function normalizeExercise(ex) {
    if (!ex || typeof ex !== 'object') return null;
    const name = String(ex.name ?? '').trim();
    const reps = Math.max(0, parseInt(ex.reps, 10) || 0);
    const sets = Math.max(0, parseInt(ex.sets, 10) || 0);
    if (!name && reps <= 0 && sets <= 0) return null;
    return { name, reps, sets };
}

function readExercisesFromForm() {
    const rows = document.querySelectorAll('.exercise-row');
    const list = [];
    rows.forEach(row => {
        const ex = normalizeExercise({
            name: row.querySelector('.exercise-name')?.value,
            reps: row.querySelector('.exercise-reps')?.value,
            sets: row.querySelector('.exercise-sets')?.value,
        });
        if (ex) list.push(ex);
    });
    return list.slice(0, MAX_EXERCISE_ROWS);
}

function readExerciseRowsDraft() {
    const rows = document.querySelectorAll('.exercise-row');
    const list = [];
    rows.forEach(row => {
        list.push({
            name: String(row.querySelector('.exercise-name')?.value ?? ''),
            reps: parseInt(row.querySelector('.exercise-reps')?.value, 10) || 0,
            sets: parseInt(row.querySelector('.exercise-sets')?.value, 10) || 0,
        });
    });
    return list.slice(0, MAX_EXERCISE_ROWS);
}

function collectExerciseNameSuggestions() {
    const names = new Set();
    Object.values(state.data || {}).forEach(entry => {
        if (!entry || !Array.isArray(entry.exercises)) return;
        entry.exercises.forEach(ex => {
            const name = String(ex?.name || '').trim();
            if (name) names.add(name);
        });
    });
    return Array.from(names).sort((a, b) => a.localeCompare(b, 'ru'));
}

function renderExerciseNameSuggestions() {
    const datalist = document.getElementById('exerciseNameSuggestions');
    if (!datalist) return;
    const names = collectExerciseNameSuggestions();
    datalist.innerHTML = names.map(name => `<option value="${escapeHtml(name)}"></option>`).join('');
}

function exerciseRowHtml(ex, index) {
    const name = escapeHtml(ex?.name || '');
    const reps = Number.isFinite(ex?.reps) ? ex.reps : '';
    const sets = Number.isFinite(ex?.sets) ? ex.sets : '';
    return `
        <div class="exercise-row" data-index="${index}">
            <input type="text" class="exercise-name" placeholder="Название упражнения" value="${name}" list="exerciseNameSuggestions" aria-label="Название упражнения">
            <input type="number" min="0" class="exercise-reps" placeholder="Раз" value="${reps}" aria-label="Сколько раз">
            <input type="number" min="0" class="exercise-sets" placeholder="Подх." value="${sets}" aria-label="Сколько подходов">
            <button type="button" class="exercise-remove" onclick="removeExerciseRow(${index})" aria-label="Удалить упражнение">
                <i class="fas fa-xmark"></i>
            </button>
        </div>
    `;
}

function renderExerciseRows(exercises, options) {
    const container = document.getElementById('exerciseList');
    if (!container) return;
    const preserveDraft = !!options?.preserveDraft;
    let rows = [];

    if (Array.isArray(exercises)) {
        if (preserveDraft) {
            rows = exercises
                .slice(0, MAX_EXERCISE_ROWS)
                .map(ex => ({
                    name: String(ex?.name ?? ''),
                    reps: Math.max(0, parseInt(ex?.reps, 10) || 0),
                    sets: Math.max(0, parseInt(ex?.sets, 10) || 0),
                }));
        } else {
            rows = exercises.map(normalizeExercise).filter(Boolean).slice(0, MAX_EXERCISE_ROWS);
        }
    }

    if (!rows.length) rows = [{}];
    container.innerHTML = rows.map((ex, idx) => exerciseRowHtml(ex, idx)).join('');
    renderExerciseNameSuggestions();
}

function initExerciseEditor() {
    renderExerciseRows([]);
}

function addExerciseRow() {
    const current = readExerciseRowsDraft();
    if (current.length >= MAX_EXERCISE_ROWS) {
        showToastError(`Максимум ${MAX_EXERCISE_ROWS} упражнений в день`);
        return;
    }
    current.push({ name: '', reps: 0, sets: 0 });
    renderExerciseRows(current, { preserveDraft: true });
    const rows = document.querySelectorAll('.exercise-row');
    const lastName = rows[rows.length - 1]?.querySelector('.exercise-name');
    lastName?.focus();
    scheduleAutoSave();
}

function removeExerciseRow(index) {
    const next = readExerciseRowsDraft().filter((_, idx) => idx !== index);
    renderExerciseRows(next, { preserveDraft: true });
    scheduleAutoSave();
}

function readFormEntry() {
    const d = {
        notes: document.getElementById('notesArea').value,
        meds: document.getElementById('medsInput').value,
        exercises: readExercisesFromForm(),
    };
    SYMPTOMS.forEach(sym => {
        d[sym] = parseInt(document.getElementById('slider' + symId(sym)).value, 10);
    });
    return d;
}

function entryContentEqual(a, b) {
    if (!a && !b) return true;
    if (!a || !b) return false;
    for (const sym of SYMPTOMS) {
        if ((a[sym] || 0) !== (b[sym] || 0)) return false;
    }
    if ((a.notes || '') !== (b.notes || '')) return false;
    if ((a.meds || '') !== (b.meds || '')) return false;
    return JSON.stringify(a.exercises || []) === JSON.stringify(b.exercises || []);
}

function persistFormToState(markSaved) {
    const key = dateKey(state.selectedDate);
    const entry = readFormEntry();
    const prev = state.data[key];

    if (markSaved) {
        entry.saved = true;
        entry.ts = new Date().toISOString();
    } else if (prev?.saved) {
        entry.saved = true;
        entry.ts = prev.ts;
    } else if (prev?.ts) {
        entry.ts = prev.ts;
    }

    if (!hasRecord(entry)) {
        if (prev && !prev.saved) {
            delete state.data[key];
            storage.saveEntries(state.data);
        }
        return;
    }

    if (prev && entryContentEqual(entry, prev) && !!entry.saved === !!prev.saved) {
        return;
    }

    if (!entry.ts) entry.ts = new Date().toISOString();
    state.data[key] = entry;
    storage.saveEntries(state.data);
}

function loadDataToForm() {
    const key = dateKey(state.selectedDate);
    const d = state.data[key];
    SYMPTOMS.forEach(sym => {
        const v = d ? (d[sym] || 0) : 0;
        document.getElementById('slider' + symId(sym)).value = v;
        updateSeverityVal(sym, v);
        setQuickBtnState(sym, v);
    });
    document.getElementById('notesArea').value = d ? (d.notes || '') : '';
    document.getElementById('medsInput').value = d ? (d.meds || '') : '';
    renderExerciseRows(d?.exercises || []);
    updateDayIndexPreview();
    updateTrackerView();
}

function getSelectedDayEntry() {
    return state.data[dateKey(state.selectedDate)];
}

function calcEntrySum(entry) {
    return SYMPTOMS.reduce((acc, s) => acc + (entry[s] || 0), 0);
}

function updateDayIndexPreview() {
    const el = document.getElementById('dayIndexValue');
    if (!el) return;
    const entry = readFormEntry();
    const sum = calcEntrySum(entry);
    el.textContent = String(sum);
}

function updateTrackerView() {
    const summaryEl = document.getElementById('trackerSummary');
    const formEl = document.getElementById('trackerForm');
    if (!summaryEl || !formEl) return;

    const entry = getSelectedDayEntry();
    const showSummary = hasRecord(entry) && !state.trackerEditMode;

    summaryEl.hidden = !showSummary;
    formEl.hidden = showSummary;

    if (showSummary) renderDaySummary(entry);
    updateDayIndexPreview();
}

function renderDaySummary(entry) {
    const sum = calcEntrySum(entry);
    const filledCount = SYMPTOMS.filter(s => (entry[s] || 0) > 0).length;
    const savedLabel = entry.saved ? 'Сохранено' : 'Черновик';

    document.getElementById('summaryAvgBadge').textContent = String(sum);
    document.getElementById('summaryMeta').textContent =
        `${filledCount} из ${SYMPTOMS.length} симптомов отмечено · ${savedLabel}`;

    document.getElementById('summarySymptoms').innerHTML = SYMPTOMS.map(sym => {
        const v = entry[sym] ?? 0;
        const pct = (v / 10) * 100;
        return `
        <div class="summary-row cat-${sym}">
            <div class="summary-row-icon icon-${sym}"><i class="fas ${ICONS[sym]}"></i></div>
            <div class="summary-row-body">
                <div class="summary-row-name">${LABELS[sym]}</div>
                <div class="summary-row-bar-wrap">
                    <div class="summary-row-bar" style="width:${pct}%;background:${TRACKER_COLORS[sym]}"></div>
                </div>
            </div>
            <span class="summary-row-value">${v}</span>
        </div>`;
    }).join('');

    let extraHtml = '';
    if (Array.isArray(entry.exercises) && entry.exercises.length) {
        extraHtml += `<div class="summary-extra-block"><strong>Упражнения</strong><div class="summary-exercises">${entry.exercises.map(ex => {
            const parts = [];
            if (ex.reps > 0) parts.push(`${ex.reps} раз`);
            if (ex.sets > 0) parts.push(`${ex.sets} подходов`);
            const detail = parts.length ? ` (${parts.join(', ')})` : '';
            return `<div class="summary-ex-row">${escapeHtml(ex.name || 'Без названия')}${escapeHtml(detail)}</div>`;
        }).join('')}</div></div>`;
    }
    if (entry.meds && entry.meds.trim()) {
        extraHtml += `<div class="summary-extra-block"><strong>Лекарства / добавки</strong>${escapeHtml(entry.meds)}</div>`;
    }
    if (entry.notes && entry.notes.trim()) {
        extraHtml += `<div class="summary-extra-block"><strong>Заметки</strong>${escapeHtml(entry.notes)}</div>`;
    }
    document.getElementById('summaryExtra').innerHTML = extraHtml;
}

function enterEditMode() {
    state.trackerEditMode = true;
    updateTrackerView();
    document.getElementById('trackerForm')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function escapeHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function saveData() {
    const key = dateKey(state.selectedDate);
    const entry = readFormEntry();
    entry.saved = true;
    state.data[key] = entry;
    storage.saveEntries(state.data);
    renderExerciseNameSuggestions();
    renderCalendar();
    updateDaysCounter();
    updateCopyBtn();
    state.trackerEditMode = false;
    updateTrackerView();
    showToast('Данные сохранены! ✓');
}

function copyPrevDay() {
    const prev = new Date(state.selectedDate);
    prev.setDate(prev.getDate() - 1);
    const d = state.data[dateKey(prev)];
    if (!hasRecord(d)) {
        showToastError('Нет данных за предыдущий день');
        return;
    }
    SYMPTOMS.forEach(sym => {
        const v = d[sym] || 0;
        document.getElementById('slider' + symId(sym)).value = v;
        updateSeverityVal(sym, v);
        setQuickBtnState(sym, v);
    });
    document.getElementById('notesArea').value = d.notes || '';
    document.getElementById('medsInput').value = d.meds || '';
    renderExerciseRows(d.exercises || []);
    state.trackerEditMode = true;
    scheduleAutoSave();
    updateTrackerView();
    showToast('Данные скопированы с вчера. Не забудьте сохранить запись.');
}

function updateCopyBtn() {
    const prev = new Date(state.selectedDate);
    prev.setDate(prev.getDate() - 1);
    document.getElementById('copyBtn').disabled = !hasRecord(state.data[dateKey(prev)]);
}

function updateDaysCounter() {
    const days = countDaysWithoutRecord();
    const block = document.getElementById('daysCounter');
    const el = document.getElementById('daysCount');

    if (days > 2) {
        block.style.display = 'flex';
        el.textContent = days;
        el.style.color = days >= 7 ? 'var(--danger)' : days >= 5 ? 'var(--warning)' : 'var(--text-primary)';
    } else {
        block.style.display = 'none';
    }
}

// Profile
function openProfileModal() {
    lastFocusedEl = document.activeElement;
    document.getElementById('profileModal').classList.add('show');
    document.getElementById('profileModal').setAttribute('aria-hidden', 'false');
    document.getElementById('inputName').value = state.profile.name || '';
    document.getElementById('inputGender').value = state.profile.gender || '';
    document.getElementById('inputAge').value = state.profile.age || '';
    const modal = document.querySelector('#profileModal .modal');
    modal?.focus();
}

function closeProfileModal() {
    document.getElementById('profileModal').classList.remove('show');
    document.getElementById('profileModal').setAttribute('aria-hidden', 'true');
    lastFocusedEl?.focus?.();
}

function saveProfile() {
    const profile = {
        name: document.getElementById('inputName').value.trim(),
        gender: document.getElementById('inputGender').value,
        age: String(document.getElementById('inputAge').value ?? '').trim(),
    };
    try {
        storage.saveProfile(profile);
        state.profile = profile;
        updateProfileDisplay();
        closeProfileModal();
        showToast('Профиль сохранён! ✓');
    } catch {
        showToastError('Не удалось сохранить профиль');
    }
}

function updateProfileDisplay() {
    const avatar = document.getElementById('avatar');
    const nameEl = document.getElementById('displayName');
    const metaEl = document.getElementById('displayMeta');
    if (state.profile.name) {
        avatar.textContent = state.profile.name[0].toUpperCase();
        nameEl.textContent = state.profile.name;
        const parts = [];
        if (state.profile.age) parts.push(state.profile.age + ' лет');
        if (state.profile.gender) {
            parts.push(state.profile.gender === 'male' ? 'Мужской' : state.profile.gender === 'female' ? 'Женский' : 'Другой');
        }
        metaEl.textContent = parts.join(' • ') || 'Заполните профиль';
    } else {
        avatar.textContent = '?';
        nameEl.textContent = 'Нажмите для ввода данных';
        metaEl.textContent = 'Возраст • Пол';
    }
}

document.getElementById('profileModal').addEventListener('click', e => {
    if (e.target.id === 'profileModal') closeProfileModal();
});

document.getElementById('backupFileInput').addEventListener('change', handleBackupFileSelect);

function downloadJsonFile(data, filename) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
}

function exportBackup() {
    const backup = storage.exportBackup();
    const count = Object.keys(backup.entries).length;
    const filename = `cst_backup_${formatDateInput(new Date())}.json`;
    downloadJsonFile(backup, filename);
    showToast(`Резервная копия сохранена (${count} записей)`);
}

function triggerImportBackup() {
    document.getElementById('backupFileInput').click();
}

function onPatientBarKey(e) {
    if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openProfileModal();
    }
}

function onCalendarDayKey(e, key) {
    if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        selectDate(key);
    }
}

document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
        if (document.getElementById('profileModal')?.classList.contains('show')) closeProfileModal();
        if (document.getElementById('calendarOverlay')?.classList.contains('show')) closeCalendar();
    }
});

function refreshAppFromStorage() {
    state.data = storage.loadEntries();
    state.profile = storage.loadProfile();
    state.trackerEditMode = false;
    updateProfileDisplay();
    loadDataToForm();
    renderCalendar();
    updateDaysCounter();
    updateCopyBtn();
    renderExerciseNameSuggestions();
    updateTrackerView();
    if (state.currentView === 'statistics') renderStats();
}

function handleBackupFileSelect(e) {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;

    const hasData = Object.keys(state.data).length > 0 || state.profile.name;
    if (hasData && !confirm('Текущие данные будут заменены содержимым файла. Продолжить?')) {
        return;
    }

    const reader = new FileReader();
    reader.onload = () => {
        try {
            const result = storage.importBackup(reader.result);
            refreshAppFromStorage();
            closeProfileModal();
            showToast(`Данные восстановлены: ${result.entryCount} записей`);
        } catch (err) {
            showToastError(err.message || 'Не удалось импортировать файл');
        }
    };
    reader.onerror = () => showToastError('Не удалось прочитать файл');
    reader.readAsText(file);
}

// Utils
function dateKey(d) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function formatDateInput(d) {
    return dateKey(d);
}

function showToast(msg) {
    const toast = document.getElementById('toast');
    toast.className = 'toast';
    document.getElementById('toastMsg').textContent = msg;
    setTimeout(() => toast.classList.add('show'), 10);
    setTimeout(() => toast.classList.remove('show'), 3000);
}

function showToastError(msg) {
    const toast = document.getElementById('toast');
    toast.className = 'toast error';
    document.getElementById('toastMsg').textContent = msg;
    setTimeout(() => toast.classList.add('show'), 10);
    setTimeout(() => toast.classList.remove('show'), 3000);
}
