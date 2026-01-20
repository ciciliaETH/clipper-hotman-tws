"use client";
import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
// Main dashboard component wrapped in a function
export default function GroupsPage() {
  const [groupParticipants, setGroupParticipants] = useState<any[]>([]);
  const [allUsers, setAllUsers] = useState<any[]>([]);
  const [usernameFilter, setUsernameFilter] = useState('');
  const [manualUsernames, setManualUsernames] = useState('');
  const [selectedEmployeeUsernames, setSelectedEmployeeUsernames] = useState<string[]>([]);
  const [selectedEmployeeIGUsernames, setSelectedEmployeeIGUsernames] = useState<string[]>([]);
  const [selectedIGUsernames, setSelectedIGUsernames] = useState<string[]>([]);
  const [selectedEmployeeId, setSelectedEmployeeId] = useState<string>('');
  const [selectedEmployeeIds, setSelectedEmployeeIds] = useState<string[]>([]); // Multi-select
  // Combobox state for employee picker
  const [empQuery, setEmpQuery] = useState('');
  const [empOpen, setEmpOpen] = useState(false);
  const assignedUsernames = useMemo(()=>{
    if (!selectedEmployeeId) return [] as string[];
    const out: string[] = [];
    for (const [uname, info] of Object.entries(assignmentByUsername||{})) {
      if ((info as any)?.employee_id === selectedEmployeeId) out.push(uname);
    }
    return out.sort();
  }, [assignmentByUsername, selectedEmployeeId]);
  const [selectedUsernames, setSelectedUsernames] = useState<string[]>([]);

  const [newName, setNewName] = useState('');
  const [newParticipants, setNewParticipants] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);
  const [manualIGUsernames, setManualIGUsernames] = useState('');

  useEffect(() => {
    const loadUpdated = async () => {
      try {
        const res = await fetch('/api/last-updated', { cache: 'no-store' });
        const j = await res.json();
        if (res.ok && j?.last_updated) setLastUpdated(String(j.last_updated));
      } catch {}
    };
    loadUpdated();
    const t = setInterval(loadUpdated, 2 * 60 * 60 * 1000); // refresh every 2h
    return () => clearInterval(t);
  }, []);

  const lastUpdatedHuman = useMemo(() => {
    if (!lastUpdated) return null;
    const dt = new Date(lastUpdated);
    const now = new Date();
    const diffMs = now.getTime() - dt.getTime();
    const diffMin = Math.round(diffMs / 60000);
    if (diffMin < 60) return `${diffMin} menit lalu`;
    const diffH = Math.round(diffMin / 60);
    if (diffH < 24) return `${diffH} jam lalu`;
    const diffD = Math.round(diffH / 24);
    return `${diffD} hari lalu`;
  }, [lastUpdated]);

  const fetchCampaigns = async () => {
    setLoading(true);
    try {
      // Groups are backed by campaigns
      const res = await fetch('/api/groups');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to fetch campaigns');
      setCampaigns(data);
      setSelected(data[0] || null);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchCampaigns(); }, []);

  useEffect(() => {
    const loadRole = async () => {
      try {
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) { setIsAdmin(false); return; }
        const { data } = await supabase.from('users').select('role').eq('id', user.id).single();
        const role = (data as any)?.role;
        setIsAdmin(role === 'admin' || role === 'super_admin');
      } catch { setIsAdmin(false); }
    };
    loadRole();
  }, []);

  useEffect(() => {
    const loadMetrics = async () => {
      if (!selected) return;
      setLoading(true);
      try {
        const effStart = groupStart; // ignored by accrual server
        const effEnd = groupEnd;
        // Always load group metrics first
        let groupUrl: string;
        
        // FIXED: Always fetch from fixed start date for consistent baseline
        const REALTIME_FIXED_START = '2026-01-03';
        
        if (chartMode === 'accrual') {
          if (useCustomAccrualDates) {
            // Custom date range - ALWAYS fetch from fixed start for consistent baseline
            const fixedStart = new Date(REALTIME_FIXED_START);
            const end = new Date(accrualCustomEnd);
            const days = Math.ceil((end.getTime() - fixedStart.getTime()) / (1000 * 60 * 60 * 24)) + 1;
            groupUrl = `/api/campaigns/${selected.id}/accrual?days=${days}&cutoff=${encodeURIComponent(REALTIME_FIXED_START)}&snapshots_only=1&custom=1`;
            console.log('[DEBUG] Custom Accrual URL (fixed start):', groupUrl);
            console.log('[DEBUG] Custom dates:', { accrualCustomStart, accrualCustomEnd, fixedStart: REALTIME_FIXED_START, days });
          } else {
            groupUrl = `/api/campaigns/${selected.id}/accrual?days=${accrualWindow}&cutoff=${encodeURIComponent(accrualCutoff)}&snapshots_only=1`;
          }
        } else {
          groupUrl = `/api/campaigns/${selected.id}/metrics?start=${effStart}&end=${effEnd}&interval=${chartInterval}`;
        }
        const gRes = await fetch(groupUrl, { cache: 'no-store' });
        let gData = await gRes.json();
        console.log('[DEBUG] API Response:', { 
          url: groupUrl, 
          seriesLength: gData?.series_total?.length || 0,
          firstDate: gData?.series_total?.[0]?.date,
          lastDate: gData?.series_total?.[gData?.series_total?.length - 1]?.date
        });
        if (!gRes.ok) throw new Error(gData.error || 'Failed to load metrics');
        // Mask accrual (realtime only): zero values sebelum cutoff global
        if (chartMode === 'accrual') {
          const effectiveCutoff = accrualCutoff;
          const zeroBefore = (arr: any[] = []) => arr.map((it:any)=>{
            if (!it || typeof it !== 'object') return it;
            if (String(it.date) <= effectiveCutoff) {
              const r:any = { ...it };
              if ('views' in r) r.views = 0;
              if ('likes' in r) r.likes = 0;
              if ('comments' in r) r.comments = 0;
              if ('shares' in r) r.shares = 0;
              if ('saves' in r) r.saves = 0;
              return r;
            }
            return it;
          });
          if (gData?.series_tiktok) gData.series_tiktok = zeroBefore(gData.series_tiktok);
          if (gData?.series_instagram) gData.series_instagram = zeroBefore(gData.series_instagram);
          if (gData?.series_total) gData.series_total = zeroBefore(gData.series_total);
          if (gData?.series) gData.series = zeroBefore(gData.series);
          
          // IMPORTANT: Filter to only include data within user-selected range
          // This ensures consistency regardless of the fixed fetch start date
          if (useCustomAccrualDates) {
            const filterByRange = (arr: any[]) => arr.filter((d: any) => {
              const dateStr = String(d.date).slice(0, 10);
              return dateStr >= accrualCustomStart && dateStr <= accrualCustomEnd;
            });
            if (gData?.series_tiktok) gData.series_tiktok = filterByRange(gData.series_tiktok);
            if (gData?.series_instagram) gData.series_instagram = filterByRange(gData.series_instagram);
            if (gData?.series_total) gData.series_total = filterByRange(gData.series_total);
            if (gData?.series) gData.series = filterByRange(gData.series);
            console.log('[DEBUG] After range filter:', {
              rangeStart: accrualCustomStart,
              rangeEnd: accrualCustomEnd,
              seriesLength: gData?.series_total?.length || 0
            });
          }
        }
        // Header totals should match the chart exactly -> sum from MASKED series currently shown
        const baseArr = (gData?.series_total || gData?.series || []) as any[];
        const headerSums = baseArr.reduce((a:any, s:any)=>({
          views: (a.views||0) + Number(s.views||0),
          likes: (a.likes||0) + Number(s.likes||0),
          comments: (a.comments||0) + Number(s.comments||0)
        }), { views:0, likes:0, comments:0 });
        setMetrics({ ...(gData||{}), totals: headerSums });

        // Optionally load selected employees
        const DEFAULT_MAX = 12; // show more employees on the chart legend by default
        const ids = (chartCompareIds.length > 0
          ? chartCompareIds.slice(0, 20)
          : (participants || []).slice(0, DEFAULT_MAX).map((p:any)=> p.id));
        if (ids.length > 0) {
          const reqs = ids.map(async (eid) => {
            const url = new URL(`/api/employees/${encodeURIComponent(eid)}/metrics`, window.location.origin);
            url.searchParams.set('campaign_id', selected.id);
            url.searchParams.set('interval', chartInterval);
            
            if (chartMode === 'accrual') {
              url.searchParams.set('mode', 'accrual');
              url.searchParams.set('snapshots_only','1');
              if (useCustomAccrualDates) {
                // FIXED: Always fetch from fixed start for consistent baseline
                const fixedStart = new Date(REALTIME_FIXED_START);
                const end = new Date(accrualCustomEnd);
                const days = Math.ceil((end.getTime() - fixedStart.getTime()) / (1000 * 60 * 60 * 24)) + 1;
                url.searchParams.set('days', String(days));
                url.searchParams.set('cutoff', REALTIME_FIXED_START);
                url.searchParams.set('custom', '1');
              } else {
                url.searchParams.set('days', String(accrualWindow));
              }
            } else {
              url.searchParams.set('start', effStart);
              url.searchParams.set('end', effEnd);
            }
            
            const res = await fetch(url.toString(), { cache: 'no-store' });
            const json = await res.json();
            return { id: eid, data: json };
          });
          const rows = await Promise.all(reqs);
          const nameMap: Record<string,string> = {};
          for (const p of participants) nameMap[p.id] = p.name || `@${p.tiktok_username||''}`;
          // Mask employee overlay series as well (keep X-axis but zero values before cutoff)
          const zeroBefore = (arr: any[] = []) => arr.map((it:any)=>{
            if (!it || typeof it !== 'object') return it;
            if (String(it.date) < accrualCutoff) {
              const r:any = { ...it };
              if ('views' in r) r.views = 0;
              if ('likes' in r) r.likes = 0;
              if ('comments' in r) r.comments = 0;
              if ('shares' in r) r.shares = 0;
              if ('saves' in r) r.saves = 0;
              return r;
            }
            return it;
          });
          // Filter by user-selected range for consistency
          const filterByRange = (arr: any[]) => {
            if (!useCustomAccrualDates) return arr;
            return arr.filter((d: any) => {
              const dateStr = String(d.date).slice(0, 10);
              return dateStr >= accrualCustomStart && dateStr <= accrualCustomEnd;
            });
          };
          setCompareData(rows.map(r => ({ 
            id: r.id, 
            name: nameMap[r.id] || r.id, 
            series: chartMode==='accrual' ? filterByRange(zeroBefore(r.data?.series || [])) : (r.data?.series || [])
          })));
        } else {
          setCompareData([]);
        }
      } catch (e: any) {
        setError(e.message);
      } finally { setLoading(false); }
    };
    loadMetrics();
  }, [selected, groupStart, groupEnd, chartInterval, chartMode, accrualWindow, useCustomAccrualDates, accrualCustomStart, accrualCustomEnd, chartCompareIds, participants]);

  useEffect(() => {
    const loadMembers = async () => {
      if (!selected) { setParticipants([]); return; }
      // Selaraskan window anggota dengan grafik (accrual memakai custom dates atau preset)
      const todayStr = new Date().toISOString().slice(0,10);
      const accStart = (()=>{ const d=new Date(); d.setUTCDate(d.getUTCDate()-(accrualWindow-1)); return d.toISOString().slice(0,10); })();
      const effStart = chartMode==='accrual' ? (useCustomAccrualDates ? accrualCustomStart : accStart) : groupStart;
      const effEnd = chartMode==='accrual' ? (useCustomAccrualDates ? accrualCustomEnd : todayStr) : groupEnd;
      const cutoff = accrualCutoff; // realtime di-mask oleh cutoff global
      
      // FIXED: Always use fixed start date for consistent baseline
      const REALTIME_FIXED_START = '2026-01-03';
      
      let apiUrl: string;
      if (chartMode === 'accrual') {
        if (useCustomAccrualDates) {
          const fixedStart = new Date(REALTIME_FIXED_START);
          const end = new Date(accrualCustomEnd);
          const days = Math.ceil((end.getTime() - fixedStart.getTime()) / (1000 * 60 * 60 * 24)) + 1;
          // Pass both fixed cutoff for API and user range for frontend filtering
          apiUrl = `/api/groups/${selected.id}/members?mode=accrual&days=${days}&cutoff=${encodeURIComponent(REALTIME_FIXED_START)}&snapshots_only=1&custom=1&range_start=${encodeURIComponent(accrualCustomStart)}&range_end=${encodeURIComponent(accrualCustomEnd)}`;
        } else {
          apiUrl = `/api/groups/${selected.id}/members?mode=accrual&days=${accrualWindow}&cutoff=${encodeURIComponent(cutoff)}&snapshots_only=1`;
        }
      } else {
        apiUrl = `/api/groups/${selected.id}/members?mode=postdate&start=${effStart}&end=${effEnd}`;
      }
      
      const res = await fetch(apiUrl, { cache: 'no-store' });
      const data = await res.json();
      if (res.ok) { setParticipants(data.members || []); setAssignmentByUsername(data.assignmentByUsername || {}); }
    };
    loadMembers();
  }, [selected, groupStart, groupEnd, chartMode, accrualWindow, useCustomAccrualDates, accrualCustomStart, accrualCustomEnd]);

  // No explicit UI for toggling; overlays will default to first few employees when chartCompareIds is empty (handled in loadMetrics)

  useEffect(() => {
    // when selecting a user (employee), fetch its daily series using PARENT page settings
    const load = async () => {
      if (!selected || !selectedUser) return;
      setUserSeriesLoading(true);
      try {
        const todayStr = new Date().toISOString().slice(0,10);
        // Use parent page settings for employee modal
        let effStart: string;
        let effEnd: string;
        let apiUrl = `/api/employees/${encodeURIComponent(selectedUser)}/metrics?campaign_id=${selected.id}`;
        
        if (chartMode === 'accrual') {
          if (useCustomAccrualDates) {
            // Custom date range - same as parent
            effStart = accrualCustomStart;
            effEnd = accrualCustomEnd;
            const days = Math.ceil((new Date(effEnd).getTime() - new Date(effStart).getTime()) / (1000 * 60 * 60 * 24)) + 1;
            apiUrl += `&mode=accrual&days=${days}&cutoff=${encodeURIComponent(effStart)}&snapshots_only=1&custom=1`;
          } else {
            // Standard accrual window from parent
            const accStart = (()=>{ const d=new Date(); d.setUTCDate(d.getUTCDate()-(accrualWindow-1)); return d.toISOString().slice(0,10); })();
            effStart = accStart;
            effEnd = todayStr;
            apiUrl += `&mode=accrual&days=${accrualWindow}&snapshots_only=1`;
          }
        } else {
          // Post date mode - use group dates
          effStart = groupStart;
          effEnd = groupEnd;
          apiUrl += `&start=${effStart}&end=${effEnd}`;
        }
        apiUrl += `&interval=${chartInterval}`;
        
        const res = await fetch(apiUrl, { cache: 'no-store' });
        const data = await res.json();
        if (res.ok) {
          const effectiveCutoff = accrualCutoff; // realtime di-mask global
          const zeroBefore = (arr: any[] = []) => arr.map((it:any)=>{
            if (!it || typeof it !== 'object') return it;
            if (String(it.date) <= effectiveCutoff) {
              const r:any = { ...it };
              if ('views' in r) r.views = 0;
              if ('likes' in r) r.likes = 0;
              if ('comments' in r) r.comments = 0;
              if ('shares' in r) r.shares = 0;
              if ('saves' in r) r.saves = 0;
              return r;
            }
            return it;
          });
          // Apply cutoff to ALL platforms for per-user series
          const maskedTT = zeroBefore(data.series_tiktok || []);
          const maskedIG = zeroBefore(data.series_instagram || []);
          setUserSeriesTT(maskedTT);
          setUserSeriesIG(maskedIG);
          // Rebuild combined series from masked TT + masked IG
          const map = new Map<string, any>();
          const add = (arr:any[] = []) => { for (const s of arr) { const key=String(s.date); const cur = map.get(key) || { date:key, views:0, likes:0, comments:0, shares:0, saves:0 }; cur.views += Number(s.views)||0; cur.likes += Number(s.likes)||0; cur.comments += Number(s.comments)||0; cur.shares += Number(s.shares)||0; cur.saves += Number(s.saves)||0; map.set(key, cur); } };
          add(maskedTT); add(maskedIG);
          setUserSeries(Array.from(map.values()).sort((a:any,b:any)=> String(a.date).localeCompare(String(b.date))));
          setUserTotals(data.totals || null);
        }
      } finally { setUserSeriesLoading(false); }
    };
    load();
  }, [selectedUser, selected, groupStart, groupEnd, chartMode, chartInterval, accrualWindow, useCustomAccrualDates, accrualCustomStart, accrualCustomEnd]);

  // Refresh snapshot button removed; metrics and member totals follow date filter automatically

  const deleteCampaign = async () => {
    if (!selected) return;
    if (!confirm('Hapus campaign ini? Tindakan tidak dapat dibatalkan.')) return;
    const res = await fetch(`/api/campaigns/${selected.id}`, { method: 'DELETE' });
    if (res.ok) {
      await fetchCampaigns();
    }
  };

  const endCampaign = async () => {
    if (!selected) return;
    if (selected.end_date) return;
    if (!confirm('Akhiri campaign ini sekarang?')) return;
    const res = await fetch(`/api/campaigns/${selected.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'end' }) });
    const data = await res.json().catch(()=>({}));
    if (res.ok) {
      // refresh list and reselect updated campaign
      await fetchCampaigns();
      if (data?.campaign) setSelected(data.campaign);
    } else {
      alert(data?.error || 'Gagal mengakhiri campaign');
    }
  };

  // stable color mapping per employee for chart legend/chips
  const colorPalette = ['#ef4444','#22c55e','#eab308','#8b5cf6','#06b6d4','#f97316','#10b981','#f43f5e','#3b82f6','#14b8a6'];
  const employeeColor = useMemo(()=>{
    const map: Record<string,string> = {};
    (participants||[]).forEach((p:any, idx:number)=>{ map[p.id] = colorPalette[idx % colorPalette.length]; });
    return map;
  }, [participants]);

  const chartData = useMemo(() => {
    if (!metrics) return null;
    // Use total series as base labels
    const base = (metrics.series_total || metrics.series || []) as any[];
    const labels = base.map((s: any) => {
      const d = parseISO(s.date);
      if (chartInterval === 'monthly') return format(d, 'MMM yyyy', { locale: localeID });
      return format(d, 'd MMM', { locale: localeID });
    });
    const pick = (s:any)=> compareMetric==='likes' ? s.likes : (compareMetric==='comments' ? s.comments : s.views);
    const dataTotal = (metrics.series_total || base).map((s:any)=> pick(s));
    const dataTikTok = (metrics.series_tiktok || []).map((s:any)=> pick(s));
    const dataInstagram = (metrics.series_instagram || []).map((s:any)=> pick(s));
    const datasets: any[] = [
      { label: 'Total', data: dataTotal, borderColor: '#3b82f6', backgroundColor: 'rgba(59,130,246,0.2)', fill: true, tension: 0.35 },
      { label: 'TikTok', data: dataTikTok, borderColor: '#38bdf8', backgroundColor: 'rgba(56,189,248,0.15)', fill: false, tension: 0.35 },
      { label: 'Instagram', data: dataInstagram, borderColor: '#f43f5e', backgroundColor: 'rgba(244,63,94,0.15)', fill: false, tension: 0.35 },
    ];

    // Add overlay datasets for selected employees
    if (compareData.length > 0) {
      // Map label dates for quick lookup
      const labelKeys = base.map((s:any)=> String(s.date));
      for (let i=0;i<compareData.length;i++) {
        const row = compareData[i];
        const map: Record<string, any> = {};
        for (const s of row.series||[]) map[String(s.date)] = s;
        const values = labelKeys.map((key:string)=>{
          const it = map[key] || { views:0, likes:0, comments:0 };
          return compareMetric==='likes' ? it.likes||0 : compareMetric==='comments' ? it.comments||0 : it.views||0;
        });
        const color = employeeColor[row.id] || colorPalette[i % colorPalette.length];
        datasets.push({ label: row.name, data: values, borderColor: color, backgroundColor: color+'33', fill: false, tension: 0.35 });
      }
    }
    return { labels, datasets };
  }, [metrics, compareData, chartInterval, compareMetric, employeeColor]);

  // UX: value panel (no need to hover to see values)
  const chartRef = useRef<any>(null);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const formatNum = (n:number)=> new Intl.NumberFormat('id-ID').format(Math.round(n||0));
  const SHOW_VALUE_PANEL = false; // set true to re-enable chips panel above chart

  // Crosshair + floating value like stock chart
  const crosshairPlugin = useMemo(()=>({
    id: 'crosshairPlugin',
    afterDraw(chart: any) {
      const { ctx, chartArea } = chart; if (!chartArea) return;
      const { top, bottom, left, right } = chartArea;
      const active = chart.tooltip && chart.tooltip.getActiveElements ? chart.tooltip.getActiveElements() : [];
      let idx: number | null = null; let x: number | null = null;
      if (active && active.length > 0) {
        idx = active[0].index; x = active[0].element.x;
      } else {
        // fallback: last point
        const labels = chart.data?.labels || [];
        if (!labels.length) return;
        idx = labels.length - 1;
        const meta = chart.getDatasetMeta(0);
        const el = meta?.data?.[idx];
        x = el?.x ?? null;
      }
      if (idx == null || x == null) return;

      // vertical dashed line
      ctx.save();
      ctx.strokeStyle = 'rgba(255,255,255,0.25)';
      ctx.setLineDash([4,4]);
      ctx.beginPath();
      ctx.moveTo(x, top);
      ctx.lineTo(x, bottom);
      ctx.stroke();
      ctx.restore();

      // floating label (Total value + date)
      try {
        const label = String(chart.data.labels[idx]);
        const totalDs = chart.data.datasets?.[0];
        const v = Array.isArray(totalDs?.data) ? Number(totalDs.data[idx]||0) : 0;
        const txt = `${new Intl.NumberFormat('id-ID').format(Math.round(v))}  ${label}`;
        ctx.save();
        ctx.font = '12px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial';
        const padX = 8, padY = 6; const tw = ctx.measureText(txt).width;
        const boxW = tw + padX*2, boxH = 22;
        const bx = Math.min(right - boxW - 6, Math.max(left+6, x + 8));
        const by = top + 8;
        // rounded box
        const r = 6;
        ctx.fillStyle = 'rgba(0,0,0,0.55)';
        ctx.beginPath();
        ctx.moveTo(bx+r, by);
        ctx.lineTo(bx+boxW-r, by);
        ctx.quadraticCurveTo(bx+boxW, by, bx+boxW, by+r);
        ctx.lineTo(bx+boxW, by+boxH-r);
        ctx.quadraticCurveTo(bx+boxW, by+boxH, bx+boxW-r, by+boxH);
        ctx.lineTo(bx+r, by+boxH);
        ctx.quadraticCurveTo(bx, by+boxH, bx, by+boxH-r);
        ctx.lineTo(bx, by+r);
        ctx.quadraticCurveTo(bx, by, bx+r, by);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = '#fff';
        ctx.fillText(txt, bx+padX, by+boxH-padY);
        ctx.restore();
      } catch {}
    }
  }), []);

  // sorting participants
  const [sortMetric, setSortMetric] = useState<'views'|'likes'|'comments'|'shares'|'posts'>('views');
  const [sortOrder, setSortOrder] = useState<'desc'|'asc'>('desc');
  const filteredSortedParticipants = useMemo(()=>{
    const list = (participants || []).filter((p:any)=>{
      const name = String(p.name || p.tiktok_username || '').toLowerCase();
      return participantSearch ? name.includes(participantSearch.toLowerCase()) : true;
    });
    const sm = sortMetric; const so = sortOrder;
    return list.sort((a:any,b:any)=>{
      const av = Number(a.totals?.[sm]||a[sm]||0); const bv = Number(b.totals?.[sm]||b[sm]||0);
      return so==='desc' ? (bv-av) : (av-bv);
    });
  }, [participants, participantSearch, sortMetric, sortOrder]);

  const createCampaign = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      const res = await fetch('/api/groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          name: newName,
          required_hashtags: newHashtags.length > 0 ? newHashtags : null
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to create campaign');
      setShowModal(false);
      setNewName(''); setNewParticipants(''); setNewHashtags([]); setHashtagInput('');
      // Refresh list, lalu pilih campaign yang baru dibuat agar peserta awalnya 0
      await fetchCampaigns();
      if (data?.id) setSelected(data);
    } catch (e: any) {
      setError(e.message);
    }
  };

  // Helper functions for hashtag management
  const addHashtag = (hashtag: string, isEdit: boolean = false) => {
    const normalized = hashtag.trim().toUpperCase();
    if (!normalized) return;
    const withHash = normalized.startsWith('#') ? normalized : `#${normalized}`;
    if (isEdit) {
      if (!editHashtags.includes(withHash)) setEditHashtags([...editHashtags, withHash]);
    } else {
      if (!newHashtags.includes(withHash)) setNewHashtags([...newHashtags, withHash]);
    }
  };

  const removeHashtag = (hashtag: string, isEdit: boolean = false) => {
    if (isEdit) {
      setEditHashtags(editHashtags.filter(h => h !== hashtag));
    } else {
      setNewHashtags(newHashtags.filter(h => h !== hashtag));
    }
  };

  const handleHashtagKeyDown = (e: React.KeyboardEvent, isEdit: boolean = false) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      addHashtag(hashtagInput, isEdit);
      setHashtagInput('');
    }
  };

  // Load group participants for assignment UI
  useEffect(() => {
    const loadParts = async () => {
      if (!selected) return;
      try {
        const res = await fetch(`/api/campaigns/${selected.id}/participants`);
        const data = await res.json();
        if (res.ok) setGroupParticipants(data);
      } catch {}
    };
    const loadUsers = async () => {
      try {
        const res = await fetch('/api/get-users');
        const data = await res.json();
        if (res.ok) setAllUsers(data);
      } catch {}
    };
    if (showManage) { loadParts(); loadUsers(); }
  }, [showManage, selected]);

  // When employee changes in manage modal, load his stored usernames and pre-fill suggestions
  useEffect(() => {
    if (!selectedEmployeeId) { setSelectedEmployeeUsernames([]); setSelectedEmployeeIGUsernames([]); return; }
    const emp = allUsers.find((u:any)=> u.id===selectedEmployeeId);
    const extras: string[] = emp?.extra_tiktok_usernames || [];
    const all = [emp?.tiktok_username, ...extras].filter(Boolean).map((u:string)=> String(u).toLowerCase());
    setSelectedEmployeeUsernames(Array.from(new Set(all)));
    const igExtras: string[] = emp?.extra_instagram_usernames || [];
    const igAll = [emp?.instagram_username, ...igExtras].filter(Boolean).map((u:string)=> String(u).toLowerCase());
    setSelectedEmployeeIGUsernames(Array.from(new Set(igAll)));
    // sync combobox label when a selection happens externally
    if (emp) setEmpQuery(String(emp.full_name || emp.username || emp.email || ''));
  }, [selectedEmployeeId, allUsers]);

  // Simple: add selected employee to this group (no username assignment here)
  const addEmployeeToGroup = async () => {
    if (!selected) return;
    if (!selectedEmployeeId) { alert('Pilih karyawan terlebih dahulu'); return; }
    // Warning if the employee is already in this group
    const already = (participants||[]).some((p:any)=> String(p.id) === String(selectedEmployeeId));
    if (already) {
      const name = (participants||[]).find((p:any)=> String(p.id)===String(selectedEmployeeId))?.name
        || (allUsers||[]).find((u:any)=> String(u.id)===String(selectedEmployeeId))?.full_name
        || 'Karyawan';
      alert(`${name} sudah terdaftar di Group "${selected.name}".`);
      return;
    }
    try {
      // Ambil semua username milik karyawan dari profil
      const ownUsernames = selectedEmployeeUsernames || [];
      // Saring agar tidak ambil yang sudah dimiliki karyawan lain pada Group ini
      const allowed = ownUsernames.filter(u => {
        const asn = (assignmentByUsername as any)[u];
        return !asn || asn.employee_id === selectedEmployeeId;
      });
      const payload: any = { employee_id: selectedEmployeeId };
      if (allowed.length) payload.participant_usernames = allowed;
      // Also assign Instagram suggestions on first add (optional)
      const allowedIG = (selectedEmployeeIGUsernames||[]).map(u=> String(u).replace(/^@/, '').toLowerCase());
      if (allowedIG.length) payload.participant_instagram_usernames = Array.from(new Set(allowedIG));
      const res = await fetch(`/api/groups/${selected.id}/members`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      const data = await res.json().catch(()=>({}));
      if (!res.ok) throw new Error(data?.error || 'Gagal menambahkan karyawan ke Group');
      // refresh members list (respect current date filter)
      const mem = await fetch(`/api/groups/${selected.id}/members?start=${groupStart}&end=${groupEnd}`);
      const mjson = await mem.json();
      if (mem.ok) { setParticipants(mjson.members || []); setAssignmentByUsername(mjson.assignmentByUsername || {});} 
      setSelectedEmployeeId('');
    } catch (e:any) {
      alert(e.message);
    }
  };

  const removeEmployeeFromGroup = async () => {
    if (!selected) return;
    if (!selectedEmployeeId) { alert('Pilih karyawan terlebih dahulu'); return; }
    if (!confirm('Hapus karyawan ini dari Group beserta semua assignment akunnya?')) return;
    try {
      const res = await fetch(`/api/groups/${selected.id}/members`, {
        method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ employee_id: selectedEmployeeId })
      });
      const data = await res.json().catch(()=>({}));
      if (!res.ok) throw new Error(data?.error || 'Gagal menghapus karyawan dari Group');
      const mem = await fetch(`/api/groups/${selected.id}/members?start=${groupStart}&end=${groupEnd}`);
      const mjson = await mem.json();
      if (mem.ok) { setParticipants(mjson.members || []); setAssignmentByUsername(mjson.assignmentByUsername || {});} 
      setSelectedEmployeeId('');
    } catch (e:any) { alert(e.message); }
  };

  // Quick remove via X icon on each employee card inside the modal
  const removeEmployeeFromGroupQuick = async (empId: string, displayName?: string) => {
    if (!selected) return;
    const nameTxt = displayName ? ` "${displayName}"` : '';
    if (!confirm(`Hapus karyawan${nameTxt} dari Group beserta semua assignment akunnya?`)) return;
    try {
      const res = await fetch(`/api/groups/${selected.id}/members`, {
        method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ employee_id: empId })
      });
      const data = await res.json().catch(()=>({}));
      if (!res.ok) throw new Error(data?.error || 'Gagal menghapus karyawan dari Group');
      const mem = await fetch(`/api/groups/${selected.id}/members?start=${groupStart}&end=${groupEnd}`);
      const mjson = await mem.json();
      if (mem.ok) { setParticipants(mjson.members || []); setAssignmentByUsername(mjson.assignmentByUsername || {});} 
      if (selectedEmployeeId === empId) setSelectedEmployeeId('');
    } catch (e:any) { alert(e.message); }
  };

  const assignEmployeeAccounts = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selected || !selectedEmployeeId) return;
    try {
      // Combine selected from list and manual input
      const manualArr = manualUsernames.split(/[,\n]/).map(s=>s.trim()).filter(Boolean).map(u=>u.replace(/^@/, '').toLowerCase());
      const payload = Array.from(new Set([...selectedUsernames, ...manualArr]));
      const res = await fetch(`/api/groups/${selected.id}/members`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ employee_id: selectedEmployeeId, participant_usernames: payload })
      });
      const data = await res.json();
      if (!res.ok) {
        const detail = data?.conflicts?.map((c:any)=> `@${c.username} → ${c.owner}`).join(', ');
        throw new Error(data.error + (detail? `: ${detail}` : ''));
      }
      // refresh members
      const mem = await fetch(`/api/groups/${selected.id}/members`);
      const mjson = await mem.json();
      if (mem.ok) { setParticipants(mjson.members || []); setAssignmentByUsername(mjson.assignmentByUsername || {});} 
      setSelectedEmployeeId('');
      setSelectedUsernames([]);
      setManualUsernames('');
    } catch (err:any) {
      alert(err.message);
    }
  };

  const removeParticipant = async (participantId: string) => {
    if (!selected) return;
    await fetch(`/api/campaigns/${selected.id}/participants`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ participant_id: participantId }) });
    const res = await fetch(`/api/campaigns/${selected.id}/participants`);
    setParticipants(await res.json());
  };

  // Explicitly assign Instagram usernames to the selected employee in this Group
  const assignEmployeeIGAccounts = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selected || !selectedEmployeeId) { alert('Pilih karyawan terlebih dahulu'); return; }
    try {
      const manualArr = manualIGUsernames.split(/[\,\n]/).map(s=>s.trim()).filter(Boolean).map(u=>u.replace(/^@/, '').toLowerCase());
      const payloadIG = Array.from(new Set([...(selectedIGUsernames||[]).map(u=>u.replace(/^@/, '').toLowerCase()), ...manualArr]));
      if (payloadIG.length === 0) { alert('Isi minimal satu username Instagram'); return; }
      const res = await fetch(`/api/groups/${selected.id}/members`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ employee_id: selectedEmployeeId, participant_instagram_usernames: payloadIG }) });
      const data = await res.json();
      if (!res.ok) {
        const detail = data?.conflicts?.map((c:any)=> `@${c.username} → ${c.owner}`).join(', ');
        throw new Error((data?.error || 'Gagal menyimpan') + (detail? `: ${detail}` : ''));
      }
      const mem = await fetch(`/api/groups/${selected.id}/members?start=${groupStart}&end=${groupEnd}`);
      const mjson = await mem.json();
      if (mem.ok) { setParticipants(mjson.members || []); setAssignmentByUsername(mjson.assignmentByUsername || {});} 
      setSelectedIGUsernames([]); setManualIGUsernames('');
      alert('Akun Instagram berhasil di-assign.');
    } catch (e:any) { alert(e.message); }
  };

  // Import peserta dihapus untuk menyederhanakan UI kelola Karyawan

  return (
    <div className="min-h-screen p-4 md:p-8">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-6">
        <h1 className="text-2xl md:text-3xl font-semibold tracking-tight bg-gradient-to-r from-blue-600 to-sky-500 dark:from-white dark:to-white/70 bg-clip-text text-transparent">Group</h1>
        <div className="flex items-center gap-2 flex-wrap">
        {isAdmin && selected && (
          <div className="flex items-center gap-2">
            <button onClick={()=>{ 
              setEditName(selected.name); 
              setEditHashtags((selected as any).required_hashtags || []); 
              setHashtagInput(''); 
              setShowEdit(true); 
            }} className="inline-flex items-center gap-2 rounded-xl px-3 py-2 border border-white/10 text-white/80 hover:text-white hover:bg-white/5">Edit</button>
            <button onClick={deleteCampaign} className="inline-flex items-center gap-2 rounded-xl px-3 py-2 border border-red-500/40 text-red-200 hover:bg-red-500/10">Hapus</button>
          </div>
        )}
        {isAdmin && (
          <button onClick={() => setShowModal(true)} className="inline-flex items-center gap-2 rounded-xl px-4 py-2 bg-gradient-to-r from-blue-600 to-sky-500 text-white shadow-lg shadow-blue-600/20">
            <FaPlus />
            <span>Buat Group</span>
          </button>
        )}
        </div>
      </div>

  <div className="grid grid-cols-1 lg:grid-cols-4 gap-4 md:gap-6">
        {/* Sidebar list */}
        <div className="lg:col-span-1 glass rounded-2xl p-4 border border-white/10">
          <h2 className="text-sm font-medium text-white/70 mb-3">Daftar Group</h2>
          <div className="space-y-2 max-h-[60vh] overflow-auto pr-1">
            {campaigns.map(c => {
              const todayStr = new Date().toISOString().slice(0,10)
              const isEnded = !!c.end_date && c.end_date < todayStr
              const isScheduled = c.start_date > todayStr
              return (
                <button key={c.id} onClick={() => setSelected(c)}
                  className={`w-full text-left px-3 py-2 rounded-lg border ${selected?.id === c.id ? 'border-blue-500/40 bg-blue-500/10 text-white' : 'border-white/10 text-white/80 hover:bg-white/5'} ${isEnded ? 'opacity-80' : ''}`}>
                  <div className="flex items-center gap-2">
                    <div className="text-sm font-medium">{c.name}</div>
                    {isEnded && <span className="px-2 py-0.5 rounded-full text-[10px] bg-gray-500/20 text-gray-200 border border-gray-400/30">Selesai</span>}
                    {isScheduled && <span className="px-2 py-0.5 rounded-full text-[10px] bg-blue-500/20 text-blue-200 border border-blue-400/30">Terjadwal</span>}
                  </div>
                  <div className="text-xs text-white/50">{format(parseISO(c.start_date), 'd MMM yyyy', { locale: localeID })}{c.end_date ? ` — ${format(parseISO(c.end_date), 'd MMM yyyy', { locale: localeID })}` : ''}</div>
                </button>
              )
            })}
            {campaigns.length === 0 && <p className="text-sm text-white/50">Belum ada campaign.</p>}
          </div>
        </div>

        {/* Main panel */}
  <div className="lg:col-span-3 space-y-6 min-w-0">
          {/* Header totals then refresh button below */}
          <div className="glass rounded-2xl p-4 border border-white/10">
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-white/70">
              {metrics && (
                <>
                  <span>Views: <strong className="text-white">{metrics.totals.views.toLocaleString('id-ID')}</strong></span>
                  <span>Likes: <strong className="text-white">{metrics.totals.likes.toLocaleString('id-ID')}</strong></span>
                  <span>Comments: <strong className="text-white">{metrics.totals.comments.toLocaleString('id-ID')}</strong></span>
                  {lastUpdatedHuman && (
                    <span className="ml-auto text-white/60">Terakhir diperbarui: <strong className="text-white/80">{lastUpdatedHuman}</strong></span>
                  )}
                </>
              )}
            </div>
            <div className="mt-3 flex justify-end">
              {chartMode==='postdate' ? (
                <div className="flex items-center gap-2 mr-2">
                  <input type="date" value={groupStart} onChange={(e)=>setGroupStart(e.target.value)} className="px-3 py-1.5 rounded-lg border border-white/10 bg-white/5 text-white/80 text-sm"/>
                  <span className="text-white/50">s/d</span>
                  <input type="date" value={groupEnd} onChange={(e)=>setGroupEnd(e.target.value)} className="px-3 py-1.5 rounded-lg border border-white/10 bg-white/5 text-white/80 text-sm"/>
                </div>
              ) : (
                <div className="flex flex-col gap-2 items-end">
                  <label className="flex items-center gap-2 text-xs text-white/70 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={useCustomAccrualDates}
                      onChange={(e) => setUseCustomAccrualDates(e.target.checked)}
                      className="w-3.5 h-3.5 rounded border-white/20 bg-white/5 text-blue-600"
                    />
                    <span>Custom Date</span>
                  </label>
                  {useCustomAccrualDates && (
                    <div className="flex items-center gap-2">
                      <input type="date" value={accrualCustomStart} onChange={(e)=>setAccrualCustomStart(e.target.value)} className="px-3 py-1.5 rounded-lg border border-white/10 bg-white/5 text-white/80 text-sm"/>
                      <span className="text-white/50">→</span>
                      <input type="date" value={accrualCustomEnd} onChange={(e)=>setAccrualCustomEnd(e.target.value)} className="px-3 py-1.5 rounded-lg border border-white/10 bg-white/5 text-white/80 text-sm"/>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Chart */}
          <div className="glass rounded-2xl p-4 md:p-6 border border-white/10 overflow-x-auto">
            {/* Re-layout controls: Mode on the left, Interval centered, Metric on the right */}
            <div className="mb-3 grid grid-cols-1 sm:grid-cols-3 items-center gap-2 text-xs">
              {/* Left: Mode */}
              <div className="flex items-center gap-2 justify-start flex-wrap">
                <span className="text-white/60">Mode:</span>
                <button className={`px-2 py-1 rounded ${chartMode==='accrual'?'bg-white/20 text-white':'text-white/70 hover:text-white hover:bg-white/10'}`} onClick={()=>setChartMode('accrual')}>Accrual</button>
                <button className={`px-2 py-1 rounded ${chartMode==='postdate'?'bg-white/20 text-white':'text-white/70 hover:text-white hover:bg-white/10'}`} onClick={()=>setChartMode('postdate')}>Post Date</button>
                {chartMode === 'accrual' && !useCustomAccrualDates && (
                  <div className="flex items-center gap-2 ml-2">
                    <span className="text-white/60">Rentang:</span>
                    <button className={`px-2 py-1 rounded ${accrualWindow===7?'bg-white/20 text-white':'text-white/70 hover:text-white hover:bg-white/10'}`} onClick={()=>setAccrualWindow(7)}>7 hari</button>
                    <button className={`px-2 py-1 rounded ${accrualWindow===28?'bg-white/20 text-white':'text-white/70 hover:text-white hover:bg-white/10'}`} onClick={()=>setAccrualWindow(28)}>28 hari</button>
                    <button className={`px-2 py-1 rounded ${accrualWindow===60?'bg-white/20 text-white':'text-white/70 hover:text-white hover:bg-white/10'}`} onClick={()=>setAccrualWindow(60)}>60 hari</button>
                  </div>
                )}
              </div>

              {/* Center: Interval */}
              <div className="flex items-center justify-center gap-2">
                {chartMode !== 'accrual' && (
                  <>
                    <span className="text-white/60">Interval:</span>
                    <button className={`px-2 py-1 rounded ${chartInterval==='daily'?'bg-white/20 text-white':'text-white/70 hover:text-white hover:bg-white/10'}`} onClick={()=>setChartInterval('daily')}>Harian</button>
                    <button className={`px-2 py-1 rounded ${chartInterval==='weekly'?'bg-white/20 text-white':'text-white/70 hover:text-white hover:bg-white/10'}`} onClick={()=>setChartInterval('weekly')}>Mingguan</button>
                    <button className={`px-2 py-1 rounded ${chartInterval==='monthly'?'bg-white/20 text-white':'text-white/70 hover:text-white hover:bg-white/10'}`} onClick={()=>setChartInterval('monthly')}>Bulanan</button>
                  </>
                )}
              </div>

              {/* Right: Metric */}
              <div className="flex items-center gap-2 justify-end">
                <span className="text-white/60">Metric:</span>
                <button className={`px-2 py-1 rounded ${compareMetric==='views'?'bg-white/20 text-white':'text-white/70 hover:text-white hover:bg-white/10'}`} onClick={()=>setCompareMetric('views')}>Views</button>
                <button className={`px-2 py-1 rounded ${compareMetric==='likes'?'bg-white/20 text-white':'text-white/70 hover:text-white hover:bg-white/10'}`} onClick={()=>setCompareMetric('likes')}>Likes</button>
                <button className={`px-2 py-1 rounded ${compareMetric==='comments'?'bg-white/20 text-white':'text-white/70 hover:text-white hover:bg-white/10'}`} onClick={()=>setCompareMetric('comments')}>Comments</button>
              </div>
            </div>
            {/* Value panel */}
            {SHOW_VALUE_PANEL && !loading && chartData && chartData.labels?.length > 0 && (
              <div className="mb-2 text-xs sm:text-sm">
                <div className="text-white/70 mb-1">
                  {(() => { const idx = activeIndex ?? (chartData.labels.length - 1); return chartData.labels[idx]; })()}
                </div>
                <div className="flex flex-wrap gap-2">
                  {chartData.datasets.map((ds:any, i:number) => {
                    const idx = activeIndex ?? (chartData.labels.length - 1);
                    const v = Array.isArray(ds.data) ? Number(ds.data[idx]||0) : 0;
                    return (
                      <span key={i} className="inline-flex items-center gap-2 px-2.5 py-1 rounded border border-white/10" style={{backgroundColor: 'rgba(255,255,255,0.06)'}}>
                        <span className="inline-block w-2.5 h-2.5 rounded" style={{ background: ds.borderColor }} />
                        <span className="text-white/70">{ds.label}</span>
                        <span className="text-white font-medium">{formatNum(v)}</span>
                      </span>
                    )
                  })}
                </div>
              </div>
            )}

            {loading && <p className="text-white/60">Memuat...</p>}
            {!loading && chartData && (
              <Line ref={chartRef} data={chartData} plugins={[crosshairPlugin]} options={{
                responsive: true,
                interaction: { mode: 'index', intersect: false },
                plugins: { legend: { labels: { color: 'rgba(255,255,255,0.8)' } } },
                scales: {
                  x: {
                    ticks: {
                      color: 'rgba(255,255,255,0.6)',
                      // Tampilkan semua label untuk harian agar 1 Jan, 2 Jan, dst tidak terskip
                      autoSkip: chartInterval !== 'daily' ? true : false,
                      maxRotation: 0,
                      minRotation: 0,
                    },
                    grid: { color: 'rgba(255,255,255,0.06)' }
                  },
                  y: { ticks: { color: 'rgba(255,255,255,0.6)' }, grid: { color: 'rgba(255,255,255,0.06)' } },
                },
                // Update value panel while moving mouse over the chart
                onHover: (event:any, elements:any[]) => {
                  if (elements && elements.length > 0) {
                    setActiveIndex(elements[0].index ?? null);
                  } else {
                    setActiveIndex(null);
                  }
                },
              }}
              onMouseLeave={() => setActiveIndex(null)}
              />
            )}
          </div>

          {/* Members List */}
          <div className="glass rounded-2xl p-4 border border-white/10 overflow-hidden">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 mb-3">
              <h3 className="text-sm font-medium text-white/80">Karyawan (Karyawan)</h3>
              <div className="flex items-center gap-2">
                {isAdmin && (<button onClick={() => setShowManage(true)} className="px-3 py-1.5 rounded-lg text-sm border border-white/10 bg-white/5 text-white/80 hover:text-white">Kelola Karyawan</button>)}
              </div>
            </div>
            <div className="flex flex-col md:flex-row gap-3 mb-3">
              <input value={participantSearch} onChange={(e)=>setParticipantSearch(e.target.value)} placeholder="Cari nama/username…" className="flex-1 min-w-0 px-3 py-2 rounded-xl border border-white/10 bg-white/5 text-white" />
              <div className="flex items-center gap-2 flex-wrap">
                <select value={sortMetric} onChange={(e)=>setSortMetric(e.target.value as any)} className="px-3 py-2 rounded-xl border border-white/10 bg-white/5 text-white text-sm">
                  <option value="views">Views</option>
                  <option value="likes">Likes</option>
                  <option value="comments">Comments</option>
                  <option value="shares">Shares</option>
                  <option value="posts">Posts</option>
                </select>
                <select value={sortOrder} onChange={(e)=>setSortOrder(e.target.value as any)} className="px-3 py-2 rounded-xl border border-white/10 bg-white/5 text-white text-sm">
                  <option value="desc">Tertinggi</option>
                  <option value="asc">Terendah</option>
                </select>
              </div>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm text-white/80">
                <thead>
                  <tr className="text-white/60">
                    <th className="text-left px-2 py-2">Employee</th>
                    <th className="text-right px-2 py-2">Views</th>
                    <th className="text-right px-2 py-2">Likes</th>
                    <th className="text-right px-2 py-2">Comments</th>
                    <th className="text-right px-2 py-2">Shares</th>
                    <th className="text-right px-2 py-2">Posts</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredSortedParticipants.map((p:any)=> (
                    <tr key={p.id} className="hover:bg-white/5 cursor-pointer" onClick={()=> { setSelectedUser(String(p.id)); setSelectedUserName(String(p.name || p.tiktok_username || '')); }}>
                      <td className="px-2 py-2 text-white">{p.name || `@${p.tiktok_username || ''}`}</td>
                      <td className="px-2 py-2 text-right">{Number(p.totals?.views||0).toLocaleString('id-ID')}</td>
                      <td className="px-2 py-2 text-right">{Number(p.totals?.likes||0).toLocaleString('id-ID')}</td>
                      <td className="px-2 py-2 text-right">{Number(p.totals?.comments||0).toLocaleString('id-ID')}</td>
                      <td className="px-2 py-2 text-right">{Number(p.totals?.shares||0).toLocaleString('id-ID')}</td>
                      <td className="px-2 py-2 text-right">{Number(p.totals?.posts||0).toLocaleString('id-ID')}</td>
                    </tr>
                  ))}
                  {(participants.length===0) && (
                    <tr><td className="px-2 py-3 text-white/60" colSpan={5}>Belum ada Karyawan.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* Participants ranking removed per request (Leaderboard lives in main dashboard) */}
        </div>
      </div>

      {/* Manage Members Modal */}
      {showManage && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60">
          <div className="glass rounded-2xl border border-white/10 w-full max-w-3xl p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-xl font-semibold text-white">Kelola Karyawan</h2>
              <button onClick={() => setShowManage(false)} className="text-white/70 hover:text-white">✕</button>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div>
                <h4 className="text-sm text-white/80 mb-2">Pilih Karyawan</h4>
                
                {/* Selected employees badges */}
                {selectedEmployeeIds.length > 0 && (
                  <div className="mb-3 flex flex-wrap gap-2 p-3 rounded-xl border border-white/10 bg-white/5">
                    {selectedEmployeeIds.map(empId => {
                      const emp = (allUsers||[]).find((u:any) => String(u.id) === empId);
                      if (!emp) return null;
                      return (
                        <span key={empId} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-gradient-to-r from-blue-600 to-sky-500 text-white text-sm">
                          {emp.full_name || emp.username || emp.email}
                          <button
                            type="button"
                            onClick={() => setSelectedEmployeeIds(prev => prev.filter(id => id !== empId))}
                            className="hover:bg-white/20 rounded-full w-4 h-4 flex items-center justify-center"
                          >
                            ×
                          </button>
                        </span>
                      );
                    })}
                  </div>
                )}

                <div className="flex items-center gap-2 mb-2">
                  <label className="block text-xs text-white/60">Karyawan</label>
                  <button
                    type="button"
                    onClick={() => {
                      const availableEmployees = (allUsers||[])
                        .filter((u:any) => u.role === 'karyawan')
                        .filter((u:any) => !participants.some((p:any) => String(p.id) === String(u.id)));
                      setSelectedEmployeeIds(availableEmployees.map((u:any) => String(u.id)));
                      setEmpOpen(false);
                      setEmpQuery('');
                    }}
                    className="ml-auto px-2 py-1 rounded-lg text-xs text-blue-300 hover:text-blue-200 hover:bg-white/5 border border-blue-500/30"
                  >
                    Pilih Semua
                  </button>
                </div>
                
                <div className="relative">
                  <input
                    value={empQuery}
                    onChange={(e)=>{ setEmpQuery(e.target.value); setEmpOpen(true); }}
                    onFocus={()=> setEmpOpen(true)}
                    onBlur={() => setTimeout(() => setEmpOpen(false), 200)}
                    placeholder="Cari nama/username…"
                    className="w-full px-3 py-2 rounded-xl border border-white/10 bg-white/5 text-white text-sm"
                  />
                  {empOpen && (
                    <div className="absolute z-10 mt-1 w-full max-h-56 overflow-auto rounded-xl border border-white/10 bg-[#0b0f1a] text-white shadow-lg">
                      {(() => {
                        const q = empQuery.trim().toLowerCase();
                        const list = (allUsers||[]).filter((u:any)=> u.role==='karyawan').filter((u:any)=>{
                          if (!q) return true;
                          const name = String(u.full_name||u.username||u.email||'').toLowerCase();
                          const tik = String(u.tiktok_username||'').toLowerCase();
                          return name.includes(q) || tik.includes(q);
                        });
                        if (list.length === 0) return (<div className="px-3 py-2 text-white/60 text-sm">Tidak ditemukan</div>);
                        return list.map((u:any)=> {
                          const isSelected = selectedEmployeeIds.includes(String(u.id));
                          const isAlreadyInGroup = participants.some((p:any) => String(p.id) === String(u.id));
                          return (
                            <button 
                              key={u.id} 
                              type="button" 
                              onMouseDown={(e) => {
                                e.preventDefault(); // Prevent input blur
                                const empId = String(u.id);
                                if (isAlreadyInGroup) return;
                                if (isSelected) {
                                  setSelectedEmployeeIds(prev => prev.filter(id => id !== empId));
                                } else {
                                  setSelectedEmployeeIds(prev => [...prev, empId]);
                                }
                                // Auto-close dropdown after selection
                                setTimeout(() => {
                                  setEmpOpen(false);
                                  setEmpQuery('');
                                }, 100);
                              }} 
                              className={`w-full text-left px-3 py-2 hover:bg-white/10 text-sm ${isSelected ? 'bg-blue-500/20' : ''} ${isAlreadyInGroup ? 'opacity-50 cursor-not-allowed' : ''}`}
                              disabled={isAlreadyInGroup}
                            >
                              <div className="flex items-center justify-between">
                                <div className="flex-1">
                                  <div className="text-white/90">{u.full_name || u.username || u.email}</div>
                                  {(u.tiktok_username) && <div className="text-white/50 text-xs">@{u.tiktok_username}</div>}
                                </div>
                                {isSelected && <span className="text-blue-300">✓</span>}
                                {isAlreadyInGroup && <span className="text-white/40 text-xs">(sudah di grup)</span>}
                              </div>
                            </button>
                          );
                        });
                      })()}
                    </div>
                  )}
                </div>
                
                {selectedEmployeeIds.length > 0 ? (
                  <div className="mt-3 text-xs text-blue-300">{selectedEmployeeIds.length} karyawan dipilih</div>
                ) : (
                  <>
                    <div className="mt-3 text-xs text-white/60">Akun di Group ini: {assignedUsernames.length? assignedUsernames.map(u=>'@'+u).join(', ') : '-'}</div>
                    <div className="mt-1 text-[11px] text-white/40">Akun TikTok profil: {selectedEmployeeUsernames.length? selectedEmployeeUsernames.map(u=>'@'+u).join(', ') : '-'}</div>
                    <div className="mt-1 text-[11px] text-white/40">Akun Instagram profil: {selectedEmployeeIGUsernames.length? selectedEmployeeIGUsernames.map(u=>'@'+u).join(', ') : '-'}</div>
                  </>
                )}
                
                <div className="mt-3 flex items-center gap-2">
                  <button 
                    onClick={async () => {
                      if (!selected) return;
                      if (selectedEmployeeIds.length === 0) {
                        alert('Pilih karyawan terlebih dahulu');
                        return;
                      }
                      
                      let successCount = 0;
                      let failCount = 0;
                      
                      for (const empId of selectedEmployeeIds) {
                        try {
                          // Check if already in group
                          const already = (participants||[]).some((p:any)=> String(p.id) === String(empId));
                          if (already) {
                            failCount++;
                            continue;
                          }
                          
                          // Get employee usernames from profile
                          const emp = (allUsers||[]).find((u:any)=> String(u.id) === empId);
                          const ownUsernames = emp?.tiktok_username ? [emp.tiktok_username] : [];
                          const ownIGUsernames = emp?.instagram_username ? [emp.instagram_username] : [];
                          
                          // Filter to avoid conflicts
                          const allowed = ownUsernames.filter((u:string) => {
                            const asn = (assignmentByUsername as any)[u];
                            return !asn || asn.employee_id === empId;
                          });
                          
                          const payload: any = { employee_id: empId };
                          if (allowed.length) payload.participant_usernames = allowed;
                          if (ownIGUsernames.length) payload.participant_instagram_usernames = ownIGUsernames;
                          
                          const res = await fetch(`/api/groups/${selected.id}/members`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify(payload)
                          });
                          
                          if (res.ok) successCount++;
                          else failCount++;
                        } catch (err) {
                          console.error('Error adding employee:', err);
                          failCount++;
                        }
                      }
                      
                      if (successCount > 0) {
                        alert(`Berhasil menambahkan ${successCount} karyawan${failCount > 0 ? ` (${failCount} gagal/sudah ada)` : ''}`);
                        setSelectedEmployeeIds([]);
                        setEmpQuery('');
                        
                        // Refresh participants list
                        const mem = await fetch(`/api/groups/${selected.id}/members?start=${groupStart}&end=${groupEnd}`);
                        const mjson = await mem.json();
                        if (mem.ok) {
                          setParticipants(mjson.members || []);
                          setAssignmentByUsername(mjson.assignmentByUsername || {});
                        }
                      } else {
                        alert('Gagal menambahkan karyawan. Mungkin sudah terdaftar semua.');
                      }
                    }} 
                    disabled={selectedEmployeeIds.length === 0}
                    className="px-3 py-2 rounded-lg bg-gradient-to-r from-blue-600 to-sky-500 text-white text-sm disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    Simpan {selectedEmployeeIds.length > 0 ? `(${selectedEmployeeIds.length})` : ''}
                  </button>
                  {selectedEmployeeIds.length > 0 && (
                    <button 
                      onClick={() => { setSelectedEmployeeIds([]); setEmpQuery(''); }} 
                      className="px-3 py-2 rounded-lg border border-white/20 text-white/70 hover:text-white text-sm"
                    >
                      Batal
                    </button>
                  )}
                </div>
              </div>
              <div>
                <h4 className="text-sm text-white/80 mb-2">Karyawan Saat Ini</h4>
                <div className="space-y-2 max-h-64 overflow-auto pr-1">
                  {participants.map(p => (
                    <div key={p.id} className="relative px-3 py-2 rounded-lg border border-white/10 bg-white/5">
                      <button
                        aria-label={`Hapus ${p.name || p.tiktok_username || 'karyawan'}`}
                        className="absolute top-2 right-2 w-6 h-6 rounded-full border border-white/10 text-white/70 hover:text-white hover:bg-red-500/20 hover:border-red-500/40"
                        onClick={() => removeEmployeeFromGroupQuick(String(p.id), String(p.name || p.tiktok_username || ''))}
                        title="Hapus dari Group"
                      >
                        ×
                      </button>
                      <div className="text-white">{p.name || `@${p.tiktok_username || ''}`}</div>
                      {/* TikTok accounts assigned in this group */}
                      <div className="text-xs text-white/60">Akun TikTok:
                        {Array.isArray(p.accounts) && p.accounts.length>0 ? (
                          <span> {Array.from(new Set<string>(p.accounts as string[])).map((u:string, i:number)=> (
                            <span key={`${u}-${i}`} className="inline-flex items-center gap-1 mr-2 mb-1">@{u}</span>
                          ))}</span>
                        ) : (
                          <span> -</span>
                        )}
                      </div>
                      {/* Instagram accounts assigned in this group */}
                      <div className="text-xs text-white/60">Akun Instagram:
                        {Array.isArray(p.accounts_ig) && p.accounts_ig.length>0 ? (
                          <span> {Array.from(new Set<string>(p.accounts_ig as string[])).map((u:string, i:number)=> (
                            <span key={`${u}-ig-${i}`} className="inline-flex items-center gap-1 mr-2 mb-1">@{u}</span>
                          ))}</span>
                        ) : (
                          <span> -</span>
                        )}
                      </div>
                    </div>
                  ))}
                  {!participants.length && <div className="text-white/60 text-sm">Belum ada Karyawan.</div>}
                </div>
              </div>
            </div>
            {/* No global footer needed; modal bisa ditutup via tombol (X) di kanan atas */}
          </div>
        </div>
      )}

      {/* Create Modal */}
      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60">
          <div className="glass rounded-2xl border border-white/10 w-full max-w-lg p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-xl font-semibold text-white">Buat Group</h2>
              <button onClick={() => setShowModal(false)} className="text-white/70 hover:text-white">✕</button>
            </div>
            {error && <p className="mb-3 border border-red-500/30 bg-red-500/10 text-red-300 rounded-lg p-3">{error}</p>}
            <form onSubmit={createCampaign} className="space-y-4">
              <div>
                <label className="block text-sm text-white/80 mb-1">Nama Group</label>
                <input value={newName} onChange={(e) => setNewName(e.target.value)} className="w-full px-3 py-2 rounded-xl border border-white/10 bg-white/5 text-white" required />
              </div>
              <div>
                <label className="block text-sm text-white/80 mb-1">Hashtags (opsional)</label>
                <div className="flex flex-wrap gap-2 mb-2">
                  {newHashtags.map((tag) => (
                    <span key={tag} className="inline-flex items-center gap-1 px-2 py-1 rounded-lg bg-blue-500/20 border border-blue-500/30 text-blue-300 text-sm">
                      {tag}
                      <button type="button" onClick={() => removeHashtag(tag, false)} className="hover:text-blue-100">×</button>
                    </span>
                  ))}
                </div>
                <input 
                  value={hashtagInput} 
                  onChange={(e) => setHashtagInput(e.target.value)}
                  onKeyDown={(e) => handleHashtagKeyDown(e, false)}
                  onBlur={() => { if (hashtagInput.trim()) { addHashtag(hashtagInput, false); setHashtagInput(''); } }}
                  placeholder="Ketik hashtag (tanpa #) lalu Enter. Contoh: SULMO" 
                  className="w-full px-3 py-2 rounded-xl border border-white/10 bg-white/5 text-white placeholder:text-white/40" 
                />
                <p className="text-xs text-white/50 mt-1">Video harus memiliki salah satu hashtag ini untuk dihitung dalam kampanye</p>
              </div>
              {/* start/end removed: we rely on date filter in header */}
              {/* No participant input at create-time; use Import after campaign created */}
              <div className="flex justify-end gap-2 pt-2">
                <button type="button" onClick={() => setShowModal(false)} className="px-4 py-2 rounded-xl border border-white/10 text-white/80 hover:bg-white/5">Batal</button>
                <button type="submit" className="px-4 py-2 rounded-xl bg-gradient-to-r from-blue-600 to-sky-500 text-white">Simpan</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Edit Modal */}
      {showEdit && selected && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60">
          <div className="glass rounded-2xl border border-white/10 w-full max-w-lg p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-xl font-semibold text-white">Edit Group</h2>
              <button onClick={() => setShowEdit(false)} className="text-white/70 hover:text-white">✕</button>
            </div>
            <div className="space-y-4">
              <div>
                <label className="block text-sm text-white/80 mb-1">Nama Group</label>
                <input type="text" value={editName} onChange={(e)=>setEditName(e.target.value)} className="w-full px-3 py-2 rounded-xl border border-white/10 bg-white/5 text-white" />
              </div>
              <div>
                <label className="block text-sm text-white/80 mb-1">Hashtags</label>
                <div className="flex flex-wrap gap-2 mb-2">
                  {editHashtags.map((tag) => (
                    <span key={tag} className="inline-flex items-center gap-1 px-2 py-1 rounded-lg bg-blue-500/20 border border-blue-500/30 text-blue-300 text-sm">
                      {tag}
                      <button type="button" onClick={() => removeHashtag(tag, true)} className="hover:text-blue-100">×</button>
                    </span>
                  ))}
                </div>
                <input 
                  value={hashtagInput} 
                  onChange={(e) => setHashtagInput(e.target.value)}
                  onKeyDown={(e) => handleHashtagKeyDown(e, true)}
                  onBlur={() => { if (hashtagInput.trim()) { addHashtag(hashtagInput, true); setHashtagInput(''); } }}
                  placeholder="Ketik hashtag lalu Enter" 
                  className="w-full px-3 py-2 rounded-xl border border-white/10 bg-white/5 text-white placeholder:text-white/40" 
                />
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <button onClick={()=>setShowEdit(false)} className="px-4 py-2 rounded-xl border border-white/10 text-white/80 hover:bg-white/5">Batal</button>
                <button onClick={async ()=>{
                  const payload: any = {};
                  if (editName && editName !== selected.name) payload.name = editName;
                  const currentHashtags = (selected as any).required_hashtags || [];
                  const hashtagsChanged = JSON.stringify(editHashtags.sort()) !== JSON.stringify(currentHashtags.sort());
                  if (hashtagsChanged) payload.required_hashtags = editHashtags.length > 0 ? editHashtags : null;
                  if (Object.keys(payload).length === 0) { setShowEdit(false); return; }
                  const res = await fetch(`/api/campaigns/${selected.id}`, { method:'PATCH', headers:{ 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
                  const data = await res.json().catch(()=>({}));
                  if (res.ok) {
                    await fetchCampaigns();
                    if (data?.campaign) setSelected(data.campaign);
                    setShowEdit(false);
                  } else {
                    alert(data?.error || 'Gagal menyimpan');
                  }
                }} className="px-4 py-2 rounded-xl bg-gradient-to-r from-blue-600 to-sky-500 text-white">Simpan</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Participant Detail Modal */}
      {selectedUser && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60" onClick={()=>setSelectedUser(null)}>
          <div className="glass rounded-2xl border border-white/10 w-full max-w-3xl p-6" onClick={(e)=>e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-3">
                {(() => {
                  const sel = (participants||[]).find((p:any)=> String(p.id)===String(selectedUser));
                  const avatar = sel?.profile_picture_url as string | undefined;
                  if (avatar) {
                    return <img src={avatar} alt="avatar" className="w-10 h-10 rounded-full object-cover border border-white/20" />;
                  }
                  // fallback initials circle
                  const label = (selectedUserName||'K').trim();
                  const initial = label ? label.charAt(0).toUpperCase() : 'K';
                  return (
                    <div className="w-10 h-10 rounded-full bg-white/10 border border-white/20 flex items-center justify-center text-white/80 text-sm">
                      {initial}
                    </div>
                  );
                })()}
                <h2 className="text-xl font-semibold text-white">{selectedUserName || 'Karyawan'}</h2>
              </div>
              <div className="flex items-center gap-3">
                <button onClick={()=>setSelectedUser(null)} className="text-white/70 hover:text-white">✕</button>
              </div>
            </div>
            {(() => {
              // Use parent page settings for period display
              const todayStr = new Date().toISOString().slice(0,10);
              let effStart: string;
              let effEnd: string;
              if (chartMode === 'accrual') {
                if (useCustomAccrualDates) {
                  effStart = accrualCustomStart;
                  effEnd = accrualCustomEnd;
                } else {
                  const accStart = (()=>{ const d=new Date(); d.setUTCDate(d.getUTCDate()-(accrualWindow-1)); return d.toISOString().slice(0,10); })();
                  effStart = accStart;
                  effEnd = todayStr;
                }
              } else {
                effStart = groupStart;
                effEnd = groupEnd;
              }
              return (
                <div className="mb-3 text-xs text-white/60">
                  Periode: {format(parseISO(effStart), 'd MMM yyyy', { locale: localeID })} — {format(parseISO(effEnd), 'd MMM yyyy', { locale: localeID })}
                  <span className="ml-2 text-white/40">
                    ({chartMode === 'accrual' ? 'Accrual' : 'Post Date'}{chartMode === 'accrual' && useCustomAccrualDates ? ' - Custom' : chartMode === 'accrual' ? ` - ${accrualWindow} hari` : ''}{chartMode !== 'accrual' ? ` - ${chartInterval === 'daily' ? 'Harian' : chartInterval === 'weekly' ? 'Mingguan' : 'Bulanan'}` : ''})
                  </span>
                </div>
              );
            })()}
            {/* Settings inherited from parent page - no separate controls needed */}
            {userSeriesLoading && <p className="text-white/60">Memuat…</p>}
            {/* Toggle sumber data seperti grafik lain */}
            {!userSeriesLoading && (userSeries || userSeriesTT || userSeriesIG) && (
              <div className="mb-2 flex items-center gap-2 text-xs">
                <span className="text-white/60">Sumber:</span>
                <button onClick={()=>setShowTotal(v=>!v)} className={`px-2 py-1 rounded border ${showTotal?'bg-white/20 text-white border-white/20':'text-white/70 border-white/10 hover:bg-white/10'}`}>Total</button>
                <button onClick={()=>setShowTikTok(v=>!v)} className={`px-2 py-1 rounded border ${showTikTok?'bg-white/20 text-white border-white/20':'text-white/70 border-white/10 hover:bg-white/10'}`}>TikTok</button>
                <button onClick={()=>setShowInstagram(v=>!v)} className={`px-2 py-1 rounded border ${showInstagram?'bg-white/20 text-white border-white/20':'text-white/70 border-white/10 hover:bg-white/10'}`}>Instagram</button>
              </div>
            )}
            {!userSeriesLoading && userTotals && (
              <>
              {/* totals */}
              <div className="grid grid-cols-2 md:grid-cols-5 gap-3 mb-4 text-sm">
                <>
                  <div className="glass rounded-xl p-3 border border-white/10"><div className="text-white/60">Views</div><div className="text-white text-lg">{Number(userTotals.views||0).toLocaleString('id-ID')}</div></div>
                  <div className="glass rounded-xl p-3 border border-white/10"><div className="text-white/60">Likes</div><div className="text-white text-lg">{Number(userTotals.likes||0).toLocaleString('id-ID')}</div></div>
                  <div className="glass rounded-xl p-3 border border-white/10"><div className="text-white/60">Comments</div><div className="text-white text-lg">{Number(userTotals.comments||0).toLocaleString('id-ID')}</div></div>
                </>
              </div>
              {userSeries && userSeries.length>0 && (
                <Line ref={userChartRef} plugins={[crosshairPlugin]} data={{
                  labels: userSeries.map((s:any)=> format(parseISO(s.date), 'd MMM', { locale: localeID })),
                  datasets: (()=>{
                    const pick = (s:any)=> compareMetric==='likes'? s.likes : (compareMetric==='comments'? s.comments : s.views);
                    const arr:any[] = [];
                    if (showTotal) arr.push({ label: 'Total', data: userSeries.map((s:any)=> pick(s)), borderColor: '#3b82f6', backgroundColor: 'rgba(59,130,246,0.12)', fill: true, tension: 0.35, pointRadius: 0, pointHoverRadius: 6 });
                    if (showTikTok) arr.push({ label: 'TikTok', data: (userSeriesTT||[]).map((s:any)=> pick(s)), borderColor: '#06b6d4', backgroundColor: 'rgba(6,182,212,0.06)', fill: false, tension: 0.35, pointRadius: 0, pointHoverRadius: 6 });
                    if (showInstagram) arr.push({ label: 'Instagram', data: (userSeriesIG||[]).map((s:any)=> pick(s)), borderColor: '#f43f5e', backgroundColor: 'rgba(244,63,94,0.06)', fill: false, tension: 0.35, pointRadius: 0, pointHoverRadius: 6 });
                    return arr;
                  })()
                }} options={{
                  responsive:true,
                  interaction:{ mode:'index', intersect:false },
                  plugins:{ legend:{ labels:{ color:'rgba(255,255,255,0.8)'} } },
                  scales:{ x:{ ticks:{ color:'rgba(255,255,255,0.6)' }, grid:{ color:'rgba(255,255,255,0.06)'}}, y:{ ticks:{ color:'rgba(255,255,255,0.6)'}, grid:{ color:'rgba(255,255,255,0.06)'}} },
                  onHover: (event:any, elements:any[]) => { if (elements && elements.length>0) setUserActiveIndex(elements[0].index ?? null); else setUserActiveIndex(null); }
                }} onMouseLeave={()=> setUserActiveIndex(null)} />
              )}
              </>
            )}
            {!userSeriesLoading && (!userSeries || userSeries.length===0) && <p className="text-white/60">Belum ada data harian untuk ditampilkan. Total di atas sudah menggunakan data snapshot kampanye.</p>}
          </div>
        </div>
      )}
    </div>
  );
}
