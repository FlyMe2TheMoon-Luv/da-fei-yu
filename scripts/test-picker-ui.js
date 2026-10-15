// Real renderer + real preload, memory-only IPC fixtures. Never writes hosts or kills processes.
const path = require('path');
const fs = require('fs');
const root = path.resolve(__dirname, '..');
if (!process.versions.electron) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = require('child_process').spawn(require('electron'), [__filename,
    '--disable-gpu', '--enable-unsafe-swiftshader', '--no-sandbox', ...process.argv.slice(2)], { cwd: root, env, stdio: 'inherit' });
  child.on('exit', (code) => process.exit(code == null ? 1 : code));
} else {
  const { app, BrowserWindow, ipcMain, nativeTheme } = require('electron');
  app.setPath('userData', path.join(root, 'tmp', 'picker-test-' + Date.now()));
  let pass = 0, fail = 0, neg = 0, negFail = 0, win;
  const errors = [];
  const check = (cond, label, negative = false, detail = '') => {
    if (negative) { neg++; if (!cond) negFail++; }
    cond ? pass++ : fail++;
    // Always print the measured value — a failing assertion without numbers is undebuggable.
    console.log(`${cond ? 'PASS' : 'FAIL'} ${negative ? '[negative] ' : ''}${label}${detail}`);
  };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  let state = { domains: ['example.org'], exes: ['manual-only.exe'], running: false,
    presets: [25, 45], lastMinutes: 25, session: null };
  let writes = 0, scanDelay = 0, rescanDelay = 0, writeDelay = 0, throwSave = false, unknownState = false;
  const fixtures = [
    { name: 'Alpha', exe: 'alpha.exe', icon: null },
    { name: 'Beta', exe: 'beta.exe', icon: null },
    { name: 'Unknown app', exe: '', blocked: true, icon: null },
  ];
  const js = (code) => win.webContents.executeJavaScript(code);
  const cell = (exe = 'alpha.exe') => `[...document.querySelectorAll('.app-cell')].find(c=>c.dataset.exe===${JSON.stringify(exe)})`;
  const click = (exe) => js(`${cell(exe)}.click()`);
  const checked = (exe) => js(`${cell(exe)}.getAttribute('aria-checked')==='true'`);
  const until = async (code, label) => {
    for (let i = 0; i < 150; i++) { if (await js(code)) return; await wait(20); }
    throw new Error('timeout: ' + label);
  };
  const open = async () => { await js('openAppPicker()'); };
  const close = async () => { await js('closeAppPicker()'); };
  const search = (value) => js(`document.getElementById('picker-search').value=${JSON.stringify(value)};
    document.getElementById('picker-search').dispatchEvent(new Event('input',{bubbles:true}))`);
  const keyboard = async (key) => {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: key });
    // Electron needs the character phase for Enter to reproduce a real keyboard activation.
    if (key === 'Enter' || key === 'Return') win.webContents.sendInputEvent({ type: 'char', keyCode: '\r' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: key });
    await wait(80);
  };
  app.whenReady().then(async () => {
    ipcMain.handle('schedules:list', () => []);
    ipcMain.handle('focus:get', () => unknownState ? null : structuredClone(state));
    ipcMain.handle('focus:state', () => structuredClone(state));
    ipcMain.handle('focus:doh', () => null);
    ipcMain.handle('week:set-mode', (_, mode) => mode);
    ipcMain.handle('apps:list', async () => {
      await wait(scanDelay);
      return { ok: true, apps: fixtures.map((x) => ({ ...x, added: state.exes.includes(x.exe) })) };
    });
    ipcMain.handle('apps:rescan', async () => { await wait(rescanDelay); return { ok: true }; });
    ipcMain.handle('focus:set-blacklist', async (_, list) => {
      writes++;
      await wait(writeDelay);
      if (throwSave) throw new Error('Injected save failure');
      if (state.running) return { ok: false, error: '专注中不能改' };
      state = { ...state, domains: list.domains.slice(), exes: list.exes.slice() };
      return { ok: true, domains: state.domains, exes: state.exes };
    });
    win = new BrowserWindow({ width: 480, height: 680, show: false,
      webPreferences: { preload: path.join(root, 'src/main/preload-settings.js'),
        contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
    win.webContents.on('console-message', (_, level, message) => {
      if (level === 3 && !/Content Security Policy|Injected save failure/.test(message || '')) errors.push(message);
    });
    await win.loadFile(path.join(root, 'src/renderer/settings/index.html'));
    win.show();
    await js("mode='focus'; applyMode(); loadFocus()");
    await open();
    check(await js("document.querySelectorAll('.app-cell').length===3"), 'fixture list renders');
    check(await js("document.getElementById('btn-picker-save').disabled"), 'no edits means Save disabled', true);
    await js(`window.originalCell=${cell()}; originalCell.focus()`);
    await click();
    check(await checked(), 'one click selects');
    check(writes === 0 && !state.exes.includes('alpha.exe'), 'select is local only', true);
    check(await js(`window.originalCell===${cell()} && document.activeElement===originalCell`), 'selection preserves DOM and focus');
    await click();
    check(!(await checked()) && writes === 0, 'second click undoes selection', true);
    await js(`${cell()}.focus()`);
    await keyboard('Space');
    check(await checked(), 'native Space selects exactly once');
    await keyboard('Return');
    check(!(await checked()), 'native Enter deselects exactly once');
    await click();
    await search('Beta');
    await click('beta.exe');
    await search('');
    check(await checked() && await checked('beta.exe'), 'filter retains hidden selection');
    await js('rescanApps()');
    check(await checked() && await checked('beta.exe') && writes === 0, 'rescan retains unsaved selection', true);
    await close();
    await open();
    check(!(await checked()) && writes === 0, 'close discards draft without saving', true);
    await click('');
    check(writes === 0 && !(await checked('')), 'unresolved app cannot be selected', true);
    await click();
    throwSave = true;
    await js('savePicks()');
    check(await checked() && !state.exes.includes('alpha.exe'), 'save failure retains selection', true);
    check(await js("!document.getElementById('picker-lock').classList.contains('hidden') && document.getElementById('picker-lock').classList.contains('error')"), 'error is visible inside modal');
    throwSave = false;
    writeDelay = 200;
    const priorWrites = writes;
    await js("document.getElementById('btn-picker-save').focus(); void savePicks(); void savePicks()");
    check(await js("document.getElementById('app-picker').contains(document.activeElement)"), 'Save retains focus inside dialog');
    await until('!pickerSaving', 'save');
    check(writes === priorWrites + 1, 'double Save produces only one write', true);
    check(state.exes.includes('alpha.exe') && state.exes.includes('manual-only.exe') && state.domains[0] === 'example.org', 'Save preserves manual-only entries and domains');
    check(await checked(), 'saved app remains checked');
    await click();
    await search('Beta'); await search('');
    check(await js(`${cell()}.classList.contains('will-remove')`), 'pending removal survives grid rebuild');
    await js('savePicks()');
    check(!state.exes.includes('alpha.exe') && state.exes.includes('manual-only.exe'), 'saved cancellation removes only intended app', true);
    await close();
    state.exes.push('beta.exe');
    await open();
    check(await checked('beta.exe'), 'reopening refreshes cached added flags');
    state.exes = state.exes.filter((x) => x !== 'beta.exe');
    await close(); await open();
    check(!(await checked('beta.exe')), 'external removal is not resurrected from cache', true);
    state.running = true;
    await close(); await open();
    const lockedWrites = writes;
    await click(); await js('savePicks()');
    check(!(await checked()) && writes === lockedWrites && await js("document.getElementById('btn-picker-save').disabled"), 'running session blocks editing and Save', true);
    state.running = false; unknownState = true;
    await close(); await open();
    check(await js("document.getElementById('btn-picker-save').disabled"), 'unknown focus state fails closed', true);
    unknownState = false;
    await close(); await js('installedApps=null'); scanDelay = 200;
    await js('void openAppPicker()'); await wait(30); await close();
    await open();
    check(await js("document.querySelectorAll('.app-cell').length===3 && !appsLoading"), 'close/reopen awaits shared scan');
    scanDelay = 0;
    // Reopen with a cached list during either rescan phase; saved cells must bind to fresh objects.
    for (const phase of ['invalidate', 'list']) {
      scanDelay = phase === 'list' ? 200 : 0;
      rescanDelay = phase === 'invalidate' ? 200 : 0;
      await js('window.pendingRescan=rescanApps(); void 0');
      await wait(30); await close(); await open();
      await js('window.pendingRescan');
      await click(); await js('savePicks()');
      check(state.exes.includes('alpha.exe') && await checked(), `cached reopen during ${phase}: selection saves`);
      await click(); await js('savePicks()');
      check(!state.exes.includes('alpha.exe') && !(await checked()), `cached reopen during ${phase}: saved app can be removed`, true);
      // Isolate phases even if the negative control fails.
      state.exes = state.exes.filter((x) => x !== 'alpha.exe');
      await close(); await open();
    }
    scanDelay = 0; rescanDelay = 0;
    const afterRaceWrites = writes;
    await js("document.getElementById('btn-picker-rescan').focus()");
    await keyboard('Enter');
    await until('!pickerOpening', 'rescan');
    check(await js("document.getElementById('app-picker').contains(document.activeElement)"), 'Rescan retains modal focus');
    await keyboard('Escape');
    check(await js("document.getElementById('app-picker').classList.contains('hidden')"), 'Escape still closes after rescan');
    await open();
    await js("document.getElementById('btn-picker-close').focus()");
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab', modifiers: ['shift'] });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab', modifiers: ['shift'] });
    await wait(50);
    check(await js("document.getElementById('app-picker').contains(document.activeElement)"), 'Shift-Tab stays in modal');

    // Browser engine pseudo-state forcing: tests actual :hover CSS without moving the user's mouse.
    const dbg = win.webContents.debugger;
    dbg.attach('1.3');
    await dbg.sendCommand('DOM.enable'); await dbg.sendCommand('CSS.enable');
    const documentNode = (await dbg.sendCommand('DOM.getDocument')).root.nodeId;
    const alphaNode = (await dbg.sendCommand('DOM.querySelector', { nodeId: documentNode, selector: '.app-cell[data-exe="alpha.exe"]' })).nodeId;
    const hover = async (enabled) => dbg.sendCommand('CSS.forcePseudoState', { nodeId: alphaNode, forcedPseudoClasses: enabled ? ['hover'] : [] });
    const scale = () => js(`new DOMMatrix(getComputedStyle(${cell()}.querySelector('.app-icon')).transform).a`);
    await hover(true); await wait(300);
    check(Math.abs(await scale() - 1.10) < .005, 'hover scales icon to 1.10');
    check(!(await checked()) && writes === afterRaceWrites, 'hover never selects or saves', true);
    const layout = await js(`${cell()}.offsetWidth`);
    await hover(false); await wait(300);
    check(Math.abs(await scale() - 1) < .005 && layout === await js(`${cell()}.offsetWidth`), 'hover exit restores scale without layout shift');
    await hover(true); await wait(45);
    const mid = await scale();
    await hover(false);
    const redirected = await scale();
    check(mid > 1 && mid < 1.10 && Math.abs(mid - redirected) < .03, 'rapid reversal starts at current displayed scale');
    await wait(250);
    check(Math.abs(await scale() - 1) < .005, 'rapid reversal settles back to normal');
    await hover(true); await click(); await wait(300);
    check(await checked() && Math.abs(await scale() - 1.10) < .005, 'selected icon still responds to hover');
    await dbg.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await wait(200);
    check(Math.abs(await scale() - 1) < .005 && await checked(), 'reduced motion removes scaling but preserves selection', true);
    await dbg.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-transparency', value: 'reduce' }] });
    check(await js("getComputedStyle(document.querySelector('header')).backdropFilter==='none'"), 'reduced transparency disables blur');
    await dbg.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-contrast', value: 'more' }] });
    check(await js("getComputedStyle(document.querySelector('.picker-panel')).borderTopWidth==='2px'"), 'higher contrast uses stronger border');
    await dbg.sendCommand('Emulation.setEmulatedMedia', { features: [] });
    for (const theme of ['light', 'dark']) {
      nativeTheme.themeSource = theme;
      await wait(150);
      const rgb = await js("({bg:getComputedStyle(document.body).backgroundColor,fg:getComputedStyle(document.body).color})");
      const n = (s) => s.match(/\d+/g).slice(0, 3).reduce((a, v) => a + +v, 0) / 3;
      check(theme === 'dark' ? n(rgb.bg) < 80 && n(rgb.fg) > 180 : n(rgb.bg) > 200 && n(rgb.fg) < 80, `${theme} theme text/background readable`);
    }
    win.setContentSize(400, 600); await wait(200);
    check(await js("document.documentElement.scrollWidth<=innerWidth && document.querySelector('.picker-foot').scrollWidth<=document.querySelector('.picker-foot').clientWidth"), '400px window has no footer horizontal overflow');
    // Footer must stay one row: the count may not wrap under the buttons and get clipped.
    const foot = await js(`(() => {
      const f = document.querySelector('.picker-foot');
      const c = document.getElementById('picker-count');
      const a = document.querySelector('.picker-acts');
      const fr = f.getBoundingClientRect(), cr = c.getBoundingClientRect(), ar = a.getBoundingClientRect();
      // Compare centers, not top edges: the count is bare text (short line box) while
      // the buttons are taller, so their tops legitimately differ by a few pixels.
      const cMid = cr.top + cr.height / 2, aMid = ar.top + ar.height / 2;
      return { h: Math.round(fr.height), sameRow: Math.abs(cMid - aMid) < 4,
        cTop: Math.round(cr.top), aTop: Math.round(ar.top),
        clipped: cr.bottom > fr.bottom + 1 || ar.bottom > fr.bottom + 1,
        overflow: getComputedStyle(f).flexWrap,
        rows: Math.round((fr.height - parseFloat(getComputedStyle(f).paddingTop) * 2) / Math.max(cr.height, ar.height)) };
    })()`);
    check(foot.sameRow && !foot.clipped, '★ 400px：计数和按钮同在一行、没有被底栏裁掉', true,
      ` → 同一行=${foot.sameRow} 计数top=${foot.cTop} 按钮top=${foot.aTop} 被裁=${foot.clipped} 底栏高=${foot.h}px wrap=${foot.overflow}`);
    check(foot.overflow !== 'wrap', '★ 负对照：底栏不能允许换行（换行就会把计数挤到窗口外面）', true,
      ` → flex-wrap=${foot.overflow}`);
    await wait(2600); // Let any toast from earlier close/discard steps finish fading.
    // The toast element only exists once a toast has been shown, so create it on demand.
    check(await js("!document.getElementById('toast') || getComputedStyle(document.getElementById('toast')).opacity==='0'"), '★ 提示条淡出后不再压住底栏（截图才干净）');
    dbg.detach();
    await close();
    check(await js("[...document.body.children].every(x=>!x.inert)"), 'closing restores background interactivity');
    check(errors.length === 0, 'no unexpected renderer errors: ' + errors.join(';'));
    if (process.argv.includes('--screenshots') && fail === 0) {
      // Read actual installed app names/icons; checkbox choices stay in this memory-only harness.
      const installed = await require('../src/main/apps').scanInstalled({ deps: {
        getIcon: (p) => app.getFileIcon(p, { size: 'large' }),
        isProtectedExe: require('../src/main/focus/blacklist').isProtectedExe,
      } });
      fixtures.splice(0, fixtures.length, ...installed);
      state = { ...state, exes: [], running: false };
      nativeTheme.themeSource = 'dark';
      win.setContentSize(480, 640);
      await js('installedApps=null');
      await open();
      const live = installed.filter((a) => a.exe && !a.blocked);
      if (live.length < 3) throw new Error('Not enough installed apps for preview');
      const out = path.join(root, 'outputs');
      const capture = async (file) => {
        await wait(300);
        fs.writeFileSync(path.join(out, file), (await win.webContents.capturePage()).toPNG());
      };
      await capture('v25-picker-default.png');
      await click(live[0].exe); await click(live[1].exe);
      dbg.attach('1.3'); await dbg.sendCommand('DOM.enable'); await dbg.sendCommand('CSS.enable');
      const docId = (await dbg.sendCommand('DOM.getDocument')).root.nodeId;
      const all = await dbg.sendCommand('DOM.querySelectorAll', { nodeId: docId, selector: '.app-cell' });
      const hoverIndex = installed.findIndex((a) => a.exe === live[2].exe);
      await dbg.sendCommand('CSS.forcePseudoState', { nodeId: all.nodeIds[hoverIndex], forcedPseudoClasses: ['hover'] });
      await capture('v25-picker-selected-hover.png');
      await click(live[0].exe);
      await capture('v25-picker-unselected.png');
      dbg.detach();
      console.log('PREVIEWS: outputs/v25-picker-{default,selected-hover,unselected}.png');
      await close();
    }
  }).catch((err) => { fail++; console.error(err.stack); }).finally(() => {
    console.log(`Negative controls: ${neg - negFail}/${neg}`);
    console.log(`PICKER RESULT: ${pass} passed / ${fail} failed`);
    if (win && !win.isDestroyed()) win.destroy();
    app.exit(fail ? 1 : 0);
  });
}
