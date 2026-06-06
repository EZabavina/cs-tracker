// Excel export
function getStatsPeriodLabel() {
    if (state.currentRange === 'custom' && state.customFrom && state.customTo) {
        return `${formatDateInput(state.customFrom)}_${formatDateInput(state.customTo)}`;
    }
    const labels = { week: 'nedelya', month: 'mesyac', '3months': '3mesyaca' };
    return labels[state.currentRange] || 'period';
}

function getStatsPeriodTitle() {
    if (state.currentRange === 'custom' && state.customFrom && state.customTo) {
        return `${formatDateInput(state.customFrom)} — ${formatDateInput(state.customTo)}`;
    }
    const titles = { week: 'Неделя', month: 'Месяц', '3months': '3 месяца' };
    return titles[state.currentRange] || 'Период';
}

function getExportRowsForPeriod() {
    const dates = getDatesForStats();
    return dates
        .map(date => {
            const entry = state.data[dateKey(date)];
            if (!hasRecord(entry)) return null;
            return { date, entry };
        })
        .filter(Boolean);
}

function getExercises(entry) {
    if (!entry || !Array.isArray(entry.exercises)) return [];
    return entry.exercises.filter(Boolean);
}

function calcExerciseLoad(entry) {
    return getExercises(entry).reduce((acc, ex) => {
        const reps = Math.max(0, parseInt(ex.reps, 10) || 0);
        const sets = Math.max(0, parseInt(ex.sets, 10) || 0);
        return acc + reps * sets;
    }, 0);
}

function formatExerciseSummary(entry) {
    const list = getExercises(entry);
    if (!list.length) return '';
    return list.map(ex => {
        const name = String(ex.name || '').trim() || 'Без названия';
        const parts = [];
        if ((ex.reps || 0) > 0) parts.push(`${ex.reps} раз`);
        if ((ex.sets || 0) > 0) parts.push(`${ex.sets} подходов`);
        return parts.length ? `${name} (${parts.join(', ')})` : name;
    }).join('; ');
}

let xlsxLoadPromise = null;

function loadXlsxLib() {
    if (typeof XLSX !== 'undefined') return Promise.resolve();
    if (!xlsxLoadPromise) {
        xlsxLoadPromise = new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';
            script.async = true;
            script.onload = () => resolve();
            script.onerror = () => reject(new Error('xlsx load failed'));
            document.head.appendChild(script);
        });
    }
    return xlsxLoadPromise;
}

async function exportToExcel() {
    try {
        await loadXlsxLib();
    } catch {
        showToastError('Библиотека Excel не загружена. Проверьте интернет.');
        return;
    }

    const rows = getExportRowsForPeriod();
    if (!rows.length) {
        showToastError('Нет данных за выбранный период');
        return;
    }

    const wb = XLSX.utils.book_new();
    const symptomHeaders = SYMPTOMS.map(s => LABELS[s]);

    const allData = [
        ['Дата', ...symptomHeaders, 'Сумма', 'Нагрузка упражнений', 'Упражнения', 'Лекарства', 'Заметки', 'Сохранено'],
        ...rows.map(({ date, entry }) => [
            date.toLocaleDateString('ru-RU'),
            ...SYMPTOMS.map(s => entry[s] ?? 0),
            calcEntrySum(entry),
            calcExerciseLoad(entry),
            formatExerciseSummary(entry),
            entry.meds || '',
            entry.notes || '',
            entry.saved ? 'Да' : 'Нет',
        ]),
    ];
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(allData), 'Все симптомы');

    const summaryHeader = ['Симптом', 'Сумма', 'Минимум', 'Максимум', 'Дней с данными'];
    const summaryRows = SYMPTOMS.map(sym => {
        const vals = rows.map(r => r.entry[sym] ?? 0);
        const sum = vals.reduce((a, b) => a + b, 0);
        return [LABELS[sym], sum, Math.min(...vals), Math.max(...vals), vals.length];
    });
    XLSX.utils.book_append_sheet(
        wb,
        XLSX.utils.aoa_to_sheet([summaryHeader, ...summaryRows]),
        'Сводка'
    );

    SYMPTOMS.forEach(sym => {
        const sheetData = [
            ['Дата', LABELS[sym], 'Нагрузка упражнений', 'Упражнения', 'Лекарства', 'Заметки'],
            ...rows.map(({ date, entry }) => [
                date.toLocaleDateString('ru-RU'),
                entry[sym] ?? 0,
                calcExerciseLoad(entry),
                formatExerciseSummary(entry),
                entry.meds || '',
                entry.notes || '',
            ]),
        ];
        const sheetName = LABELS[sym].substring(0, 31);
        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(sheetData), sheetName);
    });

    const profile = state.profile;
    const infoRows = [
        ['Central Sensitization Tracker — выгрузка'],
        ['Период', getStatsPeriodTitle()],
        ['Дата выгрузки', new Date().toLocaleString('ru-RU')],
        ['Записей в периоде', rows.length],
        [],
        ['Пациент', profile.name || '—'],
        ['Возраст', profile.age || '—'],
        ['Пол', profile.gender === 'male' ? 'Мужской' : profile.gender === 'female' ? 'Женский' : profile.gender || '—'],
    ];
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(infoRows), 'Инфо');

    const filename = `CS_Tracker_${getStatsPeriodLabel()}_${formatDateInput(getToday())}.xlsx`;
    XLSX.writeFile(wb, filename);
    showToast(`Excel: ${rows.length} записей выгружено`);
}

function exportDoctorReport() {
    const rows = getExportRowsForPeriod();
    if (!rows.length) {
        showToastError('Нет данных за выбранный период');
        return;
    }

    const profile = state.profile || {};
    const periodTitle = getStatsPeriodTitle();
    const generatedAt = new Date().toLocaleString('ru-RU');
    const daySums = rows.map(r => calcEntrySum(r.entry));
    const avgIndex = daySums.reduce((a, b) => a + b, 0) / daySums.length;
    const maxIndex = Math.max(...daySums);
    const minIndex = Math.min(...daySums);
    const sparkW = 520;
    const sparkH = 120;
    const sparkPad = 10;
    const valueToY = (v) => sparkPad + ((70 - v) / 70) * (sparkH - sparkPad * 2);
    const sparkCoords = daySums.map((v, i) => {
        const x = daySums.length <= 1
            ? sparkW / 2
            : sparkPad + (i / (daySums.length - 1)) * (sparkW - sparkPad * 2);
        const y = valueToY(v);
        return { x, y, v, i };
    });
    const sparkPoints = sparkCoords.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
    const sparkLast = daySums[daySums.length - 1];
    const sparkLastX = daySums.length <= 1 ? sparkW / 2 : sparkW - sparkPad;
    const sparkLastY = valueToY(sparkLast);
    const minPoint = sparkCoords.find(p => p.v === minIndex) || sparkCoords[0];
    const maxPoint = sparkCoords.find(p => p.v === maxIndex) || sparkCoords[0];
    const minLabelY = Math.min(sparkH - sparkPad - 2, minPoint.y + 14);
    const maxLabelY = Math.max(sparkPad + 10, maxPoint.y - 10);
    const normalTop = valueToY(23);
    const riskTop = valueToY(47);
    const sparkFirstDate = rows[0].date.toLocaleDateString('ru-RU');
    const sparkLastDate = rows[rows.length - 1].date.toLocaleDateString('ru-RU');

    const symptomRows = SYMPTOMS.map(sym => {
        const values = rows.map(r => r.entry[sym] ?? 0);
        const sum = values.reduce((a, b) => a + b, 0);
        const avg = sum / values.length;
        const trend = calcTrend(sym, rows.map(r => r.date));
        return {
            label: LABELS[sym],
            avg: avg.toFixed(1),
            min: Math.min(...values),
            max: Math.max(...values),
            trend: trend.html.replace(/<[^>]+>/g, '').trim(),
        };
    });

    const notesRows = rows
        .filter(r => (r.entry.notes && r.entry.notes.trim()) || (r.entry.meds && r.entry.meds.trim()) || getExercises(r.entry).length)
        .slice(-15)
        .map(r => `
            <tr>
                <td>${escapeHtml(r.date.toLocaleDateString('ru-RU'))}</td>
                <td>${escapeHtml(formatExerciseSummary(r.entry) || '—')}</td>
                <td>${escapeHtml(r.entry.meds || '—')}</td>
                <td>${escapeHtml(r.entry.notes || '—')}</td>
            </tr>
        `)
        .join('');

    const html = `
<!doctype html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <title>Отчёт для врача</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; color:#1c1c1e; margin:24px; }
    h1 { margin: 0 0 4px; font-size: 22px; }
    h2 { margin: 24px 0 8px; font-size: 16px; }
    .muted { color:#666; font-size:12px; }
    .grid { display:grid; grid-template-columns: repeat(2, minmax(0,1fr)); gap:10px; margin-top:12px; }
    .card { border:1px solid #ddd; border-radius:10px; padding:10px; }
    .big { font-size:24px; font-weight:700; }
    table { width:100%; border-collapse: collapse; margin-top:8px; }
    th, td { border:1px solid #ddd; padding:8px; font-size:12px; text-align:left; vertical-align:top; }
    th { background:#f5f5f7; }
    .spark-wrap { border:1px solid #ddd; border-radius:10px; padding:10px; margin-top:8px; }
    .spark-head { display:flex; justify-content:space-between; align-items:baseline; margin-bottom:6px; }
    .spark-value { font-size:20px; font-weight:700; color:#007aff; }
    .spark-axis { display:flex; justify-content:space-between; margin-top:6px; color:#666; font-size:11px; }
    .spark-zones { display:flex; gap:10px; margin-top:6px; color:#666; font-size:11px; }
    .spark-zone { display:inline-flex; align-items:center; gap:5px; }
    .spark-zone-dot { width:10px; height:10px; border-radius:2px; }
    @media print { body { margin: 10mm; } }
  </style>
</head>
<body>
  <h1>Отчёт для врача</h1>
  <div class="muted">Период: ${escapeHtml(periodTitle)} · Сформирован: ${escapeHtml(generatedAt)}</div>

  <h2>Профиль пациента</h2>
  <table>
    <tr><th>Имя</th><td>${escapeHtml(profile.name || '—')}</td></tr>
    <tr><th>Возраст</th><td>${escapeHtml(profile.age || '—')}</td></tr>
    <tr><th>Пол</th><td>${escapeHtml(profile.gender === 'male' ? 'Мужской' : profile.gender === 'female' ? 'Женский' : profile.gender === 'other' ? 'Другой' : '—')}</td></tr>
  </table>

  <h2>Общая сводка</h2>
  <div class="grid">
    <div class="card"><div class="muted">Записей</div><div class="big">${rows.length}</div></div>
    <div class="card"><div class="muted">Средний индекс дня</div><div class="big">${avgIndex.toFixed(1)} / 70</div></div>
    <div class="card"><div class="muted">Минимальный индекс</div><div class="big">${minIndex}</div></div>
    <div class="card"><div class="muted">Максимальный индекс</div><div class="big">${maxIndex}</div></div>
  </div>

  <h2>Динамика общего индекса дня</h2>
  <div class="spark-wrap">
    <div class="spark-head">
      <div class="muted">Спарклайн суммы симптомов по дням (0–70)</div>
      <div class="spark-value">${sparkLast} / 70</div>
    </div>
    <svg viewBox="0 0 ${sparkW} ${sparkH}" width="100%" height="120" aria-label="Динамика общего индекса дня">
      <rect x="0" y="0" width="${sparkW}" height="${sparkH}" rx="8" fill="#f8f8fa"></rect>
      <rect x="${sparkPad}" y="${riskTop.toFixed(1)}" width="${(sparkW - sparkPad * 2).toFixed(1)}" height="${(normalTop - riskTop).toFixed(1)}" fill="rgba(255, 149, 0, 0.16)"></rect>
      <rect x="${sparkPad}" y="${sparkPad}" width="${(sparkW - sparkPad * 2).toFixed(1)}" height="${(riskTop - sparkPad).toFixed(1)}" fill="rgba(255, 59, 48, 0.16)"></rect>
      <line x1="${sparkPad}" y1="${normalTop.toFixed(1)}" x2="${(sparkW - sparkPad).toFixed(1)}" y2="${normalTop.toFixed(1)}" stroke="#34c759" stroke-width="1" stroke-dasharray="4 3"></line>
      <line x1="${sparkPad}" y1="${riskTop.toFixed(1)}" x2="${(sparkW - sparkPad).toFixed(1)}" y2="${riskTop.toFixed(1)}" stroke="#ff9500" stroke-width="1" stroke-dasharray="4 3"></line>
      <line x1="${sparkPad}" y1="${sparkH - sparkPad}" x2="${sparkW - sparkPad}" y2="${sparkH - sparkPad}" stroke="#e0e0e6" stroke-width="1"></line>
      <polyline points="${sparkPoints}" fill="none" stroke="#007aff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"></polyline>
      <circle cx="${minPoint.x.toFixed(1)}" cy="${minPoint.y.toFixed(1)}" r="4" fill="#34c759"></circle>
      <circle cx="${maxPoint.x.toFixed(1)}" cy="${maxPoint.y.toFixed(1)}" r="4" fill="#ff3b30"></circle>
      <circle cx="${sparkLastX.toFixed(1)}" cy="${sparkLastY.toFixed(1)}" r="4.5" fill="#007aff"></circle>
      <text x="${minPoint.x.toFixed(1)}" y="${minLabelY.toFixed(1)}" text-anchor="middle" font-size="11" fill="#1c1c1e">min ${minIndex}</text>
      <text x="${maxPoint.x.toFixed(1)}" y="${maxLabelY.toFixed(1)}" text-anchor="middle" font-size="11" fill="#1c1c1e">max ${maxIndex}</text>
    </svg>
    <div class="spark-axis"><span>${escapeHtml(sparkFirstDate)}</span><span>${escapeHtml(sparkLastDate)}</span></div>
    <div class="spark-zones">
      <span class="spark-zone"><span class="spark-zone-dot" style="background:rgba(52, 199, 89, 0.35)"></span>Норма: 0–23</span>
      <span class="spark-zone"><span class="spark-zone-dot" style="background:rgba(255, 149, 0, 0.35)"></span>Риск: 24–46</span>
      <span class="spark-zone"><span class="spark-zone-dot" style="background:rgba(255, 59, 48, 0.35)"></span>Высокий риск: 47–70</span>
    </div>
  </div>

  <h2>Симптомы (средние значения за период)</h2>
  <table>
    <thead>
      <tr>
        <th>Симптом</th>
        <th>Среднее</th>
        <th>Мин</th>
        <th>Макс</th>
        <th>Тренд</th>
      </tr>
    </thead>
    <tbody>
      ${symptomRows.map(r => `
        <tr>
          <td>${escapeHtml(r.label)}</td>
          <td>${escapeHtml(r.avg)}</td>
          <td>${escapeHtml(String(r.min))}</td>
          <td>${escapeHtml(String(r.max))}</td>
          <td>${escapeHtml(r.trend)}</td>
        </tr>
      `).join('')}
    </tbody>
  </table>

  <h2>Последние заметки и препараты</h2>
  <table>
    <thead>
      <tr><th>Дата</th><th>Упражнения</th><th>Препараты/добавки</th><th>Заметки</th></tr>
    </thead>
    <tbody>
      ${notesRows || '<tr><td colspan="4">Нет записей с упражнениями/заметками/препаратами</td></tr>'}
    </tbody>
  </table>
</body>
</html>`;

    const reportWindow = window.open('', '_blank');
    if (!reportWindow) {
        showToastError('Разрешите всплывающие окна для отчёта');
        return;
    }
    reportWindow.document.open();
    reportWindow.document.write(html);
    reportWindow.document.close();
    reportWindow.focus();
    showToast('Отчёт для врача сформирован');
}

// Statistics
function setRange(range, btn) {
    state.currentRange = range;
    state.customFrom = null;
    state.customTo = null;
    document.querySelectorAll('.range-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    renderStats();
}

function setCustomRange() {
    const from = document.getElementById('dateFrom').value;
    const to = document.getElementById('dateTo').value;
    if (!from || !to) return;
    state.customFrom = startOfDay(new Date(from + 'T00:00:00'));
    state.customTo = startOfDay(new Date(to + 'T00:00:00'));
    if (state.customFrom > state.customTo) return;
    state.currentRange = 'custom';
    document.querySelectorAll('.range-btn').forEach(b => b.classList.remove('active'));
    renderStats();
}

function getDatesForStats() {
    if (state.currentRange === 'custom' && state.customFrom && state.customTo) {
        const arr = [];
        const cur = new Date(state.customFrom);
        while (cur <= state.customTo) {
            arr.push(new Date(cur));
            cur.setDate(cur.getDate() + 1);
        }
        return arr;
    }

    const today = getToday();
    const days = state.currentRange === 'week' ? 7 : state.currentRange === 'month' ? 30 : 90;
    const arr = [];
    for (let i = days - 1; i >= 0; i--) {
        const d = new Date(today);
        d.setDate(d.getDate() - i);
        arr.push(d);
    }
    return arr;
}

/**
 * Тренд: сравнение среднего за раннюю и позднюю половину периода (по хронологии дат).
 * Рост симптома → стрелка вверх; снижение → вниз. Красный при росте ≥ 30%.
 */
function calcTrendFromSeries(series) {
    if (series.length < 4) {
        return { html: '<i class="fas fa-minus"></i> --%', cls: 'trend-stable' };
    }

    const mid = Math.floor(series.length / 2);
    const olderSum = series.slice(0, mid).reduce((a, b) => a + b, 0);
    const newerSum = series.slice(mid).reduce((a, b) => a + b, 0);

    if (olderSum === 0 && newerSum === 0) {
        return { html: '<i class="fas fa-minus"></i> 0%', cls: 'trend-stable' };
    }
    if (olderSum === 0) {
        return { html: '<i class="fas fa-arrow-up"></i> +100%', cls: 'trend-up trend-up-strong' };
    }

    const ch = Math.round(((newerSum - olderSum) / olderSum) * 100);

    if (ch > 5) {
        const cls = ch >= 30 ? 'trend-up trend-up-strong' : 'trend-up';
        return { html: '<i class="fas fa-arrow-up"></i> +' + ch + '%', cls };
    }
    if (ch < -5) {
        return { html: '<i class="fas fa-arrow-down"></i> ' + ch + '%', cls: 'trend-down' };
    }
    const sign = ch > 0 ? '+' : '';
    return { html: '<i class="fas fa-minus"></i> ' + sign + ch + '%', cls: 'trend-stable' };
}

function calcTrend(sym, dates) {
    const series = [];
    dates.forEach(d => {
        const entry = state.data[dateKey(d)];
        if (!hasRecord(entry)) return;
        series.push(entry[sym] ?? 0);
    });
    return calcTrendFromSeries(series);
}

function renderStats() {
    const dates = getDatesForStats();

    let statsHtml = '';
    const dayEntries = dates
        .map(d => state.data[dateKey(d)])
        .filter(hasRecord);
    const daySums = dayEntries.map(calcEntrySum);
    const avgIndex = daySums.length
        ? (daySums.reduce((a, b) => a + b, 0) / daySums.length)
        : null;
    const indexTrend = calcTrendFromSeries(daySums);

    statsHtml += `
        <div class="stat-card stat-card-overall">
            <div class="stat-head">
                <div class="stat-icon stat-icon-overall"><i class="fas fa-gauge-high"></i></div>
                <div class="stat-title-row">
                    <span class="stat-label-title">Общий индекс дня</span>
                    <span class="stat-trend ${indexTrend.cls}">${indexTrend.html}</span>
                </div>
                <span class="stat-value">${avgIndex === null ? '--' : avgIndex.toFixed(1) + '/70'}</span>
            </div>
            <div class="stat-label-desc">${daySums.length} дн. · средний суммарный индекс за день</div>
        </div>`;

    SYMPTOMS.forEach(sym => {
        const vals = dates
            .map(d => state.data[dateKey(d)])
            .filter(hasRecord)
            .map(entry => entry[sym] ?? 0);

        const sum = vals.length > 0
            ? vals.reduce((a, b) => a + b, 0)
            : '--';
        const avgForColor = vals.length > 0 ? (sum / vals.length) : null;
        const valueCls = avgForColor !== null && avgForColor >= 7 ? 'stat-value stat-value-high' : 'stat-value';
        const trend = calcTrend(sym, dates);

        statsHtml += `
        <div class="stat-card">
            <div class="stat-head">
                <div class="stat-icon icon-${sym}"><i class="fas ${ICONS[sym]}"></i></div>
                <div class="stat-title-row">
                    <span class="stat-label-title">${LABELS[sym]}</span>
                    <span class="stat-trend ${trend.cls}">${trend.html}</span>
                </div>
                <span class="${valueCls}">${sum}</span>
            </div>
            <div class="stat-label-desc">${vals.length} дн. · ${DESCS[sym]}</div>
        </div>`;
    });
    document.getElementById('statsGrid').innerHTML = statsHtml;
    renderCharts();

    const rows = getExportRowsForPeriod();
    const patternsEl = document.getElementById('patternsContainer');
    if (!patternsEl) return;
    if (!rows.length) {
        patternsEl.innerHTML = '';
        return;
    }

    const indexValues = [];
    const symptomValues = {};
    SYMPTOMS.forEach(sym => { symptomValues[sym] = []; });

    rows.forEach(({ entry }) => {
        const sum = calcEntrySum(entry);
        indexValues.push(sum);
        SYMPTOMS.forEach(sym => {
            symptomValues[sym].push(entry[sym] ?? 0);
        });
    });

    function pearson(x, y) {
        const n = x.length;
        if (n !== y.length || n < 3) return null;
        let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
        for (let i = 0; i < n; i++) {
            const xi = x[i];
            const yi = y[i];
            sx += xi; sy += yi;
            sxx += xi * xi; syy += yi * yi;
            sxy += xi * yi;
        }
        const cov = sxy / n - (sx / n) * (sy / n);
        const vx = sxx / n - (sx / n) ** 2;
        const vy = syy / n - (sy / n) ** 2;
        if (vx <= 0 || vy <= 0) return null;
        return cov / Math.sqrt(vx * vy);
    }

    const corrItems = [];
    SYMPTOMS.forEach(sym => {
        const r = pearson(indexValues, symptomValues[sym]);
        if (r == null) return;
        corrItems.push({ sym, r });
    });
    corrItems.sort((a, b) => Math.abs(b.r) - Math.abs(a.r));
    const topCorr = corrItems.filter(it => Math.abs(it.r) >= 0.4).slice(0, 3);
    const exerciseLoad = rows.map(({ entry }) => calcExerciseLoad(entry));
    const painValues = rows.map(({ entry }) => entry.pain ?? 0);
    const exercisePainCorr = pearson(exerciseLoad, painValues);
    const exerciseIndexCorr = pearson(exerciseLoad, indexValues);

    const dowSums = Array(7).fill(0);
    const dowCounts = Array(7).fill(0);
    rows.forEach(({ date, entry }) => {
        const idx = (date.getDay() + 6) % 7; // Monday=0
        dowSums[idx] += calcEntrySum(entry);
        dowCounts[idx] += 1;
    });
    const dowAvg = dowSums.map((s, i) => dowCounts[i] ? s / dowCounts[i] : null);
    const weekdayNames = ['Пн','Вт','Ср','Чт','Пт','Сб','Вс'];
    let maxDow = null, minDow = null;
    dowAvg.forEach((v, i) => {
        if (v == null) return;
        if (!maxDow || v > maxDow.v) maxDow = { i, v };
        if (!minDow || v < minDow.v) minDow = { i, v };
    });

    const items = [];
    if (topCorr.length) {
        const parts = topCorr.map(it => {
            const dir = it.r > 0 ? 'растёт вместе с индексом' : 'снижается при росте индекса';
            return `${LABELS[it.sym]} (r=${it.r.toFixed(2)}, ${dir})`;
        });
        items.push(`Сильнее всего с общим индексом дня связаны: ${parts.join('; ')}.`);
    }
    const hasExerciseData = exerciseLoad.some(v => v > 0);
    if (hasExerciseData && exercisePainCorr != null) {
        const direction = exercisePainCorr > 0 ? 'выше' : 'ниже';
        items.push(`Нагрузка упражнений и боль: r=${exercisePainCorr.toFixed(2)} — при большей нагрузке боль в среднем ${direction}.`);
    }
    if (hasExerciseData && exerciseIndexCorr != null) {
        const direction = exerciseIndexCorr > 0 ? 'выше' : 'ниже';
        items.push(`Нагрузка упражнений и общий индекс дня: r=${exerciseIndexCorr.toFixed(2)} — индекс в среднем ${direction} при росте нагрузки.`);
    }
    if (maxDow && minDow && Math.abs(maxDow.v - minDow.v) >= 3) {
        items.push(`По дням недели нагрузка максимальна в ${weekdayNames[maxDow.i]} и минимальна в ${weekdayNames[minDow.i]} (разница ≈ ${Math.round(maxDow.v - minDow.v)} баллов по индексу дня).`);
    }
    if (!items.length) {
        items.push('Паттерны по периоду не выражены (недостаточно данных или слабые связи).');
    }

    patternsEl.innerHTML = `
        <div class="patterns-title">Корреляции и паттерны за период</div>
        <ul class="patterns-list">
            ${items.map(text => `<li>${text}</li>`).join('')}
        </ul>
    `;
}

function addDays(date, days) {
    const d = new Date(date);
    d.setDate(d.getDate() + days);
    return startOfDay(d);
}

function startOfWeekMonday(date) {
    const d = startOfDay(date);
    const day = d.getDay();
    const diff = day === 0 ? -6 : 1 - day;
    d.setDate(d.getDate() + diff);
    return d;
}

function formatShortDate(date) {
    return date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
}

function formatDateRange(dates) {
    if (!dates.length) return '';
    if (dates.length === 1) return formatShortDate(dates[0]);
    return `${formatShortDate(dates[0])} — ${formatShortDate(dates[dates.length - 1])}`;
}

function getSymptomValue(date, sym) {
    const entry = state.data[dateKey(date)];
    if (!hasRecord(entry)) return { v: 0, hasData: false };
    if (sym === 'overall') {
        const sum = calcEntrySum(entry);
        return { v: sum / SYMPTOMS.length, raw: sum, max: 70, hasData: true };
    }
    const value = entry[sym] ?? 0;
    return { v: value, raw: value, max: 10, hasData: true };
}

function chartSeriesLabel(sym) {
    return sym === 'overall' ? 'Общий индекс' : LABELS[sym];
}

function chartSeriesColor(sym) {
    return sym === 'overall' ? '#0A84FF' : COLORS[sym];
}

function initChartFilters() {
    const container = document.getElementById('chartFilters');
    if (!container || container.dataset.inited) return;
    container.dataset.inited = '1';

    let html = '<button type="button" class="chart-filter-btn active" data-symptom="all" onclick="setChartFilter(\'all\', this)">Все</button>';
    SYMPTOMS.forEach(sym => {
        html += `<button type="button" class="chart-filter-btn" data-symptom="${sym}" style="--filter-color:${COLORS[sym]}" onclick="setChartFilter('${sym}', this)">${LABELS[sym]}</button>`;
    });
    container.innerHTML = html;
}

function initChartCompareFilters() {
    const container = document.getElementById('chartCompareFilters');
    if (!container || container.dataset.inited) return;
    container.dataset.inited = '1';

    const modes = [
        { id: 'off', label: 'Выкл' },
        { id: 'day', label: 'День к дню' },
        { id: 'week', label: 'Неделя к неделе' },
        { id: 'month', label: 'Месяц к месяцу' },
        { id: 'period', label: 'Период к периоду' },
    ];

    container.innerHTML = modes.map(m => `
        <button type="button" class="chart-filter-btn chart-compare-btn${m.id === 'off' ? ' active' : ''}"
            data-compare="${m.id}" onclick="setChartCompare('${m.id}', this)">${m.label}</button>
    `).join('');
}

function setChartFilter(symptom, btn) {
    state.chartFilter = symptom;
    document.querySelectorAll('.chart-filter-btn[data-symptom]').forEach(b => {
        b.classList.toggle('active', b === btn);
    });
    renderSymptomsLineChart();
}

function setChartCompare(mode, btn) {
    state.chartCompare = mode;
    document.querySelectorAll('.chart-compare-btn').forEach(b => {
        b.classList.toggle('active', b === btn);
    });
    renderCharts();
}

function getActiveChartSymptoms() {
    if (state.chartFilter === 'overall') state.chartFilter = 'all';
    return state.chartFilter === 'all' ? [...SYMPTOMS] : [state.chartFilter];
}

function getOverallIndexForDate(date) {
    const entry = state.data[dateKey(date)];
    if (!hasRecord(entry)) return { raw: 0, hasData: false };
    const sum = calcEntrySum(entry);
    return { raw: sum, hasData: true };
}

function buildTimelineContext() {
    const dates = getDatesForStats();
    return {
        type: 'timeline',
        labels: dates.map(d => `${d.getDate()}.${String(d.getMonth() + 1).padStart(2, '0')}`),
        subtitle: 'Непрерывная линия по всем дням выбранного периода. Точки — только на днях с записью.',
        series: [{ key: 'current', label: 'Выбранный период', dates, dashed: false }],
    };
}

function buildDayCompareContext() {
    const rangeDates = getDatesForStats();
    const n = Math.min(7, rangeDates.length) || 7;
    const today = getToday();
    const currentDates = [];
    for (let i = n - 1; i >= 0; i--) currentDates.push(addDays(today, -i));
    const previousDates = currentDates.map(d => addDays(d, -n));
    const labels = currentDates.map(d => `${d.getDate()}.${String(d.getMonth() + 1).padStart(2, '0')}`);

    return {
        type: 'compare',
        labels,
        subtitle: `День к дню: ${formatDateRange(currentDates)} (сплошная) vs ${formatDateRange(previousDates)} (пунктир).`,
        series: [
            { key: 'current', label: `Текущие ${n} дн.`, dates: currentDates, dashed: false },
            { key: 'previous', label: `Предыдущие ${n} дн.`, dates: previousDates, dashed: true },
        ],
    };
}

function buildWeekCompareContext() {
    const today = getToday();
    const monday = startOfWeekMonday(today);
    const prevMonday = addDays(monday, -7);
    const weekdayLabels = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
    const currentDates = weekdayLabels.map((_, i) => addDays(monday, i));
    const previousDates = weekdayLabels.map((_, i) => addDays(prevMonday, i));

    return {
        type: 'compare',
        labels: weekdayLabels,
        subtitle: `Неделя к неделе: ${formatDateRange(currentDates)} vs ${formatDateRange(previousDates)}.`,
        series: [
            { key: 'current', label: 'Эта неделя', dates: currentDates, dashed: false },
            { key: 'previous', label: 'Прошлая неделя', dates: previousDates, dashed: true },
        ],
    };
}

function buildMonthCompareContext() {
    const today = getToday();
    const y = today.getFullYear();
    const m = today.getMonth();
    const daysInMonth = new Date(y, m + 1, 0).getDate();
    const prevM = m === 0 ? 11 : m - 1;
    const prevY = m === 0 ? y - 1 : y;
    const daysInPrev = new Date(prevY, prevM + 1, 0).getDate();

    const labels = [];
    const currentDates = [];
    const previousDates = [];
    for (let day = 1; day <= daysInMonth; day++) {
        labels.push(String(day));
        currentDates.push(new Date(y, m, day));
        previousDates.push(new Date(prevY, prevM, Math.min(day, daysInPrev)));
    }

    const monthNames = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
    return {
        type: 'compare',
        labels,
        subtitle: `Месяц к месяцу: ${monthNames[m]} ${y} (сплошная) vs ${monthNames[prevM]} ${prevY} (пунктир), по числам месяца.`,
        series: [
            { key: 'current', label: `${monthNames[m]} ${y}`, dates: currentDates, dashed: false },
            { key: 'previous', label: `${monthNames[prevM]} ${prevY}`, dates: previousDates, dashed: true },
        ],
    };
}

function buildPeriodCompareContext() {
    const currentDates = getDatesForStats();
    const len = currentDates.length;
    if (len === 0) return null;

    const prevEnd = addDays(currentDates[0], -1);
    const previousDates = [];
    for (let i = 0; i < len; i++) {
        previousDates.push(addDays(prevEnd, i - (len - 1)));
    }

    const labels = currentDates.map((d, i) => {
        if (len <= 14) return `${d.getDate()}.${String(d.getMonth() + 1).padStart(2, '0')}`;
        return `Д${i + 1}`;
    });

    return {
        type: 'compare',
        labels,
        subtitle: `Период к периоду (${len} дн.): ${formatDateRange(currentDates)} vs ${formatDateRange(previousDates)}.`,
        series: [
            { key: 'current', label: formatDateRange(currentDates), dates: currentDates, dashed: false },
            { key: 'previous', label: formatDateRange(previousDates), dates: previousDates, dashed: true },
        ],
    };
}

function getChartContext() {
    switch (state.chartCompare) {
        case 'day': return buildDayCompareContext();
        case 'week': return buildWeekCompareContext();
        case 'month': return buildMonthCompareContext();
        case 'period': return buildPeriodCompareContext();
        default: return buildTimelineContext();
    }
}

function contextHasData(ctx) {
    return ctx.series.some(ser =>
        ser.dates.some(date => hasRecord(state.data[dateKey(date)]))
    );
}

function buildLinePath(points) {
    if (!points.length) return '';
    return points.map((p, idx) => `${idx === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
}

function isMobileChartView() {
    return typeof window !== 'undefined' && window.matchMedia('(max-width: 768px)').matches;
}

function getOverallChartMetrics() {
    const mobile = isMobileChartView();
    return {
        W: 900,
        H: mobile ? 200 : 140,
        pad: mobile ? { t: 18, r: 24, b: 32, l: 44 } : { t: 14, r: 20, b: 24, l: 38 },
        pointR: mobile ? 6 : 4.5,
        lineWidth: mobile ? 3.5 : 3,
        dashedLineWidth: mobile ? 2.5 : 2
    };
}

function getSymptomsChartMetrics(pointCount) {
    const mobile = isMobileChartView();
    const n = Math.max(1, pointCount || 1);
    return {
        W: mobile ? Math.max(720, n * 48) : 900,
        H: mobile ? 400 : 300,
        pad: mobile ? { t: 32, r: 32, b: 60, l: 52 } : { t: 28, r: 28, b: 52, l: 48 },
        pointR: mobile ? 6.5 : 5,
        lineWidth: mobile ? 3 : 2.5,
        dashedLineWidth: mobile ? 2.5 : 2
    };
}

function renderCharts() {
    initChartCompareFilters();
    initChartFilters();
    renderOverallSparklineChart();
    renderSymptomsLineChart();
}

function renderOverallSparklineChart() {
    const emptyEl = document.getElementById('overallChartEmpty');
    const wrapEl = document.getElementById('overallChartWrap');
    const svgEl = document.getElementById('overallIndexChart');
    const subtitleEl = document.getElementById('overallChartSubtitle');
    const axisEl = document.getElementById('overallChartAxis');
    const lastValueEl = document.getElementById('overallChartLastValue');
    const legendEl = document.getElementById('overallChartLegend');

    if (!emptyEl || !wrapEl || !svgEl) return;

    const ctx = getChartContext();
    if (!ctx || !ctx.series.length || !ctx.labels.length || !contextHasData(ctx)) {
        emptyEl.classList.add('visible');
        wrapEl.classList.remove('visible');
        svgEl.innerHTML = '';
        if (legendEl) legendEl.innerHTML = '';
        if (subtitleEl) subtitleEl.textContent = '';
        if (axisEl) axisEl.innerHTML = '';
        if (lastValueEl) lastValueEl.textContent = '— / 70';
        return;
    }

    emptyEl.classList.remove('visible');
    wrapEl.classList.add('visible');
    if (subtitleEl) subtitleEl.textContent = ctx.subtitle || '';

    const n = ctx.labels.length;
    const metrics = getOverallChartMetrics();
    const { W, H, pad, pointR, lineWidth, dashedLineWidth } = metrics;
    svgEl.setAttribute('viewBox', `0 0 ${W} ${H}`);
    const plotW = W - pad.l - pad.r;
    const plotH = H - pad.t - pad.b;
    const xAt = (i) => pad.l + (n <= 1 ? plotW / 2 : (i / (n - 1)) * plotW);
    const yAt = (v) => pad.t + plotH - (Math.min(70, Math.max(0, v)) / 70) * plotH;
    const normalTop = yAt(23);
    const riskTop = yAt(47);
    const overallColor = '#0A84FF';

    let svg = `<rect x="0" y="0" width="${W}" height="${H}" rx="8" fill="#f8f8fa"></rect>`;
    svg += `<rect x="${pad.l}" y="${riskTop.toFixed(1)}" width="${plotW.toFixed(1)}" height="${(normalTop - riskTop).toFixed(1)}" fill="rgba(255, 149, 0, 0.14)"></rect>`;
    svg += `<rect x="${pad.l}" y="${pad.t}" width="${plotW.toFixed(1)}" height="${(riskTop - pad.t).toFixed(1)}" fill="rgba(255, 59, 48, 0.12)"></rect>`;
    svg += `<line x1="${pad.l}" y1="${normalTop.toFixed(1)}" x2="${(W - pad.r).toFixed(1)}" y2="${normalTop.toFixed(1)}" stroke="#34c759" stroke-width="1" stroke-dasharray="4 3" opacity="0.7"></line>`;
    svg += `<line x1="${pad.l}" y1="${riskTop.toFixed(1)}" x2="${(W - pad.r).toFixed(1)}" y2="${riskTop.toFixed(1)}" stroke="#ff9500" stroke-width="1" stroke-dasharray="4 3" opacity="0.7"></line>`;

    [0, 23, 47, 70].forEach(v => {
        const y = yAt(v);
        svg += `<line x1="${pad.l}" y1="${y.toFixed(1)}" x2="${(W - pad.r).toFixed(1)}" y2="${y.toFixed(1)}" class="chart-grid"></line>`;
        svg += `<text x="${pad.l - 8}" y="${(y + 4).toFixed(1)}" class="chart-axis-y">${v}</text>`;
    });

    const labelStep = n > 20 ? Math.ceil(n / 10) : n > 10 ? 2 : 1;
    ctx.labels.forEach((lbl, i) => {
        if (i % labelStep !== 0 && i !== n - 1) return;
        svg += `<text x="${xAt(i).toFixed(1)}" y="${(H - 6).toFixed(1)}" text-anchor="middle" class="chart-axis-x">${lbl}</text>`;
    });

    let lastRecorded = null;
    let minPoint = null;
    let maxPoint = null;

    ctx.series.forEach(ser => {
        const points = ser.dates.map((date, i) => {
            const { raw, hasData } = getOverallIndexForDate(date);
            return { x: xAt(i), y: yAt(raw), raw, hasData, date };
        });
        const plotted = points.filter(p => p.hasData);
        if (!plotted.length) return;

        plotted.forEach(p => {
            if (!minPoint || p.raw < minPoint.raw) minPoint = p;
            if (!maxPoint || p.raw > maxPoint.raw) maxPoint = p;
        });
        if (!ser.dashed) lastRecorded = plotted[plotted.length - 1];

        const pathD = buildLinePath(plotted);
        const width = ser.dashed ? dashedLineWidth : lineWidth;
        const dashAttr = ser.dashed ? ' stroke-dasharray="7 5"' : '';
        const stroke = ser.dashed ? '#8E8E93' : overallColor;
        svg += `<path d="${pathD}" fill="none" stroke="${stroke}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round" opacity="${ser.dashed ? 0.85 : 1}"${dashAttr}></path>`;

        plotted.forEach(p => {
            svg += `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${pointR}" fill="${stroke}" stroke="#fff" stroke-width="2">`;
            svg += `<title>Общий индекс · ${ser.label} · ${lblDate(p.date)}: ${p.raw}/70</title></circle>`;
        });
    });

    if (minPoint && maxPoint && minPoint.raw !== maxPoint.raw) {
        const minLabelY = Math.min(H - pad.b - 2, minPoint.y + 14);
        const maxLabelY = Math.max(pad.t + 10, maxPoint.y - 8);
        svg += `<text x="${minPoint.x.toFixed(1)}" y="${minLabelY.toFixed(1)}" text-anchor="middle" class="chart-value" fill="#34c759">min ${minPoint.raw}</text>`;
        svg += `<text x="${maxPoint.x.toFixed(1)}" y="${maxLabelY.toFixed(1)}" text-anchor="middle" class="chart-value" fill="#ff3b30">max ${maxPoint.raw}</text>`;
    }

    svgEl.innerHTML = svg;

    const primarySeries = ctx.series.find(s => !s.dashed) || ctx.series[0];
    if (axisEl && primarySeries?.dates?.length) {
        const first = primarySeries.dates[0];
        const last = primarySeries.dates[primarySeries.dates.length - 1];
        axisEl.innerHTML = `<span>${lblDate(first)}</span><span>${lblDate(last)}</span>`;
    }
    if (lastValueEl) {
        lastValueEl.textContent = lastRecorded ? `${lastRecorded.raw} / 70` : '— / 70';
    }
    if (legendEl) {
        if (ctx.type === 'compare') {
            legendEl.innerHTML = ctx.series.map(ser => `
                <span class="chart-legend-item">
                    <span class="chart-legend-dot" style="background:${ser.dashed ? 'transparent' : overallColor};border:2px solid ${ser.dashed ? '#8E8E93' : overallColor};${ser.dashed ? 'border-style:dashed' : ''}"></span>
                    ${ser.label}${ser.dashed ? ' (пунктир)' : ''}
                </span>
            `).join('');
        } else {
            legendEl.innerHTML = `<span class="chart-legend-item"><span class="chart-legend-dot" style="background:${overallColor}"></span>Общий индекс дня (0–70)</span>`;
        }
    }
}

function renderSymptomsLineChart() {
    initChartFilters();

    const emptyEl = document.getElementById('chartEmpty');
    const wrapEl = document.getElementById('lineChartWrap');
    const svgEl = document.getElementById('symptomChart');
    const legendEl = document.getElementById('chartLegend');
    const subtitleEl = document.getElementById('chartSubtitle');

    if (!emptyEl || !wrapEl || !svgEl || !legendEl) return;

    const ctx = getChartContext();
    if (!ctx || !ctx.series.length || !ctx.labels.length || !contextHasData(ctx)) {
        emptyEl.classList.add('visible');
        wrapEl.classList.remove('visible');
        svgEl.innerHTML = '';
        legendEl.innerHTML = '';
        if (subtitleEl) subtitleEl.textContent = '';
        return;
    }

    emptyEl.classList.remove('visible');
    wrapEl.classList.add('visible');
    if (subtitleEl) subtitleEl.textContent = 'Шкала 0–10 по каждому симптому. ' + (ctx.subtitle || '');

    const symptoms = getActiveChartSymptoms();
    const n = ctx.labels.length;
    const metrics = getSymptomsChartMetrics(n);
    const { W, H, pad, pointR, lineWidth, dashedLineWidth } = metrics;
    svgEl.setAttribute('viewBox', `0 0 ${W} ${H}`);
    const plotW = W - pad.l - pad.r;
    const plotH = H - pad.t - pad.b;

    const xAt = (i) => pad.l + (n <= 1 ? plotW / 2 : (i / (n - 1)) * plotW);
    const yAt = (v) => pad.t + plotH - (Math.min(10, Math.max(0, v)) / 10) * plotH;

    let svg = '';

    svg += `<rect x="${pad.l}" y="${pad.t}" width="${plotW}" height="${plotH}" fill="none" stroke="#e2e8f0" stroke-width="1" rx="4"/>`;

    [0, 2, 4, 6, 8, 10].forEach(v => {
        const y = yAt(v);
        svg += `<line x1="${pad.l}" y1="${y}" x2="${W - pad.r}" y2="${y}" class="chart-grid"/>`;
        svg += `<text x="${pad.l - 10}" y="${y + 4}" class="chart-axis-y">${v}</text>`;
    });

    const labelStep = n > 20 ? Math.ceil(n / 12) : n > 10 ? 2 : 1;
    ctx.labels.forEach((lbl, i) => {
        if (i % labelStep !== 0 && i !== n - 1) return;
        svg += `<text x="${xAt(i)}" y="${H - 14}" text-anchor="middle" class="chart-axis-x">${lbl}</text>`;
    });

    const showValues = n <= 14 && (state.chartFilter !== 'all' || ctx.type === 'compare');

    ctx.series.forEach(ser => {
        symptoms.forEach(sym => {
            const color = chartSeriesColor(sym);
            const points = ser.dates.map((date, i) => {
                const { v, raw, max, hasData } = getSymptomValue(date, sym);
                return { x: xAt(i), y: yAt(v), v, raw, max, hasData, date };
            });

            const pathD = buildLinePath(points);
            if (!pathD) return;

            const width = ser.dashed ? dashedLineWidth : lineWidth;
            const opacity = ser.dashed ? 0.8 : 1;
            const dashAttr = ser.dashed ? ' stroke-dasharray="7 5"' : '';

            svg += `<path d="${pathD}" fill="none" stroke="${color}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round" opacity="${opacity}"${dashAttr}/>`;

            points.forEach(p => {
                if (!p.hasData) return;
                svg += `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${pointR}" fill="${color}" stroke="#fff" stroke-width="2">`;
                svg += `<title>${chartSeriesLabel(sym)} · ${ser.label} · ${lblDate(p.date)}: ${p.raw}/${p.max}</title></circle>`;
                if (showValues) {
                    svg += `<text x="${p.x.toFixed(1)}" y="${(p.y - 10).toFixed(1)}" text-anchor="middle" class="chart-value" fill="${color}">${p.raw}</text>`;
                }
            });
        });
    });

    svgEl.innerHTML = svg;

    let legendHtml = '';
    if (ctx.type === 'compare') {
        ctx.series.forEach(ser => {
            legendHtml += `<span class="chart-legend-item">
                <span class="chart-legend-dot" style="background:${ser.dashed ? 'transparent' : 'var(--primary)'};border:2px solid var(--primary);${ser.dashed ? 'border-style:dashed' : ''}"></span>
                ${ser.label}${ser.dashed ? ' (пунктир)' : ' (сплошная)'}
            </span>`;
        });
        if (state.chartFilter !== 'all') {
            legendHtml += `<span class="chart-legend-item"><span class="chart-legend-dot" style="background:${chartSeriesColor(state.chartFilter)}"></span>${chartSeriesLabel(state.chartFilter)}</span>`;
        }
    } else {
        legendHtml = symptoms.map(sym => `
            <span class="chart-legend-item">
                <span class="chart-legend-dot" style="background:${chartSeriesColor(sym)}"></span>
                ${chartSeriesLabel(sym)}
            </span>
        `).join('');
    }
    legendEl.innerHTML = legendHtml;
}

function lblDate(date) {
    return date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
}
