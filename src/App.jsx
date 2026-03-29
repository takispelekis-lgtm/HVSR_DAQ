import React, { useState, useEffect, useRef } from 'react';
import { Upload, Settings, Activity, LineChart, FileText, ChevronLeft, ChevronRight, Eye, Grid, Table, Copy, Check } from 'lucide-react';

// --- ΥΠΟΛΟΓΙΣΤΙΚΕΣ ΣΥΝΑΡΤΗΣΕΙΣ ---

function computeSpectraForChannel(w, c, dt, acc) {
  const npts = acc.length;
  if (npts < 3) return 0;
  
  const OMGO = w * dt;
  const omgd = OMGO * Math.sqrt(1 - c * c);
  const cosd = Math.cos(omgd);
  const sind = Math.sin(omgd);
  const exp1 = Math.exp(-c * OMGO);
  const exp2 = Math.exp(-2 * c * OMGO);
  const b1 = 2 * exp1 * cosd;
  const b2 = -exp2;
  const E1 = (1 / omgd) * exp1 * sind;
  const E2 = (-2 * exp1 / omgd) * sind;
  const e3 = exp1 * (cosd - (1 + c * OMGO) / omgd * sind);

  let AM1 = -acc[0];
  let a = -e3 * acc[0] - E1 * acc[1];
  let amax = Math.abs(a + acc[1]);

  for (let i = 1; i < npts - 1; i++) {
    let AP1 = b1 * a + b2 * AM1 - E1 * (acc[i - 1] + acc[i + 1]) - E2 * acc[i];
    let AT = AP1 + acc[i + 1];
    if (Math.abs(AT) > amax) {
      amax = Math.abs(AT);
    }
    AM1 = a;
    a = AP1;
  }
  return amax;
}

function nextPow2(v) {
  v--;
  v |= v >> 1; v |= v >> 2; v |= v >> 4; v |= v >> 8; v |= v >> 16;
  v++;
  return v;
}

function fft(re, im) {
  const N = re.length;
  let j = 0;
  for (let i = 0; i < N - 1; i++) {
    if (i < j) {
      let tr = re[j], ti = im[j];
      re[j] = re[i]; im[j] = im[i];
      re[i] = tr; im[i] = ti;
    }
    let m = N >> 1;
    while (m >= 1 && j >= m) { j -= m; m >>= 1; }
    j += m;
  }
  for (let l = 2; l <= N; l <<= 1) {
    let half = l >> 1;
    let wtr = Math.cos(-2 * Math.PI / l);
    let wti = Math.sin(-2 * Math.PI / l);
    for (let i = 0; i < N; i += l) {
      let wr = 1, wi = 0;
      for (let k = 0; k < half; k++) {
        let idx = i + k;
        let idx2 = idx + half;
        let tr = wr * re[idx2] - wi * im[idx2];
        let ti = wr * im[idx2] + wi * re[idx2];
        re[idx2] = re[idx] - tr;
        im[idx2] = im[idx] - ti;
        re[idx] += tr;
        im[idx] += ti;
        let nwr = wr * wtr - wi * wti;
        let nwi = wr * wti + wi * wtr;
        wr = nwr; wi = nwi;
      }
    }
  }
}

function getFAS(data, dt, windowType, gain = 1) {
  const originalN = data.length;
  const N = nextPow2(originalN);
  const re = new Float32Array(N);
  const im = new Float32Array(N);
  
  for(let i = 0; i < originalN; i++) {
    let w = 1;
    if(windowType === 'Hanning') {
      w = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (originalN - 1)));
    } else if (windowType === 'Hamming') {
      w = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (originalN - 1));
    }
    re[i] = data[i] * w * gain;
  }

  fft(re, im);
  
  const df = 1 / (N * dt);
  const fas = [];
  for(let i = 0; i <= N / 2; i++) {
    fas.push({
      f: i * df,
      amp: Math.sqrt(re[i] * re[i] + im[i] * im[i]) * dt 
    });
  }
  return fas;
}

function smoothFAS(fas, windowSize) {
  if (windowSize <= 1) return fas;
  const out = [];
  const half = Math.floor(windowSize / 2);
  for (let i = 0; i < fas.length; i++) {
    let sum = 0, count = 0;
    for (let j = Math.max(0, i - half); j <= Math.min(fas.length - 1, i + half); j++) {
      sum += fas[j].amp;
      count++;
    }
    out.push({ f: fas[i].f, amp: sum / count });
  }
  return out;
}

function getDerivative(data, dt) {
  const n = data.length;
  const out = new Float32Array(n);
  if (n === 0) return out;
  out[0] = 0; 
  for (let i = 1; i < n; i++) {
    out[i] = (data[i] - data[i - 1]) / dt;
  }
  return out;
}

// --- ΣΥΝΑΡΤΗΣΕΙΣ HEATMAP (JET COLORMAP) ---
function valueToColor(val, min, max, logScale) {
  let v;
  if (logScale) {
      const logVal = Math.log10(Math.max(val, 1e-10));
      const logMin = Math.log10(Math.max(min, 1e-10));
      const logMax = Math.log10(Math.max(max, 1e-10));
      v = (logVal - logMin) / (logMax - logMin || 1);
  } else {
      v = (val - min) / (max - min || 1);
  }
  v = Math.max(0, Math.min(1, v));
  const r = Math.max(0, Math.min(1, 1.5 - Math.abs(4 * v - 3))) * 255;
  const g = Math.max(0, Math.min(1, 1.5 - Math.abs(4 * v - 2))) * 255;
  const b = Math.max(0, Math.min(1, 1.5 - Math.abs(4 * v - 1))) * 255;
  return [r, g, b, 255];
}

const HeatmapViewer = ({ computedData, records, selectedRecords, activeRecord, setActiveRecord }) => {
  const [hmParams, setHmParams] = useState({
    domain: 'SDOF', // 'SDOF' or 'FFT'
    component: 'Ratio', // 'Ratio', 'Z', 'X', 'Y'
    maxF: 20,
    logScale: true
  });
  
  const canvasRef = useRef(null);

  useEffect(() => {
    if (!computedData || !canvasRef.current) return;
    const ctx = canvasRef.current.getContext('2d');
    
    let freqs = hmParams.domain === 'SDOF' ? computedData.sdofFreqs : computedData.fftFreqs;
    let data2D = [];
    
    if (hmParams.domain === 'SDOF') {
      if (hmParams.component === 'Ratio') data2D = computedData.hv;
      else if (hmParams.component === 'Z') data2D = computedData.sdofV;
      else if (hmParams.component === 'X') data2D = computedData.sdofH1;
      else if (hmParams.component === 'Y') data2D = computedData.sdofH2;
    } else {
      if (hmParams.component === 'Ratio') data2D = computedData.hvFFT;
      else if (hmParams.component === 'Z') data2D = computedData.fftV;
      else if (hmParams.component === 'X') data2D = computedData.fftH1;
      else if (hmParams.component === 'Y') data2D = computedData.fftH2;
    }

    let height = 0;
    while (height < freqs.length && freqs[height] <= hmParams.maxF) {
      height++;
    }
    if (height === 0) height = 1;
    
    const width = records;

    if (width === 0 || height === 0) return;

    canvasRef.current.width = width;
    canvasRef.current.height = height;
    const imgData = ctx.createImageData(width, height);

    let validVals = [];
    for (let r = 0; r < width; r++) {
      if (!selectedRecords[r]) continue; 
      for (let i = 0; i < height; i++) {
        let val = data2D[i][r];
        if (val > 0 && !isNaN(val)) validVals.push(val);
      }
    }
    
    let min = 1e-5, max = 10;
    if (validVals.length > 0) {
      validVals.sort((a, b) => a - b);
      min = validVals[Math.floor(validVals.length * 0.02)]; 
      max = validVals[Math.floor(validVals.length * 0.98)]; 
      if (min === max) { min *= 0.9; max *= 1.1; } 
    }

    for (let i = 0; i < height; i++) {
      const y = height - 1 - i; 
      for (let r = 0; r < width; r++) {
        let val = data2D[i][r];
        let color = valueToColor(val, min, max, hmParams.logScale);
        
        let idx = (y * width + r) * 4;
        imgData.data[idx] = color[0];
        imgData.data[idx+1] = color[1];
        imgData.data[idx+2] = color[2];
        imgData.data[idx+3] = 255;
        
        if (!selectedRecords[r]) {
          imgData.data[idx] *= 0.25;
          imgData.data[idx+1] *= 0.25;
          imgData.data[idx+2] *= 0.25;
        }
        
        if (activeRecord === r) {
          imgData.data[idx] = Math.min(255, imgData.data[idx] + 100);
          imgData.data[idx+1] = Math.min(255, imgData.data[idx+1] + 100);
          imgData.data[idx+2] = Math.min(255, imgData.data[idx+2] + 100);
        }
      }
    }
    ctx.putImageData(imgData, 0, 0);

  }, [computedData, hmParams, records, selectedRecords, activeRecord]);

  const handleCanvasClick = (e) => {
    if (!canvasRef.current) return;
    const rect = canvasRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const recordIndex = Math.floor((x / rect.width) * records);
    if (recordIndex >= 0 && recordIndex < records) {
      setActiveRecord(recordIndex);
    }
  };

  return (
    <div className="flex flex-col h-full bg-white border border-slate-200 shadow-sm rounded-lg overflow-hidden">
      <div className="flex items-center justify-between p-3 gap-2 bg-slate-50 border-b border-slate-200">
        <h3 className="font-bold text-sm text-slate-800 flex items-center gap-1.5">
          <Grid className="w-4 h-4 text-blue-600" />
          Spectral Heatmap
        </h3>
        <div className="flex items-center gap-2 text-xs">
          <select 
            value={hmParams.domain} 
            onChange={(e) => setHmParams({...hmParams, domain: e.target.value})}
            className="border border-slate-300 rounded p-1 outline-none bg-white"
          >
            <option value="SDOF">SDOF</option>
            <option value="FFT">FFT</option>
          </select>
          <select 
            value={hmParams.component} 
            onChange={(e) => setHmParams({...hmParams, component: e.target.value})}
            className="border border-slate-300 rounded p-1 outline-none bg-white"
          >
            <option value="Ratio">Λόγος H/V</option>
            <option value="Z">Z (Vert)</option>
            <option value="X">X (Hor 1)</option>
            <option value="Y">Y (Hor 2)</option>
          </select>
          <input 
            type="number" 
            value={hmParams.maxF} 
            onChange={(e) => setHmParams({...hmParams, maxF: Number(e.target.value) || 1})}
            className="border border-slate-300 rounded p-1 w-14 text-center outline-none bg-white"
            title="Max Frequency"
          />
          <label className="flex items-center gap-1 cursor-pointer font-bold text-slate-700">
            <input 
              type="checkbox" 
              checked={hmParams.logScale} 
              onChange={(e) => setHmParams({...hmParams, logScale: e.target.checked})}
            />
            Log
          </label>
        </div>
      </div>
      
      <div className="flex-1 relative flex bg-white m-2 border border-slate-200 mt-0">
         {/* Y-Axis Labels (Frequencies) */}
         <div className="w-12 relative p-1 text-[10px] text-slate-700 font-bold bg-slate-50 border-r border-slate-200">
            {[0, 0.25, 0.5, 0.75, 1].map(frac => {
               const val = hmParams.maxF * frac;
               return (
                 <span key={frac} className="absolute right-1" style={{ bottom: `${frac * 100}%`, transform: 'translateY(50%)' }}>
                   {val.toFixed(1)}
                 </span>
               );
            })}
         </div>
         {/* Canvas Area */}
         <div className="flex-1 relative cursor-crosshair" onClick={handleCanvasClick}>
           <canvas 
             ref={canvasRef} 
             className="absolute inset-0 w-full h-full"
             style={{ imageRendering: 'pixelated' }}
           />
         </div>
      </div>
      {/* X-Axis Labels (Records) */}
      <div className="h-6 relative w-full text-[10px] text-slate-700 font-bold px-12 mb-1">
         {[0, 0.25, 0.5, 0.75, 1].map(frac => {
            const numTicksX = records > 1 ? records - 1 : 1;
            const recIdx = Math.floor(numTicksX * frac);
            if (records === 0) return null;
            return (
              <span key={frac} className="absolute top-0" style={{ left: `calc(3rem + ${frac * 100} * calc(100% - 3rem) / 100)`, transform: 'translateX(-50%)' }}>
                Rec {recIdx + 1}
              </span>
            );
         })}
      </div>
    </div>
  );
};


// --- MAIN APP COMPONENT ---
export default function App() {
  const [fileData, setFileData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [fileName, setFileName] = useState("");

  const [params, setParams] = useState({
    nspec: 100,
    maxfre: 20,
    dratio: 0.05,
    power: 1,
    option: 3,        
    dt: 0.01,
    horGain: 1,       
    windowType: 'Hanning', 
    fftSmoothWindow: 5,
    sdofInput: 'velocity', 
    chV: 0,
    chH1: 1,
    chH2: 2,
    penMinF: 0.5,
    penMaxF: 10.0
  });

  const [selectedRecords, setSelectedRecords] = useState([]);
  const [activeRecord, setActiveRecord] = useState(0); 
  const [hoveredRecord, setHoveredRecord] = useState(null);
  const [computedData, setComputedData] = useState(null);
  
  const [chartScale, setChartScale] = useState('linear');
  const [chartMaxY, setChartMaxY] = useState(10); 
  const [chartMaxX, setChartMaxX] = useState(20); 
  
  const [sortByPenalty, setSortByPenalty] = useState(false);
  const [tableDomain, setTableDomain] = useState('SDOF'); 
  const [tableCopied, setTableCopied] = useState(false);

  // States για τους Cursors στα γραφήματα
  const [tsCursor, setTsCursor] = useState(null);
  const [chartCursor, setChartCursor] = useState(null);
  
  const [displayOpts, setDisplayOpts] = useState({
    showMeanSDOF: true,
    showMeanFFT: true,
    showActiveSDOF: true,
    showActiveFFT: true,
    showAllSDOF: true,
    showAllFFT: false,
    showStdDev: false
  });

  const handleFileUpload = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    setFileName(file.name);
    setLoading(true);

    const reader = new FileReader();
    reader.onload = (event) => {
      const text = event.target.result;
      try {
        const lines = text.split(/\r?\n/);
        
        const recordsTokens = lines[3].trim().split(/[\s,]+/).filter(Boolean);
        const records = parseInt(recordsTokens[recordsTokens.length - 1], 10);

        const trTokens = lines[9].trim().split(/[\s,]+/).filter(Boolean);
        const tr = parseFloat(trTokens[trTokens.length - 1]);

        const dtTokens = lines[10].trim().split(/[\s,]+/).filter(Boolean);
        const dt = parseFloat(dtTokens[dtTokens.length - 1]) / 1000;

        const npoints = Math.floor(tr / dt);

        const sensorData = Array.from({ length: records }, () =>
          Array.from({ length: 12 }, () => new Float32Array(npoints))
        );

        const dataStartIndex = 22;
        for (let i = 0; i < npoints; i++) {
          const lineIdx = dataStartIndex + i;
          if (lineIdx >= lines.length) break;
          const tokens = lines[lineIdx].trim().split(/[\s,]+/).filter(Boolean);
          if (tokens.length < 2 + 12 * records) continue;

          let tIdx = 2;
          for (let rec = 0; rec < records; rec++) {
            for (let ch = 0; ch < 12; ch++) {
              let val = parseFloat(tokens[tIdx++]);
              if (!isNaN(val) && ch < 12) {
                sensorData[rec][ch][i] = val;
              }
            }
          }
        }

        setParams(p => ({ ...p, dt: dt }));
        setFileData({ records, npoints, sensorData });
        setSelectedRecords(Array(records).fill(true));
        setActiveRecord(0);
        setLoading(false);
      } catch (err) {
        console.error(err);
        alert("Σφάλμα κατά την ανάγνωση του αρχείου. Ελέγξτε τη μορφή του.");
        setLoading(false);
      }
    };
    reader.readAsText(file);
  };

  useEffect(() => {
    if (!fileData) return;

    const timer = setTimeout(() => {
      const { records, sensorData } = fileData;
      const { nspec, maxfre, dratio, dt, option, power, horGain, windowType, fftSmoothWindow, sdofInput, chV, chH1, chH2, penMinF, penMaxF } = params;
      
      const safeMaxFre = Number(maxfre) || 20;
      
      const sdofFreqs = [];
      for (let i = 1; i <= nspec; i++) sdofFreqs.push((safeMaxFre / nspec) * i);

      const sdofV_arr = Array(nspec).fill(0).map(() => Array(records).fill(0));
      const sdofH1_arr = Array(nspec).fill(0).map(() => Array(records).fill(0));
      const sdofH2_arr = Array(nspec).fill(0).map(() => Array(records).fill(0));
      const hv = Array(nspec).fill(0).map(() => Array(records).fill(0));
      
      let fftFreqs = [];
      let fftV_arr = [];
      let fftH1_arr = [];
      let fftH2_arr = [];
      let hvFFT = [];

      for (let rec = 0; rec < records; rec++) {
        
        const vFAS = getFAS(sensorData[rec][chV], dt, windowType, 1);
        const h1FAS = getFAS(sensorData[rec][chH1], dt, windowType, 1);
        const h2FAS = getFAS(sensorData[rec][chH2], dt, windowType, 1);
        
        const smoothedVFAS = smoothFAS(vFAS, fftSmoothWindow).filter(item => item.f > 0 && item.f <= safeMaxFre);
        const smoothedH1FAS = smoothFAS(h1FAS, fftSmoothWindow).filter(item => item.f > 0 && item.f <= safeMaxFre);
        const smoothedH2FAS = smoothFAS(h2FAS, fftSmoothWindow).filter(item => item.f > 0 && item.f <= safeMaxFre);

        if (rec === 0) {
          fftFreqs = smoothedVFAS.map(item => item.f);
          fftV_arr = Array(fftFreqs.length).fill(0).map(() => Array(records).fill(0));
          fftH1_arr = Array(fftFreqs.length).fill(0).map(() => Array(records).fill(0));
          fftH2_arr = Array(fftFreqs.length).fill(0).map(() => Array(records).fill(0));
          hvFFT = Array(fftFreqs.length).fill(0).map(() => Array(records).fill(0));
        }

        for (let i3 = 0; i3 < fftFreqs.length; i3++) {
          const vAmp = smoothedVFAS[i3].amp;
          const h1Amp = smoothedH1FAS[i3].amp;
          const h2Amp = smoothedH2FAS[i3].amp;

          fftV_arr[i3][rec] = vAmp;
          fftH1_arr[i3][rec] = h1Amp;
          fftH2_arr[i3][rec] = h2Amp;

          let valFFT = 0;
          if (vAmp > 0) {
             if (option === 1) valFFT = Math.pow(h1Amp / vAmp, power);
             else if (option === 2) valFFT = Math.pow(h2Amp / vAmp, power);
             else if (option === 3) valFFT = Math.pow(Math.sqrt(h1Amp * h2Amp) / vAmp, power);
          }
          hvFFT[i3][rec] = valFFT;
        }

        const sdofV = sdofInput === 'acceleration' ? getDerivative(sensorData[rec][chV], dt) : sensorData[rec][chV];
        const sdofH1 = sdofInput === 'acceleration' ? getDerivative(sensorData[rec][chH1], dt) : sensorData[rec][chH1];
        const sdofH2 = sdofInput === 'acceleration' ? getDerivative(sensorData[rec][chH2], dt) : sensorData[rec][chH2];

        for (let i3 = 0; i3 < nspec; i3++) {
          const fre = sdofFreqs[i3];
          const w = 2 * Math.PI * fre;

          const v = computeSpectraForChannel(w, dratio, dt, sdofV);
          const h1 = computeSpectraForChannel(w, dratio, dt, sdofH1) * horGain;
          const h2 = computeSpectraForChannel(w, dratio, dt, sdofH2) * horGain;

          sdofV_arr[i3][rec] = v;
          sdofH1_arr[i3][rec] = h1;
          sdofH2_arr[i3][rec] = h2;

          let valSDOF = 0;
          if (v > 0) {
            if (option === 1) valSDOF = Math.pow(h1 / v, power);
            else if (option === 2) valSDOF = Math.pow(h2 / v, power);
            else if (option === 3) valSDOF = Math.pow(Math.sqrt(h1 * h2) / v, power);
          }
          hv[i3][rec] = valSDOF;
        }
      }

      // --- Averaging & Standard Deviation ---
      const hvave = Array(nspec).fill(0);
      const hvFFTave = Array(fftFreqs.length).fill(0);
      const hvStd = Array(nspec).fill(0);
      const hvFFTStd = Array(fftFreqs.length).fill(0);
      
      let selCount = selectedRecords.filter(Boolean).length;
      
      if (selCount > 0) {
        for (let i = 0; i < nspec; i++) {
          let sumSDOF = 0;
          for (let rec = 0; rec < records; rec++) {
            if (selectedRecords[rec]) sumSDOF += hv[i][rec];
          }
          hvave[i] = sumSDOF / selCount;
        }
        for (let i = 0; i < fftFreqs.length; i++) {
          let sumFFT = 0;
          for (let rec = 0; rec < records; rec++) {
            if (selectedRecords[rec]) sumFFT += hvFFT[i][rec];
          }
          hvFFTave[i] = sumFFT / selCount;
        }
        
        if (selCount > 1) {
          for (let i = 0; i < nspec; i++) {
            let sumSq = 0;
            for (let rec = 0; rec < records; rec++) {
              if (selectedRecords[rec]) sumSq += Math.pow(hv[i][rec] - hvave[i], 2);
            }
            hvStd[i] = Math.sqrt(sumSq / (selCount - 1));
          }
          for (let i = 0; i < fftFreqs.length; i++) {
            let sumSq = 0;
            for (let rec = 0; rec < records; rec++) {
              if (selectedRecords[rec]) sumSq += Math.pow(hvFFT[i][rec] - hvFFTave[i], 2);
            }
            hvFFTStd[i] = Math.sqrt(sumSq / (selCount - 1));
          }
        }
      }

      // --- Υπολογισμός Penalty ---
      const penalties = Array(records).fill(0);
      for (let rec = 0; rec < records; rec++) {
        let pen = 0;
        for (let i = 0; i < nspec; i++) {
          const f = sdofFreqs[i];
          if (f >= penMinF && f <= penMaxF) {
            const diff = hv[i][rec] - hvave[i];
            pen += diff; 
          }
        }
        penalties[rec] = pen;
      }

      setComputedData({ 
        sdofFreqs, fftFreqs, 
        hv, hvFFT, 
        sdofV: sdofV_arr, sdofH1: sdofH1_arr, sdofH2: sdofH2_arr,
        fftV: fftV_arr, fftH1: fftH1_arr, fftH2: fftH2_arr,
        hvave, hvFFTave, hvStd, hvFFTStd, penalties 
      });
    }, 50);

    return () => clearTimeout(timer);
  }, [fileData, params, selectedRecords]);

  useEffect(() => {
    setChartMaxX(params.maxfre);
  }, [params.maxfre]);

  // Λειτουργία Αντιγραφής Πίνακα
  const handleCopyTable = () => {
    if (!computedData) return;
    let tsv = "";
    
    let freqs = tableDomain === 'SDOF' ? computedData.sdofFreqs : computedData.fftFreqs;
    let meanArr = tableDomain === 'SDOF' ? computedData.hvave : computedData.hvFFTave;
    let stdArr = tableDomain === 'SDOF' ? computedData.hvStd : computedData.hvFFTStd;
    let data2D = tableDomain === 'SDOF' ? computedData.hv : computedData.hvFFT;

    let headers = ["Freq(Hz)", "MO", "+1σ", "-1σ"];
    fileData.sensorData.forEach((_, i) => {
        if (selectedRecords[i]) headers.push(`R ${i + 1}`);
    });
    tsv += headers.join("\t") + "\n";

    for (let i = 0; i < freqs.length; i++) {
        let row = [
            freqs[i].toFixed(4),
            meanArr[i].toFixed(4),
            (meanArr[i] + stdArr[i]).toFixed(4),
            Math.max(0, meanArr[i] - stdArr[i]).toFixed(4)
        ];
        for (let rec = 0; rec < fileData.records; rec++) {
            if (selectedRecords[rec]) row.push(data2D[i][rec].toFixed(4));
        }
        tsv += row.join("\t") + "\n";
    }

    navigator.clipboard.writeText(tsv).then(() => {
      setTableCopied(true);
      setTimeout(() => setTableCopied(false), 2000);
    });
  };

  const handleParamChange = (e) => {
    const { name, value, type } = e.target;
    let parsedValue = value;
    
    if (type === 'number' || ['option', 'chV', 'chH1', 'chH2'].includes(name)) {
      parsedValue = value === '' ? '' : Number(value);
    } else if (type === 'checkbox') {
      parsedValue = e.target.checked;
    }
    
    setParams(p => ({
      ...p,
      [name]: parsedValue
    }));
  };

  const handleDisplayOptToggle = (opt) => {
    setDisplayOpts(prev => ({ ...prev, [opt]: !prev[opt] }));
  };

  const toggleRecord = (index) => {
    const newSelected = [...selectedRecords];
    newSelected[index] = !newSelected[index];
    setSelectedRecords(newSelected);
  };

  const handlePrevRecord = () => {
    if (fileData && activeRecord !== null && activeRecord > 0) setActiveRecord(prev => prev - 1);
  };
  const handleNextRecord = () => {
    if (fileData && activeRecord !== null && activeRecord < fileData.records - 1) setActiveRecord(prev => prev + 1);
  };

  const getRecordIndices = () => {
    if (!fileData) return [];
    let indices = Array.from({length: fileData.records}, (_, i) => i);
    if (sortByPenalty && computedData?.penalties) {
      // Ταξινόμηση: Μικρότερα (πιο αρνητικά) πρώτα, Μεγαλύτερα (πιο θετικά) τελευταία
      indices.sort((a, b) => computedData.penalties[a] - computedData.penalties[b]); 
    }
    return indices;
  };
  const recordIndices = getRecordIndices();

  // --- Cursors Logic ---
  const handleTsMouseMove = (e) => {
    if (!fileData || activeRecord === null) return;
    const width = 1200, height = 240, padding = 35;
    const rect = e.currentTarget.getBoundingClientRect();
    const xSvg = (e.clientX - rect.left) / rect.width * width;
    const ySvg = (e.clientY - rect.top) / rect.height * height;
    
    if (xSvg >= padding && xSvg <= width - padding) {
      const { npoints, sensorData } = fileData;
      const tr = npoints * params.dt;
      const time = (xSvg - padding) / (width - 2 * padding) * tr;
      
      const chHeight = (height - 2 * padding) / 3;
      let chIdx = Math.floor((ySvg - padding) / chHeight);
      chIdx = Math.max(0, Math.min(2, chIdx));
      
      const channels = [
        { name: "Z (Vert)", data: sensorData[activeRecord][params.chV] },
        { name: "X (Hor 1)", data: sensorData[activeRecord][params.chH1] },
        { name: "Y (Hor 2)", data: sensorData[activeRecord][params.chH2] }
      ];
      
      const pIdx = Math.floor((time / tr) * npoints);
      const val = (pIdx >= 0 && pIdx < npoints) ? channels[chIdx].data[pIdx] : 0;
      
      setTsCursor({ time: time.toFixed(3), val: val.toExponential(2), chName: channels[chIdx].name });
    } else {
      setTsCursor(null);
    }
  };

  const handleChartMouseMove = (e) => {
    const width = 1200, height = 450, padding = 50;
    const rect = e.currentTarget.getBoundingClientRect();
    const xSvg = (e.clientX - rect.left) / rect.width * width;
    const ySvg = (e.clientY - rect.top) / rect.height * height;
    
    if (xSvg >= padding && xSvg <= width - padding && ySvg >= padding && ySvg <= height - padding) {
      const maxFre = Number(chartMaxX) || 20;
      const maxY = Number(chartMaxY) || 10;
      const minY = chartScale === 'linear' ? 0 : 0.1;
      
      const f = (xSvg - padding) / (width - 2 * padding) * maxFre;
      let val;
      if (chartScale === 'log') {
         const logMin = Math.log10(Math.max(minY, 1e-5));
         const logMax = Math.log10(Math.max(maxY, 1e-5));
         const logVal = logMin + ((height - padding - ySvg) / (height - 2 * padding)) * (logMax - logMin);
         val = Math.pow(10, logVal);
      } else {
         val = minY + ((height - padding - ySvg) / (height - 2 * padding)) * (maxY - minY);
      }
      setChartCursor({ f: f.toFixed(2), val: val.toFixed(3) });
    } else {
      setChartCursor(null);
    }
  };

  const renderTimeSeries = () => {
    if (!fileData || activeRecord === null || !fileData.sensorData[activeRecord]) return null;
    
    const width = 1200;
    const height = 240; 
    const padding = 35;
    const { npoints, sensorData } = fileData;
    
    const channels = [
      { name: `Z / Vertical (Ch ${params.chV + 1})`, data: sensorData[activeRecord][params.chV], color: "#57534e" },
      { name: `X / Horizontal 1 (Ch ${params.chH1 + 1})`, data: sensorData[activeRecord][params.chH1], color: "#0284c7" },
      { name: `Y / Horizontal 2 (Ch ${params.chH2 + 1})`, data: sensorData[activeRecord][params.chH2], color: "#dc2626" }
    ];

    return (
      <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-auto bg-white border border-slate-200 rounded-lg shadow-sm" onMouseMove={handleTsMouseMove} onMouseLeave={() => setTsCursor(null)}>
        {channels.map((ch, idx) => {
          const chHeight = (height - 2 * padding) / 3;
          const startY = padding + idx * chHeight;
          
          let maxVal = -Infinity;
          let minVal = Infinity;
          const step = Math.ceil(npoints / 2000); 
          for(let i=0; i<npoints; i+=step) {
            if(ch.data[i] > maxVal) maxVal = ch.data[i];
            if(ch.data[i] < minVal) minVal = ch.data[i];
          }
          const range = Math.max(Math.abs(maxVal), Math.abs(minVal)) || 1;

          let path = "";
          for(let i=0; i<npoints; i+=step) {
            const x = padding + (i / npoints) * (width - 2 * padding);
            const y = startY + chHeight/2 - (ch.data[i] / range) * (chHeight/2) * 0.85;
            path += (i===0 ? "M " : " L ") + `${x} ${y}`;
          }

          return (
            <g key={`ch-${idx}`}>
              <text x={padding} y={startY + 18} fontSize="14" fill={ch.color} fontWeight="600">{ch.name}</text>
              <path d={path} fill="none" stroke={ch.color} strokeWidth="1" opacity="0.9" />
              {idx < 2 && <line x1={padding} y1={startY + chHeight} x2={width - padding} y2={startY + chHeight} stroke="#e5e7eb" strokeWidth="1" />}
            </g>
          );
        })}
        <text x={width/2} y={height - 10} fontSize="14" textAnchor="middle" fill="#666" fontWeight="500">
          Χρόνος (sec) — Record {activeRecord + 1}
        </text>

        {tsCursor && (
           <text x={width - padding} y={padding + 10} fontSize="14" fill="#000" fontWeight="bold" textAnchor="end">
              {tsCursor.chName} | Time: {tsCursor.time} s | Val: {tsCursor.val}
           </text>
        )}
      </svg>
    );
  };

  const renderChart = () => {
    if (!computedData) return null;
    const width = 1200; 
    const height = 450;
    const padding = 50;

    const { sdofFreqs, fftFreqs, hv, hvFFT, hvave, hvFFTave, hvStd, hvFFTStd } = computedData; 
    
    const maxY = Number(chartMaxY) || 10;
    const maxFre = Number(chartMaxX) || 20;

    const minY = chartScale === 'linear' ? 0 : 0.1;
    
    const yTicks = [];
    if (chartScale === 'linear') {
      const step = maxY / 5;
      for (let i=0; i < maxY - 0.001; i += step) yTicks.push(i);
    } else {
      [0.1, 1, 10, 100, 1000].forEach(t => { if(t < maxY) yTicks.push(t); });
    }
    
    const getX = (f) => padding + ((f) / maxFre) * (width - 2 * padding);
    const getY = (v) => {
      let val = Math.max(minY, Math.min(v, maxY)); 
      let max = maxY;
      let min = minY;
      
      if (chartScale === 'log') {
        val = Math.log10(Math.max(val, 0.001));
        max = Math.log10(maxY);
        min = Math.log10(minY);
      }
      return height - padding - ((val - min) / (max - min)) * (height - 2 * padding);
    };

    const xTicks = [];
    for(let i=0; i < maxFre - 0.001; i += maxFre/10) xTicks.push(i);

    return (
      <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-auto bg-white border rounded-lg shadow-sm" style={{ overflow: 'hidden' }} onMouseMove={handleChartMouseMove} onMouseLeave={() => setChartCursor(null)}>
        {/* X-Axis Ticks */}
        {xTicks.map((tick, i) => (
          <g key={`x-${i}`}>
            <line x1={getX(tick)} y1={padding} x2={getX(tick)} y2={height - padding} stroke="#f0f0f0" />
            <text x={getX(tick)} y={height - padding + 18} fontSize="14" textAnchor="middle" fill="#666">
              {tick.toFixed(1)}
            </text>
          </g>
        ))}

        {/* Y-Axis Ticks */}
        {yTicks.map((tick, i) => (
          <g key={`y-${i}`}>
            <line x1={padding} y1={getY(tick)} x2={width - padding} y2={getY(tick)} stroke="#f0f0f0" />
            <text x={padding - 10} y={getY(tick) + 5} fontSize="14" textAnchor="end" fill="#666">
              {Number.isInteger(tick) ? tick : tick.toFixed(1)}
            </text>
          </g>
        ))}
        
        {/* Editable Tick TextBox - Max Y */}
        <foreignObject x={2} y={padding - 12} width={50} height={24} style={{ overflow: 'visible' }}>
          <input 
            type="number" 
            value={chartMaxY}
            onChange={(e) => setChartMaxY(e.target.value === '' ? '' : Number(e.target.value))}
            className="w-full h-full text-right text-[14px] font-medium text-blue-700 bg-blue-50/80 border border-transparent hover:border-blue-300 focus:border-blue-500 focus:bg-white rounded outline-none p-0 cursor-text"
            title="Αλλαγή Μέγιστου Y"
          />
        </foreignObject>

        {/* Editable Tick TextBox - Max X */}
        <foreignObject x={width - padding - 25} y={height - padding + 6} width={50} height={24} style={{ overflow: 'visible' }}>
          <input 
            type="number" 
            value={chartMaxX}
            onChange={(e) => setChartMaxX(e.target.value === '' ? '' : Number(e.target.value))}
            className="w-full h-full text-center text-[14px] font-medium text-blue-700 bg-blue-50/80 border border-transparent hover:border-blue-300 focus:border-blue-500 focus:bg-white rounded outline-none p-0 cursor-text"
            title="Αλλαγή Οπτικής Κλίμακας (X)"
          />
        </foreignObject>
        
        {/* Y Axis Label */}
        <text x="15" y={height/2} fontSize="16" transform={`rotate(-90, 15, ${height/2})`} textAnchor="middle" fill="#666" fontWeight="500">
          HVSR Amplitude {chartScale === 'log' ? '(Log)' : ''}
        </text>

        <text x={width/2} y={height - 8} fontSize="16" textAnchor="middle" fill="#666" fontWeight="500">
          Frequency (Hz)
        </text>

        <clipPath id="chart-area">
           <rect x={padding} y={padding} width={width - 2 * padding} height={height - 2 * padding} />
        </clipPath>

        <g clipPath="url(#chart-area)">
          {displayOpts.showAllFFT && fileData.records > 0 && Array.from({length: fileData.records}).map((_, rec) => {
            if (!selectedRecords[rec] || rec === activeRecord) return null;
            const isHovered = hoveredRecord === rec;
            let path = "";
            for(let i=0; i<fftFreqs.length; i++) {
               const x = getX(fftFreqs[i]);
               const y = getY(hvFFT[i][rec]);
               path += (i===0 ? "M " : " L ") + `${x} ${y}`;
            }
            return (
              <path 
                key={`fft-rec-${rec}`} 
                d={path} 
                fill="none" 
                stroke={isHovered ? "#059669" : "#10b981"} 
                strokeWidth={isHovered ? "3" : "1.5"} 
                strokeOpacity={isHovered ? "1" : "0.2"} 
                style={{ cursor: 'pointer', transition: 'stroke-width 0.1s' }}
                onMouseEnter={() => setHoveredRecord(rec)}
                onMouseLeave={() => setHoveredRecord(null)}
                onClick={(e) => { e.stopPropagation(); toggleRecord(rec); setHoveredRecord(null); }}
              />
            );
          })}

          {displayOpts.showAllSDOF && fileData.records > 0 && Array.from({length: fileData.records}).map((_, rec) => {
            if (!selectedRecords[rec] || rec === activeRecord) return null;
            const isHovered = hoveredRecord === rec;
            let path = "";
            for(let i=0; i<params.nspec; i++) {
               const x = getX(sdofFreqs[i]);
               const y = getY(hv[i][rec]);
               path += (i===0 ? "M " : " L ") + `${x} ${y}`;
            }
            return (
              <path 
                key={`sdof-rec-${rec}`} 
                d={path} 
                fill="none" 
                stroke={isHovered ? "#2563eb" : "#3b82f6"} 
                strokeWidth={isHovered ? "3" : "1.5"} 
                strokeOpacity={isHovered ? "1" : "0.25"} 
                style={{ cursor: 'pointer', transition: 'stroke-width 0.1s' }}
                onMouseEnter={() => setHoveredRecord(rec)}
                onMouseLeave={() => setHoveredRecord(null)}
                onClick={(e) => { e.stopPropagation(); toggleRecord(rec); setHoveredRecord(null); }}
              />
            );
          })}

          {/* Σχεδίαση Std Dev (+-1σ) */}
          {displayOpts.showStdDev && displayOpts.showMeanFFT && (() => {
            let pathPlus = "", pathMinus = "";
            for(let i=0; i<fftFreqs.length; i++) {
               const x = getX(fftFreqs[i]);
               const yPlus = getY(hvFFTave[i] + hvFFTStd[i]);
               const yMinus = getY(Math.max(1e-10, hvFFTave[i] - hvFFTStd[i]));
               pathPlus += (i===0 ? "M " : " L ") + `${x} ${yPlus}`;
               pathMinus += (i===0 ? "M " : " L ") + `${x} ${yMinus}`;
            }
            return (
              <g opacity="0.5">
                <path d={pathPlus} fill="none" stroke="#10b981" strokeWidth="1.5" strokeDasharray="3,4" style={{ pointerEvents: 'none' }} />
                <path d={pathMinus} fill="none" stroke="#10b981" strokeWidth="1.5" strokeDasharray="3,4" style={{ pointerEvents: 'none' }} />
              </g>
            );
          })()}

          {displayOpts.showStdDev && displayOpts.showMeanSDOF && (() => {
            let pathPlus = "", pathMinus = "";
            for(let i=0; i<params.nspec; i++) {
               const x = getX(sdofFreqs[i]);
               const yPlus = getY(hvave[i] + hvStd[i]);
               const yMinus = getY(Math.max(1e-10, hvave[i] - hvStd[i]));
               pathPlus += (i===0 ? "M " : " L ") + `${x} ${yPlus}`;
               pathMinus += (i===0 ? "M " : " L ") + `${x} ${yMinus}`;
            }
            return (
              <g opacity="0.5">
                <path d={pathPlus} fill="none" stroke="#2563eb" strokeWidth="1.5" strokeDasharray="3,4" style={{ pointerEvents: 'none' }} />
                <path d={pathMinus} fill="none" stroke="#2563eb" strokeWidth="1.5" strokeDasharray="3,4" style={{ pointerEvents: 'none' }} />
              </g>
            );
          })()}

          {displayOpts.showMeanFFT && (() => {
            let path = "";
            for(let i=0; i<fftFreqs.length; i++) {
               const x = getX(fftFreqs[i]);
               const y = getY(hvFFTave[i]);
               path += (i===0 ? "M " : " L ") + `${x} ${y}`;
            }
            return <path d={path} fill="none" stroke="#10b981" strokeWidth="3.5" opacity="0.85" style={{ pointerEvents: 'none' }} />;
          })()}

          {displayOpts.showMeanSDOF && (() => {
            let path = "";
            for(let i=0; i<params.nspec; i++) {
               const x = getX(sdofFreqs[i]);
               const y = getY(hvave[i]);
               path += (i===0 ? "M " : " L ") + `${x} ${y}`;
            }
            return <path d={path} fill="none" stroke="#2563eb" strokeWidth="4" style={{ pointerEvents: 'none' }} />;
          })()}
          
          {displayOpts.showActiveFFT && fileData.records > 0 && activeRecord !== null && selectedRecords[activeRecord] && (() => {
            let path = "";
            for(let i=0; i<fftFreqs.length; i++) {
               const x = getX(fftFreqs[i]);
               const y = getY(hvFFT[i][activeRecord]);
               path += (i===0 ? "M " : " L ") + `${x} ${y}`;
            }
            return <path d={path} fill="none" stroke="#eab308" strokeWidth="3" strokeDasharray="5,5" style={{ pointerEvents: 'none' }} />;
          })()}
          
          {displayOpts.showActiveSDOF && fileData.records > 0 && activeRecord !== null && selectedRecords[activeRecord] && (() => {
            let path = "";
            for(let i=0; i<params.nspec; i++) {
               const x = getX(sdofFreqs[i]);
               const y = getY(hv[i][activeRecord]);
               path += (i===0 ? "M " : " L ") + `${x} ${y}`;
            }
            return <path d={path} fill="none" stroke="#f97316" strokeWidth="3.5" style={{ pointerEvents: 'none' }} />;
          })()}
        </g>

        {/* Cursor Info Display */}
        {chartCursor && (
           <text x={width - padding - 15} y={padding + 12} fontSize="14" fill="#000" fontWeight="bold" textAnchor="end">
              Freq: {chartCursor.f} Hz | Amp: {chartCursor.val}
           </text>
        )}

        {/* Hovered Record Indicator */}
        {hoveredRecord !== null && !chartCursor && (
          <text x={width - padding - 15} y={padding + 12} fontSize="14" fill="#475569" fontWeight="bold" textAnchor="end">
            Αναγνώριση: Record {hoveredRecord + 1}
          </text>
        )}

        <line x1={padding} y1={height - padding} x2={width - padding} y2={height - padding} stroke="#333" strokeWidth="2" />
        <line x1={padding} y1={padding} x2={padding} y2={height - padding} stroke="#333" strokeWidth="2" />
      </svg>
    );
  };

  return (
    <div className="min-h-screen bg-slate-50 p-4 lg:p-6 font-sans text-slate-800">
      <div className="max-w-[98%] 2xl:max-w-[1700px] mx-auto">
        
        <header className="flex items-center justify-between mb-4 lg:mb-6 pb-3 lg:pb-4 border-b border-slate-200">
          <div className="flex items-center gap-3">
            <Activity className="text-blue-600 w-8 h-8" />
            <div>
              <h1 className="text-2xl font-bold text-slate-900">HVSR Analyzer Pro</h1>
              <p className="text-sm text-slate-500">Spectral Ratio Computing & FFT Analysis</p>
            </div>
          </div>
          {/* Το κουμπί Εξαγωγής CSV Αφαιρέθηκε όπως ζητήθηκε */}
        </header>

        <div className="grid grid-cols-1 xl:grid-cols-[280px_1fr_280px] gap-6">
          
          {/* ----- ΑΡΙΣΤΕΡΗ ΜΠΑΡΑ ----- */}
          <div className="space-y-4 flex flex-col">
            
            <div className="bg-white p-4 rounded-xl shadow-sm border border-slate-200">
              <h3 className="font-semibold text-sm flex items-center gap-2 mb-3 text-slate-800">
                <Upload className="w-4 h-4" /> Δεδομένα
              </h3>
              <label className="block w-full cursor-pointer bg-blue-50 text-blue-700 hover:bg-blue-100 transition-colors py-1.5 px-3 rounded text-center text-sm font-medium border border-blue-200">
                Επιλογή CSV...
                <input type="file" accept=".csv" className="hidden" onChange={handleFileUpload} />
              </label>
              {fileName && <p className="text-xs text-slate-500 mt-2 truncate">Αρχείο: {fileName}</p>}
              
              {fileData && (
                <>
                  <div className="mt-2 text-xs bg-slate-50 p-2 rounded border border-slate-100 text-slate-600 flex justify-between">
                    <span>Rec: <strong className="text-slate-900">{fileData.records}</strong></span>
                    <span>Pts: <strong className="text-slate-900">{fileData.npoints}</strong></span>
                    <span>dt: <strong className="text-slate-900">{params.dt}s</strong></span>
                  </div>
                  
                  <div className="mt-3 pt-3 border-t border-slate-200">
                     <label className="block text-slate-700 font-semibold mb-2 text-xs">Αντιστοίχιση Καναλιών</label>
                     <div className="grid grid-cols-3 gap-2 text-xs">
                       <div>
                         <label className="block text-slate-500 mb-1">Z (Vert)</label>
                         <select name="chV" value={params.chV} onChange={handleParamChange} className="w-full border border-slate-300 p-1 rounded bg-white focus:ring-1 focus:ring-blue-400 outline-none">
                           {Array.from({length: 12}).map((_, i) => <option key={`v-${i}`} value={i}>Ch {i+1}</option>)}
                         </select>
                       </div>
                       <div>
                         <label className="block text-slate-500 mb-1">X (Hor 1)</label>
                         <select name="chH1" value={params.chH1} onChange={handleParamChange} className="w-full border border-slate-300 p-1 rounded bg-white focus:ring-1 focus:ring-blue-400 outline-none">
                           {Array.from({length: 12}).map((_, i) => <option key={`h1-${i}`} value={i}>Ch {i+1}</option>)}
                         </select>
                       </div>
                       <div>
                         <label className="block text-slate-500 mb-1">Y (Hor 2)</label>
                         <select name="chH2" value={params.chH2} onChange={handleParamChange} className="w-full border border-slate-300 p-1 rounded bg-white focus:ring-1 focus:ring-blue-400 outline-none">
                           {Array.from({length: 12}).map((_, i) => <option key={`h2-${i}`} value={i}>Ch {i+1}</option>)}
                         </select>
                       </div>
                     </div>
                  </div>
                </>
              )}
            </div>

            <div className="bg-white p-4 rounded-xl shadow-sm border border-slate-200">
               <h3 className="font-semibold text-sm flex items-center gap-2 mb-3 text-slate-800">
                <Settings className="w-4 h-4" /> Υπολογισμοί
              </h3>
              <div className="grid grid-cols-2 gap-x-3 gap-y-3 text-xs">
                <div>
                  <label className="block text-slate-600 font-medium mb-1">Max Freq (Hz)</label>
                  <input type="number" name="maxfre" value={params.maxfre} onChange={handleParamChange} className="w-full border border-slate-300 p-1.5 rounded focus:ring-1 focus:ring-blue-400 outline-none" title="Όριο συχνοτήτων για τον ταλαντωτή" />
                </div>
                <div>
                  <label className="block text-slate-600 font-medium mb-1">Spec Points</label>
                  <input type="number" name="nspec" value={params.nspec} onChange={handleParamChange} className="w-full border border-slate-300 p-1.5 rounded focus:ring-1 focus:ring-blue-400 outline-none" />
                </div>
                <div>
                  <label className="block text-slate-600 font-medium mb-1">Damping (ζ)</label>
                  <input type="number" step="0.01" name="dratio" value={params.dratio} onChange={handleParamChange} className="w-full border border-slate-300 p-1.5 rounded focus:ring-1 focus:ring-blue-400 outline-none" />
                </div>
                <div>
                  <label className="block text-slate-600 font-medium mb-1">Horiz. Gain</label>
                  <input type="number" min="1" max="4" step="0.1" name="horGain" value={params.horGain} onChange={handleParamChange} className="w-full border border-slate-300 p-1.5 rounded focus:ring-1 focus:ring-blue-400 outline-none" />
                </div>
                <div className="col-span-1 pt-2 border-t border-slate-100">
                  <label className="block text-slate-600 font-medium mb-1">Windowing (FFT)</label>
                  <select name="windowType" value={params.windowType} onChange={handleParamChange} className="w-full border border-slate-300 p-1.5 rounded bg-white focus:ring-1 focus:ring-blue-400 outline-none">
                    <option value="None">Rectangular</option>
                    <option value="Hanning">Hanning</option>
                    <option value="Hamming">Hamming</option>
                  </select>
                </div>
                <div className="col-span-1 pt-2 border-t border-slate-100">
                  <label className="block text-slate-600 font-medium mb-1">Είσοδος SDOF</label>
                  <select name="sdofInput" value={params.sdofInput} onChange={handleParamChange} className="w-full border border-slate-300 p-1.5 rounded bg-white focus:ring-1 focus:ring-blue-400 outline-none">
                    <option value="velocity">Ταχύτητες</option>
                    <option value="acceleration">Επιταχύνσεις</option>
                  </select>
                </div>
                <div className="col-span-2">
                  <label className="block text-slate-600 font-medium mb-1">FFT Smooth (Pts)</label>
                  <input type="number" min="1" step="2" name="fftSmoothWindow" value={params.fftSmoothWindow} onChange={handleParamChange} className="w-full border border-slate-300 p-1.5 rounded focus:ring-1 focus:ring-blue-400 outline-none" />
                </div>
                <div className="col-span-2">
                  <label className="block text-slate-600 font-medium mb-1">Μέθοδος Συνδυασμού</label>
                  <select name="option" value={params.option} onChange={handleParamChange} className="w-full border border-slate-300 p-1.5 rounded bg-white focus:ring-1 focus:ring-blue-400 outline-none">
                    <option value={1}>(H1 / V)^p</option>
                    <option value={2}>(H2 / V)^p</option>
                    <option value={3}>(sqrt(H1*H2) / V)^p</option>
                  </select>
                </div>
              </div>
            </div>

            {fileData && (
              <div className="bg-white p-4 rounded-xl shadow-sm border border-slate-200 flex flex-col flex-1 max-h-[500px]">
                <div className="flex justify-between items-center mb-2">
                  <h3 className="font-semibold text-sm">Επιλογή Καταγραφών</h3>
                  <button onClick={() => setSelectedRecords(Array(fileData.records).fill(true))} className="text-[10px] bg-slate-100 px-2 py-1 rounded text-blue-600 hover:bg-slate-200 transition-colors">
                    Επιλογή Όλων
                  </button>
                </div>
                
                <div className="mb-2 p-2 bg-slate-50 border border-slate-100 rounded text-xs">
                  <div className="font-medium text-slate-700 mb-1">Εύρος Penalty (Hz)</div>
                  <div className="flex gap-2 items-center mb-2">
                    <input type="number" name="penMinF" value={params.penMinF} onChange={handleParamChange} step="0.1" className="w-14 border border-slate-300 p-1 rounded outline-none" title="Από (Hz)" />
                    <span className="text-slate-500">-</span>
                    <input type="number" name="penMaxF" value={params.penMaxF} onChange={handleParamChange} step="0.1" className="w-14 border border-slate-300 p-1 rounded outline-none" title="Έως (Hz)" />
                  </div>
                  <label className="flex items-center gap-2 cursor-pointer mt-1 hover:text-blue-700">
                    <input type="checkbox" checked={sortByPenalty} onChange={(e) => setSortByPenalty(e.target.checked)} className="rounded text-blue-600 cursor-pointer" />
                    <span className="font-medium">Ταξινόμηση (Χειρότερα Πρώτα)</span>
                  </label>
                </div>

                <div className="flex-1 overflow-y-auto border border-slate-200 rounded p-2 text-xs bg-slate-50 space-y-1">
                  {recordIndices.map((i) => {
                    const penValue = computedData?.penalties ? computedData.penalties[i] : 0;
                    return (
                      <div 
                        key={i} 
                        onClick={() => setActiveRecord(i)} 
                        onMouseEnter={() => setHoveredRecord(i)}
                        onMouseLeave={() => setHoveredRecord(null)}
                        className={`flex items-center gap-2 cursor-pointer p-1.5 rounded transition-colors ${activeRecord === i ? 'bg-blue-100 border border-blue-200' : (hoveredRecord === i ? 'bg-slate-200 border border-transparent' : 'hover:bg-slate-100 border border-transparent')} ${!selectedRecords[i] ? 'opacity-60' : ''}`}
                      >
                        <input type="checkbox" checked={selectedRecords[i] || false} onChange={(e) => { e.stopPropagation(); toggleRecord(i); }} className="rounded text-blue-600 focus:ring-blue-500 w-3.5 h-3.5 cursor-pointer"/>
                        <span className={`text-black font-bold text-sm ${activeRecord === i ? 'text-blue-800' : ''}`}>Rec {i + 1}</span>
                        
                        <span className="ml-auto text-xs text-black font-bold" title={`Penalty Score: ${penValue.toFixed(2)}`}>
                           {`[P: ${penValue > 0 ? '+' : ''}${penValue.toFixed(1)}${!selectedRecords[i] ? ' OFF' : ''}]`}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>

          {/* ----- ΚΕΝΤΡΙΚΗ ΠΕΡΙΟΧΗ: Γραφήματα ----- */}
          <div className="space-y-4 flex flex-col min-w-0">
            <div className="bg-white p-4 lg:p-6 rounded-xl shadow-sm border border-slate-200 flex flex-col gap-4">
              {loading ? (
                <div className="h-[700px] flex items-center justify-center border-2 border-dashed border-slate-200 rounded-xl bg-slate-50 text-slate-400">
                  <Activity className="w-10 h-10 animate-pulse text-blue-400" />
                </div>
              ) : !computedData ? (
                <div className="h-[700px] flex flex-col items-center justify-center border-2 border-dashed border-slate-200 rounded-xl bg-slate-50 text-slate-400">
                  <FileText className="w-16 h-16 mb-4 opacity-40 text-slate-400" />
                  <p className="text-base font-medium text-slate-500">Φορτώστε ένα αρχείο CSV για να ξεκινήσετε</p>
                </div>
              ) : (
                <>
                  {renderTimeSeries()}
                  {renderChart()}
                  
                  <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mt-2 h-[350px]">
                    {/* Αριστερά: Heatmap */}
                    <HeatmapViewer 
                      computedData={computedData} 
                      records={fileData.records} 
                      selectedRecords={selectedRecords}
                      activeRecord={activeRecord}
                      setActiveRecord={setActiveRecord}
                    />
                    
                    {/* Δεξιά: Πίνακας Δεδομένων */}
                    <div className="flex flex-col h-full bg-white border border-slate-200 shadow-sm rounded-lg overflow-hidden">
                      <div className="flex items-center justify-between p-3 bg-slate-50 border-b border-slate-200">
                        <h3 className="font-bold text-sm text-slate-800 flex items-center gap-1.5">
                          <Table className="w-4 h-4 text-blue-600" />
                          Πίνακας Λόγων H/V
                        </h3>
                        <div className="flex items-center gap-2">
                           <select 
                             value={tableDomain} 
                             onChange={(e) => setTableDomain(e.target.value)}
                             className="border border-slate-300 text-xs rounded p-1 outline-none bg-white"
                           >
                             <option value="SDOF">SDOF</option>
                             <option value="FFT">FFT</option>
                           </select>
                           <button 
                             onClick={handleCopyTable}
                             className={`flex items-center gap-1 px-2 py-1 text-xs font-medium rounded transition-colors ${tableCopied ? 'bg-green-100 text-green-700' : 'bg-blue-100 text-blue-700 hover:bg-blue-200'}`}
                           >
                             {tableCopied ? <><Check size={14} /> Έγινε!</> : <><Copy size={14} /> Αντιγραφή</>}
                           </button>
                        </div>
                      </div>
                      <div className="flex-1 overflow-auto">
                        <table className="w-full text-xs text-right border-collapse">
                          <thead className="bg-slate-100 sticky top-0 shadow-sm z-10">
                            <tr>
                              <th className="p-2 border-b border-slate-200 text-left font-semibold text-slate-700">Freq(Hz)</th>
                              <th className="p-2 border-b border-slate-200 font-bold text-slate-800">MO</th>
                              <th className="p-2 border-b border-slate-200 font-semibold text-slate-600">+1σ</th>
                              <th className="p-2 border-b border-slate-200 font-semibold text-slate-600">-1σ</th>
                              {selectedRecords.map((isSelected, i) => isSelected ? (
                                <th key={`th-${i}`} className="p-2 border-b border-slate-200 font-medium text-slate-500 whitespace-nowrap">R {i+1}</th>
                              ) : null)}
                            </tr>
                          </thead>
                          <tbody>
                            {(tableDomain === 'SDOF' ? computedData.sdofFreqs : computedData.fftFreqs).map((freq, i) => {
                              const mean = tableDomain === 'SDOF' ? computedData.hvave[i] : computedData.hvFFTave[i];
                              const std = tableDomain === 'SDOF' ? computedData.hvStd[i] : computedData.hvFFTStd[i];
                              const hvData = tableDomain === 'SDOF' ? computedData.hv[i] : computedData.hvFFT[i];
                              return (
                                <tr key={`tr-${i}`} className="hover:bg-slate-50 border-b border-slate-100 last:border-0">
                                  <td className="p-2 text-left font-medium text-slate-600">{freq.toFixed(2)}</td>
                                  <td className="p-2 font-bold text-slate-800">{mean.toFixed(2)}</td>
                                  <td className="p-2 text-slate-500">{(mean + std).toFixed(2)}</td>
                                  <td className="p-2 text-slate-500">{Math.max(0, mean - std).toFixed(2)}</td>
                                  {selectedRecords.map((isSelected, recIdx) => isSelected ? (
                                    <td key={`td-${i}-${recIdx}`} className="p-2 text-slate-600">
                                      {hvData[recIdx].toFixed(2)}
                                    </td>
                                  ) : null)}
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>

          {/* ----- ΔΕΞΙΑ ΜΠΑΡΑ: Σχεδίαση & Πλοήγηση ----- */}
          <div className="space-y-4 flex flex-col">
             
             {fileData && (
              <div className="bg-white p-4 rounded-xl shadow-sm border border-slate-200">
                <h3 className="font-semibold text-sm flex items-center gap-2 mb-3 text-slate-800">Πλοήγηση Καταγραφών</h3>
                <div className="flex items-center justify-between bg-slate-100 p-2 rounded-lg border border-slate-200">
                  <button onClick={handlePrevRecord} disabled={activeRecord === null || activeRecord === 0} className="p-1.5 bg-white rounded shadow-sm hover:bg-slate-50 disabled:opacity-50 text-slate-700 transition-colors">
                    <ChevronLeft size={20} />
                  </button>
                  <span className="text-sm font-medium text-slate-700">
                    Record {activeRecord !== null ? activeRecord + 1 : '-'} / {fileData.records}
                  </span>
                  <button onClick={handleNextRecord} disabled={activeRecord === null || activeRecord === fileData.records - 1} className="p-1.5 bg-white rounded shadow-sm hover:bg-slate-50 disabled:opacity-50 text-slate-700 transition-colors">
                    <ChevronRight size={20} />
                  </button>
                </div>
              </div>
             )}

             <div className="bg-white p-4 rounded-xl shadow-sm border border-slate-200 flex-1">
               <div className="flex items-center justify-between mb-4">
                 <h3 className="font-semibold text-sm flex items-center gap-2 text-slate-800">
                  <Eye className="w-4 h-4" /> Επιλογές Σχεδίασης
                 </h3>
               </div>

               <div className="space-y-3">
                 <label className="flex items-center gap-3 p-2 bg-slate-50 border border-slate-100 rounded cursor-pointer hover:bg-slate-100 transition-colors">
                    <input type="checkbox" checked={chartScale === 'log'} onChange={(e) => setChartScale(e.target.checked ? 'log' : 'linear')} className="rounded text-blue-600 w-4 h-4" />
                    <span className="text-sm font-medium text-slate-700">Λογαριθμική Κλίμακα Y</span>
                 </label>

                 <hr className="border-slate-100 my-2" />

                 <label className="flex items-center gap-3 p-2 cursor-pointer hover:bg-slate-50 rounded transition-colors">
                    <input type="checkbox" checked={displayOpts.showMeanSDOF} onChange={() => handleDisplayOptToggle('showMeanSDOF')} className="rounded text-blue-600 w-4 h-4" />
                    <div className="w-5 h-1 bg-blue-600 rounded-full"></div>
                    <span className="text-sm text-slate-700 font-medium">Μέσος Όρος (SDOF)</span>
                 </label>

                 <label className="flex items-center gap-3 p-2 cursor-pointer hover:bg-slate-50 rounded transition-colors">
                    <input type="checkbox" checked={displayOpts.showMeanFFT} onChange={() => handleDisplayOptToggle('showMeanFFT')} className="rounded text-blue-600 w-4 h-4" />
                    <div className="w-5 h-1 bg-emerald-500 rounded-full"></div>
                    <span className="text-sm text-slate-700 font-medium">Μέσος Όρος (FFT)</span>
                 </label>

                 <label className="flex items-center gap-3 p-2 bg-slate-50 border border-slate-100 rounded cursor-pointer hover:bg-slate-100 transition-colors mt-2">
                    <input type="checkbox" checked={displayOpts.showStdDev} onChange={() => handleDisplayOptToggle('showStdDev')} className="rounded text-blue-600 w-4 h-4" />
                    <span className="text-sm font-medium text-slate-700">±1 Standard Deviation (σ)</span>
                 </label>

                 <hr className="border-slate-100 my-2" />

                 <label className="flex items-center gap-3 p-2 cursor-pointer hover:bg-slate-50 rounded transition-colors">
                    <input type="checkbox" checked={displayOpts.showActiveSDOF} onChange={() => handleDisplayOptToggle('showActiveSDOF')} className="rounded text-blue-600 w-4 h-4" />
                    <div className="w-5 h-1 bg-[#f97316] rounded-full"></div>
                    <span className="text-sm text-slate-700 font-medium">Ενεργό Record (SDOF)</span>
                 </label>

                 <label className="flex items-center gap-3 p-2 cursor-pointer hover:bg-slate-50 rounded transition-colors">
                    <input type="checkbox" checked={displayOpts.showActiveFFT} onChange={() => handleDisplayOptToggle('showActiveFFT')} className="rounded text-blue-600 w-4 h-4" />
                    <div className="w-5 h-1 border-b-2 border-dashed border-yellow-500"></div>
                    <span className="text-sm text-slate-700 font-medium">Ενεργό Record (FFT)</span>
                 </label>

                 <label className="flex items-center gap-3 p-2 cursor-pointer hover:bg-slate-50 rounded transition-colors">
                    <input type="checkbox" checked={displayOpts.showAllSDOF} onChange={() => handleDisplayOptToggle('showAllSDOF')} className="rounded text-blue-600 w-4 h-4" />
                    <div className="w-5 h-1 bg-blue-300 rounded-full"></div>
                    <span className="text-sm text-slate-700 font-medium">Υπόλοιπα SDOF</span>
                 </label>

                 <label className="flex items-center gap-3 p-2 cursor-pointer hover:bg-slate-50 rounded transition-colors">
                    <input type="checkbox" checked={displayOpts.showAllFFT} onChange={() => handleDisplayOptToggle('showAllFFT')} className="rounded text-blue-600 w-4 h-4" />
                    <div className="w-5 h-1 bg-emerald-300 rounded-full"></div>
                    <span className="text-sm text-slate-700 font-medium">Υπόλοιπα FFT</span>
                 </label>
               </div>
               
               <div className="mt-4 text-[11px] text-slate-500 bg-blue-50/50 p-2.5 rounded border border-blue-100">
                  💡 <strong>Tip:</strong> Κάνε κλικ πάνω σε οποιαδήποτε αχνή γραμμή (SDOF ή FFT) στο γράφημα για να την απενεργοποιήσεις και να την αφαιρέσεις από τον μέσο όρο.
               </div>
             </div>

          </div>

        </div>
      </div>
    </div>
  );
}