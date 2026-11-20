'use strict';
const { load, ok, near, summary } = require('./harness');
const PET = load(['core', 'isotopes', 'scanner', 'kinetics', 'phantoms']);
const Ph = PET.phantoms;

const TISSUES = ['gm', 'wm', 'csf', 'bone', 'soft', 'blood', 'water', 'air', 'lung', 'plastic'];
const ri = (ph, id) => Ph.regionIndex(ph, id);
function centroid(ph, id) {
    const i = ri(ph, id); let sx = 0, sy = 0, c = 0;
    for (let k = 0; k < ph.label.length; k++) if (ph.label[k] === i) { sx += (k % ph.n - 128) * ph.dx; sy += (Math.floor(k / ph.n) - 128) * ph.dx; c++; }
    return { x: sx / c, y: sy / c, n: c };
}

// Build time: every phantom from scratch under 150 ms (the first build in a
// process also pays for compiling the code, so take the better of two)
{
    for (const id of ['point', 'cylinder', 'spheres', 'rods', 'brain']) {
        const times = [];
        for (let r = 0; r < 2; r++) { Ph.clearCache(); const t0 = Date.now(); Ph.build(id); times.push(Date.now() - t0); }
        ok(Math.min.apply(null, times) < 150, id + ' builds in under 150 ms (' + times.join(', ') + ' ms)');
        if (id === 'brain') console.log('    brain build: ' + times.join(', ') + ' ms');
    }
}

// The list the UI shows
{
    const L = Ph.list();
    ok(L.map(p => p.id).join(',') === 'point,cylinder,spheres,rods,brain', 'five phantoms in order');
    ok(L.every(p => p.name && p.description && (p.kind === 'solution' || p.kind === 'brain') && Array.isArray(p.options)), 'list entries complete');
    ok(L.find(p => p.id === 'brain').kind === 'brain' && L.filter(p => p.kind === 'solution').length === 4, 'kinds');
    const opt = (pid, key) => L.find(p => p.id === pid).options.find(o => o.key === key);
    ok(opt('brain', 'condition').values.map(v => v.value).join(',') === 'normal,ad,pd' && opt('brain', 'condition').default === 'normal', 'brain condition option');
    ok(opt('spheres', 'ratio').values.map(v => v.value).join(',') === '2,4,8,16' && opt('spheres', 'ratio').default === 4, 'sphere ratio option');
    ok(opt('spheres', 'lung').type === 'bool' && opt('spheres', 'lung').default === true, 'lung option');
    ok(opt('point', 'medium').values.map(v => v.value).join(',') === 'air,water' && opt('point', 'medium').default === 'air', 'point medium option');
    let threw = false; try { Ph.build('teapot'); } catch (e) { threw = /Unknown phantom/.test(e.message); }
    ok(threw, 'unknown phantom throws');
    threw = false; try { Ph.build('brain', { condition: 'flu' }); } catch (e) { threw = /condition/.test(e.message); }
    ok(threw, 'invalid option value throws');
}

// Every phantom: raster, region records, labels, volumes, mu map
const VARIANTS = [['point', {}], ['point', { medium: 'water' }], ['cylinder', {}], ['spheres', {}], ['spheres', { ratio: 16, lung: false }],
    ['rods', {}], ['brain', {}], ['brain', { condition: 'ad' }], ['brain', { condition: 'pd' }]];
const AXIAL = { point: 50, cylinder: 200, spheres: 180, rods: 100, brain: 150 };
for (const [id, o] of VARIANTS) {
    const ph = Ph.build(id, o), tag = id + ' ' + JSON.stringify(o);
    ok(ph.id === id && ph.n === 256 && ph.fov === 320 && ph.dx === 1.25, tag + ': raster 256 x 1.25 mm');
    ok(ph.label instanceof Uint8Array && ph.label.length === 256 * 256 && ph.mu instanceof Float32Array && ph.mu.length === 256 * 256, tag + ': typed arrays');
    ok(ph.regions[0].id === 'air' && ph.regions[0].mu === 0, tag + ': regions[0] is air');
    let maxLabel = 0; for (const v of ph.label) if (v > maxLabel) maxLabel = v;
    ok(maxLabel < ph.regions.length, tag + ': every label indexes a region');
    let sum = 0, volOk = true, muOk = true, fieldsOk = true;
    ph.regions.forEach((r, i) => {
        sum += r.pixels;
        if (Math.abs(r.volume - r.pixels * 1.5625 * ph.axialLength / 1000) > 1e-9) volOk = false;
        if (!(typeof r.id === 'string' && typeof r.name === 'string' && /^#[0-9a-f]{6}$/i.test(r.color) && typeof r.mu === 'number' &&
            TISSUES.indexOf(r.tissue) >= 0 && typeof r.roi === 'boolean' && 'rel' in r)) fieldsOk = false;
        if (i > 0 && r.pixels === 0) fieldsOk = false;
    });
    ok(sum === 256 * 256, tag + ': pixel counts add up');
    ok(volOk, tag + ': volume = pixels dx^2 axialLength');
    ok(fieldsOk, tag + ': region records complete, every region has pixels');
    for (let k = 0; k < ph.label.length; k += 7) if (ph.mu[k] !== Math.fround(ph.regions[ph.label[k]].mu)) { muOk = false; break; }
    ok(muOk, tag + ': mu map follows the labels');
    const colors = new Set(ph.regions.map(r => r.color.toLowerCase()));
    ok(colors.size === ph.regions.length, tag + ': region colours distinct');
    ok(new Set(ph.regions.map(r => r.id)).size === ph.regions.length, tag + ': region ids unique');
    ok(ph.axialLength === AXIAL[id], tag + ': axialLength ' + AXIAL[id] + ' mm');
    ok(ph.outsideFraction === (id === 'brain' ? 0.3 : 0), tag + ': outsideFraction');
    ok(ph.kind === (id === 'brain' ? 'brain' : 'solution') && (id === 'brain' ? ph.condition === (o.condition || 'normal') : ph.condition === null), tag + ': kind and condition');
    ok(Array.isArray(ph.landmarks) && ph.landmarks.length > 0 && ph.landmarks.every(l => typeof l.name === 'string' && isFinite(l.x) && isFinite(l.y)), tag + ': landmarks');
    ok(typeof ph.notes === 'string' && ph.notes.length > 20 && !/\u2014/.test(ph.notes + ph.description + ph.regions.map(r => r.name).join('')), tag + ': notes, no em dashes');
}

// Caching
{
    Ph.clearCache();
    const a = Ph.build('brain'), b = Ph.build('brain', { condition: 'normal' });
    ok(a === b, 'default options and explicit defaults share a cache entry');
    ok(Ph.build('spheres', { ratio: 4 }) === Ph.build('spheres', { lung: true, ratio: '4' }), 'cache key ignores key order and number formatting');
    ok(Ph.build('brain', { condition: 'ad' }) !== a, 'different options, different phantom');
    Ph.clearCache();
    ok(Ph.build('brain') !== a, 'clearCache forgets');
}

// Line sources
{
    const ph = Ph.build('point');
    for (const [id, x, y] of [['src_0', 0, 0], ['src_50', 50, 0], ['src_100', 100, 0], ['src_top', 0, -100]]) {
        const c = centroid(ph, id);
        ok(c.n === 1 && Math.abs(c.x - x) < 1e-9 && Math.abs(c.y - y) < 1e-9, id + ' is one pixel at (' + x + ', ' + y + ')');
        ok(ph.regions[ri(ph, id)].rel === 1, id + ' carries the activity');
    }
    const w = Ph.build('point', { medium: 'water' }), iw = ri(w, 'water');
    ok(iw > 0 && w.regions[iw].rel === 0 && w.regions[iw].mu === 0.0096, 'water medium: no activity, mu of water');
    near(w.regions[iw].pixels * 1.5625 / (Math.PI * 100 * 100), 1, 0.02, 'water medium is a 200 mm cylinder');
}

// Uniform cylinder
{
    const ph = Ph.build('cylinder'), w = ph.regions[ri(ph, 'water')], wall = ph.regions[ri(ph, 'wall')];
    near(w.pixels * 1.5625 / (Math.PI * 100 * 100), 1, 0.01, 'cylinder diameter 200 mm');
    near(w.volume, 6283, 60, 'cylinder holds 6.28 L');
    ok(wall.mu === 0.0103 && wall.rel === 0 && wall.tissue === 'plastic', '3 mm PMMA wall, no activity');
    near(wall.pixels * 1.5625 / (Math.PI * (103 * 103 - 100 * 100)), 1, 0.05, 'wall 3 mm thick');
}

// Hot and cold spheres: diameters by pixel area, positions, ratios
{
    const ph = Ph.build('spheres');
    for (const [d, kind] of [[10, 'hot'], [13, 'hot'], [17, 'hot'], [22, 'hot'], [28, 'cold'], [37, 'cold']]) {
        const r = ph.regions[ri(ph, 'sphere' + d)], c = centroid(ph, 'sphere' + d);
        const dEq = 2 * Math.sqrt(r.pixels * 1.5625 / Math.PI);
        ok(Math.abs(dEq / d - 1) < 0.05, d + ' mm sphere has the right area (equivalent diameter ' + dEq.toFixed(2) + ' mm)');
        near(Math.hypot(c.x, c.y), 57.2, 0.6, d + ' mm sphere centred on the 57.2 mm circle');
        ok(r.rel === (kind === 'hot' ? 4 : 0) && r.kind === kind && r.diameter === d, d + ' mm sphere is ' + kind);
    }
    ok(ph.regions[ri(ph, 'background')].rel === 1, 'background relative activity 1');
    const lung = ph.regions[ri(ph, 'lung')];
    ok(lung.mu === 0.0030 && lung.rel === 0 && lung.tissue === 'lung', 'lung insert: lung mu, no activity');
    near(2 * Math.sqrt(lung.pixels * 1.5625 / Math.PI), 51, 1.5, 'lung insert 51 mm');
    near(ph.regions[ri(ph, 'background')].pixels * 1.5625 + ph.regions.slice(3).reduce((s, r) => s + r.pixels * 1.5625, 0),
        Math.PI * 115 * 115, 400, 'background cylinder 230 mm');
    const p2 = Ph.build('spheres', { ratio: 16, lung: false });
    ok(ri(p2, 'lung') < 0 && p2.regions[ri(p2, 'sphere13')].rel === 16, 'ratio and lung options');
    ok(p2.label[128 * 256 + 128] === ri(p2, 'background'), 'without the lung insert the centre is background');
    ok(/rods/.test(ph.notes), 'notes say the spheres act as rods in one slice');
}

// Hot rods
{
    const ph = Ph.build('rods');
    ok(ph.regions[ri(ph, 'water')].rel === 0, 'no background activity');
    const ds = [3, 4, 5, 6, 8, 10];
    ds.forEach(d => {
        const r = ph.regions[ri(ph, 'rods' + d)];
        ok(r && r.rel === 1 && r.diameter === d && r.spacing === 2 * d && r.centres.length >= 3, d + ' mm rods: ' + (r ? r.centres.length : 0) + ' rods at spacing ' + 2 * d + ' mm');
        let minSep = Infinity;
        for (let i = 0; i < r.centres.length; i++) for (let j = i + 1; j < r.centres.length; j++)
            minSep = Math.min(minSep, Math.hypot(r.centres[i][0] - r.centres[j][0], r.centres[i][1] - r.centres[j][1]));
        near(minSep, 2 * d, 1e-6, d + ' mm rods are two diameters apart');
        ok(r.centres.every(c => Math.hypot(c[0], c[1]) + d / 2 <= 92.01), d + ' mm rods inside the cylinder');
        const area = r.centres.length * Math.PI * d * d / 4;
        ok(Math.abs(r.pixels * 1.5625 / area - 1) < 0.12, d + ' mm rods cover their nominal area (' + (r.pixels * 1.5625 / area).toFixed(3) + ')');
    });
}

// Brain: region ids, anatomy, sizes, mu
{
    const ph = Ph.build('brain');
    const IDS = 'air scalp skull csf ventricles wm gm_frontal gm_temporal gm_occipital caudate_r caudate_l putamen_r_ant putamen_r_post putamen_l_ant putamen_l_post thalamus cereb_gm cereb_wm sinus'.split(' ');
    ok(ph.regions.map(r => r.id).join(' ') === IDS.join(' '), 'brain region ids as in the contract');
    const mu = id => ph.regions[ri(ph, id)].mu;
    ok(mu('skull') === 0.0151 && mu('scalp') === 0.0096 && mu('csf') === 0.0096 && mu('ventricles') === 0.0096, 'mu of bone, soft tissue and CSF');
    ok(['wm', 'gm_frontal', 'caudate_l', 'putamen_r_post', 'thalamus', 'cereb_gm', 'cereb_wm'].every(id => mu(id) === 0.0099), 'mu of brain');
    ok(ph.regions[ri(ph, 'sinus')].tissue === 'blood' && ph.regions[ri(ph, 'skull')].tissue === 'bone', 'tissue classes');
    ok(ph.regions.every(r => r.rel === null), 'brain regions have no fixed relative activity (kinetics decide)');
    // size of the head and of the brain in the slice
    let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
    for (let k = 0; k < ph.label.length; k++) if (ph.label[k]) {
        const x = (k % 256 - 128) * 1.25, y = (Math.floor(k / 256) - 128) * 1.25;
        x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
    }
    const W = x1 - x0 + 1.25, Ht = y1 - y0 + 1.25;
    ok(Math.abs(W - 150) < 10 && Math.abs(Ht - 190) < 10, 'head about 150 x 190 mm (' + W + ' x ' + Ht + ')');
    const parenchyma = ph.regions.filter(r => r.tissue === 'gm' || r.tissue === 'wm').reduce((s, r) => s + r.pixels, 0) * 1.5625 / 100;
    ok(parenchyma >= 100 && parenchyma <= 140, 'brain parenchyma ' + parenchyma.toFixed(1) + ' cm2 in the slice (100 to 140)');
    const gm = ['gm_frontal', 'gm_temporal', 'gm_occipital'].reduce((s, id) => s + ph.regions[ri(ph, id)].pixels, 0);
    const wm = ph.regions[ri(ph, 'wm')].pixels;
    ok(gm / wm > 0.5 && gm / wm < 1.2, 'cortex to white matter area ratio ' + (gm / wm).toFixed(2));
    console.log('    brain: head ' + W + ' x ' + Ht + ' mm, parenchyma ' + parenchyma.toFixed(1) + ' cm2, cortex/WM ' + (gm / wm).toFixed(2));
    // cortical ribbon about 3 mm: area / (half the GM-to-other boundary length)
    let edges = 0;
    const isGM = v => v === ri(ph, 'gm_frontal') || v === ri(ph, 'gm_temporal') || v === ri(ph, 'gm_occipital');
    for (let k = 0; k < ph.label.length - 257; k++) {
        if (isGM(ph.label[k]) !== isGM(ph.label[k + 1])) edges++;
        if (isGM(ph.label[k]) !== isGM(ph.label[k + 256])) edges++;
    }
    const thick = gm * 1.5625 / (edges * 1.25 / 2) * (4 / Math.PI);     // city-block boundary length overestimates by 4/pi
    ok(thick > 2.2 && thick < 4.5, 'cortical ribbon about 3 mm thick (' + thick.toFixed(2) + ' mm)');
    // radiological convention: patient's right on the image left
    ['caudate_r', 'putamen_r_ant', 'putamen_r_post'].forEach(id => ok(centroid(ph, id).x < -5, id + ' on the image left'));
    ['caudate_l', 'putamen_l_ant', 'putamen_l_post'].forEach(id => ok(centroid(ph, id).x > 5, id + ' on the image right'));
    // putamen split front to back, lateral to the caudate
    for (const s of ['r', 'l']) {
        const a = centroid(ph, 'putamen_' + s + '_ant'), p = centroid(ph, 'putamen_' + s + '_post'), c = centroid(ph, 'caudate_' + s);
        ok(a.y < p.y && Math.abs(a.x) > Math.abs(c.x) + 8 && Math.abs(a.n - p.n) / a.n < 0.2, 'putamen ' + s + ': anterior and posterior halves, lateral to the caudate');
    }
    // anatomy front to back
    const th = centroid(ph, 'thalamus'), cg = centroid(ph, 'cereb_gm'), si = centroid(ph, 'sinus'), ca = centroid(ph, 'caudate_l');
    ok(ca.y < th.y && th.y < cg.y, 'caudate in front of the thalamus, cerebellum behind');
    ok(Math.abs(th.x) < 1 && Math.abs(cg.x) < 1, 'thalamus and cerebellum bilateral, symmetric');
    ok(centroid(ph, 'gm_frontal').y < -20 && centroid(ph, 'gm_occipital').y > 25 && Math.abs(centroid(ph, 'gm_temporal').y) < 30, 'lobes: frontal in front, occipital behind');
    // ventricles: frontal horns either side of the septum, in front of the third ventricle
    const iv = ri(ph, 'ventricles');
    let left = 0, right = 0, mid = 0;
    for (let k = 0; k < ph.label.length; k++) if (ph.label[k] === iv) {
        const x = (k % 256 - 128) * 1.25, y = (Math.floor(k / 256) - 128) * 1.25;
        if (y < -12 && x < -1) left++; else if (y < -12 && x > 1) right++; else if (Math.abs(x) < 2.5 && y > -10) mid++;
    }
    ok(left > 30 && right > 30 && Math.abs(left - right) <= 2 && mid > 10, 'two frontal horns and a third ventricle (' + left + ', ' + right + ', ' + mid + ')');
    // confluence of sinuses at the posterior midline, 8 to 10 mm
    let sp = 0, sx = 0, sy = 0;
    for (let k = 0; k < ph.label.length; k++) if (ph.label[k] === ri(ph, 'sinus') && Math.floor(k / 256) > 128) { sp++; sx += (k % 256 - 128) * 1.25; sy += (Math.floor(k / 256) - 128) * 1.25; }
    const dS = 2 * Math.sqrt(sp * 1.5625 / Math.PI);
    ok(dS >= 8 && dS <= 10.5 && Math.abs(sx / sp) < 0.5 && sy / sp > 70, 'confluence of sinuses ' + dS.toFixed(1) + ' mm at the posterior midline');
    // CSF in the sulci: the cortex touches CSF along its outer edge and in sulci deep in the brain
    let deepCSF = 0;
    for (let k = 0; k < ph.label.length; k++) if (ph.label[k] === ri(ph, 'csf')) {
        const x = (k % 256 - 128) * 1.25, y = (Math.floor(k / 256) - 128) * 1.25;
        if (Math.hypot(x / 60, y / 78) < 0.8 && Math.hypot(x / 60, y / 78) > 0.5) deepCSF++;
    }
    ok(deepCSF > 150, 'sulci reach well into the brain (' + deepCSF + ' CSF pixels at depth)');
    // tentorium separates occipital cortex from the cerebellum: no pixel of one touches the other
    let touch = 0;
    const io = ri(ph, 'gm_occipital'), ic = ri(ph, 'cereb_gm'), icw = ri(ph, 'cereb_wm');
    for (let k = 257; k < ph.label.length - 257; k++) if (ph.label[k] === io) {
        for (const d of [1, -1, 256, -256]) if (ph.label[k + d] === ic || ph.label[k + d] === icw) touch++;
    }
    ok(touch === 0, 'tentorium separates the occipital lobes from the cerebellum');
    ok(ph.regions[ri(ph, 'cereb_wm')].pixels > 80 && ph.regions[ri(ph, 'cereb_gm')].pixels > 3 * ph.regions[ri(ph, 'cereb_wm')].pixels, 'cerebellum: gray folia around a white core');
    // landmarks for annotation
    const names = ph.landmarks.map(l => l.name);
    ['Confluence of sinuses', 'Tentorium', 'Vermis', 'Third ventricle', 'Caudate head (R)', 'Putamen (L)', 'Insula'].forEach(n =>
        ok(names.indexOf(n) >= 0, 'landmark ' + n));
    const R = ph.landmarks.find(l => l.name === 'R'), A = ph.landmarks.find(l => l.name === 'A');
    ok(R && R.x < 0 && R.kind === 'orientation' && A && A.y < 0, 'orientation markers: R on the left, A at the top');
    const pl = ph.landmarks.find(l => l.name === 'Putamen (L)');
    ok(ph.label[(Math.round(pl.y / 1.25) + 128) * 256 + Math.round(pl.x / 1.25) + 128] === ri(ph, 'putamen_l_ant') ||
        ph.label[(Math.round(pl.y / 1.25) + 128) * 256 + Math.round(pl.x / 1.25) + 128] === ri(ph, 'putamen_l_post'), 'putamen landmark lies on the putamen');
    // conditions share the anatomy
    const ad = Ph.build('brain', { condition: 'ad' }), pd = Ph.build('brain', { condition: 'pd' });
    ok(ad.condition === 'ad' && pd.condition === 'pd' && /Alzheimer/.test(ad.name) && /Parkinson/.test(pd.name), 'AD and PD options accepted and named');
    ok(ad.label.every((v, k) => v === ph.label[k]), 'same anatomy in every condition');
    // region symmetry: left and right structures the same size
    ok(ph.regions[ri(ph, 'caudate_r')].pixels === ph.regions[ri(ph, 'caudate_l')].pixels &&
        ph.regions[ri(ph, 'putamen_r_post')].pixels === ph.regions[ri(ph, 'putamen_l_post')].pixels, 'left and right deep nuclei match');
}

summary('phantoms');
