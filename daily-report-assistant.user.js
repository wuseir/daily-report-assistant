// ==UserScript==
// @name         项目日报助手 · 批量填写面板
// @namespace    local.daily-report-assistant
// @version      1.0.0
// @description  选择项目、导入 Markdown、预览后通过网页表单批量保存和提交日报。
// @match        https://projgrg.grgbanking.com/*
// @run-at       document-idle
// @grant        none
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  const VERSION = '1.0.0';
  const norm = value => String(value ?? '').replace(/\s+/g, '');
  const clean = value => String(value ?? '').replace(/\r\n?/g, '\n').trim();
  const ensure = (condition, message) => { if (!condition) throw new Error(message); };
  function today() {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
    return ['year', 'month', 'day'].map(type => parts.find(p => p.type === type).value).join('-');
  }
  function parseDate(value, year) {
    const match = String(value).trim().replace(/^\*+/, '').match(/^(?:(\d{4})[-/.年])?(\d{1,2})[-/.月](\d{1,2})日?(?:\s*[（(].*?[）)])?\s*[:：]?$/);
    if (!match) return null;
    const y = Number(match[1] || year), m = Number(match[2]), d = Number(match[3]);
    const date = new Date(Date.UTC(y, m - 1, d));
    ensure(y >= 2000 && y <= 2100 && date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d, `无效日期：${value}`);
    return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
  function normalizeContent(value, title = '') {
    const lines = clean(value).replace(/<br\s*\/?\s*>/gi, '\n').split('\n').map(s => s.trim()).filter(Boolean);
    if (title.trim()) {
      const prefix = title.trim().replace(/[:：]+$/, '') + '：';
      if (lines[0] && /[:：]$/.test(lines[0]) && !/^\d+[、.]/.test(lines[0])) lines[0] = prefix;
      else lines.unshift(prefix);
    }
    return lines.join('\n');
  }
  function splitCells(line) {
    const cells = []; let cell = '', escaped = false;
    for (const char of line.trim().replace(/^\|/, '').replace(/\|$/, '')) {
      if (escaped) { cell += char === '|' ? '|' : '\\' + char; escaped = false; }
      else if (char === '\\') escaped = true;
      else if (char === '|') { cells.push(cell.trim()); cell = ''; }
      else cell += char;
    }
    cells.push((cell + (escaped ? '\\' : '')).trim()); return cells;
  }
  function parseMarkdown(text, options = {}) {
    const year = Number(options.year || today().slice(0, 4));
    const hours = Number(options.hours ?? 8), title = options.title || '';
    ensure(Number.isFinite(hours) && hours > 0 && hours <= 24, '每日工时必须大于 0 且不超过 24。');
    const result = []; let current = null, sectionsSeen = false, appendix = false;
    const append = (date, content) => {
      const normalized = normalizeContent(content, title);
      ensure(normalized, `${date} 的工作内容为空。`);
      ensure(normalized.length <= 3000, `${date} 的工作内容超过网站的 3000 字限制。`);
      ensure(!result.some(r => r.date === date), `日期重复：${date}，请合并为一条。`);
      result.push({ date, hours, content: normalized, selected: date <= today(), status: '待处理' });
    };
    const flush = () => { if (current) { append(current.date, current.lines.join('\n')); current = null; } };
    for (const line of clean(text).split('\n')) {
      if (/^\s*\|/.test(line)) {
        const cells = splitCells(line);
        const date = !appendix && cells.length === 2 ? parseDate(cells[0], year) : null;
        if (date) { flush(); append(date, cells.slice(1).join(' | ')); }
        continue;
      }
      const candidate = line.trim().replace(/^#{1,6}\s*/, '');
      const date = parseDate(candidate, year);
      if (date) { flush(); sectionsSeen = true; appendix = false; current = { date, lines: [] }; }
      else if (/^#{1,6}\s+/.test(line)) { flush(); appendix = sectionsSeen; }
      else if (current) current.lines.push(line);
    }
    flush();
    ensure(result.length, '未识别到日报。请使用“## 10/10”分段，或“日期 | 工作内容”表格。');
    return result.sort((a, b) => a.date.localeCompare(b.date));
  }
  const Core = { VERSION, parseDate, normalizeContent, parseMarkdown, today };
  if (typeof module !== 'undefined' && module.exports) { module.exports = Core; return; }
  if (window.top !== window.self || window.__dailyReportAssistant) return;
  if (location.hostname !== 'projgrg.grgbanking.com' && !window.__DAILY_PANEL_TEST__) return;

  const state = { reports: [], projects: [], project: null, running: false, stop: false, logs: [], lastReadComplete: false, approver: null, pendingResume: null };
  const $all = (root, selector) => [...root.querySelectorAll(selector)];
  const visible = el => Boolean(el && el.isConnected && el.getClientRects().length && el.ownerDocument.defaultView.getComputedStyle(el).visibility !== 'hidden');
  const canClick = el => visible(el) && !el.disabled && !el.classList.contains('disabled');
  function windows(root = window) {
    const list = [];
    const visit = win => {
      try {
        void win.document.body; list.push(win);
        for (const iframe of win.document.querySelectorAll('iframe')) if (visible(iframe) && iframe.contentWindow) visit(iframe.contentWindow);
      } catch { /* 非同源框架不属于日报工作区。 */ }
    };
    visit(root); return list;
  }
  function reportWindow() {
    const win = windows().find(w => w.document.querySelector('th[data-field="record_date"]') && w.document.querySelector('th[data-field="pmwork_id"]'));
    ensure(win, '请先在网站左侧打开“日报填写/审核 → 我的日报”，再操作面板。');
    return win;
  }
  function button(doc, label, name) {
    if (name) { const found = $all(doc, `[name="${name}"]`).find(visible); if (found) return found; }
    return $all(doc, 'button,a,[role="button"]').find(el => visible(el) && norm(el.textContent) === norm(label));
  }
  function click(el, description) {
    ensure(canClick(el), `${description || '目标控件'} 当前不可操作。`);
    el.click();
  }
  async function waitFor(check, description, timeout = 18000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const result = check(); if (result) return result;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`等待超时：${description}。请检查网页后重新预览。`);
  }
  async function settle(doc) {
    await new Promise(resolve => {
      let quiet; const finish = () => { clearTimeout(quiet); clearTimeout(limit); observer.disconnect(); resolve(); };
      const observer = new MutationObserver(() => { clearTimeout(quiet); quiet = setTimeout(finish, 250); });
      const limit = setTimeout(finish, 1600);
      observer.observe(doc.body, { childList: true, subtree: true, attributes: true }); quiet = setTimeout(finish, 250);
    });
  }
  function ajaxAction(win, path, trigger, timeout = 25000) {
    // 只监听网页自身请求的完成结果；不构造、重放或篡改业务请求。
    ensure(typeof win.jQuery === 'function', '网页请求监听不可用，请刷新网站后再试。');
    return new Promise((resolve, reject) => {
      const namespace = `.dailyPanel${Date.now()}${Math.random().toString(36).slice(2)}`;
      const scopes = [...new Set([win, ...windows()])].filter(w => typeof w.jQuery === 'function').map(w => w.jQuery(w.document));
      let timer;
      const finish = (error, value) => { clearTimeout(timer); scopes.forEach(jq => jq.off(namespace)); error ? reject(error) : resolve(value); };
      const handler = (event, xhr, settings) => {
        let requestPath;
        try { requestPath = new URL(settings.url, win.location.href).pathname; } catch { return; }
        if (requestPath !== path) return;
        if (xhr.status < 200 || xhr.status >= 300) { finish(new Error(`${path} 请求失败（${xhr.status}）。`)); return; }
        let data = xhr.responseJSON;
        if (!data) { try { data = JSON.parse(xhr.responseText); } catch { finish(new Error(`${path} 返回非 JSON 数据，可能需要重新登录。`)); return; } }
        if (data.success === false) finish(new Error(data.errorMsg || data.msg || data.message || `${path} 操作失败。`));
        else finish(null, data);
      };
      scopes.forEach(jq => jq.on(`ajaxComplete${namespace}`, handler));
      timer = setTimeout(() => finish(new Error(`${path} 未收到完成结果。可能已写入，请先用“只检查”核对再继续。`)), timeout);
      try { trigger(); } catch (error) { finish(error); }
    });
  }
  function table(doc) { return $all(doc, 'table#table').find(visible) || $all(doc, 'table').find(t => visible(t) && t.querySelector('tbody tr td')); }
  function rows(doc) {
    const target = table(doc); if (!target) return [];
    const headers = $all(target, 'thead tr').at(-1)?.querySelectorAll('th') || [];
    const cols = [...headers].map(th => ({ field: th.dataset.field || '', label: norm(th.textContent).replace(/\*/g, '') }));
    return $all(target, 'tbody > tr').filter(tr => tr.cells.length >= 3).map(tr => {
      const row = { _el: tr, _cells: [...tr.cells], _cols: cols };
      [...tr.cells].forEach((cell, i) => { const col = cols[i]; if (col) { row[col.field || col.label] = clean(cell.textContent); row[`label:${col.label}`] = clean(cell.textContent); } });
      return row;
    });
  }
  const rowCell = (row, field) => row._cells[row._cols.findIndex(c => c.field === field)];
  function records(win, date) { return rows(win.document).filter(row => row.record_date?.slice(0, 10) === date); }
  function selectedRecord(win, report, project) {
    const matches = records(win, report.date).filter(row => row.pmwork_id === project.id);
    ensure(matches.length <= 1, `${report.date} 在同一项目下有多条记录，请先在网页处理。`);
    return matches[0];
  }
  async function listTab(win) {
    if (visible(win.document.querySelector('form [name="record_date"]'))) {
      const tab = button(win.document, '我的日报'); click(tab, '我的日报列表');
      await waitFor(() => visible(win.document.querySelector('#table')), '日报列表'); await settle(win.document);
    }
  }
  async function query(win) {
    const data = await ajaxAction(win, '/common/list', () => click(button(win.document, '查 询'), '查询'));
    await settle(win.document); return data;
  }
  async function selectDate(win, date) {
    await listTab(win);
    const doc = win.document;
    const find = () => $all(doc, 'a[title]').find(a => a.title.replace(/^\*/, '').startsWith(date + '(') || a.title.replace(/^\*/, '').startsWith(date + '（'));
    let anchor = find();
    if (!visible(anchor)) {
      const month = $all(doc, 'a[title]').find(a => a.title === date.slice(0, 7));
      ensure(month, `左侧月份树中没有 ${date.slice(0, 7)}。请先在网站加载该月份。`);
      const toggle = month.closest('li')?.querySelector('[id$="_switch"]');
      if (toggle && (!anchor || !visible(anchor))) click(toggle, '展开月份');
      else click(month, '月份');
      anchor = await waitFor(() => { const a = find(); return visible(a) && a; }, `日期 ${date}`);
    }
    if (!anchor.classList.contains('curSelectedNode')) {
      await ajaxAction(win, '/common/list', () => click(anchor, `选择 ${date}`));
      await settle(doc);
    }
    // 日期树的请求完成后再查询，避免树回调尚未更新日期时查到上一天。
    await query(win);
    await waitFor(() => records(win, date).length === rows(doc).length, `列表切换到 ${date}`);
  }
  function importLayer() { return $all(document, '.layui-layer').find(el => visible(el) && el.querySelector('.layui-layer-title')?.textContent.trim() === '导入窗口'); }
  async function openImporter(win) {
    ensure(!importLayer(), '请先关闭网站现有的导入窗口。');
    click(button(win.document, '导入数据', 'importWindow'), '导入数据');
    const layer = await waitFor(importLayer, '导入窗口');
    const importer = await waitFor(() => {
      const iframe = layer.querySelector('iframe');
      try { return iframe?.contentWindow?.document.body && iframe.contentWindow; } catch { return null; }
    }, '导入窗口内容');
    const category = await waitFor(() => button(importer.document, '信息化项目待办') || $all(importer.document, 'li').find(el => visible(el) && norm(el.textContent) === '信息化项目待办'), '信息化项目待办');
    click(category, '信息化项目待办');
    await waitFor(() => rows(importer.document).some(row => row['label:项目名称']), '可选项目列表'); await settle(importer.document);
    return { layer, win: importer };
  }
  function closeImporter(layer) { const close = layer?.querySelector('.layui-layer-close'); if (visible(close)) click(close, '关闭导入窗口'); }
  function projectRows(win) {
    return rows(win.document).map(row => ({ id: row['label:编号'] || '', name: row['label:项目名称'] || '', approver: row['label:项目负责人'] || '', _row: row })).filter(p => p.id && p.name);
  }
  function nextPage(doc) { return $all(doc, '.page-next:not(.disabled) a,.page-next:not(.disabled) button,[aria-label="下一页"]').find(canClick); }
  async function eachProjectPage(win, visit) {
    const seenPages = new Set();
    for (let page = 1; page <= 40; page++) {
      const current = projectRows(win), signature = current.map(p => p.id).join('|');
      ensure(!seenPages.has(signature), '项目分页没有前进，请在网站确认分页状态。'); seenPages.add(signature);
      if (await visit(current, page)) return true;
      const next = nextPage(win.document); if (!next) return false;
      await ajaxAction(win, '/common/list', () => click(next, '下一页')); await settle(win.document);
    }
    throw new Error('项目超过 40 页，请先在网站缩小项目筛选范围。');
  }
  async function readProjects() {
    const win = reportWindow(); await listTab(win);
    const firstDate = state.reports.find(r => r.selected)?.date || rows(win.document).find(r => /^\d{4}-\d{2}-\d{2}/.test(r.record_date))?.record_date.slice(0, 10);
    ensure(firstDate, '请先导入并预览日报，或在网站选择一个有记录的日期。');
    await selectDate(win, firstDate);
    const importer = await openImporter(win), projects = [];
    try {
      await eachProjectPage(importer.win, items => { projects.push(...items.map(({ id, name, approver }) => ({ id, name, approver }))); return false; });
      const totalMatch = importer.win.document.body.innerText.match(/总共\s*(\d+)\s*条记录/);
      if (totalMatch) ensure(projects.length >= Number(totalMatch[1]), '项目列表未读取完整，请检查分页。');
    } finally { closeImporter(importer.layer); }
    const unique = [...new Map(projects.map(p => [p.id, p])).values()];
    ensure(unique.length, '当前账号没有可读取的项目。');
    state.projects = unique; state.lastReadComplete = true;
    const previous = state.project?.id || loadPrefs().projectId;
    state.project = unique.find(p => p.id === previous) || (unique.length === 1 ? unique[0] : null);
    renderProjects(); log(`已读取当前账号的 ${unique.length} 个项目。`);
  }
  async function importProject(win, project) {
    const importer = await openImporter(win);
    try {
      const found = await eachProjectPage(importer.win, async items => {
        const target = items.find(p => p.id === project.id); if (!target) return false;
        ensure(target.name === project.name, '项目名称已变化，请重新读取项目列表。');
        for (const checkbox of $all(importer.win.document, '#table tbody input[type="checkbox"]')) if (checkbox.checked) click(checkbox, '取消默认项目');
        const box = target._row._el.querySelector('input[type="checkbox"]');
        ensure(box, '项目没有可选复选框。'); if (!box.checked) click(box, '选择项目');
        ensure($all(importer.win.document, '#table tbody input[type="checkbox"]:checked').length === 1, '项目选择不唯一，已停止导入。');
        await ajaxAction(importer.win, '/common/dataimport', () => click(button(importer.win.document, '导入'), '导入所选项目'));
        return true;
      });
      ensure(found, `当前账号的项目列表中找不到 ${project.id}，请重新读取项目。`);
    } finally { closeImporter(importer.layer); }
    await query(win);
  }
  function setField(win, name, value) {
    const el = win.document.querySelector(`form [name="${name}"]`);
    ensure(el && visible(el) && !el.disabled && !el.readOnly, `${name} 字段不可编辑。`);
    const prototype = el.tagName === 'TEXTAREA' ? win.HTMLTextAreaElement.prototype : win.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value').set.call(el, value);
    el.dispatchEvent(new win.Event('input', { bubbles: true })); el.dispatchEvent(new win.Event('change', { bubbles: true }));
    ensure(el.value === String(value), `${name} 未正确写入。`);
  }
  async function chooseApprover(win) {
    if ($('#approver-mode').value !== 'manual') return;
    const nameField = win.document.querySelector('form [name="approve_user_name"]');
    const idField = win.document.querySelector('form [name="approve_user_id"]');
    ensure(nameField && idField, '网站没有提供完整的审批人选择字段。');
    if (state.approver) {
      // 审批人只从本轮网站选择器读取；同步真实选择器字段，避免只改姓名而保留旧 ID。
      nameField.value = state.approver.name; idField.value = state.approver.id;
      nameField.dispatchEvent(new win.Event('change', { bubbles: true })); idField.dispatchEvent(new win.Event('change', { bubbles: true }));
      return;
    }
    click(win.document.querySelector('[name="btn_approve_user_name"]'), '网站审批人选择器');
    $('#resume').hidden = false; $('#resume').textContent = '已在网站选好审批人，继续';
    log('请在网站原有选择器里选择审批人并确定，再点击面板“继续”。');
    $('#panel').hidden = true; $('#launcher').hidden = false;
    await new Promise(resolve => { state.pendingResume = resolve; });
    $('#resume').hidden = true; state.pendingResume = null;
    ensure(nameField.value.trim() && idField.value.trim(), '未读取到有效审批人，请重新选择。');
    state.approver = { name: nameField.value.trim(), id: idField.value.trim() };
    $('#approver-info').textContent = `本轮使用：${state.approver.name}`;
  }
  async function processReport(report, options) {
    const win = reportWindow(), project = state.project;
    ensure(report.date <= today(), `${report.date} 尚未发生，请取消该日期。`);
    ensure(report.content && report.content.length <= 3000 && report.hours > 0 && report.hours <= 24, `${report.date} 的内容或工时无效。`);
    await selectDate(win, report.date);
    let row = selectedRecord(win, report, project);
    if (row && /已提交|已锁定/.test(row.aduditing)) return '已跳过：' + row.aduditing;
    if (options.checkOnly) return row ? `${row.aduditing || '状态未知'} · ${row.task_time || 0} 小时` : '尚未创建';
    const otherHours = records(win, report.date).filter(r => r.pmwork_id !== project.id).reduce((sum, r) => sum + (Number(r.task_time) || 0), 0);
    ensure(otherHours + Number(report.hours) <= 24, `${report.date} 其他项目已有 ${otherHours} 小时，加上本次后超过 24 小时。`);
    if (row && row.aduditing !== '未提交') return '已跳过：' + (row.aduditing || '未知状态');
    const same = row && clean(row.task_descript) === report.content && Number(row.task_time) === Number(report.hours);
    if (row && clean(row.task_descript) && !same && !options.overwrite) return '已跳过：已有不同草稿';
    if (!row) { await importProject(win, project); row = selectedRecord(win, report, project); ensure(row, '导入后没有找到对应项目记录。'); }
    if (!same || $('#approver-mode').value === 'manual') {
      const dateCell = rowCell(row, 'record_date'); ensure(dateCell, '日报日期列缺失。');
      dateCell.dispatchEvent(new win.MouseEvent('dblclick', { bubbles: true, cancelable: true, view: win }));
      const form = await waitFor(() => {
        const field = win.document.querySelector('form [name="record_date"]');
        return visible(field) && field.value === report.date && field.closest('form');
      }, '日报编辑表单');
      ensure(form.querySelector('[name="pmwork_id"]')?.value === project.id, '编辑表单项目与选择不一致，已停止。');
      await chooseApprover(win);
      const approver = form.querySelector('[name="approve_user_name"]')?.value.trim();
      ensure(approver && form.querySelector('[name="approve_user_id"]')?.value, '项目默认审批人不完整，请使用网站选择器选择。');
      setField(win, 'task_time', String(report.hours)); setField(win, 'task_descript', report.content);
      await ajaxAction(win, '/common/save', () => click(button(win.document, '保存', 'save'), '保存日报'));
      await listTab(win); await query(win);
      row = selectedRecord(win, report, project);
      ensure(row && clean(row.task_descript) === report.content && Number(row.task_time) === Number(report.hours), '保存后的内容或工时与预览不一致。');
    }
    if (!options.submit) return '已保存 · 未提交';
    // 查询后再选择复选框，防止保存回调的异步刷新清空勾选状态。
    await query(win); row = selectedRecord(win, report, project);
    if (/已提交|已锁定/.test(row?.aduditing || '')) return '已跳过：' + row.aduditing;
    for (const box of $all(win.document, '#table tbody input[type="checkbox"]')) if (box.checked) click(box, '取消其他记录');
    const box = row?._el.querySelector('input[type="checkbox"]'); ensure(box, '没有找到日报选择框。'); click(box, '选择当前日报');
    ensure($all(win.document, '#table tbody input[type="checkbox"]:checked').length === 1, '日报选择不唯一，已停止提交。');
    const submit = await waitFor(() => { const el = button(win.document, '提交日报', 'gridcommit'); return canClick(el) && el; }, '提交按钮');
    click(submit, '提交日报');
    const confirmation = await waitFor(() => $all(document, '.layui-layer').find(el => visible(el) && /确认要执行\s*提交日报\s*\?/.test(el.textContent)), '提交确认窗口');
    const confirm = $all(confirmation, 'a,button').find(el => norm(el.textContent) === '确定');
    await ajaxAction(win, '/common/update', () => click(confirm, '确认提交日报'));
    await query(win); row = selectedRecord(win, report, project);
    ensure(row?.aduditing === '已提交', '提交后状态未变为“已提交”，请先核对网站。');
    ensure(clean(row.task_descript) === report.content && Number(row.task_time) === Number(report.hours), '提交后内容核对失败。');
    return '已提交';
  }

  const host = document.createElement('div'); host.id = 'daily-report-assistant-host'; document.documentElement.append(host);
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `<style>
    :host{all:initial;font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;color:#1b304a}
    *{box-sizing:border-box}button,input,select,textarea{font:inherit}button{cursor:pointer}button:disabled{cursor:default;opacity:.5}
    #launcher{position:fixed;right:24px;bottom:24px;z-index:2147483000;border:0;border-radius:28px;padding:13px 20px;background:#1267de;color:#fff;box-shadow:0 6px 24px #154b9250;font-weight:650}
    #panel{position:fixed;right:22px;top:28px;bottom:24px;width:490px;max-width:calc(100vw - 24px);z-index:2147483001;background:#fff;border:1px solid #dce5ef;border-radius:18px;box-shadow:0 16px 70px #10264138;display:flex;flex-direction:column;overflow:hidden}
    [hidden]{display:none!important}header{padding:18px 22px 14px;border-bottom:1px solid #e7edf5;display:flex;align-items:center;justify-content:space-between;background:linear-gradient(120deg,#f1f7ff,#fff)}
    h2{margin:0;font-size:20px;letter-spacing:.5px}header p{margin:3px 0 0;color:#69809b;font-size:12px}.close{border:0;background:transparent;color:#7d8ca0;font-size:25px;padding:0 4px}
    nav{display:flex;padding:0 16px;border-bottom:1px solid #e7edf5}nav button{flex:1;border:0;background:white;padding:13px 4px;color:#71829a;border-bottom:2px solid transparent}nav button.active{color:#1465d8;border-color:#1465d8;font-weight:650}
    main{overflow:auto;padding:18px 22px;flex:1;min-height:0}.view{display:none}.view.active{display:block}.hint{font-size:12px;color:#71829a;margin:6px 0 13px}.banner{border:1px solid #d8e7fd;background:#f5f9ff;padding:10px 12px;border-radius:9px;font-size:12px;color:#3c628c;margin-bottom:16px}
    label{display:block;font-size:12px;font-weight:600;margin:13px 0 6px;color:#51657f}input,select,textarea{border:1px solid #d7e1ec;border-radius:7px;padding:8px 10px;color:#243950;background:#fff;width:100%;outline:none}input:focus,select:focus,textarea:focus{border-color:#5396f2;box-shadow:0 0 0 3px #edf4ff}textarea{resize:vertical;line-height:1.65}
    .row{display:flex;gap:12px;align-items:flex-end}.row>div{flex:1;min-width:0}.row>button{flex:0 0 auto}.secondary{border:1px solid #d5e1f0;background:#f8fbff;color:#2562af;padding:8px 12px;border-radius:7px;white-space:nowrap}.primary{border:0;background:#1267de;color:white;padding:10px 17px;border-radius:8px;font-weight:600}.full{width:100%}
    .checks{display:flex;align-items:flex-start;gap:8px;font-size:12px;font-weight:400;margin:12px 0}.checks input{width:auto;margin-top:4px;accent-color:#1267de}.file{display:flex;gap:8px;align-items:center}.file input{padding:6px;font-size:12px}.file input::file-selector-button{border:0;border-radius:4px;padding:5px 8px;background:#eaf2ff;color:#2463ae;margin-right:8px}
    .summary{display:flex;justify-content:space-between;margin-bottom:12px;font-size:13px;color:#52708e}.card{border:1px solid #dce5f0;border-radius:10px;margin:10px 0;padding:12px;background:#fff}.card-top{display:flex;align-items:center;gap:8px;margin-bottom:9px}.card-top input[type=checkbox]{width:auto;accent-color:#1267de}.date{font-weight:650;flex:1}.hours{width:65px;padding:4px 7px}.status{font-size:12px;color:#718299;overflow-wrap:anywhere;margin-top:7px}.status.done{color:#14815f}.status.error{color:#bd4c31}.card textarea{font-size:12px;background:#fbfcff;min-height:92px}
    footer{border-top:1px solid #e7edf5;background:#fafcff;padding:14px 22px}.footer-row{display:flex;gap:8px}.footer-row .primary{flex:1}#overall{font-size:12px;color:#68809a;margin:0 0 10px}#error{white-space:pre-wrap;background:#fff3ef;border:1px solid #f4d8cb;padding:10px;border-radius:7px;color:#a2472e;font-size:12px;margin-bottom:10px;max-height:130px;overflow:auto}
    #logs{font:12px/1.8 ui-monospace,Consolas,"Microsoft YaHei",monospace;white-space:pre-wrap;overflow-wrap:anywhere;background:#f6f8fb;border:1px solid #e5eaf1;border-radius:9px;padding:12px;min-height:160px}.small{font-size:12px;color:#70839c}.actions{display:flex;gap:8px}.actions button{flex:1}.review-box{border:1px solid #c6dbf6;border-radius:9px;padding:12px;background:#f5f9ff;margin:12px 0}.review-box b{display:block;font-size:14px}.review-box .checks{margin-bottom:0}
    @media(max-width:560px){#panel{right:8px;top:10px;bottom:10px;width:calc(100vw - 16px)}main{padding:14px}header,footer{padding:14px}}
  </style>
  <button id="launcher">▤ 日报助手</button>
  <section id="panel" hidden aria-label="日报批量填写助手">
    <header><div><h2>日报批量填写</h2><p>本地操作面板 · 使用当前网站账号 · v${VERSION}</p></div><button class="close" id="close" aria-label="收起面板">×</button></header>
    <nav><button data-view="prepare" class="active">1　准备内容</button><button data-view="preview">2　预览执行</button><button data-view="history">执行记录</button></nav>
    <main>
      <div class="view active" id="view-prepare">
        <div class="banner">先在网站打开「我的日报」。选择当前账号可用的项目，导入内容后预览，再执行。</div>
        <div class="row"><div><label for="year">无年份日期采用</label><input id="year" type="number" min="2000" max="2100"></div><div><label for="hours">默认每日工时</label><input id="hours" type="number" min="0.1" max="24" step="0.5" value="8"></div></div>
        <label for="title">统一标题（留空保留原文）</label><input id="title" placeholder="例如：智算云2.0："><div class="hint">标题与工作项之间只保留一个换行，不留空白行。</div>
        <label for="source">工作记录 · Markdown / 日期表格</label><textarea id="source" rows="6" placeholder="## 10/10&#10;智算云2.0：&#10;1、完成某项工作。&#10;2、处理某个问题。"></textarea>
        <div class="file"><input id="file" type="file" accept=".md,.markdown,.txt,text/plain,text/markdown" aria-label="导入工作记录文件"><button class="secondary" id="parse">解析内容</button></div>
        <label for="project">信息化项目</label><div class="row"><div><select id="project"><option value="">点击“读取项目”加载当前账号项目</option></select></div><button class="secondary" id="read-projects">读取项目</button></div>
        <label for="approver-mode">审批人</label><select id="approver-mode"><option value="default">沿用网站记录 / 项目默认审批人</option><option value="manual">本轮通过网站原有选择器另选审批人</option></select><div id="approver-info" class="hint">读取并选择项目后显示默认负责人。</div>
        <label class="checks"><input type="checkbox" id="overwrite"><span>允许更新已有的不同草稿（仅“未提交”记录；已提交、已锁定始终跳过）</span></label>
        <button class="secondary full" id="to-preview">查看并编辑预览 →</button>
      </div>
      <div class="view" id="view-preview"><div id="summary" class="summary"></div><div class="actions"><button class="secondary" id="select-all">选择可用日期</button><button class="secondary" id="select-none">全部取消</button></div><div id="cards"></div><div id="review" class="review-box" hidden><b id="review-title"></b><div id="review-details" class="small"></div><label class="checks"><input type="checkbox" id="confirm-run"><span>我已核对日期、项目、工时和文案，按下方模式执行。</span></label></div></div>
      <div class="view" id="view-history"><div class="actions"><button class="secondary" id="export-log">导出执行记录</button><button class="secondary" id="clear-log">清空面板记录</button></div><p class="hint">记录仅在本次页面会话内保留；失败后先核对网站，不自动重试写入。</p><div id="logs">暂无执行记录。</div></div>
    </main>
    <footer><div id="error" hidden role="alert"></div><p id="overall" role="status">准备好内容后，先解析并选择项目。</p><div class="footer-row"><select id="mode" aria-label="执行模式" style="width:138px"><option value="check">只检查状态</option><option value="save">仅保存草稿</option><option value="submit" selected>保存并提交</option></select><button class="primary" id="run">核对并执行</button><button class="secondary" id="stop" hidden>完成当前条后停止</button></div><button class="primary full" id="resume" hidden style="margin-top:8px">继续</button></footer>
  </section>`;
  const $ = selector => shadow.querySelector(selector);
  function showView(name) {
    shadow.querySelectorAll('nav button').forEach(el => el.classList.toggle('active', el.dataset.view === name));
    shadow.querySelectorAll('.view').forEach(el => el.classList.toggle('active', el.id === `view-${name}`));
  }
  function error(message = '') { $('#error').textContent = message; $('#error').hidden = !message; }
  function log(message) {
    const stamp = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date());
    state.logs.push(`[${stamp}] ${message}`); $('#logs').textContent = state.logs.join('\n');
  }
  function loadPrefs() { try { return JSON.parse(localStorage.getItem('daily-panel-prefs-v1') || '{}'); } catch { return {}; } }
  function savePrefs() { try { localStorage.setItem('daily-panel-prefs-v1', JSON.stringify({ year: $('#year').value, hours: $('#hours').value, title: $('#title').value, projectId: state.project?.id || '' })); } catch { /* 不影响填写。 */ } }
  function renderProjects() {
    $('#project').replaceChildren(new Option('请选择项目', ''));
    for (const project of state.projects) $('#project').append(new Option(`${project.name} · ${project.id}`, project.id));
    $('#project').value = state.project?.id || ''; updateApprover();
  }
  function updateApprover() { state.approver = null; $('#approver-info').textContent = state.project ? `项目默认负责人：${state.project.approver || '以网站表单为准'}` : '请先读取并选择项目。'; }
  function invalidateReview() { $('#confirm-run').checked = false; $('#review').hidden = true; }
  function updateSummary() {
    const chosen = state.reports.filter(r => r.selected);
    $('#summary').textContent = `共 ${state.reports.length} 天 · 已选 ${chosen.length} 天 · ${chosen.reduce((n, r) => n + Number(r.hours), 0)} 小时`;
  }
  function renderReports() {
    $('#cards').replaceChildren();
    for (const report of state.reports) {
      const card = document.createElement('article'); card.className = 'card'; card.dataset.date = report.date;
      const top = document.createElement('div'); top.className = 'card-top';
      const checked = document.createElement('input'); checked.type = 'checkbox'; checked.checked = report.selected; checked.disabled = report.date > today(); checked.setAttribute('aria-label', `选择 ${report.date}`);
      const date = document.createElement('span'); date.className = 'date'; date.textContent = report.date;
      const hours = document.createElement('input'); hours.type = 'number'; hours.className = 'hours'; hours.min = '0.1'; hours.max = '24'; hours.step = '.5'; hours.value = report.hours; hours.setAttribute('aria-label', `${report.date} 工时`);
      const unit = document.createElement('span'); unit.className = 'small'; unit.textContent = '小时';
      top.append(checked, date, hours, unit);
      const content = document.createElement('textarea'); content.rows = Math.min(7, Math.max(3, report.content.split('\n').length)); content.value = report.content; content.setAttribute('aria-label', `${report.date} 工作内容`);
      const status = document.createElement('div'); status.className = 'status'; status.textContent = report.date > today() ? '未来日期，暂不执行' : report.status;
      checked.addEventListener('change', () => { report.selected = checked.checked; updateSummary(); invalidateReview(); });
      hours.addEventListener('input', () => { report.hours = Number(hours.value); updateSummary(); invalidateReview(); });
      content.addEventListener('change', () => { report.content = normalizeContent(content.value); content.value = report.content; invalidateReview(); });
      card.append(top, content, status); $('#cards').append(card);
    }
    updateSummary();
  }
  function setReportStatus(report, status, failed = false) {
    report.status = status;
    const label = $(`#cards [data-date="${report.date}"] .status`);
    if (label) { label.textContent = status; label.classList.toggle('done', /已提交|已保存|已跳过/.test(status)); label.classList.toggle('error', failed); }
  }
  function parse() { state.reports = parseMarkdown($('#source').value, { year: $('#year').value, hours: $('#hours').value, title: $('#title').value }); renderReports(); invalidateReview(); savePrefs(); error(); log(`已解析 ${state.reports.length} 天内容，空白行已清除。`); }
  async function action(work) { if (state.running) return; error(); try { await work(); } catch (err) { error(err.message); log(err.message); } }
  function setBusy(busy) {
    state.running = busy; $('#stop').hidden = !busy;
    if (busy) $('#stop').disabled = false;
    shadow.querySelectorAll('#view-prepare input,#view-prepare select,#view-prepare textarea,#view-prepare button,#cards input,#cards textarea,#mode,#run,#select-all,#select-none,#confirm-run').forEach(el => { el.disabled = busy; });
    if (!busy) state.reports.forEach(r => { if (r.date > today()) $(`#cards [data-date="${r.date}"] input[type=checkbox]`).disabled = true; });
  }
  async function run() {
    ensure(state.lastReadComplete && state.project, '请先读取并选择当前账号可用的项目。');
    const selected = state.reports.filter(r => r.selected); ensure(selected.length, '请至少选择一个日期。');
    selected.forEach(r => { r.content = normalizeContent(r.content); ensure(r.content && r.content.length <= 3000 && r.hours > 0 && r.hours <= 24 && r.date <= today(), `${r.date} 的内容、日期或工时无效。`); });
    const checkOnly = $('#mode').value === 'check';
    if (!checkOnly && (!$('#confirm-run').checked || $('#review').hidden)) {
      $('#review').hidden = false; $('#review-title').textContent = `${state.project.name} · ${selected.length} 天 · ${selected.reduce((n, r) => n + r.hours, 0)} 小时`;
      $('#review-details').textContent = `模式：${$('#mode').selectedOptions[0].textContent}。审批人：${$('#approver-mode').selectedOptions[0].textContent}。已提交和已锁定记录会跳过。`;
      showView('preview'); $('#review').scrollIntoView({ block: 'nearest' });
      $('#overall').textContent = '请核对上方摘要并勾选确认，再次点击“核对并执行”。'; return;
    }
    const options = { checkOnly, submit: $('#mode').value === 'submit', overwrite: $('#overwrite').checked };
    state.stop = false; state.approver = null; savePrefs();
    const execute = async () => {
      setBusy(true); let completed = 0;
      try {
        showView('preview'); log(`开始：${state.project.name}，${selected.length} 天，${checkOnly ? '只检查' : options.submit ? '保存并提交' : '仅保存'}。`);
        for (const report of selected) {
          if (state.stop) { log('已在当前条处理完成后停止。'); break; }
          $('#overall').textContent = `正在处理 ${report.date}（${completed + 1}/${selected.length}）`;
          setReportStatus(report, checkOnly ? '正在检查…' : '正在处理…');
          try { const status = await processReport(report, options); setReportStatus(report, status); log(`${report.date}：${status}`); completed++; }
          catch (err) { setReportStatus(report, '已停止：' + err.message, true); throw err; }
        }
        $('#overall').textContent = `本轮已处理 ${completed}/${selected.length} 天。${state.stop ? '已停止。' : '结果见各日期下方。'}`;
      } catch (err) {
        $('#overall').textContent = `本轮已停止，完成 ${completed}/${selected.length} 天。请核对错误对应的网页记录。`;
        throw err;
      } finally { setBusy(false); state.approver = null; invalidateReview(); }
    };
    if (navigator.locks?.request) await navigator.locks.request('daily-report-panel-batch', { ifAvailable: true }, async lock => { ensure(lock, '另一个网页标签正在运行日报批处理，请等待它结束。'); await execute(); });
    else await execute();
  }
  $('#launcher').onclick = () => { $('#panel').hidden = false; $('#launcher').hidden = true; };
  $('#close').onclick = () => { $('#panel').hidden = true; $('#launcher').hidden = false; };
  shadow.querySelectorAll('nav button').forEach(el => el.onclick = () => showView(el.dataset.view));
  $('#parse').onclick = () => action(parse);
  $('#to-preview').onclick = () => action(() => { if (!state.reports.length) parse(); showView('preview'); });
  $('#file').onchange = () => action(async () => { const file = $('#file').files[0]; if (!file) return; ensure(file.size < 2 * 1024 * 1024, '工作记录文件不能超过 2 MB。'); $('#source').value = await file.text(); parse(); });
  $('#read-projects').onclick = () => action(async () => { $('#read-projects').disabled = true; $('#overall').textContent = '正在读取当前账号项目…'; try { await readProjects(); $('#overall').textContent = '项目读取完成，请选择后进入预览。'; } finally { $('#read-projects').disabled = false; } });
  $('#project').onchange = () => { state.project = state.projects.find(p => p.id === $('#project').value) || null; updateApprover(); invalidateReview(); savePrefs(); };
  $('#approver-mode').onchange = () => { updateApprover(); invalidateReview(); };
  ['#mode', '#overwrite'].forEach(selector => $(selector).addEventListener('change', invalidateReview));
  ['#year', '#hours', '#title', '#source'].forEach(selector => $(selector).addEventListener('input', () => { state.reports = []; $('#cards').replaceChildren(); updateSummary(); invalidateReview(); }));
  $('#select-all').onclick = () => { state.reports.forEach(r => { r.selected = r.date <= today(); }); renderReports(); invalidateReview(); };
  $('#select-none').onclick = () => { state.reports.forEach(r => { r.selected = false; }); renderReports(); invalidateReview(); };
  $('#run').onclick = () => action(run);
  $('#stop').onclick = () => { state.stop = true; $('#stop').disabled = true; if (state.pendingResume) { $('#overall').textContent = '请先在网站完成审批人选择，再继续结束当前条。'; } };
  $('#resume').onclick = () => state.pendingResume?.();
  $('#clear-log').onclick = () => { if (!state.running) { state.logs = []; $('#logs').textContent = '暂无执行记录。'; } };
  $('#export-log').onclick = () => {
    const text = JSON.stringify({ version: VERSION, exportedAt: new Date().toISOString(), project: state.project ? { id: state.project.id, name: state.project.name } : null, reports: state.reports.map(({ date, hours, status }) => ({ date, hours, status })), logs: state.logs }, null, 2);
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json;charset=utf-8' }));
    const a = document.createElement('a'); a.href = url; a.download = `日报执行记录-${today()}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const prefs = loadPrefs(); $('#year').value = prefs.year || today().slice(0, 4); $('#hours').value = prefs.hours || 8; $('#title').value = prefs.title || '';
  window.__dailyReportAssistant = { version: VERSION, core: Core, open: () => $('#launcher').click(), destroy: () => { ensure(!state.running, '批处理尚未结束，不能移除面板。'); host.remove(); delete window.__dailyReportAssistant; }, getStatus: () => ({ running: state.running, project: state.project?.name || null, reports: state.reports.map(({ date, hours, status }) => ({ date, hours, status })) }) };
  if (window.__DAILY_PANEL_TEST__) window.__dailyReportAssistant.test = { state, processReport, rows, reportWindow, readProjects };
})();
