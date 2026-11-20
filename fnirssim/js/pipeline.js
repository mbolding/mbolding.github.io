/* fNIRS simulator: the processing pipeline.

   From raw intensities to statistics, in the order most fNIRS pipelines
   use (Homer, MNE-NIRS, NIRS Toolbox):

     raw intensity --quality--> channels kept or rejected
       --> optical density --> motion correction --> band-pass filter
       --> concentration changes (modified Beer-Lambert law)
       --> short-channel regression --> block averages and GLM

   process(ds, rec, P) runs everything from a stage down and returns one
   object the tabs read from.  P holds the analysis settings and starts as
   the program's analysis block. */
(function (G) {
  'use strict';
  const NIRS = G.NIRS, dsp = NIRS.dsp;

  NIRS.pipeline = {};
  NIRS.pipeline.defaults = function (cfg) {
    const an = JSON.parse(JSON.stringify(cfg.analysis));
    return Object.assign(an, { qualityOn: true, splineK: 5 });
  };

  /* Concentrations from OD for every channel under the settings P. */
  function toConc(ds, odRows, P) {
    return ds.chans.map((c, ci) => {
      const dpf = dsp.dpfValues(ds, P, c);
      const r = dsp.mbll(odRows[ci], ds.lambdas, c.rho, dpf);
      return { hbo: r.hbo, hbr: r.hbr, dpf, Ei: r.Ei };
    });
  }

  NIRS.pipeline.run = function (ds, rec, P, prev, from) {
    const STAGES = ['quality', 'od', 'motion', 'filter', 'conc', 'short', 'stats'];
    let k = STAGES.indexOf(from || 'quality');
    if (!prev) k = 0;
    const out = prev ? Object.assign({}, prev) : {};
    const fs = ds.fs;
    if (k <= 0) out.quality = dsp.quality(ds, rec, { sci: P.sci, cv: P.cv });
    if (k <= 0) out.bad = new Set(P.qualityOn ? out.quality.map((q, i) => (q.bad ? i : -1)).filter(i => i >= 0) : []);
    if (k <= 1) out.od = rec.I.map(row => row.map(x => dsp.od(x)));
    if (k <= 2) {
      out.motionSegs = ds.chans.map(() => null);
      out.odm = out.od.map((row, ci) => row.map((x, li) => {
        if (P.motion === 'tddr') return dsp.tddr(x, fs).y;
        if (P.motion === 'spline') {
          const det = out.motionSegs[ci] || (out.motionSegs[ci] = dsp.detectMotion(row[row.length - 1], fs, P.splineK));
          return dsp.splineCorrect(x, fs, P.splineK, det.segs).y;
        }
        return x;
      }));
    }
    if (k <= 3) out.odf = out.odm.map(row => row.map(x => dsp.bandpass(x, fs, P.hp, P.lp)));
    if (k <= 4) out.conc = toConc(ds, out.odf, P);
    if (k <= 5) {
      out.shortReg = dsp.shortRegressors(ds, out.conc, P.qualityOn ? out.quality : null, P.short);
      /* 'before': regress the short channel out of the whole series first.
         Simple, but when the scalp signal is itself time-locked to the task,
         the regression also takes away the part of the cortical response
         that resembles it.  'glm': estimate the short channel's weight in a
         model that also contains the task, then remove only that part. */
      const des = P.short !== 'off' && P.shortMode === 'glm' ? dsp.firDesign(ds, Math.max(P.epoch[1], 10), 2.5, Math.max(0.004, P.hp || 0.008)) : null;
      out.clean = out.conc.map((c, ci) => {
        const sr = out.shortReg[ci];
        if (!sr) return { hbo: c.hbo, hbr: c.hbr, betaO: null, betaR: null };
        if (des) {
          const one = key => {
            const x = sr[key], f = dsp.olsCols(des.cols.concat([x]), c[key]), b = f.beta[f.beta.length - 1], mx = NIRS.mean(x);
            return { y: Float64Array.from(c[key], (v, i) => v - b * (x[i] - mx)), beta: b };
          };
          const a = one('hbo'), b = one('hbr');
          return { hbo: a.y, hbr: b.y, betaO: a.beta, betaR: b.beta };
        }
        const a = dsp.regressOut(c.hbo, sr.hbo), b = dsp.regressOut(c.hbr, sr.hbr);
        return { hbo: a.y, hbr: b.y, betaO: a.beta, betaR: b.beta };
      });
    }
    if (k <= 6) {
      out.avg = averages(ds, out.clean, P);
      out.glm = null;          // computed on demand: it is the slowest step
    }
    return out;
  };

  function averages(ds, rows, P) {
    return ds.conditions.map((c, ci) => ds.chans.map((ch, k) => {
      const eo = dsp.epochs(rows[k].hbo, ds.fs, ds.events, ci, P.epoch, P.baseline);
      const er = dsp.epochs(rows[k].hbr, ds.fs, ds.events, ci, P.epoch, P.baseline);
      return { times: eo.times, hbo: eo.list, hbr: er.list, mHbo: dsp.average(eo.list), mHbr: dsp.average(er.list) };
    }));
  }
  NIRS.pipeline.averages = averages;

  /* The GLM for every channel and both chromophores.  It is fitted to
     concentrations that have been motion corrected but not band-pass
     filtered: slow drift is modelled by cosine regressors instead, and the
     serial correlation of the physiological noise by an AR model of up to
     4 x fs lags (as in AR-IRLS, Barker and colleagues 2013).  Filtering
     first would make the noise so smooth that no AR model could whiten it,
     and the t values would be wildly inflated.  The short channel, when
     used, is subtracted with the weight estimated in the processing step. */
  NIRS.pipeline.glm = function (ds, res, P) {
    const des = dsp.design(ds, P, { driftHz: Math.max(0.004, P.hp || 0.008) });
    const raw = toConc(ds, res.odm, P);
    const fs = ds.fs, order = Math.min(60, Math.max(2, Math.round(4 * fs)));
    const idx = label => ds.chans.findIndex(c => c.label === label);
    const regOf = ci => {
      const sr = res.shortReg[ci];
      if (!sr || P.short === 'off') return null;
      const ii = sr.from.map(idx).filter(i => i >= 0);
      const avg = key => { const out = new Float64Array(ds.n); ii.forEach(i => { const x = raw[i][key]; for (let k = 0; k < ds.n; k++) out[k] += x[k] / ii.length; }); return out; };
      return { hbo: avg('hbo'), hbr: avg('hbr') };
    };
    return ds.chans.map((c, ci) => {
      const sr = regOf(ci);
      const fit = key => {
        let y = raw[ci][key], w = null;
        if (sr) {
          /* The short channel's weight comes from the band-limited data (res.clean),
             where it was estimated alongside a flexible model of the task ('glm') or
             on its own ('before'); unfiltered, the heartbeat would dominate it. */
          w = res.clean[ci][key === 'hbo' ? 'betaO' : 'betaR'];
          const x = sr[key], mx = NIRS.mean(x);
          y = Float64Array.from(y, (v, i) => v - w * (x[i] - mx));
        }
        const f = dsp.glmFit(y, des.cols, { ar: P.noise === 'ar', order });
        const nk = des.nTask * (P.deriv ? 2 : 1);
        return { beta: Array.from(f.beta.slice(0, nk)), t: Array.from(f.t.slice(0, nk)), df: f.df, fitted: f.fitted, y, short: w };
      };
      return { hbo: fit('hbo'), hbr: fit('hbr') };
    });
  };
  NIRS.pipeline.taskIndex = (P, ci) => ci * (P.deriv ? 2 : 1);

  /* Plain conversion with no filtering or correction, for looking at the
     raw data (Recording and Confounds tabs). */
  NIRS.pipeline.quickConc = function (ds, rec, P) { return toConc(ds, rec.I.map(row => row.map(x => dsp.od(x))), P); };

  /* The truth: what the cortex alone contributes, through the same optics,
     the same conversion and the same filters, but with no physiology, no
     artifacts and no noise. */
  NIRS.pipeline.truth = function (ds, P) {
    const brain = new Set(ds.groups.filter(g => g.kind === 'brain').map(g => g.id));
    const rec = NIRS.assemble(ds, { enabled: brain, noise: false });
    const od = rec.I.map(row => row.map(x => dsp.od(x)));
    const odf = od.map(row => row.map(x => dsp.bandpass(x, ds.fs, P.hp, P.lp)));
    const conc = toConc(ds, odf, P);
    return { conc, avg: averages(ds, conc, P) };
  };

  /* How much of each channel's light reached a region: the channel's
     sensitivity to it (cm of mean path inside the region) and the fraction
     of its whole path that is (the partial volume). */
  NIRS.pipeline.regionSensitivity = function (ds, li) {
    return ds.regions.map((rg, ri) => ds.chans.map(c => ({ L: c.per[li].La[ri], frac: c.per[li].La[ri] / c.per[li].L })));
  };
})(typeof window !== 'undefined' ? window : globalThis);
