'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Line } from 'react-chartjs-2';
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Tooltip,
  Legend,
  Filler,
} from 'chart.js';
import { format, parseISO } from 'date-fns';
import { id as localeID } from 'date-fns/locale';

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Tooltip, Legend, Filler);

export default function AnalyticsPage() {
  const [accounts, setAccounts] = useState<any[]>([]);
  const [platform, setPlatform] = useState<'tiktok'|'instagram'>('tiktok');
  const [username, setUsername] = useState('');
  const [label, setLabel] = useState('');
  const [interval, setIntervalVal] = useState<'daily'|'weekly'|'monthly'>('daily');
  const [mode, setMode] = useState<'accrual'|'postdate'>('accrual');
  const [metric, setMetric] = useState<'views'|'likes'|'comments'>('views');
  const [start, setStart] = useState(()=> { const d=new Date(); const s=new Date(); s.setDate(d.getDate()-7); return s.toISOString().slice(0,10); });
  const [end, setEnd] = useState(()=> new Date().toISOString().slice(0,10));
  const [accrualWindow, setAccrualWindow] = useState<7|28|60>(7);
  const [data, setData] = useState<any|null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const accrualCutoff = (process.env.NEXT_PUBLIC_ACCRUAL_CUTOFF_DATE as string) || '2026-01-02';
  // Toggle sumber data agar konsisten dengan Dashboard/Groups
  const [showTotal, setShowTotal] = useState(true);
  const [showTikTok, setShowTikTok] = useState(true);
  const [showInstagram, setShowInstagram] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);

  const loadAccounts = async () => {
    try {
      const r = await fetch('/api/analytics/accounts', { cache: 'no-store' });
      const j = await r.json();
      if (r.ok) setAccounts(j.accounts||[]);
      else alert(j.error||'Gagal memuat akun');
    } catch {}
  };

  const addAccount = async (e:React.FormEvent) => {
    e.preventDefault();
    try {
      const r = await fetch('/api/analytics/accounts', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ platform, username, label }) });
      const j = await r.json();
      if (r.ok) { setUsername(''); setLabel(''); await loadAccounts(); }
      else alert(j.error||'Gagal menambah akun');
    } catch {}
  };

  const removeAccount = async (id:string) => {
    if (!confirm('Hapus akun ini dari daftar analitik?')) return;
    const qs = new URLSearchParams({ id }).toString();
    const r = await fetch('/api/analytics/accounts?'+qs, { method:'DELETE' });
    const j = await r.json();
    if (r.ok) loadAccounts(); else alert(j.error||'Gagal menghapus');
  };

  const sleep = (ms:number)=> new Promise(r=> setTimeout(r, ms));
  const refreshAll = async () => {
    if (!accounts.length) { alert('Tambah akun dulu'); return; }
    setRefreshing(true);
    try {
      const base = window.location.origin;
      // refresh tiap akun bergiliran supaya tidak melebihi rate limit
      for (let i=0;i<accounts.length;i++) {
        const a = accounts[i];
        try {
          if (a.platform === 'tiktok') {
            const u = new URL(`/api/fetch-metrics/${encodeURIComponent(a.username)}`, base);
            // Batasan: ambil 30 hari ke belakang supaya cepat
            const s = new Date(); s.setDate(s.getDate()-30); u.searchParams.set('start', s.toISOString().slice(0,10)); u.searchParams.set('end', new Date().toISOString().slice(0,10));
            const r = await fetch(u.toString(), { cache:'no-store' }); await r.json().catch(()=>null);
          } else {
            const u = new URL(`/api/fetch-ig/${encodeURIComponent(a.username)}`, base);
            u.searchParams.set('create','1'); u.searchParams.set('allow_username','0'); u.searchParams.set('max_pages','6'); u.searchParams.set('page_size','40');
            const r = await fetch(u.toString(), { cache:'no-store' }); await r.json().catch(()=>null);
          }
        } catch {}
        // jeda singkat untuk menghindari rate limit
        await sleep(1500);
      }
      // setelah refresh, muat ulang series
      await loadSeries();
      alert('Refresh selesai');
    } finally { setRefreshing(false); }
  };

  const loadSeries = async () => {
    setLoading(true);
    try {
      const u = new URL('/api/analytics/series', window.location.origin);
      // selaraskan perilaku seperti dashboard/groups
      const todayStr = new Date().toISOString().slice(0,10);
      const accStart = (()=>{ const d=new Date(); d.setUTCDate(d.getUTCDate()-(accrualWindow-1)); return d.toISOString().slice(0,10) })();
      const effStart = mode==='accrual' ? accStart : start;
      const effEnd = mode==='accrual' ? todayStr : end;
      u.searchParams.set('start', effStart); u.searchParams.set('end', effEnd);
      u.searchParams.set('interval', interval); u.searchParams.set('mode', mode); u.searchParams.set('cutoff', accrualCutoff);
      const r = await fetch(u.toString(), { cache:'no-store' });
      let j = await r.json();
      if (!r.ok) throw new Error(j?.error || 'Gagal memuat data');

      // Jika semua nilai nol (tidak ada akun/riwayat), fallback ke /api/groups/series agar identik dengan Dashboard
      const sumAll = (()=>{
        try { return (j?.series||[]).reduce((A:number, s:any)=> A + (s.series||[]).reduce((a:number,p:any)=> a + Number(p.views||0) + Number(p.likes||0) + Number(p.comments||0), 0), 0); } catch { return 0; }
      })();
      if (!sumAll) {
        const g = new URL('/api/groups/series', window.location.origin);
        g.searchParams.set('start', effStart); g.searchParams.set('end', effEnd); g.searchParams.set('interval', interval); g.searchParams.set('mode', mode);
        const gr = await fetch(g.toString(), { cache:'no-store' });
        const gj = await gr.json();
        if (gr.ok) {
          // Bentuk data.series seperti analytics: dua entry (tiktok, instagram) + biarkan chart agregasi Total sendiri
          const toSeries = (arr:any[])=> (arr||[]).map((s:any)=> ({ date:String(s.date), views:Number(s.views||0), likes:Number(s.likes||0), comments:Number(s.comments||0), shares:Number(s.shares||0)||0, saves:Number(s.saves||0)||0 }));
          j = { ...j, series: [
            { key: 'tiktok:__dashboard__', series: toSeries(gj.total_tiktok||[]) },
            { key: 'instagram:__dashboard__', series: toSeries(gj.total_instagram||[]) }
          ] };
        }
      }
      setData(j);
    } catch {}
    setLoading(false);
  };

    const chartData = useMemo(()=>{
      if (!data) return null;
      const datasets:any[] = [];
      // 1) Jika response sudah berbentuk seperti /dashboard (/api/groups/series): gunakan langsung agar identik
      if (Array.isArray((data as any).total)) {
        const base = (data as any).total as any[];
        const labels = base.map((s:any)=> format(parseISO(String(s.date)),'d MMM',{locale: localeID}));
        const pick = (s:any)=> metric==='likes'? s.likes : (metric==='comments'? s.comments : s.views);
        const totalVals = base.map((s:any)=> pick(s));
        const nonZeroCount = totalVals.filter((v:number)=> Number(v)||0).filter((v:number)=> v>0).length;
        const ttVals = ((data as any).total_tiktok||[]).map((s:any)=> pick(s));
        const igVals = ((data as any).total_instagram||[]).map((s:any)=> pick(s));
        // Samakan dengan /dashboard: tension 0.35
        const lineOpts = { pointRadius:0, pointHoverRadius:6, spanGaps:false as const, tension:0.35 as const, cubicInterpolationMode:'monotone' as const };
        // Ikuti dashboard, tetapi hanya aktifkan fill jika titik non-zero memadai agar tidak melebar
        const useFill = nonZeroCount >= 3;
        if (showTotal) datasets.push({ label:'Total', data: totalVals, borderColor:'#3b82f6', backgroundColor:'rgba(59,130,246,0.2)', fill: useFill, ...lineOpts });
        if (showTikTok) datasets.push({ label:'TikTok', data: ttVals, borderColor:'#38bdf8', backgroundColor:'rgba(56,189,248,0.15)', fill:false, ...lineOpts });
        if (showInstagram) datasets.push({ label:'Instagram', data: igVals, borderColor:'#f43f5e', backgroundColor:'rgba(244,63,94,0.15)', fill:false, ...lineOpts });
        return { labels, datasets };
      }
      // 2) Jika memakai format analytics (kumpulan akun) → agregasi per-platform dahulu
      const dateSet = new Set<string>();
      for (const it of (data.series||[])) for (const p of (it.series||[])) dateSet.add(String(p.date));
      const dates = Array.from(dateSet).sort();
      const labels = dates.map(d=> format(parseISO(d),'d MMM', { locale: localeID }));
      const aggTT = new Map<string, {views:number;likes:number;comments:number;shares?:number;saves?:number}>();
      const aggIG = new Map<string, {views:number;likes:number;comments:number;shares?:number;saves?:number}>();
      const add = (map:Map<string, any>, d:string, p:any)=>{
        const cur = map.get(d) || { views:0, likes:0, comments:0, shares:0, saves:0 };
        cur.views += Number(p.views||0); cur.likes += Number(p.likes||0); cur.comments += Number(p.comments||0);
        cur.shares = (cur.shares||0) + Number(p.shares||0); cur.saves = (cur.saves||0) + Number(p.saves||0);
        map.set(d, cur);
      };
      for (const it of (data.series||[])) {
        const isTT = String(it.key).startsWith('tiktok:');
        const isIG = String(it.key).startsWith('instagram:');
        for (const p of (it.series||[])) {
          const d = String(p.date);
          if (isTT) add(aggTT, d, p); else if (isIG) add(aggIG, d, p);
        }
      }
      const pick = (p:any)=> metric==='likes'? (p?.likes||0) : (metric==='comments'? (p?.comments||0) : (p?.views||0));
      const valsTotal:number[] = []; const valsTT:number[] = []; const valsIG:number[] = [];
      for (const d of dates) {
        const tt = aggTT.get(d) || { views:0, likes:0, comments:0 };
        const ig = aggIG.get(d) || { views:0, likes:0, comments:0 };
        valsTT.push(pick(tt)); valsIG.push(pick(ig)); valsTotal.push(pick(tt)+pick(ig));
      }
      const lineOpts = { pointRadius:0, pointHoverRadius:6, spanGaps:false as const, tension:0.35 as const, cubicInterpolationMode:'monotone' as const };
      const nonZeroCount2 = valsTotal.filter((v:number)=> Number(v)||0).filter((v:number)=> v>0).length;
      const useFill2 = nonZeroCount2 >= 3;
      if (showTotal) datasets.push({ label:'Total', data: valsTotal, borderColor:'#3b82f6', backgroundColor:'rgba(59,130,246,0.2)', fill: useFill2, ...lineOpts });
      if (showTikTok) datasets.push({ label:'TikTok', data: valsTT, borderColor:'#38bdf8', backgroundColor:'rgba(56,189,248,0.15)', fill:false, ...lineOpts });
      if (showInstagram) datasets.push({ label:'Instagram', data: valsIG, borderColor:'#f43f5e', backgroundColor:'rgba(244,63,94,0.15)', fill:false, ...lineOpts });
      return { labels, datasets };
    }, [data, metric, showTotal, showTikTok, showInstagram]);

  // Crosshair plugin agar sama seperti Dashboard/Groups
  const chartRef = useRef<any>(null);
  const crosshairPlugin = useMemo(()=>({
    id:'crosshairPlugin',
    afterDraw(chart:any){
      const { ctx, chartArea } = chart; if (!chartArea) return; const { top,bottom,left,right } = chartArea;
      const active = chart.tooltip && chart.tooltip.getActiveElements ? chart.tooltip.getActiveElements() : [];
      let idx:number|null=null, x:number|null=null;
      if (active && active.length>0){ idx=active[0].index; x=active[0].element.x; }
      else { const labels=chart.data?.labels||[]; if (!labels.length) return; idx=labels.length-1; const meta=chart.getDatasetMeta(0); const el=meta?.data?.[idx]; x=el?.x??null; }
      if (idx==null || x==null) return;
      ctx.save(); ctx.strokeStyle='rgba(255,255,255,0.25)'; ctx.setLineDash([4,4]); ctx.beginPath(); ctx.moveTo(x,top); ctx.lineTo(x,bottom); ctx.stroke(); ctx.restore();
    }
  }), []);

  const lastUpdatedHuman = useMemo(()=>{
    if (!lastUpdated) return null; const dt=new Date(lastUpdated); const diffMin=Math.round((Date.now()-dt.getTime())/60000); if (diffMin<60) return `${diffMin} menit lalu`; const h=Math.round(diffMin/60); if (h<24) return `${h} jam lalu`; const d=Math.round(h/24); return `${d} hari lalu`;
  }, [lastUpdated]);

  // Hitung header totals dari dataset Total
  const headerTotals = useMemo(()=>{
    if (!data) return { views:0, likes:0, comments:0 };
    const dateSet = new Set<string>();
    for (const it of (data.series||[])) for (const p of (it.series||[])) dateSet.add(String(p.date));
    const dates = Array.from(dateSet).sort();
    const aggTT = new Map<string, any>(); const aggIG = new Map<string, any>();
    const add = (map:Map<string, any>, d:string, p:any)=>{ const cur=map.get(d)||{views:0,likes:0,comments:0}; cur.views+=Number(p.views||0); cur.likes+=Number(p.likes||0); cur.comments+=Number(p.comments||0); map.set(d,cur); };
    for (const it of (data.series||[])) {
      const isTT = String(it.key).startsWith('tiktok:'); const isIG = String(it.key).startsWith('instagram:');
      for (const p of (it.series||[])) { const d=String(p.date); if (isTT) add(aggTT,d,p); else if (isIG) add(aggIG,d,p); }
    }
    let views=0, likes=0, comments=0; for (const d of dates){ const tt=aggTT.get(d)||{views:0,likes:0,comments:0}; const ig=aggIG.get(d)||{views:0,likes:0,comments:0}; views+= (tt.views||0)+(ig.views||0); likes+= (tt.likes||0)+(ig.likes||0); comments+=(tt.comments||0)+(ig.comments||0); }
    return { views, likes, comments };
  }, [data]);

  return (
    <div className="min-h-screen p-4 md:p-8">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-6">
        <h1 className="text-2xl md:text-3xl font-semibold tracking-tight bg-gradient-to-r from-blue-600 to-sky-500 dark:from-white dark:to-white/70 bg-clip-text text-transparent">Analytics</h1>
      </div>

      {/* Accounts manager */}
      <div className="glass rounded-2xl p-4 border border-white/10 mb-6">
        <div className="grid md:grid-cols-3 gap-4 items-end">
        <div>
          <label className="block text-sm mb-1">Platform</label>
          <select className="w-full bg-white/5 border border-white/10 text-white px-3 py-2 rounded" value={platform} onChange={e=> setPlatform(e.target.value as any)}>
            <option value="tiktok">TikTok</option>
            <option value="instagram">Instagram</option>
          </select>
        </div>
        <div>
          <label className="block text-sm mb-1">Username</label>
          <input value={username} onChange={e=> setUsername(e.target.value)} placeholder="tanpa @" className="w-full bg-white/5 border border-white/10 text-white px-3 py-2 rounded" />
        </div>
        <div>
          <label className="block text-sm mb-1">Label (opsional)</label>
          <input value={label} onChange={e=> setLabel(e.target.value)} placeholder="Nama tampil" className="w-full bg-white/5 border border-white/10 text-white px-3 py-2 rounded" />
        </div>
        <div className="md:col-span-3">
          <button onClick={addAccount} className="px-4 py-2 rounded-xl bg-gradient-to-r from-blue-600 to-sky-500 text-white">Tambah Akun</button>
        </div>
        </div>
        <h2 className="text-sm font-medium text-white/70 mt-4 mb-2">Daftar Akun</h2>
        <div className="flex flex-wrap gap-2">
          {accounts.map((a:any)=> (
            <div key={a.id} className="flex items-center gap-2 bg-white/5 border border-white/10 px-3 py-1 rounded">
              <span className="text-xs uppercase tracking-wide text-white/60">{a.platform}</span>
              <span>@{a.username}</span>
              {a.label ? <span className="text-white/60">({a.label})</span> : null}
              <button onClick={()=> removeAccount(a.id)} className="text-red-300 hover:text-red-200 text-sm">hapus</button>
            </div>
          ))}
        </div>
        <div className="mt-3">
          <button onClick={refreshAll} disabled={refreshing || !accounts.length} className="px-4 py-2 rounded-xl bg-gradient-to-r from-emerald-600 to-green-500 text-white disabled:opacity-50">
            {refreshing ? 'Refreshing…' : 'Refresh Data Akun'}
          </button>
        </div>
      </div>

      {/* Header totals */}
      <div className="glass rounded-2xl p-4 border border-white/10 mb-4">
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-white/70">
          <span>Views: <strong className="text-white">{Number(headerTotals.views||0).toLocaleString('id-ID')}</strong></span>
          <span>Likes: <strong className="text-white">{Number(headerTotals.likes||0).toLocaleString('id-ID')}</strong></span>
          <span>Comments: <strong className="text-white">{Number(headerTotals.comments||0).toLocaleString('id-ID')}</strong></span>
          {lastUpdatedHuman && (
            <span className="ml-auto text-white/60">Terakhir diperbarui: <strong className="text-white/80">{lastUpdatedHuman}</strong></span>
          )}
        </div>
        <div className="mt-3 flex justify-end">
          {mode==='postdate' ? (
            <div className="flex items-center gap-2 mr-2">
              <input type="date" value={start} onChange={(e)=>setStart(e.target.value)} className="px-3 py-1.5 rounded-lg border border-white/10 bg-white/5 text-white/80 text-sm"/>
              <span className="text-white/50">s/d</span>
              <input type="date" value={end} onChange={(e)=>setEnd(e.target.value)} className="px-3 py-1.5 rounded-lg border border-white/10 bg-white/5 text-white/80 text-sm"/>
            </div>
          ) : (
            <div className="flex items-center gap-2 mr-2 text-xs">
              <span className="text-white/60">Rentang:</span>
              <button className={`px-2 py-1 rounded ${accrualWindow===7?'bg-white/20 text-white':'text-white/70 hover:text-white hover:bg-white/10'}`} onClick={()=>setAccrualWindow(7)}>7 hari</button>
              <button className={`px-2 py-1 rounded ${accrualWindow===28?'bg-white/20 text-white':'text-white/70 hover:text-white hover:bg-white/10'}`} onClick={()=>setAccrualWindow(28)}>28 hari</button>
              <button className={`px-2 py-1 rounded ${accrualWindow===60?'bg-white/20 text-white':'text-white/70 hover:text-white hover:bg-white/10'}`} onClick={()=>setAccrualWindow(60)}>60 hari</button>
            </div>
          )}
        </div>
      </div>

      {/* Controls ala dashboard: Mode | Interval | Metric */}
      <div className="mb-3 grid grid-cols-1 sm:grid-cols-3 items-center gap-2 text-xs">
        <div className="flex items-center gap-2 justify-start">
          <span className="text-white/60">Mode:</span>
          <button className={`px-2 py-1 rounded ${mode==='accrual'?'bg-white/20 text-white':'text-white/70 hover:text-white hover:bg-white/10'}`} onClick={()=>setMode('accrual')}>Accrual</button>
          <button className={`px-2 py-1 rounded ${mode==='postdate'?'bg-white/20 text-white':'text-white/70 hover:text-white hover:bg-white/10'}`} onClick={()=>setMode('postdate')}>Post Date</button>
        </div>
        <div className="flex items-center gap-2 justify-center">
          {mode!=='accrual' && (
            <>
              <span className="text-white/60">Interval:</span>
              <button className={`px-2 py-1 rounded ${interval==='daily'?'bg-white/20 text-white':'text-white/70 hover:text-white hover:bg-white/10'}`} onClick={()=>setIntervalVal('daily')}>Harian</button>
              <button className={`px-2 py-1 rounded ${interval==='weekly'?'bg-white/20 text-white':'text-white/70 hover:text-white hover:bg-white/10'}`} onClick={()=>setIntervalVal('weekly')}>Mingguan</button>
              <button className={`px-2 py-1 rounded ${interval==='monthly'?'bg-white/20 text-white':'text-white/70 hover:text-white hover:bg-white/10'}`} onClick={()=>setIntervalVal('monthly')}>Bulanan</button>
            </>
          )}
        </div>
        <div className="flex items-center gap-2 justify-end">
          <span className="text-white/60">Metric:</span>
          <button className={`px-2 py-1 rounded ${metric==='views'?'bg-white/20 text-white':'text-white/70 hover:text-white hover:bg-white/10'}`} onClick={()=>setMetric('views')}>Views</button>
          <button className={`px-2 py-1 rounded ${metric==='likes'?'bg-white/20 text-white':'text-white/70 hover:text-white hover:bg-white/10'}`} onClick={()=>setMetric('likes')}>Likes</button>
          <button className={`px-2 py-1 rounded ${metric==='comments'?'bg-white/20 text-white':'text-white/70 hover:text-white hover:bg-white/10'}`} onClick={()=>setMetric('comments')}>Comments</button>
        </div>
      </div>

      <div className="glass rounded-2xl p-4 md:p-6 border border-white/10 overflow-x-auto">
        {/* Toggle sumber data */}
        <div className="mb-2 flex items-center gap-2 text-xs">
          <span className="text-white/60">Sumber:</span>
          <button onClick={()=>setShowTotal(v=>!v)} className={`px-2 py-1 rounded border ${showTotal?'bg-white/20 text-white border-white/20':'text-white/70 border-white/10 hover:bg-white/10'}`}>Total</button>
          <button onClick={()=>setShowTikTok(v=>!v)} className={`px-2 py-1 rounded border ${showTikTok?'bg-white/20 text-white border-white/20':'text-white/70 border-white/10 hover:bg-white/10'}`}>TikTok</button>
          <button onClick={()=>setShowInstagram(v=>!v)} className={`px-2 py-1 rounded border ${showInstagram?'bg-white/20 text-white border-white/20':'text-white/70 border-white/10 hover:bg-white/10'}`}>Instagram</button>
        </div>
        {loading ? <div className="text-white/60">Memuat…</div> : chartData ? (
          <Line ref={chartRef} data={chartData as any} plugins={[crosshairPlugin]} options={{
            responsive:true, maintainAspectRatio:false,
            interaction:{ mode:'index', intersect:false },
            normalized:true,
            animation:false,
            elements:{ line:{ capBezierPoints:true } },
            plugins:{ legend:{ labels:{ color:'rgba(255,255,255,0.8)'} } },
            scales:{
              x:{ ticks:{ color:'rgba(255,255,255,0.6)', autoSkip: interval !== 'daily', maxRotation:0, minRotation:0 }, grid:{ color:'rgba(255,255,255,0.06)'} },
              y:{ ticks:{ color:'rgba(255,255,255,0.6)' }, grid:{ color:'rgba(255,255,255,0.06)' } }
            }
          }} height={380} />
        ) : <div>Tidak ada data</div>}
      </div>
    </div>
  );
}
