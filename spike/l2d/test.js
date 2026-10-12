// spike/l2d/test.js —— Live2D 加载与性能实测
// 这个文件是验证脚本，不是产品代码。

(async () => {
  const log = (m) => console.log('[spike] ' + m);
  const fail = (m) => console.log('[spike] ✗ ' + m);
  const ok = (m) => console.log('[spike] ✓ ' + m);

  try {
    // ---------- 1. 运行时自检 ----------
    log('PIXI 版本: ' + (window.PIXI ? PIXI.VERSION : '未加载'));
    if (!window.PIXI) return fail('PIXI 没加载起来');
    ok('PIXI 已加载');

    log('Cubism Core: ' + (typeof Live2DCubismCore !== 'undefined' ? '已加载' : '缺失'));
    if (typeof Live2DCubismCore === 'undefined') return fail('Live2D Cubism Core 没加载起来');
    ok('Cubism Core 已加载');

    if (!PIXI.live2d || !PIXI.live2d.Live2DModel) return fail('pixi-live2d-display 没挂到 PIXI.live2d 上');
    ok('pixi-live2d-display 已加载');

    // ---------- 2. 建 PIXI 应用（透明背景） ----------
    const wrap = document.getElementById('wrap');
    const app = new PIXI.Application({
      width: window.innerWidth,
      height: window.innerHeight,
      backgroundAlpha: 0,          // 关键：背景完全透明
      antialias: true,
      autoDensity: true,
      preserveDrawingBuffer: true, // 关键：截图/读像素需要
      resolution: Math.min(window.devicePixelRatio || 1, 1.5),
      powerPreference: 'low-power',
    });
    app.ticker.maxFPS = 30;        // 30 帧足够，60 帧白烧性能
    wrap.appendChild(app.view);
    ok(`PIXI 应用已建立 · 画布 ${app.view.width}x${app.view.height} · 渲染分辨率 ${app.renderer.resolution}`);
    log(`渲染器类型: ${app.renderer.type === 2 ? 'WebGL2' : app.renderer.type === 1 ? 'WebGL1' : '未知'}`);
    log(`WebGL 版本: ${app.renderer.gl ? app.renderer.gl.getParameter(app.renderer.gl.VERSION) : '无'}`);
    log(`GPU 厂商: ${app.renderer.gl ? app.renderer.gl.getParameter(app.renderer.gl.RENDERER) : '无'}`);

    // ---------- 3. 加载模型 ----------
    const { Live2DModel } = PIXI.live2d;
    Live2DModel.registerTicker(PIXI.Ticker);

    const t0 = performance.now();
    const model = await Live2DModel.from('model/c_0120.model3.json', {
      autoInteract: false,
      autoUpdate: true,
      idleMotionGroup: 'idle',
    });
    const loadMs = performance.now() - t0;
    ok(`模型加载成功 · 耗时 ${Math.round(loadMs)}ms`);

    const internal = model.internalModel;
    log(`模型原始尺寸: ${Math.round(internal.originalWidth)} x ${Math.round(internal.originalHeight)}`);
    log(`眨眼功能: ${internal.eyeBlink ? '自带' : '无'}`);
    log(`物理演算: ${internal.physics ? '有' : '无'}`);

    model.eventMode = 'none';
    app.stage.addChild(model);

    // ---------- 4. 缩放到窗口 ----------
    // 注意：model.width 是随 scale 变化的，所以要先取 localBounds 作为基准
    const box = model.getLocalBounds();
    const baseW = box.width;
    const baseH = box.height;
    log(`模型包围盒: ${Math.round(baseW)} x ${Math.round(baseH)}`);

    const availW = window.innerWidth * 0.92;
    const availH = window.innerHeight * 0.95;
    const scale = Math.min(availW / baseW, availH / baseH);
    model.scale.set(scale);
    model.x = (window.innerWidth - baseW * scale) / 2 - box.x * scale;
    model.y = window.innerHeight - baseH * scale - box.y * scale;
    ok(`缩放 ${scale.toFixed(4)} 倍 → 屏幕显示 ${Math.round(baseW * scale)} x ${Math.round(baseH * scale)}`);
    log(`模型位置: x=${Math.round(model.x)} y=${Math.round(model.y)}`);

    // ---------- 5. 帧率实测 ----------
    let frames = 0;
    const t1 = performance.now();
    app.ticker.add(() => { frames++; });

    await new Promise((r) => setTimeout(r, 3000));
    const fps = frames / ((performance.now() - t1) / 1000);
    ok(`实测帧率 ${fps.toFixed(1)} fps（上限 30）`);

    // ---------- 6. 表情与动作 ----------
    try {
      await model.expression('爱心眼');
      ok('表情切换成功：爱心眼');
    } catch (e) {
      fail('表情切换失败：' + e.message);
    }

    await new Promise((r) => setTimeout(r, 800));
    try {
      await model.motion('bubble');
      ok('动作播放成功：bubble（吹泡泡）');
    } catch (e) {
      fail('动作播放失败：' + e.message);
    }

    await new Promise((r) => setTimeout(r, 1500));

    // ---------- 7. 画布自导出存证 ----------
    // capturePage() 抓不到 WebGL 内容，所以直接让画布自己导出。
    // 这同时证明了"模型确实被画出来了"。
    app.renderer.render(app.stage);
    const dataUrl = app.view.toDataURL('image/png');
    const canvasInfo = await window.spikeAPI.saveCanvas(dataUrl, 'l2d-canvas');
    ok('画布导出已保存: ' + canvasInfo);

    // 顺便测一次：透明背景是否真的透（取左上角像素）
    try {
      const gl = app.renderer.gl;
      const px = new Uint8Array(4);
      gl.readPixels(2, 2, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      log(`画布左上角像素 RGBA = [${px[0]}, ${px[1]}, ${px[2]}, ${px[3]}]（alpha 应为 0）`);
    } catch (e) {
      log('读像素失败：' + e.message);
    }

    // ---------- 8. 桌面透明验证 ----------
    // 等一小会儿让窗口稳定合成，再抓桌面与底图比对。
    await new Promise((r) => setTimeout(r, 600));
    try {
      const desktopInfo = await window.spikeAPI.captureDesktop();
      ok('桌面比对结果:\n    ' + String(desktopInfo).replace(/\n/g, '\n    '));
    } catch (e) {
      fail('桌面比对失败：' + e.message);
    }

    ok('全部检查完成');
    window.spikeAPI.done();
  } catch (err) {
    fail('整体失败: ' + (err && err.message ? err.message : String(err)));
    if (err && err.stack) console.log('[spike] stack: ' + err.stack);
    window.spikeAPI.done();
  }
})();
